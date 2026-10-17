/**
 * Readiness queries (R1–R13): site resolution, table freshness, coverage,
 * revenue trust, templates, checkout reconciliation, and matrix coverage.
 */

import { botPredicate, channelExpr, datePredicate, deviceExpr, returningExpr } from '../sql.js';
import { addDays } from '../windows.js';

/**
 * Tables whose freshness decides blocked vs partial.
 * Optional tables are reported and do not block the brand.
 */
export const FRESHNESS = [
  { id: 'log_visit', table: 'default.log_visit', dateCol: 'server_date', required: true },
  { id: 'log_hsr', table: 'default.log_hsr', dateCol: 'server_date', required: true },
  { id: 'log_hsr_event', table: 'default.log_hsr_event', dateCol: 'server_date', required: false },
  { id: 'log_conversion', table: 'default.log_conversion', dateCol: 'server_date', required: true },
  { id: 'conversion_item', table: 'default.conversion_item', dateCol: 'server_time', required: false },
  { id: 'journey_events_map', table: 'default.journey_events_map', dateCol: 'server_date', required: true },
  { id: 'journey_custom_map', table: 'default.journey_custom_map', dateCol: 'server_date', required: false },
  { id: 'session_tags', table: 'default.session_tags', dateCol: 'server_date', required: false },
  { id: 'partner_tags', table: 'default.partner_tags', dateCol: 'server_date', required: false },
  { id: 'udp_am_zones', table: 'default.udp_am_zones', dateCol: 'server_date', required: false },
  { id: 'udp_am_elements', table: 'default.udp_am_elements', dateCol: 'server_date', required: false },
  { id: 'page_speed_cache', table: 'journey_events.page_speed_cache', dateCol: 'fetched_at', required: false },
];

/**
 * @param {{idsite: number, name: string, domain: string}} brand
 * @param {import('./windows.js').auditWindows extends Function ? ReturnType<import('./windows.js').auditWindows> : object} windows
 * @param {Array<{idsite: number, pattern: string, template: string}>} [urlRules]
 */
