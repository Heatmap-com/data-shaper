/**
 * QueryGateway over a ClickHouse client. The gateway binds parameters, logs
 * label, rows, and seconds, memoizes system.columns notes, and refuses a
 * fact-table query that does not carry the {idsite} parameter. The bot-flag
 * rule (c) fleet scan is the sanctioned exception: labels starting with
 * `fleet:` skip the guard by design and are obvious in logs. Labels starting
 * with `audit:`, `trend:`, `experiment:`, or `shape:` also refuse a joined fact table
 * whose server_date or idsite is unconstrained, and whose idsitehsr is
 * unconstrained when that parameter is set.
 */

import { attachConnectionRetry } from '../../connection-retry.js';
import { queryBoundGaps } from '../../governance/query-bounds.js';

/** The database the ae_* tables live in when composition names none. */
export const DEFAULT_DATABASE = 'disp';

/**
 * The configured application database. CLICKHOUSE_DATABASE overrides the
 * default. The name is an identifier, so a value that is not one is refused
 * before it can be interpolated into SQL.
 * @param {NodeJS.ProcessEnv} [env]
 */
export function configuredDatabase(env = process.env) {
  const name = env.CLICKHOUSE_DATABASE || DEFAULT_DATABASE;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`CLICKHOUSE_DATABASE is not an identifier: ${name}`);
  }
  return name;
}

const FACT_TABLE_RE =
  /\b(default\.)?(udp_hsrce_visits|udp_hsrce_pageviews|udp_clicksce_clicks|udp_conversions|udp_session_tags|udp_partner_tags|udp_custom_events|udp_am_elements|udp_am_zones|udp_conversion_product_items|journey_events_map|journey_custom_map|log_visit|log_hsr_event|log_hsr\b|log_conversion|conversion_item|session_tags|partner_tags|section_level_data)\b/i;

// Schema-2 fact tables: ae_src_* plus the ae_ analysis and state tables that
// hold per-site data. Queues (ae_site_queue, ae_page_target, ae_capture_queue),
// batch/version bookkeeping (ae_batch, ae_schema_version, ae_ingest_run) and
// the reference tables (ae_requirement, ae_strategy_catalog,
// ae_strategy_crosswalk, ae_screen_rule) are exempt, same as the v1 queues:
// the runner may scan them fleet-wide.
/**
 * @param {string} database
 */
export function aeFactTableRe(database) {
  return new RegExp(
  `\\b${database.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.ae_(src_\\w+|dataset_row|analysis_checkpoint|trend_row|experiment_row|experiment_descriptor|session_tag_trend|session_tag_selection|traffic_exclusion_model|requirement_status|strategy_card|page_analysis|site_analysis|element_binding|page_render|render_node|page_capture|page_descriptor|store_descriptor|tool_registry|change_log|source_connection|experiment|review_verdict|trigger_hit|trigger_chain)\\b`,
  'i',
  );
}

/**
 * QueryGateway over the shared client. See the port typedef for the contract.
 * @param {object} client
 * @param {{logger: object, telemetry?: import('../../ports/telemetry.js').Telemetry | null, database?: string}} opts
 */
export function createGateway(client, { logger, telemetry = null, database = DEFAULT_DATABASE }) {
  client = attachConnectionRetry(client, logger);
  const aeFactTable = aeFactTableRe(database);
  /** @type {Map<string, Promise<Array<{name: string, type: string}>>>} */
  const columnCache = new Map();

  async function runQuery(sql, params, label, { command = false } = {}) {
    if (
      !label.startsWith('fleet:') &&
      (FACT_TABLE_RE.test(sql) || aeFactTable.test(sql)) &&
      !sql.includes('{idsite:')
    ) {
      throw new Error(
        `gateway refused query "${label}": fact-table queries must carry the {{idsite:...}} parameter (one site per query)`,
      );
    }
    if (['audit:', 'trend:', 'experiment:', 'shape:'].some((prefix) => label.startsWith(prefix))) {
      const gaps = queryBoundGaps(sql, { idsitehsr: params?.idsitehsr != null });
      if (gaps.length > 0) {
        throw new Error(`gateway refused query "${label}": missing bounds ${gaps.join(', ')}`);
      }
    }
    const t0 = Date.now();
    const clickhouse_settings = label.startsWith('audit:') ? { max_execution_time: 180 } : undefined;
    try {
      const res = command
        ? await client.command({ query: sql, query_params: params, ...(clickhouse_settings ? { clickhouse_settings } : {}) })
        : await client.query({
          query: sql,
          query_params: params,
          format: 'JSONEachRow',
          ...(clickhouse_settings ? { clickhouse_settings } : {}),
        });
      const durationMs = Date.now() - t0;
      const rows = command ? [] : await res.json();
      logger.info({ label, rows: rows.length, seconds: Number((durationMs / 1000).toFixed(2)) }, 'query');
      telemetry?.emit({
        name: 'query',
        durationMs,
        ok: true,
        attrs: { label, rows: rows.length, idsite: params?.idsite ?? null },
      });
      return rows;
    } catch (err) {
      const durationMs = Date.now() - t0;
      const error = err instanceof Error ? err.message : String(err);
      telemetry?.emit({
        name: 'query',
        durationMs,
        ok: false,
        attrs: { label, idsite: params?.idsite ?? null, error },
      });
      throw err;
    }
  }

  return {
    async query(sql, params = {}, label = 'query') {
      return runQuery(sql, params, label);
    },

    async explain(sql, params, label = 'explain') {
      const rows = await runQuery(`EXPLAIN ${sql}`, params, label);
      return JSON.stringify(rows, null, 2);
    },

    /** @param {string} table */
    columns(table) {
      if (!columnCache.has(table)) {
        columnCache.set(
          table,
          runQuery(
            `SELECT name, type FROM system.columns WHERE database = 'default' AND table = {table:String}`,
            { table },
            `columns:${table}`,
          ),
        );
      }
      return columnCache.get(table);
    },
  };
}

export const adapter = {
  id: 'clickhouse',
  /** @param {object} client @param {{logger: object, telemetry?: object | null, database?: string}} opts */
  create: (client, opts) => createGateway(client, opts),
};
