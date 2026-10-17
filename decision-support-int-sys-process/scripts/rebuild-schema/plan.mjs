// The rebuild plan (data-capture-plan.md §8.3): which objects drop, which
// are protected, the statements in order, and the V1–V8 checks. Pure apart
// from reading the backup directory it is given; it issues no query.
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';
import { AE_SCHEMA_SQL } from '../../src/adapters/persistence/clickhouse/schema-migrator.js';
import { loadCatalog } from '../../src/catalog/index.js';

export const EXPECTED_SCHEMA_VERSION = 2;

/** The seven v1 tables (plan §8.1). */
export const LEGACY_TABLES = [
  'landing_page_batch',
  'site_queue',
  'landing_page_analysis',
  'landing_page_dataset',
  'page_naming',
  'naming_queue',
  'page_element_name',
];

/** Their seven _current views, dropped before the tables. */
export const LEGACY_VIEWS = LEGACY_TABLES.map((t) => `${t}_current`);

/** All 14 legacy objects, views first (the drop order). */
export const LEGACY_OBJECTS = [...LEGACY_VIEWS, ...LEGACY_TABLES];

/** The protected list from plan §8.1 (10 named objects; the 11th rule —
 *  "any object not on the drop list" — is the `other` classification). */
export const PROTECTED_OBJECTS = [
  'intercom_contacts',
  'intercom_conversations',
  'intercom_conversation_classifications',
  'intercom_conversation_domains',
  'intercom_tag_definitions',
  'jira_comments',
  'facet_baselines',
  'page_speed_cache',
  'site_report_1425_page_click_weekly',
  'site_report_5173_page_click_weekly',
];

/** The taxonomy stamped on migrated v1 names so the capture gate treats
 *  them as stale and re-captures (plan §8.6). */
export const LEGACY_TAXONOMY_VERSION = '2026-10-03';

/** Table and view names defined by src/persistence/schema2.sql — the closed
 *  ae_ set; drops are never derived from a wildcard. */
export function AEObjects() {
  const tables = [...AE_SCHEMA_SQL.matchAll(/CREATE TABLE IF NOT EXISTS \$\{DATABASE\}\.(ae_\w+)/g)].map((m) => m[1]);
  const views = [...AE_SCHEMA_SQL.matchAll(/CREATE OR REPLACE VIEW IF NOT EXISTS \$\{DATABASE\}\.(\w+)/g)].map((m) => m[1]);
  return { tables, views };
}

function scopeDrops(scope) {
  if (scope === 'legacy') return { views: LEGACY_VIEWS, tables: LEGACY_TABLES };
  if (scope === 'ae') return AEObjects();
  if (scope === 'all') {
    const ae = AEObjects();
    return { views: [...LEGACY_VIEWS, ...ae.views], tables: [...LEGACY_TABLES, ...ae.tables] };
  }
  throw new Error(`--scope must be legacy|ae|all, got "${scope}"`);
}

/**
 * Classify every existing object as drop / protected / other. Throws when a
 * drop-listed name is protected, when a drop target is a dictionary or a
 * materialized view's target, or when a near-name (case or suffix differs)
 * would make a wildcard drop ambiguous.
 *
 * @param {Array<string | {name: string, engine?: string}>} existingNames
 * @param {'legacy'|'ae'|'all'} scope
 * @param {object} [opts]
 * @param {string[]} [opts.drop] override the scope's allowlist (tests)
 * @param {Object<string, string>} [opts.engines] name -> system.tables engine
 * @param {string[]} [opts.mvTargets] names that are materialized-view targets
 */
