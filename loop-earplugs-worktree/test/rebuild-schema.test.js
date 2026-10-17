import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { loadCatalog } from '../src/catalog/index.js';
import {
  AEObjects,
  LEGACY_OBJECTS,
  LEGACY_TABLES,
  buildRebuildPlan,
  classifyObjects,
  executeRebuildPlan,
  migrationRowsFromBackup,
} from '../scripts/rebuild-schema.mjs';

/**
 * The operator rebuild tool (plan §13 rebuild-schema.test.js), against fakes:
 * drops only allowlisted names, protected names refuse even when listed,
 * the database must be confirmed, the backup manifest must match live
 * counts, views drop before tables, a dry run issues no DDL, a second run is
 * a no-op, and the ae scope never emits a DROP outside AEObjects().
 */

const DB = 'journey_events';

function planInput(overrides = {}) {
  return {
    existing: [],
    scope: 'legacy',
    database: DB,
    confirmDatabase: DB,
    backupManifest: {
      tables: Object.fromEntries(LEGACY_TABLES.map((t) => [t, { rows: 3 }])),
    },
    liveCounts: Object.fromEntries(LEGACY_TABLES.map((t) => [t, 3])),
    claimedFresh: { siteQueue: 0, namingQueue: 0, aeSiteQueue: 0, aeCaptureQueue: 0 },
    gitSha: 'abc123',
    catalogBundle: loadCatalog(),
    ...overrides,
  };
}

const dropNames = (plan) =>
  plan.drops.map((s) => s.match(/DROP (?:VIEW|TABLE) IF EXISTS journey_events\.(\w+)/)[1]);

describe('classifyObjects', () => {
  it('classifies drop, protected and other', () => {
    const result = classifyObjects(
      ['landing_page_batch', 'landing_page_batch_current', 'facet_baselines', 'udp_hsrce_visits'],
      'legacy',
    );
    expect(result.drop).toEqual(['landing_page_batch_current', 'landing_page_batch']);
    expect(result.protected).toEqual(['facet_baselines']);
    expect(result.other).toEqual(['udp_hsrce_visits']);
  });

  it('refuses protected names even if listed', () => {
    expect(() => classifyObjects(['facet_baselines'], 'legacy', { drop: ['facet_baselines'] })).toThrow(
      /protected/,
    );
  });

  it('refuses a dictionary or a materialized-view target on the drop list', () => {
    expect(() =>
      classifyObjects([{ name: 'landing_page_batch', engine: 'Dictionary' }], 'legacy'),
    ).toThrow(/dictionary/);
    expect(() => classifyObjects(['landing_page_batch'], 'legacy', { mvTargets: ['landing_page_batch'] })).toThrow(
      /materialized view/,
    );
  });

  it('refuses near-name matches differing only by case or suffix', () => {
    expect(() => classifyObjects(['Landing_Page_Batch'], 'legacy')).toThrow(/near-name/);
    expect(() => classifyObjects(['landing_page_batch_v2'], 'legacy')).toThrow(/near-name/);
  });

  it('does not near-name-match allowlisted siblings (ae_src_order vs ae_src_order_line)', () => {
    const ae = AEObjects();
    expect(() => classifyObjects(ae.tables, 'ae')).not.toThrow();
  });
});

describe('buildRebuildPlan guards', () => {
  it('refuses a missing or wrong --confirm-database', () => {
    expect(() => buildRebuildPlan(planInput({ confirmDatabase: undefined }))).toThrow(/confirm-database/);
    expect(() => buildRebuildPlan(planInput({ confirmDatabase: 'staging' }))).toThrow(/confirm-database/);
  });

  it('refuses a database mismatch between config and confirmation', () => {
    expect(() => buildRebuildPlan(planInput({ database: 'analysis' }))).toThrow(/does not match/);
  });

  it('refuses without a backup manifest', () => {
    expect(() => buildRebuildPlan(planInput({ backupManifest: null }))).toThrow(/manifest/);
  });

  it('refuses when manifest rows != live counts', () => {
    expect(() => buildRebuildPlan(planInput({ liveCounts: { ...planInput().liveCounts, site_queue: 4 } }))).toThrow(
      /site_queue/,
    );
  });

  it('refuses when queues are not quiesced', () => {
    expect(() => buildRebuildPlan(planInput({ claimedFresh: { namingQueue: 1 } }))).toThrow(/namingQueue/);
    expect(() =>
      buildRebuildPlan(planInput({ scope: 'ae', claimedFresh: { aeCaptureQueue: 2 } })),
    ).toThrow(/aeCaptureQueue/);
  });

  it('ae scope never emits DROP for a name not in AEObjects()', () => {
    const ae = AEObjects();
    const allNames = new Set([...ae.tables, ...ae.views]);
    const plan = buildRebuildPlan(planInput({ scope: 'ae', existing: [...allNames], backupDir }));
    expect(plan.drops.length).toBeGreaterThan(0); // version != 2 -> recreate
    for (const name of dropNames(plan)) {
      expect(allNames.has(name), name).toBe(true);
    }
  });
});

