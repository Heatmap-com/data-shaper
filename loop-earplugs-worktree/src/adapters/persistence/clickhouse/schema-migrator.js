/**
 * Create-only DDL for one ClickHouse database: the v1 tables, the schema-2
 * ae_* tables and views from schema2.sql, and the ae_trend_row sort-key
 * rebuild. The database name is passed in; composition reads it.
 */

import { readFileSync } from 'node:fs';

/**
 * v1 tables and views for one database.
 * @param {string} database
 */
export function schemaSql(database) {
  return `
CREATE DATABASE IF NOT EXISTS ${database};

CREATE TABLE IF NOT EXISTS ${database}.landing_page_batch
(
    batch_id UUID,
    created_at DateTime64(3),
    window_start Date,
    window_end Date,
    site_source LowCardinality(String),
    qualifier LowCardinality(String),
    min_sessions UInt32,
    min_orders UInt32,
    min_share_of_home Float64,
    status LowCardinality(String),
    sites_queued UInt32,
    sites_qualified UInt32,
    sites_skipped UInt32,
    sites_failed UInt32,
    metadata String
)
ENGINE = ReplacingMergeTree(created_at)
ORDER BY (batch_id);

CREATE TABLE IF NOT EXISTS ${database}.site_queue
(
    batch_id UUID,
    idsite UInt32,
    site_name String,
    status LowCardinality(String),
    idsitehsr UInt64,
    landing_page_url String,
    page_type LowCardinality(String),
    entry_sessions UInt64,
    orders UInt64,
    revenue Float64,
    reason String,
    claim_token String,
    generated_at DateTime64(3)
)
ENGINE = ReplacingMergeTree(generated_at)
ORDER BY (batch_id, idsite);

CREATE TABLE IF NOT EXISTS ${database}.landing_page_analysis
(
    batch_id UUID,
    idsite UInt32,
    idsitehsr UInt64,
    landing_page_url String,
    page_title String,
    page_type LowCardinality(String),
    window_start Date,
    window_end Date,
    entry_sessions UInt64,
    orders UInt32,
    revenue Float64,
    rps Float64,
    single_pageview_share Float64,
    scroll_reach_25 Float64,
    scroll_reach_70 Float64,
    desktop_rps Float64,
    mobile_rps Float64,
    mobile_to_desktop_rps Float64,
    bot_sessions_excluded UInt64,
    sessions_unfiltered UInt64,
    orders_unfiltered UInt32,
    strategies_triggered UInt16,
    strategies_below_floor UInt16,
    strategies_blocked UInt16,
    strategies_silent UInt16,
    status LowCardinality(String),
    metadata String,
    generated_at DateTime64(3)
)
ENGINE = ReplacingMergeTree(generated_at)
ORDER BY (batch_id, idsite, idsitehsr);

CREATE TABLE IF NOT EXISTS ${database}.landing_page_dataset
(
    batch_id UUID,
    idsite UInt32,
    idsitehsr UInt64,
    dataset_id LowCardinality(String),
    bot_filter LowCardinality(String),
    dim_week Nullable(Date),
    dim_device LowCardinality(String),
    dim_referer LowCardinality(String),
    dim_selector String,
    dim_extra String,
    metrics String,
    row_key String,
    generated_at DateTime64(3)
)
ENGINE = ReplacingMergeTree(generated_at)
ORDER BY (batch_id, idsite, idsitehsr, dataset_id, row_key);

CREATE OR REPLACE VIEW ${database}.landing_page_batch_current AS
SELECT batch_id, created_at_v AS created_at, window_start, window_end, site_source, qualifier,
       min_sessions, min_orders, min_share_of_home, status,
       sites_queued, sites_qualified, sites_skipped, sites_failed, metadata
FROM (
    SELECT batch_id,
           max(created_at) AS created_at_v,
           argMax(window_start, created_at) AS window_start,
           argMax(window_end, created_at) AS window_end,
           argMax(site_source, created_at) AS site_source,
           argMax(qualifier, created_at) AS qualifier,
           argMax(min_sessions, created_at) AS min_sessions,
           argMax(min_orders, created_at) AS min_orders,
           argMax(min_share_of_home, created_at) AS min_share_of_home,
           argMax(status, created_at) AS status,
           argMax(sites_queued, created_at) AS sites_queued,
           argMax(sites_qualified, created_at) AS sites_qualified,
           argMax(sites_skipped, created_at) AS sites_skipped,
           argMax(sites_failed, created_at) AS sites_failed,
           argMax(metadata, created_at) AS metadata
    FROM ${database}.landing_page_batch
    GROUP BY batch_id
);

CREATE OR REPLACE VIEW ${database}.site_queue_current AS
SELECT batch_id, idsite, site_name, status, idsitehsr, landing_page_url, page_type,
       entry_sessions, orders, revenue, reason, claim_token, generated_at_v AS generated_at
FROM (
    SELECT batch_id, idsite,
           argMax(site_name, generated_at) AS site_name,
           argMax(status, generated_at) AS status,
           argMax(idsitehsr, generated_at) AS idsitehsr,
           argMax(landing_page_url, generated_at) AS landing_page_url,
           argMax(page_type, generated_at) AS page_type,
           argMax(entry_sessions, generated_at) AS entry_sessions,
           argMax(orders, generated_at) AS orders,
           argMax(revenue, generated_at) AS revenue,
           argMax(reason, generated_at) AS reason,
           argMax(claim_token, generated_at) AS claim_token,
           max(generated_at) AS generated_at_v
    FROM ${database}.site_queue
    GROUP BY batch_id, idsite
);

CREATE OR REPLACE VIEW ${database}.landing_page_analysis_current AS
SELECT batch_id, idsite, idsitehsr, landing_page_url, page_title, page_type, window_start, window_end,
       entry_sessions, orders, revenue, rps, single_pageview_share, scroll_reach_25, scroll_reach_70,
       desktop_rps, mobile_rps, mobile_to_desktop_rps, bot_sessions_excluded, sessions_unfiltered,
       orders_unfiltered, strategies_triggered, strategies_below_floor, strategies_blocked,
       strategies_silent, status, metadata, generated_at_v AS generated_at
FROM (
    SELECT batch_id, idsite, idsitehsr,
           argMax(landing_page_url, generated_at) AS landing_page_url,
           argMax(page_title, generated_at) AS page_title,
           argMax(page_type, generated_at) AS page_type,
           argMax(window_start, generated_at) AS window_start,
           argMax(window_end, generated_at) AS window_end,
           argMax(entry_sessions, generated_at) AS entry_sessions,
           argMax(orders, generated_at) AS orders,
           argMax(revenue, generated_at) AS revenue,
           argMax(rps, generated_at) AS rps,
           argMax(single_pageview_share, generated_at) AS single_pageview_share,
           argMax(scroll_reach_25, generated_at) AS scroll_reach_25,
           argMax(scroll_reach_70, generated_at) AS scroll_reach_70,
           argMax(desktop_rps, generated_at) AS desktop_rps,
           argMax(mobile_rps, generated_at) AS mobile_rps,
           argMax(mobile_to_desktop_rps, generated_at) AS mobile_to_desktop_rps,
           argMax(bot_sessions_excluded, generated_at) AS bot_sessions_excluded,
           argMax(sessions_unfiltered, generated_at) AS sessions_unfiltered,
           argMax(orders_unfiltered, generated_at) AS orders_unfiltered,
           argMax(strategies_triggered, generated_at) AS strategies_triggered,
           argMax(strategies_below_floor, generated_at) AS strategies_below_floor,
           argMax(strategies_blocked, generated_at) AS strategies_blocked,
           argMax(strategies_silent, generated_at) AS strategies_silent,
           argMax(status, generated_at) AS status,
           argMax(metadata, generated_at) AS metadata,
           max(generated_at) AS generated_at_v
    FROM ${database}.landing_page_analysis
    GROUP BY batch_id, idsite, idsitehsr
);

CREATE OR REPLACE VIEW ${database}.landing_page_dataset_current AS
SELECT batch_id, idsite, idsitehsr, dataset_id, row_key, bot_filter, dim_week, dim_device,
       dim_referer, dim_selector, dim_extra, metrics, generated_at_v AS generated_at
FROM (
    SELECT batch_id, idsite, idsitehsr, dataset_id, row_key,
           argMax(bot_filter, generated_at) AS bot_filter,
           argMax(dim_week, generated_at) AS dim_week,
           argMax(dim_device, generated_at) AS dim_device,
           argMax(dim_referer, generated_at) AS dim_referer,
           argMax(dim_selector, generated_at) AS dim_selector,
           argMax(dim_extra, generated_at) AS dim_extra,
           argMax(metrics, generated_at) AS metrics,
           max(generated_at) AS generated_at_v
    FROM ${database}.landing_page_dataset
    GROUP BY batch_id, idsite, idsitehsr, dataset_id, row_key
);

CREATE TABLE IF NOT EXISTS ${database}.page_naming
(
    idsite UInt32,
    idsitehsr UInt64,
    landing_page_url String,
    status LowCardinality(String),
    taxonomy_version LowCardinality(String),
    named_on Date,
    coverage String,
    generated_at DateTime64(3)
)
ENGINE = ReplacingMergeTree(generated_at)
ORDER BY (idsite, idsitehsr);

CREATE OR REPLACE VIEW ${database}.page_naming_current AS
SELECT idsite, idsitehsr, landing_page_url, status, taxonomy_version, named_on, coverage,
       generated_at_v AS generated_at
FROM (
    SELECT idsite, idsitehsr,
           argMax(landing_page_url, generated_at) AS landing_page_url,
           argMax(status, generated_at) AS status,
           argMax(taxonomy_version, generated_at) AS taxonomy_version,
           argMax(named_on, generated_at) AS named_on,
           argMax(coverage, generated_at) AS coverage,
           max(generated_at) AS generated_at_v
    FROM ${database}.page_naming
    GROUP BY idsite, idsitehsr
);

CREATE TABLE IF NOT EXISTS ${database}.naming_queue
(
    idsite UInt32,
    idsitehsr UInt64,
    landing_page_url String,
    page_type LowCardinality(String),
    status LowCardinality(String),
    reason String,
    requested_on Date,
    claim_token String,
    generated_at DateTime64(3)
)
ENGINE = ReplacingMergeTree(generated_at)
ORDER BY (idsite, idsitehsr);

CREATE OR REPLACE VIEW ${database}.naming_queue_current AS
SELECT idsite, idsitehsr, landing_page_url, page_type, status, reason, requested_on,
       claim_token, generated_at_v AS generated_at
FROM (
    SELECT idsite, idsitehsr,
           argMax(landing_page_url, generated_at) AS landing_page_url,
           argMax(page_type, generated_at) AS page_type,
           argMax(status, generated_at) AS status,
           argMax(reason, generated_at) AS reason,
           argMax(requested_on, generated_at) AS requested_on,
           argMax(claim_token, generated_at) AS claim_token,
           max(generated_at) AS generated_at_v
    FROM ${database}.naming_queue
    GROUP BY idsite, idsitehsr
);

CREATE TABLE IF NOT EXISTS ${database}.page_element_name
(
    idsite UInt32,
    idsitehsr UInt64,
    selector String,
    element_class LowCardinality(String),
    name String,
    named_on Date,
    generated_at DateTime64(3)
)
ENGINE = ReplacingMergeTree(generated_at)
ORDER BY (idsite, idsitehsr, selector);

CREATE OR REPLACE VIEW ${database}.page_element_name_current AS
SELECT idsite, idsitehsr, selector, element_class, name, named_on, generated_at_v AS generated_at
FROM (
    SELECT idsite, idsitehsr, selector,
           argMax(element_class, generated_at) AS element_class,
           argMax(name, generated_at) AS name,
           argMax(named_on, generated_at) AS named_on,
           max(generated_at) AS generated_at_v
    FROM ${database}.page_element_name
    GROUP BY idsite, idsitehsr, selector
);
`;
}