export function readinessQueries(brand, windows, urlRules = []) {
  const idsite = brand.idsite || 0;
  const base = { idsite, start: windows.trendStart, end: windows.trendEnd };
  const snap = { idsite, start: windows.snapshotStart, end: windows.snapshotEnd };
  /** @type {Array<{id: string, label: string, sql: string, params: object}>} */
  const queries = [
    {
      id: 'R1',
      label: 'audit:R1',
      sql: `SELECT idsite, name, main_url, platform, currency, status
              FROM default.sites
             WHERE ({idsite:UInt32} > 0 AND idsite = {idsite:UInt32})
                OR positionCaseInsensitive(main_url, {domain:String}) > 0
                OR positionCaseInsensitive(name, {name:String}) > 0
             LIMIT 5`,
      params: { idsite, domain: brand.domain, name: brand.name },
    },
  ];

  for (const source of FRESHNESS) {
    const value = source.dateCol === 'server_date' ? `max(${source.dateCol})` : `toDate(max(${source.dateCol}))`;
    const bound = source.dateCol === 'server_date'
      ? 'server_date >= {fresh:Date} AND server_date <= today()'
      : `toDate(${source.dateCol}) >= {fresh:Date} AND toDate(${source.dateCol}) <= today()`;
    queries.push({
      id: `R2:${source.id}`,
      label: `audit:R2:${source.id}`,
      sql: `SELECT toString(if(count() = 0, NULL, ${value})) AS max_date
              FROM ${source.table}
             WHERE idsite = {idsite:UInt32}
               AND ${bound}`,
      params: { idsite, fresh: addDays(windows.yesterday, -1) },
    });
  }

  queries.push(
    {
      id: 'R3',
      label: 'audit:R3',
      sql: `SELECT toString(server_date) AS day, uniqExact(idvisit) AS sessions
              FROM default.log_visit
             WHERE idsite = {idsite:UInt32}
               AND ${datePredicate('default.log_visit').replaceAll('default.log_visit.', '')}
               AND ${botPredicate()}
             GROUP BY server_date
             ORDER BY day`,
      params: base,
    },
    {
      id: 'R4',
      label: 'audit:R4',
      sql: `SELECT count() AS orders,
                   countIf(revenue IS NULL OR revenue = 0) AS zero_revenue,
                   uniqExact(idorder) AS distinct_orders
              FROM default.log_conversion FINAL
             WHERE idsite = {idsite:UInt32}
               AND server_date BETWEEN {start:Date} AND {end:Date}
               AND server_date <= today()`,
      params: base,
    },
    {
      id: 'R4unmatched',
      label: 'audit:R4:unmatched',
      sql: `SELECT count() AS orders,
                   countIf(v.seen = 0) AS unmatched
              FROM default.log_conversion AS c FINAL
              LEFT JOIN (
                SELECT CAST(idvisit AS UInt64) AS idvisit, toUInt8(1) AS seen
                  FROM default.log_visit
                 WHERE idsite = {idsite:UInt32}
                   AND ${datePredicate('default.log_visit').replaceAll('default.log_visit.', '')}
                 GROUP BY idvisit
              ) AS v ON v.idvisit = CAST(c.idvisit AS UInt64)
             WHERE c.idsite = {idsite:UInt32}
               AND c.server_date BETWEEN {start:Date} AND {end:Date}
               AND c.server_date <= today()`,
      params: base,
    },
    {
      id: 'R5pages',
      label: 'audit:R5:pages',
      sql: `SELECT toString(idsitehsr) AS idsitehsr, count() AS pageviews
              FROM default.log_hsr
             WHERE idsite = {idsite:UInt32}
               AND server_date BETWEEN {start:Date} AND {end:Date}
               AND server_date <= today()
             GROUP BY idsitehsr`,
      params: snap,
    },
    {
      id: 'R5urls',
      label: 'audit:R5:urls',
      sql: `SELECT toString(idsitehsr) AS idsitehsr, any(screenshot_url) AS url
              FROM default.site_hsr
             WHERE idsite = {idsite:UInt32}
             GROUP BY idsitehsr`,
      params: { idsite },
    },
    {
      id: 'R6',
      label: 'audit:R6',
      sql: `SELECT event_type, uniqExact(idvisit) AS sessions
              FROM default.journey_events_map
             WHERE idsite = {idsite:UInt32}
               AND server_date BETWEEN {start:Date} AND {end:Date}
               AND server_date <= today()
             GROUP BY event_type`,
      params: base,
    },
    {
      id: 'R7',
      label: 'audit:R7',
      sql: `SELECT toString(min(server_date)) AS first_date,
                   uniqExact(idsitehsr) AS pages,
                   count() AS elements
              FROM default.udp_am_elements
             WHERE idsite = {idsite:UInt32}
               AND server_date >= {start:Date}
               AND server_date <= today()`,
      params: { idsite, start: windows.extendedStart },
    },
    {
      id: 'R8',
      label: 'audit:R8',
      sql: `SELECT ${deviceExpr('v')} AS device,
                   ${returningExpr('v')} AS returning,
                   ${channelExpr('v')} AS channel,
                   uniqExact(v.idvisit) AS sessions,
                   uniqExactIf(v.idvisit, c.orders > 0) AS buyers
              FROM default.log_visit AS v
              LEFT JOIN (
                SELECT CAST(idvisit AS UInt64) AS idvisit, count() AS orders
                  FROM default.log_conversion FINAL
                 WHERE idsite = {idsite:UInt32}
                   AND server_date BETWEEN {start:Date} AND {end:Date}
                   AND server_date <= today()
                 GROUP BY idvisit
              ) AS c ON c.idvisit = CAST(v.idvisit AS UInt64)
             WHERE v.idsite = {idsite:UInt32}
               AND ${datePredicate('v')}
               AND ${botPredicate('v')}
             GROUP BY device, returning, channel`,
      params: snap,
    },
    {
      id: 'R10',
      label: 'audit:R10',
      sql: `SELECT toString(toStartOfWeek(server_date, 1)) AS week,
                   count() AS sessions_raw,
                   countIf(${botPredicate()}) AS sessions_kept
              FROM default.log_visit
             WHERE idsite = {idsite:UInt32}
               AND server_date BETWEEN {start:Date} AND {end:Date}
               AND server_date <= today()
             GROUP BY week
             ORDER BY week`,
      params: base,
    },
    {
      id: 'R11',
      label: 'audit:R11',
      sql: `SELECT toString(toStartOfWeek(server_date, 1)) AS week,
                   uniqExact(partner) AS partners,
                   uniqExact(experience_id) AS experiences,
                   uniqExact(variant_id) AS variants
              FROM default.partner_tags
             WHERE idsite = {idsite:UInt32}
               AND server_date BETWEEN {start:Date} AND {end:Date}
               AND server_date <= today()
             GROUP BY week
             ORDER BY week`,
      params: base,
    },
    {
      id: 'R12',
      label: 'audit:R12',
      sql: `SELECT toString(event_id) AS event_id, count() AS events
              FROM default.journey_custom_map
             WHERE idsite = {idsite:UInt32}
               AND server_date BETWEEN {start:Date} AND {end:Date}
               AND server_date <= today()
             GROUP BY event_id
             ORDER BY events DESC
             LIMIT 50`,
      params: base,
    },
    {
      id: 'R13',
      label: 'audit:R13',
      sql: `SELECT count() AS rows
              FROM journey_events.page_speed_cache
             WHERE idsite = {idsite:UInt32}
               AND toDate(fetched_at) BETWEEN {start:Date} AND {end:Date}`,
      params: snap,
    },
  );

  // R9 is added by the collector when the matrix has live selectors.
  void urlRules;
  return queries;
}

