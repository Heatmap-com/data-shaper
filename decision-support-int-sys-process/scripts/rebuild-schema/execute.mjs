// The cluster side of the rebuild: the SELECTs a plan is built from, and
// running a plan's statements and checks through a client.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { CLAIM_TTL_MS } from '../../src/adapters/persistence/clickhouse.js';
import { createGateway } from '../../src/adapters/query-gateway/clickhouse.js';
import { loadCatalog } from '../../src/catalog/index.js';
import { LEGACY_TABLES, PROTECTED_OBJECTS, buildRebuildPlan } from './plan.mjs';

/**
 * Runs the statements then the V1–V8 checks. Throws with the failing check
 * id on any mismatch; a refusal is a pass for V7.
 * @param {object} plan buildRebuildPlan result
 * @param {object} runner
 * @param {object} runner.client @clickhouse/client instance
 * @param {object} [runner.gateway] for the V7 guard check
 */
export async function executeRebuildPlan(plan, { client, gateway }) {
  for (const statement of plan.statements) {
    await client.command({ query: statement });
  }
  /** @type {Array<{id: string, ok: boolean, detail: string}>} */
  const results = [];
  for (const group of plan.verification) {
    for (const check of group.checks) {
      let ok = true;
      let detail = '';
      if (check.expectRefusal) {
        const gw = gateway ?? createGateway(client, { logger: { info() {} }, database: plan.database });
        try {
          await gw.query(check.sql, {}, `verify:${group.id}`);
          ok = false;
          detail = 'query was not refused';
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          ok = message.includes(check.expectRefusal);
          detail = ok ? 'refused as expected' : `unexpected error: ${message}`;
        }
      } else {
        const rows = await client
          .query({ query: check.sql, format: 'JSONEachRow' })
          .then((r) => r.json());
        const got = rows[0]?.n ?? rows[0];
        if (check.expect !== undefined) {
          ok = JSON.stringify(got) === JSON.stringify(check.expect);
          detail = `got ${JSON.stringify(got)}, want ${JSON.stringify(check.expect)}`;
        } else if (check.expectAtLeast !== undefined) {
          ok = Number(got) >= check.expectAtLeast;
          detail = `got ${JSON.stringify(got)}, want >= ${check.expectAtLeast}${check.table ? ` (${check.table})` : ''}`;
        }
      }
      results.push({ id: group.id, ok, detail });
      if (!ok) {
        throw new Error(`verification ${group.id} failed: ${detail}`);
      }
    }
  }
  return results;
}

/**
 * Gathers the cluster-side inputs (SELECTs only) and builds the plan.
 * @param {object} opts
 * @param {object} opts.client
 * @param {'legacy'|'ae'|'all'} opts.scope
 * @param {string} opts.confirmDatabase
 * @param {string} [opts.backupDir]
 * @param {string} [opts.gitSha]
 * @param {object} [opts.catalogBundle]
 * @param {string} [opts.now]
 */
export async function planFromCluster({ client, database, scope, confirmDatabase, backupDir, gitSha, catalogBundle, now }) {
  const q = async (sql) => client.query({ query: sql, format: 'JSONEachRow' }).then((r) => r.json());

  const systemRows = await q(
    `SELECT name, engine FROM system.tables WHERE database = '${database}'`,
  );
  const existing = systemRows.map((r) => ({ name: r.name, engine: r.engine }));
  const engines = Object.fromEntries(systemRows.map((r) => [r.name, r.engine]));

  // materialized-view targets in this database
  const mvs = await q(
    `SELECT name, create_table_query FROM system.tables WHERE database = '${database}' AND engine = 'MaterializedView'`,
  );
  const mvTargets = mvs
    .map((r) => String(r.create_table_query ?? '').match(/TO\s+\w+\.(\w+)/i)?.[1])
    .filter(Boolean);

  const ttlSeconds = CLAIM_TTL_MS / 1000;
  const freshCutoff = `(now64(3) - toIntervalSecond(${ttlSeconds}))`;
  const claimedFresh = {
    siteQueue: Number(
      (await q(`SELECT count() AS n FROM ${database}.site_queue WHERE status IN ('qualifying', 'analyzing') AND generated_at > ${freshCutoff}`))[0]?.n ?? 0,
    ),
    namingQueue: Number(
      (await q(`SELECT count() AS n FROM ${database}.naming_queue WHERE status = 'claiming' AND generated_at > ${freshCutoff}`))[0]?.n ?? 0,
    ),
    aeSiteQueue: Number(
      (await q(`SELECT count() AS n FROM ${database}.ae_site_queue WHERE status IN ('claimed', 'selecting_pages', 'analyzing') AND generated_at > ${freshCutoff}`))[0]?.n ?? 0,
    ),
    aeCaptureQueue: Number(
      (await q(`SELECT count() AS n FROM ${database}.ae_capture_queue WHERE status = 'claimed' AND generated_at > ${freshCutoff}`))[0]?.n ?? 0,
    ),
  };

  /** @type {Object<string, number>} */
  const liveCounts = {};
  for (const table of LEGACY_TABLES) {
    liveCounts[table] = Number((await q(`SELECT count() AS n FROM ${database}.${table}`))[0]?.n ?? 0);
  }

  /** @type {Object<string, number>} */
  const protectedCounts = {};
  for (const name of PROTECTED_OBJECTS) {
    if (!engines[name]) continue;
    protectedCounts[name] = Number((await q(`SELECT count() AS n FROM ${database}.${name}`))[0]?.n ?? 0);
  }

  /** @type {object | null} */
  let backupManifest = null;
  if (backupDir) {
    backupManifest = JSON.parse(await readFile(path.join(backupDir, 'manifest.json'), 'utf8'));
  }

  // max schema_version; null when ae_schema_version does not exist yet
  let schemaVersion = null;
  try {
    const rows = await q(`SELECT max(schema_version) AS n FROM ${database}.ae_schema_version`);
    schemaVersion = rows[0]?.n == null ? null : Number(rows[0].n);
  } catch {
    schemaVersion = null;
  }

  return buildRebuildPlan({
    existing,
    scope,
    database,
    confirmDatabase,
    backupManifest,
    liveCounts,
    claimedFresh,
    gitSha,
    catalogBundle: catalogBundle ?? loadCatalog(),
    backupDir,
    engines,
    mvTargets,
    protectedCounts,
    schemaVersion,
    now,
  });
}