/**
 * @param {object} client @clickhouse/client instance
 * @param {string} database
 */
export async function ensureSchema(client, database) {
  const dbs = await client
    .query({ query: 'SELECT name FROM system.databases', format: 'JSONEachRow' })
    .then((r) => r.json());
  if (!dbs.some((d) => d.name === database)) {
    await client.command({ query: `CREATE DATABASE ${database}` });
  }
  const statements = schemaSql(database).split(';')
    .map((s) => s.trim())
    .filter(Boolean);
  const tables = statements.filter((s) => !s.startsWith('CREATE OR REPLACE VIEW'));
  const views = statements.filter((s) => s.startsWith('CREATE OR REPLACE VIEW'));
  for (const statement of tables) {
    await client.command({ query: statement });
  }
  // Columns added after the first deploy; idempotent on current schemas.
  // These run before the views because the _current views select them.
  await client.command({
    query: `ALTER TABLE ${database}.site_queue ADD COLUMN IF NOT EXISTS claim_token String`,
  });
  await client.command({
    query: `ALTER TABLE ${database}.naming_queue ADD COLUMN IF NOT EXISTS claim_token String`,
  });
  for (const statement of views) {
    await client.command({ query: statement });
  }
}

/**
 * Schema-2 DDL (data-capture-plan.md §8.4/§8.5): 49 ae_* tables and 47
 * `<table>_current` views reading through `FINAL`. Read once at module load;
 * `${DATABASE}` is substituted at ensure time. Four tables whose DDL is
 * intentionally truncated in the file (ae_source_connection, ae_page_render,
 * ae_src_order, ae_src_tool_event — ingest-side, later phases) end mid
 * column-list; their incomplete fragments are skipped, as is any fragment
 * that is not a complete CREATE statement.
 */