describe('buildRebuildPlan statements', () => {
  it('legacy scope drops only the 14 allowlisted objects, views before tables', () => {
    const legacyTables = LEGACY_OBJECTS.filter((n) => !n.endsWith('_current'));
    const plan = buildRebuildPlan(planInput({ existing: [...LEGACY_OBJECTS] }));
    expect(dropNames(plan).sort()).toEqual([...LEGACY_OBJECTS].sort());
    expect(plan.drops).toHaveLength(14);
    const firstTable = Math.min(...plan.drops.map((s) => (s.startsWith('DROP TABLE') ? plan.drops.indexOf(s) : Infinity)));
    const lastView = Math.max(...plan.drops.map((s, i) => (s.startsWith('DROP VIEW') ? i : -Infinity)));
    expect(lastView).toBeLessThan(firstTable);
    expect(legacyTables).toHaveLength(7);
  });

  it('a second ae execute is a no-op: zero drops, only idempotent creates', () => {
    const ae = AEObjects();
    const existing = [
      ...ae.views.map((name) => ({ name, engine: 'View' })),
      ...ae.tables.map((name) => ({ name, engine: 'ReplacingMergeTree' })),
    ];
    const plan = buildRebuildPlan(planInput({ scope: 'ae', existing, backupDir, schemaVersion: 2 }));
    expect(plan.drops).toHaveLength(0);
    expect(plan.creates.length).toBeGreaterThan(0);
    for (const create of plan.creates) {
      expect(create).toMatch(/^CREATE (TABLE IF NOT EXISTS|OR REPLACE VIEW IF NOT EXISTS)/);
    }
    // the only mutating statements are the version row + seeds + migration
    const nonCreates = plan.statements.filter((s) => !s.startsWith('CREATE'));
    expect(nonCreates.every((s) => s.startsWith('INSERT'))).toBe(true);
  });

  it('records the schema version row 2 with the git sha', () => {
    const plan = buildRebuildPlan(planInput());
    const versionInsert = plan.statements.find(
      (s) => s.startsWith('INSERT INTO') && s.includes('ae_schema_version'),
    );
    expect(versionInsert).toMatch(/VALUES \(2, /);
    expect(versionInsert).toContain('abc123');
  });

  it('emits the V1–V8 verification checks', () => {
    const plan = buildRebuildPlan(planInput({ scope: 'ae', backupDir }));
    const ids = plan.verification.map((v) => v.id);
    expect(ids).toEqual(['V1', 'V2', 'V3', 'V4', 'V5', 'V6', 'V7', 'V8']);
    const v7 = plan.verification.find((v) => v.id === 'V7').checks[0];
    expect(v7.sql).toContain('ae_src_order');
    expect(v7.sql).not.toContain('{idsite');
    expect(v7.expectRefusal).toBe('gateway refused');
    const v8 = plan.verification.find((v) => v.id === 'V8');
    expect(v8.checks).toHaveLength(3);
    const v5 = plan.verification.find((v) => v.id === 'V5');
    const requirementsCheck = v5.checks.find((c) => c.sql.includes('ae_requirement_current'));
    expect(requirementsCheck.expect).toBe(101);
    const catalogCheck = v5.checks.find((c) => c.sql.includes('ae_strategy_catalog_current'));
    expect(catalogCheck.expect).toBe(325);
  });

  it('V2 expects 64 tables and 62 views parsed from schema2.sql', () => {
    const plan = buildRebuildPlan(planInput({ scope: 'ae', backupDir }));
    const v2 = plan.verification.find((v) => v.id === 'V2').checks[0];
    expect(v2.expect).toEqual({ tables: 64, views: 62 });
  });
});

describe('dry run and execute', () => {
  it('a dry run issues no DDL: client.command is never called', async () => {
    const { planFromCluster } = await import('../scripts/rebuild-schema.mjs');
    const commands = [];
    const client = {
      async query({ query }) {
        return {
          async json() {
            if (query.includes('system.tables')) return [];
            const table = query.match(/^SELECT count\(\) AS n FROM journey_events\.(\w+)$/)?.[1];
            if (table && LEGACY_TABLES.includes(table)) return [{ n: 3 }]; // matches the fixture manifest
            return [{ n: 0 }];
          },
        };
      },
      async command({ query }) {
        commands.push(query);
      },
    };
    await planFromCluster({ client, database: DB, scope: 'legacy', confirmDatabase: DB, backupDir });
    expect(commands).toEqual([]);
  });

  it('executeRebuildPlan issues statements then verifies, and a V7 refusal passes', async () => {
    const commands = [];
    const client = {
      async command({ query }) {
        commands.push(query);
      },
      async query() {
        return { json: async () => [{ n: 0 }] };
      },
    };
    const gateway = {
      async query() {
        throw new Error('gateway refused query "verify:V7": fact-table queries must carry the {idsite:...} parameter');
      },
    };
    const plan = {
      statements: ['CREATE TABLE x'],
      verification: [
        {
          id: 'V1',
          description: 't',
          checks: [
            { sql: 'SELECT count() AS n FROM x', expect: 0 },
            { sql: 'SELECT * FROM journey_events.ae_src_order', expectRefusal: 'gateway refused' },
          ],
        },
      ],
    };
    const results = await executeRebuildPlan(plan, { client, gateway });
    expect(commands).toEqual(['CREATE TABLE x']);
    expect(results.every((r) => r.ok)).toBe(true);
  });
});

// ---- legacy-name migration fixture ----------------------------------------

let backupDir;
const fixtureRows = [
  {
    idsite: 3199,
    idsitehsr: 63918696,
    selector: 'button.atc',
    element_class: 'offer_add_to_cart',
    name: 'Add to Cart',
    named_on: '2026-09-01',
    generated_at: '2026-09-01 10:00:00.000',
  },
  {
    // older version of the same key: the migration must take the latest
    idsite: 3199,
    idsitehsr: 63918696,
    selector: 'button.atc',
    element_class: 'offer_add_to_cart',
    name: 'Old label',
    named_on: '2026-08-01',
    generated_at: '2026-08-01 10:00:00.000',
  },
  {
    idsite: 3207,
    idsitehsr: 9307614,
    selector: 'header > button',
    element_class: 'nav_toggle',
    name: 'Menu',
    named_on: '2026-09-15',
    generated_at: '2026-09-15 12:00:00.000',
  },
];

beforeAll(async () => {
  backupDir = await mkdtemp(path.join(tmpdir(), 'rebuild-test-'));
  await writeFile(
    path.join(backupDir, 'page_element_name.jsonl.gz'),
    gzipSync(fixtureRows.map((r) => JSON.stringify(r)).join('\n')),
  );
  // a manifest whose counts match the fake live counts
  await writeFile(
    path.join(backupDir, 'manifest.json'),
    JSON.stringify({ tables: Object.fromEntries(LEGACY_TABLES.map((t) => [t, { rows: 3 }])) }),
  );
});

afterAll(async () => {
  await rm(backupDir, { recursive: true, force: true });
});

describe('legacy-name migration (plan §8.6)', () => {
  it('maps the backup rows to ae_element_binding, latest per key, provenance legacy_v1, taxonomy 2026-10-03', () => {
    const rows = migrationRowsFromBackup(backupDir, '2026-10-04 00:00:00.000');
    expect(rows).toHaveLength(2); // latest row per (idsite, idsitehsr, selector)
    const atc = rows.find((r) => r.selector === 'button.atc');
    expect(atc.name).toBe('Add to Cart');
    expect(atc.naming_provenance).toBe('legacy_v1');
    expect(atc.taxonomy_version).toBe('2026-10-03');
    expect(atc.element_role).toBe('');
    expect(atc.position_index).toBe(-1);
    expect(atc.rollup_grain).toBe('selector');
    expect(atc.named_on).toBe('2026-09-01');
    expect(atc.generated_at).toBe('2026-10-04 00:00:00.000');
  });

  it('the ae plan emits the migration INSERT for ae_element_binding', () => {
    const plan = buildRebuildPlan(planInput({ scope: 'ae', backupDir }));
    const migration = plan.statements.find((s) => s.startsWith('INSERT INTO journey_events.ae_element_binding'));
    expect(migration).toBeDefined();
    expect(migration).toContain('"naming_provenance":"legacy_v1"');
    expect(migration).toContain('"taxonomy_version":"2026-10-03"');
    expect(migration).toContain('Add to Cart');
    expect(migration).not.toContain('Old label');
    expect(plan.migratedKeys).toBe(2);
    const v6 = plan.verification.find((v) => v.id === 'V6').checks[0];
    expect(v6.expect).toBe(2);
  });

  it('seeds reference rows from the catalog bundle (101 requirements, 325 catalog rows)', () => {
    const bundle = loadCatalog();
    const plan = buildRebuildPlan(planInput({ scope: 'ae', backupDir, catalogBundle: bundle }));
    expect(plan.seedCounts.requirements).toBe(101);
    expect(plan.seedCounts.strategy_catalog).toBe(325);
    const requirementInsert = plan.statements.find((s) => s.startsWith('INSERT INTO journey_events.ae_requirement '));
    expect(requirementInsert).toBeDefined();
    const catalogInsert = plan.statements.find((s) => s.startsWith('INSERT INTO journey_events.ae_strategy_catalog'));
    expect(catalogInsert.match(/\n/g)).toHaveLength(325);
  });
});

describe('rebuild-schema module split', () => {
  it('the CLI module re-exports the plan and execute modules', async () => {
    const cli = await import('../scripts/rebuild-schema.mjs');
    const plan = await import('../scripts/rebuild-schema/plan.mjs');
    const execute = await import('../scripts/rebuild-schema/execute.mjs');
    for (const name of Object.keys(plan)) expect(cli[name], name).toBe(plan[name]);
    expect(cli.executeRebuildPlan).toBe(execute.executeRebuildPlan);
    expect(cli.planFromCluster).toBe(execute.planFromCluster);
  });

  it('builds a plan with no client: the plan module makes no connection', async () => {
    const source = await readFile(path.resolve('scripts/rebuild-schema/plan.mjs'), 'utf8');
    expect(source).not.toMatch(/createClientFromEnv|createGateway|\.command\(|\.query\(/);
  });
});