/**
 * Click-match query. Empty string when the matrix has no live selectors,
 * which skips the scan.
 * @param {number} idsite
 * @param {object} windows
 * @param {object[]} entries
 */
export function matrixCoverageQuery(idsite, windows, entries) {
  const live = entries.filter((e) => e.idsite === idsite && !e.absent && e.selector_match);
  if (live.length === 0 || idsite <= 0) return null;
  return {
    id: 'R9',
    label: 'audit:R9',
    sql: `WITH ${matrixCte(live)}
          SELECT count() AS clicks,
                 countIf(m.element_class != '') AS matched
            FROM default.log_hsr_event AS e
            INNER JOIN default.log_visit AS v
              ON v.idsite = e.idsite
             AND CAST(v.idvisit AS UInt64) = CAST(e.idvisit AS UInt64)
             AND ${datePredicate('v')}
            LEFT JOIN element_matrix AS m
              ON m.idsite = e.idsite
             AND match(e.selector, m.selector_match)
             AND e.server_date BETWEEN m.valid_from AND m.valid_to
           WHERE e.idsite = {idsite:UInt32}
             AND e.server_date BETWEEN {start:Date} AND {end:Date}
             AND e.server_date <= today()
             AND e.event_type = 2
             AND ${botPredicate('v')}`,
    params: { idsite, start: windows.snapshotStart, end: windows.snapshotEnd },
  };
}

/** @param {object[]} live */
function matrixCte(live) {
  const tuples = live.map((e) => `(${Number(e.idsite)}, ${sqlString(e.selector_match)}, ${sqlString(e.element_class)}, toDate(${sqlString(e.valid_from)}), toDate(${sqlString(e.valid_to)}))`);
  return `element_matrix AS (
    SELECT idsite, selector_match, element_class, valid_from, valid_to
    FROM VALUES(
      'idsite UInt32, selector_match String, element_class String, valid_from Date, valid_to Date',
      ${tuples.join(', ')}
    )
  )`;
}

/** @param {string} value */
function sqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}