export const AE_SCHEMA_SQL = readFileSync(
  new URL('../../../persistence/schema2.sql', import.meta.url),
  'utf8',
);

// Destructive DDL must never run from the schema template; refuse before a
// single statement is sent. The template is expected to contain none.
const AE_DESTRUCTIVE_DDL_RE = /DROP|TRUNCATE|ALTER\s+TABLE.*DELETE/i;

function stripLineComments(sql) {
  return sql
    .split('\n')
    .map((line) => {
      const i = line.indexOf('--');
      return i === -1 ? line : line.slice(0, i);
    })
    .join('\n');
}

/**
 * Create-only, idempotent: every CREATE TABLE IF NOT EXISTS and CREATE OR
 * REPLACE VIEW IF NOT EXISTS statement, in file order. Never drops, truncates
 * or alters. Throws if the template ever gains destructive DDL.
 * @param {object} client @clickhouse/client instance
 * @param {string} database
 */
export async function ensureAeSchema(client, database) {
  if (AE_DESTRUCTIVE_DDL_RE.test(AE_SCHEMA_SQL)) {
    throw new Error('schema2.sql contains destructive DDL (DROP/TRUNCATE/ALTER TABLE ... DELETE); refusing to run it');
  }
  const statements = stripLineComments(AE_SCHEMA_SQL)
    .split(/(?=CREATE (?:TABLE IF NOT EXISTS|OR REPLACE VIEW IF NOT EXISTS))/)
    .map((chunk) => chunk.split(';')[0].trim())
    .filter(Boolean)
    .filter((s) => /\bENGINE\s*=/.test(s) || /CREATE\s+OR\s+REPLACE\s+VIEW/i.test(s));
  for (const statement of statements) {
    if (AE_DESTRUCTIVE_DDL_RE.test(statement)) {
      throw new Error(`schema2.sql statement is destructive: ${statement.slice(0, 80)}`);
    }
    // This server rejects CREATE OR REPLACE VIEW IF NOT EXISTS. OR REPLACE is idempotent.
    const query = statement
      .replaceAll('${DATABASE}', database)
      .replaceAll('CREATE OR REPLACE VIEW IF NOT EXISTS', 'CREATE OR REPLACE VIEW');
    await client.command({ query });
  }
}