export function classifyObjects(existingNames, scope, opts = {}) {
  const existing = existingNames.map((e) => (typeof e === 'string' ? { name: e, engine: '' } : e));
  const allow = opts.drop ?? [...scopeDrops(scope).views, ...scopeDrops(scope).tables];
  const allowSet = new Set(allow);
  const engines = opts.engines ?? {};
  const mvTargets = new Set(opts.mvTargets ?? []);

  for (const name of allow) {
    if (PROTECTED_OBJECTS.includes(name)) {
      throw new Error(`refusing to drop protected object ${name}`);
    }
  }

  const existingByName = new Map(existing.map((e) => [e.name, e]));

  /** @type {string[]} */
  const drop = [];
  /** @type {string[]} */
  const protected_ = [];
  /** @type {string[]} */
  const other = [];
  // Drops follow the allowlist order (views before tables), never the
  // database's enumeration order.
  for (const name of allow) {
    const row = existingByName.get(name);
    if (!row) continue;
    if (row.engine === 'Dictionary') {
      throw new Error(`refusing to drop ${name}: it is a dictionary`);
    }
    if (mvTargets.has(name)) {
      throw new Error(`refusing to drop ${name}: it is a materialized view's target`);
    }
    drop.push(name);
  }
  for (const { name } of existing) {
    if (allowSet.has(name)) continue;
    if (PROTECTED_OBJECTS.includes(name)) {
      protected_.push(name);
      continue;
    }
    other.push(name);
  }

  // Near-name check: an object that is NOT on the allowlist but differs from
  // a drop-list entry only by case or suffix means the list no longer
  // describes the database (typo, drift, or an unexpected near-duplicate).
  for (const name of other) {
    const low = name.toLowerCase();
    for (const d of allow) {
      const dl = d.toLowerCase();
      if (low === dl) {
        throw new Error(`near-name match: existing "${name}" differs from drop-list "${d}" only by case`);
      }
      if (dl.length >= 4 && low.startsWith(dl)) {
        throw new Error(`near-name match: existing "${name}" looks like "${d}" plus a suffix`);
      }
    }
  }

  return { drop, protected: protected_, other };
}

/**
 * Parses schema2.sql the same way ensureAeSchema does: complete CREATE
 * statements only, ${DATABASE} substituted. Never returns destructive DDL.
 * @param {string} database
 */
export function aeCreateStatements(database) {
  const destructive = /DROP|TRUNCATE|ALTER\s+TABLE.*DELETE/i;
  if (destructive.test(AE_SCHEMA_SQL)) {
    throw new Error('schema2.sql contains destructive DDL; refusing to run it');
  }
  return AE_SCHEMA_SQL.split('\n')
    .map((line) => {
      const i = line.indexOf('--');
      return i === -1 ? line : line.slice(0, i);
    })
    .join('\n')
    .split(/(?=CREATE (?:TABLE IF NOT EXISTS|OR REPLACE VIEW IF NOT EXISTS))/)
    .map((chunk) => chunk.split(';')[0].trim())
    .filter(Boolean)
    .filter((s) => /\bENGINE\s*=/.test(s) || /CREATE\s+OR\s+REPLACE\s+VIEW/i.test(s))
    .map((s) => s.replaceAll('${DATABASE}', database));
}

/**
 * Reads the backup's page_element_name.jsonl.gz and maps the latest row per
 * (idsite, idsitehsr, selector) onto ae_element_binding columns (plan §8.6).
 * @param {string} backupDir
 * @param {string} generatedAt literal for the generated_at column
 */
export function migrationRowsFromBackup(backupDir, generatedAt) {
  const raw = gunzipSync(readFileSync(path.join(backupDir, 'page_element_name.jsonl.gz')));
  /** @type {Map<string, object>} */
  const latest = new Map();
  for (const line of raw.toString('utf8').split('\n')) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    const key = `${row.idsite}|${row.idsitehsr}|${row.selector}`;
    const prev = latest.get(key);
    if (!prev || String(prev.generated_at ?? '') <= String(row.generated_at ?? '')) latest.set(key, row);
  }
  return [...latest.values()].map((row) => ({
    idsite: Number(row.idsite),
    idsitehsr: Number(row.idsitehsr),
    selector: String(row.selector),
    element_class: String(row.element_class ?? ''),
    element_role: '',
    name: String(row.name ?? ''),
    template_family: '',
    position_index: -1,
    section_id: '',
    naming_provenance: 'legacy_v1',
    ai_confidence: 0,
    human_confirmed_by: '',
    rollup_grain: 'selector',
    attention_enrolled: 0,
    taxonomy_version: LEGACY_TAXONOMY_VERSION,
    named_on: String(row.named_on).slice(0, 10),
    generated_at: generatedAt,
  }));
}

function jsonlInsert(table, rows) {
  return `INSERT INTO ${table} FORMAT JSONEachRow\n${rows.map((r) => JSON.stringify(r)).join('\n')}`;
}