/**
 * Columns schema2.sql gained after its tables shipped. CREATE TABLE IF NOT
 * EXISTS leaves an existing table as it is, so these reach it by
 * ADD COLUMN IF NOT EXISTS. Each altered table's _current view is
 * replaced afterwards, because a view fixes its columns when created.
 */
const AE_COLUMN_MIGRATIONS = Object.freeze([
  ['ae_batch', 'profile', "LowCardinality(String) DEFAULT ''"],
  ['ae_batch', 'subject_type', "LowCardinality(String) DEFAULT ''"],
  ['ae_dataset_row', 'subject_type', "LowCardinality(String) DEFAULT 'page'"],
  ['ae_dataset_row', 'subject_key', "String DEFAULT ''"],
  ['ae_analysis_checkpoint', 'subject_type', "LowCardinality(String) DEFAULT 'page'"],
  ['ae_analysis_checkpoint', 'subject_key', "String DEFAULT ''"],
  ['ae_requirement_status', 'subject_type', "LowCardinality(String) DEFAULT 'page'"],
  ['ae_requirement_status', 'subject_key', "String DEFAULT ''"],
  ['ae_strategy_card', 'subject_type', "LowCardinality(String) DEFAULT 'page'"],
  ['ae_strategy_card', 'subject_key', "String DEFAULT ''"],
  ['ae_trigger_chain', 'level', "LowCardinality(String) DEFAULT ''"],
  ['ae_trigger_chain', 'device', "LowCardinality(String) DEFAULT ''"],
  ['ae_trigger_chain', 'channel', "LowCardinality(String) DEFAULT ''"],
  ['ae_trigger_chain', 'source', "String DEFAULT ''"],
  ['ae_trigger_chain', 'medium', "String DEFAULT ''"],
  ['ae_trigger_chain', 'returning', "LowCardinality(String) DEFAULT ''"],
  ['ae_trigger_chain', 'country', "LowCardinality(String) DEFAULT ''"],
  ['ae_trigger_chain', 'landing_page', "String DEFAULT ''"],
  ['ae_trigger_chain', 'entry_template', "LowCardinality(String) DEFAULT ''"],
]);

/**
 * The exact statements migrateAeSchema may send, in order: every column
 * addition, then each altered table's view as schema2.sql writes it.
 * @param {string} database
 * @returns {string[]}
 */
export function aeMigrationStatements(database) {
  const columns = AE_COLUMN_MIGRATIONS.map(([table, column, type]) =>
    `ALTER TABLE ${database}.${table} ADD COLUMN IF NOT EXISTS ${column} ${type}`);
  const tables = [...new Set(AE_COLUMN_MIGRATIONS.map(([table]) => table))];
  const views = tables.map((table) => {
    const view = `CREATE OR REPLACE VIEW IF NOT EXISTS \${DATABASE}.${table}_current AS\nSELECT * FROM \${DATABASE}.${table} FINAL;`;
    if (!AE_SCHEMA_SQL.includes(view)) {
      throw new Error(`schema2.sql has no ${table}_current view in the expected form`);
    }
    return `CREATE OR REPLACE VIEW ${database}.${table}_current AS SELECT * FROM ${database}.${table} FINAL`;
  });
  return [...columns, ...views];
}

/**
 * Additive only: sends aeMigrationStatements and nothing else. Every
 * statement is checked against that list before the first one runs.
 * @param {import('@clickhouse/client').ClickHouseClient} client
 * @param {string} database
 * @param {string[]} [statements] defaults to the whole list
 */
export async function migrateAeSchema(client, database, statements = aeMigrationStatements(database)) {
  const allowed = new Set(aeMigrationStatements(database));
  const refused = statements.filter((statement) => !allowed.has(statement));
  if (refused.length > 0) {
    throw new Error(`migrateAeSchema refuses a statement outside its list: ${refused[0].slice(0, 80)}`);
  }
  for (const query of statements) await client.command({ query });
}

/**
 * The schema-2 tables and views, then the column migrations.
 * @param {import('@clickhouse/client').ClickHouseClient} client
 * @param {string} database
 */
export async function ensureAe(client, database) {
  await ensureAeSchema(client, database);
  await migrateAeSchema(client, database);
}

/**
 * ae_trend_row's sort key cannot be altered in place. The table is replaced
 * only when it has no viewport_type column and no rows. schema2.sql holds
 * the create statement and is not allowed to drop.
 * @param {import('@clickhouse/client').ClickHouseClient} client
 * @param {string} database
 */
export async function ensureTrendTables(client, database) {
  const existing = await jsonEach(client, `
    SELECT name FROM system.tables
    WHERE database = {db:String} AND name = 'ae_trend_row'
    LIMIT 1
  `, { db: database });
  if (existing.length > 0) {
    const viewport = await jsonEach(client, `
      SELECT name FROM system.columns
      WHERE database = {db:String} AND table = 'ae_trend_row' AND name = 'viewport_type'
      LIMIT 1
    `, { db: database });
    if (viewport.length === 0) {
      const counted = await jsonEach(client, `
        SELECT count() AS n FROM ${database}.ae_trend_row LIMIT 1
      `);
      if (Number(counted[0]?.n ?? 0) !== 0) {
        throw new Error('ae_trend_row has rows and no viewport_type; refusing to rebuild the sort key');
      }
      await client.command({ query: `DROP VIEW IF EXISTS ${database}.ae_trend_row_current` });
      await client.command({ query: `DROP TABLE IF EXISTS ${database}.ae_trend_row` });
    }
  }
  await ensureAeSchema(client, database);
}

/**
 * @param {import('@clickhouse/client').ClickHouseClient} client
 * @param {string} query
 * @param {Record<string, unknown>} [params]
 */
async function jsonEach(client, query, params = {}) {
  const res = await client.query({
    query,
    query_params: params,
    format: 'JSONEachRow',
    clickhouse_settings: { max_execution_time: 30 },
  });
  return res.json();
}