/**
 * Builds the full rebuild plan (§8.3 steps 1–10). Every guard runs here, in
 * dry-run mode too, so an abort happens before a single statement exists.
 *
 * @param {object} input
 * @param {Array<string | {name: string, engine?: string}>} input.existing
 * @param {'legacy'|'ae'|'all'} input.scope
 * @param {string} input.database the configured database
 * @param {string} input.confirmDatabase the operator's --confirm-database
 * @param {object} [input.backupManifest] manifest.json from backup-legacy.mjs
 * @param {Object<string, number>} [input.liveCounts] fresh count() per legacy table
 * @param {Object<string, number>} [input.claimedFresh] claimed rows younger than the TTL
 * @param {string} [input.gitSha]
 * @param {object} [input.catalogBundle] loadCatalog()
 * @param {string} [input.backupDir] for the legacy-name migration
 * @param {Object<string, string>} [input.engines]
 * @param {string[]} [input.mvTargets]
 * @param {Object<string, number>} [input.protectedCounts]
 * @param {number | null} [input.schemaVersion] max(ae_schema_version); null/absent recreates ae objects
 * @param {string} [input.now] applied_at literal
 */
export function buildRebuildPlan(input) {
  const { existing, scope, database, confirmDatabase } = input;
  if (!confirmDatabase || confirmDatabase !== 'journey_events') {
    throw new Error(`refusing: --confirm-database must be "journey_events", got "${confirmDatabase ?? '(missing)'}"`);
  }
  if (database !== confirmDatabase) {
    throw new Error(`refusing: configured database "${database}" does not match --confirm-database "${confirmDatabase}"`);
  }
  const gitSha = input.gitSha ?? '';
  const now = input.now ?? new Date().toISOString().replace('T', ' ').slice(0, -1);
  const db = database;

  // (1) classify
  const classification = classifyObjects(existing, scope, {
    engines: input.engines,
    mvTargets: input.mvTargets,
  });

  // (2) quiesce check
  const queues =
    scope === 'legacy'
      ? ['siteQueue', 'namingQueue']
      : scope === 'ae'
        ? ['aeSiteQueue', 'aeCaptureQueue']
        : ['siteQueue', 'namingQueue', 'aeSiteQueue', 'aeCaptureQueue'];
  for (const q of queues) {
    const n = Number(input.claimedFresh?.[q] ?? 0);
    if (n > 0) {
      throw new Error(`refusing: ${q} has ${n} claimed row(s) younger than the claim TTL; stop the services first`);
    }
  }

  // (3) backup manifest check
  const manifest = input.backupManifest;
  if (!manifest?.tables) {
    throw new Error('refusing: --backup manifest.json not provided');
  }
  const liveCounts = input.liveCounts ?? {};
  for (const table of LEGACY_TABLES) {
    const backedUp = Number(manifest.tables[table]?.rows ?? -1);
    const live = Number(liveCounts[table] ?? -1);
    if (backedUp !== live) {
      throw new Error(`refusing: backup manifest rows for ${table} (${backedUp}) != live count() (${live}); re-run the backup`);
    }
  }

  // (4) protected snapshot
  const protectedSnapshot = input.protectedCounts ?? {};

  // (5) drops: views before tables, exact allowlisted names only. The ae
  // objects are recreated (dropped first) only when the database does not
  // already carry this template's schema version; once version 2 is
  // recorded, an ae run reconciles by creating (IF NOT EXISTS) only, which
  // makes a second execute a no-op.
  const aeRecreate = input.schemaVersion == null || Number(input.schemaVersion) !== EXPECTED_SCHEMA_VERSION;
  const effectiveDrop = classification.drop.filter((n) => {
    const isAe = AEObjects().tables.includes(n) || AEObjects().views.includes(n);
    return !isAe || aeRecreate;
  });
  const dropViews = effectiveDrop.filter((n) => scopeDrops(scope).views.includes(n));
  const dropTables = effectiveDrop.filter((n) => scopeDrops(scope).tables.includes(n));
  const drops = [
    ...dropViews.map((name) => `DROP VIEW IF EXISTS ${db}.${name} SYNC`),
    ...dropTables.map((name) => `DROP TABLE IF EXISTS ${db}.${name} SYNC`),
  ];

  // (6) creates from the schema template (idempotent IF NOT EXISTS)
  const creates = aeCreateStatements(db);

  // (7) schema version row
  const statements = [
    ...drops,
    ...creates,
    `INSERT INTO ${db}.ae_schema_version (schema_version, applied_at, applied_by, git_sha, notes) ` +
      `VALUES (${EXPECTED_SCHEMA_VERSION}, '${now}', 'rebuild-schema', '${gitSha}', 'scope=${scope}')`,
  ];

  // (8) reference seed from the catalog bundle (scope ae/all)
  /** @type {Object<string, number>} */
  const seedCounts = {};
  if (scope !== 'legacy') {
    const bundle = input.catalogBundle;
    if (!bundle) throw new Error('catalog bundle is required for seed statements');
    const requirementRows = (bundle.requirements.requirements ?? []).map((r) => ({
      registry_version: bundle.requirements.registry_version,
      requirement_key: r.key,
      domain: r.domain ?? '',
      title: r.title ?? '',
      source_layer: r.source_layer ?? '',
      mechanism: r.mechanism ?? '',
      dataset_ids: r.dataset_ids ?? r.datasets ?? [],
      grain: r.grain ?? '',
      human_required: r.human_required ? 1 : 0,
      generated_at: now,
    }));
    const catalogRows = Object.values(bundle.strategies ?? {}).flatMap((catalog) =>
      (catalog.strategies ?? []).filter((s) => !s.card_only).map((s) => ({
        catalog_version: catalog.catalog_version ?? '',
        catalog_id: catalog.catalog_id,
        strategy_id: s.id,
        family: s.family ?? '',
        name: s.title ?? '',
        scope: s.scope ?? '',
        surface: s.surface ?? '',
        tools: s.tools ?? [],
        requirement_keys: s.requirement_keys ?? [],
        composite_of: s.composite_of ?? [],
        alias_of: s.alias_of ?? '',
        spec: JSON.stringify(s.spec ?? {}),
        source_ref: s.source_ref ?? '',
        generated_at: now,
      })),
    );
    const crosswalkRows = (bundle.crosswalk.entries ?? []).flatMap((entry) =>
      (entry.members ?? []).map((member) => ({
        catalog_version: bundle.crosswalk.catalog_version ?? '',
        intent_id: entry.intent_id,
        catalog_id: member.slice(0, member.indexOf(':')),
        strategy_id: member,
        relation: entry.relation ?? '',
        generated_at: now,
      })),
    );
    const screenRuleRows = (bundle.screenRules.rules ?? []).map((rule) => ({
      catalog_version: bundle.screenRules.version ?? '',
      catalog_id: rule.catalog ?? '',
      rule_id: rule.id,
      kind: rule.kind ?? '',
      applies_to: rule.applies_to ?? [],
      disposition: rule.disposition ?? '',
      spec: JSON.stringify(rule.spec ?? {}),
      source_ref: rule.source_ref ?? '',
      generated_at: now,
    }));
    seedCounts.requirements = requirementRows.length;
    seedCounts.strategy_catalog = catalogRows.length;
    seedCounts.crosswalk = crosswalkRows.length;
    seedCounts.screen_rules = screenRuleRows.length;
    if (requirementRows.length > 0) statements.push(jsonlInsert(`${db}.ae_requirement`, requirementRows));
    if (catalogRows.length > 0) statements.push(jsonlInsert(`${db}.ae_strategy_catalog`, catalogRows));
    if (crosswalkRows.length > 0) statements.push(jsonlInsert(`${db}.ae_strategy_crosswalk`, crosswalkRows));
    if (screenRuleRows.length > 0) statements.push(jsonlInsert(`${db}.ae_screen_rule`, screenRuleRows));
  }

  // (9) legacy element names from the backup (scope ae/all)
  /** @type {object[]} */
  let migratedRows = [];
  if (scope !== 'legacy') {
    if (!input.backupDir) throw new Error('--backup dir is required for the legacy-name migration');
    migratedRows = migrationRowsFromBackup(input.backupDir, now);
    if (migratedRows.length > 0) statements.push(jsonlInsert(`${db}.ae_element_binding`, migratedRows));
  }

  // (10) verification statements V1–V8 (plan §8.7)
  const ae = AEObjects();
  const legacyList = LEGACY_OBJECTS.map((n) => `'${n}'`).join(', ');
  const aeLike = `'ae\\\\_%'`;
  /** @type {Array<{id: string, description: string, checks: Array<object>}>} */
  const verification = [
    {
      id: 'V1',
      description: 'legacy objects gone',
      checks: [
        {
          sql: `SELECT count() AS n FROM system.tables WHERE database = '${db}' AND name IN (${legacyList})`,
          expect: 0,
        },
      ],
    },
    {
      id: 'V2',
      description: '49 ae_ tables and 47 _current views present',
      checks: [
        {
          sql:
            `SELECT (SELECT count() FROM system.tables WHERE database = '${db}' AND name LIKE ${aeLike} AND engine != 'View') AS tables, ` +
            `(SELECT count() FROM system.tables WHERE database = '${db}' AND name LIKE ${aeLike} AND engine = 'View') AS views`,
          expect: { tables: ae.tables.length, views: ae.views.length },
        },
      ],
    },
    {
      id: 'V3',
      description: 'protected tables untouched (count >= snapshot)',
      checks: Object.entries(protectedSnapshot).map(([name, n]) => ({
        sql: `SELECT count() AS n FROM ${db}.${name}`,
        expectAtLeast: Number(n),
        table: name,
      })),
    },
    {
      id: 'V4',
      description: 'max schema_version = 2',
      checks: [{ sql: `SELECT max(schema_version) AS n FROM ${db}.ae_schema_version`, expect: 2 }],
    },
    {
      id: 'V5',
      description: 'reference seed counts',
      checks: [
        { sql: `SELECT count() AS n FROM ${db}.ae_requirement_current`, expect: seedCounts.requirements ?? 0 },
        { sql: `SELECT count() AS n FROM ${db}.ae_strategy_catalog_current`, expect: seedCounts.strategy_catalog ?? 0 },
        { sql: `SELECT count() AS n FROM ${db}.ae_strategy_crosswalk_current`, expect: seedCounts.crosswalk ?? 0 },
        { sql: `SELECT count() AS n FROM ${db}.ae_screen_rule_current`, expect: seedCounts.screen_rules ?? 0 },
        {
          sql:
            `SELECT count() AS n FROM ${db}.ae_strategy_catalog_current ` +
            `ARRAY JOIN requirement_keys AS rk WHERE rk NOT IN (SELECT requirement_key FROM ${db}.ae_requirement_current)`,
          expect: 0,
        },
      ],
    },
    {
      id: 'V6',
      description: 'legacy names migrated (legacy_v1 rows == backup distinct keys)',
      checks: [
        {
          sql: `SELECT count() AS n FROM ${db}.ae_element_binding_current WHERE naming_provenance = 'legacy_v1'`,
          expect: migratedRows.length,
        },
      ],
    },
    {
      id: 'V7',
      description: 'gateway guard refuses an unbounded ae_src_order query',
      checks: [{ sql: `SELECT * FROM ${db}.ae_src_order`, expectRefusal: 'gateway refused' }],
    },
    {
      id: 'V8',
      description: 'ae_batch sentinel write and read round trip',
      checks: [
        {
          sql:
            `INSERT INTO ${db}.ae_batch (batch_id, created_at, window_start, window_end, window_days, status, generated_at) ` +
            `VALUES ('00000000-0000-0000-0000-000000000002', '${now}', '1970-01-01', '1970-01-01', 1, 'running', '${now}')`,
        },
        {
          sql: `SELECT count() AS n FROM ${db}.ae_batch WHERE batch_id = '00000000-0000-0000-0000-000000000002'`,
          expect: 1,
        },
        {
          sql:
            `INSERT INTO ${db}.ae_batch (batch_id, created_at, window_start, window_end, window_days, status, generated_at) ` +
            `VALUES ('00000000-0000-0000-0000-000000000002', '${now}', '1970-01-01', '1970-01-01', 1, 'failed', '${now}')`,
        },
      ],
    },
  ];

  return {
    statements,
    drops,
    creates,
    verification,
    classification,
    protectedSnapshot,
    migratedKeys: migratedRows.length,
    seedCounts,
  };
}
