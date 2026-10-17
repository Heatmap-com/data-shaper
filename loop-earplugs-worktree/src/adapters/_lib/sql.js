/**
 * Shared SQL builders for qualifier and dataset adapters.
 *
 * The shapes port the extract-3 session stream and the landing-page extract:
 * one idsite per query, server_date bounded on every fact table, entry page
 * by argMin(visit_entry_idaction_url, visit_first_action_time), orders
 * deduplicated to one row per (idvisit, idorder) from udp_conversions FINAL.
 *
 * Every query takes {idsite, w0, w1} params. w0/w1 are the batch window as
 * YYYY-MM-DD strings; the gateway binds them as Date.
 */

export const RETURNING_ERA_SPLIT = '2026-09-07';
export const TIME_ON_PAGE_CAP_MS = 1800000; // 1,800 seconds, the extract-2 cap
export const SUB_5S_MS = 5000;

export const FP_HASH_PARTS =
  'location_country, location_city, config_resolution, config_browser_name, config_browser_version, toString(device_type)';

/**
 * cityHash64 of the fingerprint dimensions. Pass the visits alias when the
 * expression sits outside the visits CTE.
 * @param {string} [alias]
 */
export function fpHashExpr(alias = '') {
  const p = alias ? `${alias}.` : '';
  return `cityHash64(${p}location_country, ${p}location_city, ${p}config_resolution, ${p}config_browser_name, ${p}config_browser_version, toString(${p}device_type))`;
}

export const FP_HASH_EXPR = fpHashExpr();

/**
 * The same fingerprint hash as fpHashExpr(), computed inside a
 * GROUP BY idsite, idvisit over udp_hsrce_visits. Uses argMin on
 * visit_first_action_time so a visit with more than one row hashes the
 * earliest row, matching the visits CTE.
 */
export function fpHashOfVisit() {
  return `cityHash64(
    trim(toString(argMin(location_country, visit_first_action_time))),
    trim(toString(argMin(location_city, visit_first_action_time))),
    trim(toString(argMin(config_resolution, visit_first_action_time))),
    trim(toString(argMin(config_browser_name, visit_first_action_time))),
    trim(toString(argMin(config_browser_version, visit_first_action_time))),
    toString(toUInt8(argMin(config_device_type, visit_first_action_time)))
  )`;
}

/**
 * The session's UTMs. The tag attaches them to the session as session tags:
 * udp_session_tags.session_tags, a JSON object on the session's pageview
 * rows. The visit's custom variables (custom_var_k5 source, custom_var_v1
 * medium, custom_var_v4 campaign) hold them too, for fewer sessions. A tag
 * value wins, and the custom variable fills a key the tags leave empty.
 *
 * A tag value is the session's first non-empty one in idloghsr order, its
 * key matched without case. Source and medium are lowercased; all three are
 * trimmed, as the custom variables are.
 */
const UTM_TAG_KEYS = Object.freeze([
  ['utm_source', (value) => `lower(trim(${value}))`],
  ['utm_medium', (value) => `lower(trim(${value}))`],
  ['utm_campaign', (value) => `trim(${value})`],
]);

/** The UTM columns a session carries. */
export const UTM_COLUMNS = Object.freeze(UTM_TAG_KEYS.map(([key]) => key));

/**
 * A CTE of the session-tag UTMs: one row per `keys` group, with utm_source,
 * utm_medium, and utm_campaign, each '' when no tag set holds it.
 * @param {string} name
 * @param {{keys: Array<[string, string]>, idsite?: string, from?: string, to?: string, and?: string}} opts
 *   `keys` are [alias, expression over udp_session_tags] pairs, the CTE's
 *   group. `idsite` is the comparison that bounds idsite, `from` and `to`
 *   the server_date bounds, and `and` any further ` AND ...` predicate
 */
export function tagUtmCte(name, { keys, idsite = '= {idsite:UInt32}', from = '{w0:Date}', to = '{w1:Date}', and = '' }) {
  const group = keys.map(([alias]) => alias).join(', ');
  const rowKeys = keys.map(([alias, expr]) => `${expr} AS ${alias}`).join(', ');
  const picked = UTM_COLUMNS.map((key) => `argMinIf(tag_${key}, tag_row, tag_${key} != '') AS ${key}`).join(',\n           ');
  const extracted = UTM_TAG_KEYS.map(([key, normalize]) => `${normalize(`arrayFirst(kv -> lower(kv.1) = '${key}', tag_pairs).2`)} AS tag_${key}`).join(',\n               ');
  return `
${name} AS (
    SELECT ${group},
           ${picked}
    FROM (
        SELECT ${rowKeys},
               toUInt64(idloghsr) AS tag_row,
               JSONExtractKeysAndValues(session_tags, 'String') AS tag_pairs,
               ${extracted}
        FROM default.udp_session_tags
        WHERE idsite ${idsite} AND server_date BETWEEN ${from} AND ${to}${and}
          AND session_tags NOT IN ('{}', '')
    )
    GROUP BY ${group}
)`;
}

/**
 * The session's value of one UTM column: the tag CTE's value when it is not
 * empty, else the custom-variable value. Reads '' for a session the tag CTE
 * has no row for, whatever join_use_nulls is.
 * @param {string} key one of UTM_COLUMNS
 * @param {string} tags the tag CTE's alias
 * @param {string} fallback the custom-variable expression
 */
export function sessionUtmSql(key, tags, fallback) {
  return `if(ifNull(${tags}.${key}, '') != '', ${tags}.${key}, ${fallback})`;
}

/**
 * @param {string} [site] the comparison that bounds idsite; the default
 * scopes to one site, and a fleet scan passes an idsite range.
 */
export function visitsCte(site = '= {idsite:UInt32}') {
  const tags = tagUtmCte('visit_tags', { keys: [['idsite', 'CAST(idsite AS UInt32)'], ['idvisit', 'CAST(idvisit AS UInt64)']], idsite: site });
  return `${tags},
visit_rows AS (
    SELECT CAST(idsite AS UInt32) AS idsite,
           CAST(idvisit AS UInt64) AS idvisit,
           min(server_date) AS first_date,
           toMonday(min(server_date)) AS week_start,
           toUInt8(argMin(config_device_type, visit_first_action_time)) AS device_type,
           toInt32(argMin(referer_type, visit_first_action_time)) AS referer_type,
           toUInt8(ifNull(argMin(visitor_returning, visit_first_action_time), false)) AS visitor_returning,
           trim(toString(argMin(location_country, visit_first_action_time))) AS location_country,
           trim(toString(argMin(location_city, visit_first_action_time))) AS location_city,
           trim(toString(argMin(config_resolution, visit_first_action_time))) AS config_resolution,
           trim(toString(argMin(config_browser_name, visit_first_action_time))) AS config_browser_name,
           trim(toString(argMin(config_browser_version, visit_first_action_time))) AS config_browser_version,
           toString(argMin(visit_entry_idaction_url, visit_first_action_time)) AS entry_hsr,
           lower(trim(toString(argMin(custom_var_k5, visit_first_action_time)))) AS utm_source
    FROM default.udp_hsrce_visits
    WHERE idsite ${site} AND server_date BETWEEN {w0:Date} AND {w1:Date}
    GROUP BY idsite, idvisit
),
visits AS (
    SELECT r.* REPLACE (${sessionUtmSql('utm_source', 't', 'r.utm_source')} AS utm_source)
    FROM visit_rows AS r
    LEFT JOIN visit_tags AS t ON t.idsite = r.idsite AND t.idvisit = r.idvisit
)`;
}

export const VISITS_CTE = visitsCte();

export const EVENTS_CTE = `
events AS (
    SELECT CAST(idsite AS UInt32) AS idsite,
           CAST(idvisit AS UInt64) AS idvisit,
           max(event_type = 'product_viewed') AS saw_product,
           max(event_type = 'add_to_cart') AS saw_atc,
           max(event_type = 'checkout_started') AS saw_checkout,
           max(event_type = 'checkout_completed') AS saw_purchase
    FROM default.journey_events_map
    WHERE idsite = {idsite:UInt32} AND server_date BETWEEN {w0:Date} AND {w1:Date}
      AND event_type IN ('product_viewed', 'add_to_cart', 'checkout_started', 'checkout_completed')
    GROUP BY idsite, idvisit
)`;

/**
 * Orders per visit from udp_conversions, one row per order (FINAL, then
 * max(revenue) per idorder). The audit's conversionCte (src/audit/sql.js)
 * reads log_conversion instead and counts conversion rows: the audit is
 * checking the tracker's own conversion log, and these datasets the
 * deduplicated order feed. The two differ on purpose; do not merge them.
 */
export const ORDERS_CTE = `
orders AS (
    SELECT CAST(idvisit AS UInt64) AS idvisit,
           uniqExact(idorder) AS orders_udp,
           sum(revenue) AS revenue_udp
    FROM (
        SELECT idvisit, idorder, max(revenue) AS revenue
        FROM default.udp_conversions FINAL
        WHERE idsite = {idsite:UInt32} AND server_date BETWEEN {w0:Date} AND {w1:Date}
        GROUP BY idvisit, idorder
    )
    GROUP BY idvisit
)`;

/**
 * Orders CTE for fleet scans: the ORDERS_CTE dedup shape (one row per
 * (idsite, idvisit, idorder) via max(revenue), aggregated per
 * (idsite, idvisit)) with an idsite-range predicate and idsite retained for
 * the per-site zero-order count. Deliberately non-FINAL: the same dedup
 * without the merge, because a range scan over udp_conversions FINAL blows
 * the server's memory limit on 30-day windows.
 * @param {string} [pred]
 */
export function ordersBySiteCte(pred = 'idsite = {idsite:UInt32}') {
  return `
orders AS (
    SELECT CAST(idsite AS UInt32) AS idsite,
           CAST(idvisit AS UInt64) AS idvisit,
           uniqExact(idorder) AS orders_udp,
           sum(revenue) AS revenue_udp
    FROM (
        SELECT idsite, idvisit, idorder, max(revenue) AS revenue
        FROM default.udp_conversions
        WHERE ${pred} AND server_date BETWEEN {w0:Date} AND {w1:Date}
        GROUP BY idsite, idvisit, idorder
    )
    GROUP BY idsite, idvisit
)`;
}

export const ORDERS_BY_SITE_CTE = ordersBySiteCte();

/**
 * Visits whose entry page is {hsr} in the window, with idvisit as UInt64
 * so it joins the click, pageview, and order CTEs directly.
 */
export const ENTRY_VISITS_CTE = `
entry AS (
    SELECT CAST(idvisit AS UInt64) AS idvisit
    FROM (
        SELECT idvisit, toString(argMin(visit_entry_idaction_url, visit_first_action_time)) AS entry_hsr
        FROM default.udp_hsrce_visits
        WHERE idsite = {idsite:UInt32} AND server_date BETWEEN {w0:Date} AND {w1:Date}
        GROUP BY idvisit
    )
    WHERE entry_hsr = {hsr:String}
)`;

/**
 * The visits that entered or viewed {idsitehsr} in the window, as a
 * subquery for `CAST(idvisit AS UInt64) IN ${PAGE_VISITS}`. It holds every
 * page entry session and every session that viewed the page, so a per-page
 * load restricted to it keeps all of those sessions' window rows.
 * Parameters: {idsite:UInt32}, {idsitehsr:UInt64}, {w0:Date}, {w1:Date}.
 */
export const PAGE_VISITS = `(
    SELECT CAST(idvisit AS UInt64)
    FROM default.udp_hsrce_visits
    WHERE idsite = {idsite:UInt32} AND server_date BETWEEN {w0:Date} AND {w1:Date}
      AND visit_entry_idaction_url = toString({idsitehsr:UInt64})
    UNION DISTINCT
    SELECT CAST(idvisit AS UInt64)
    FROM default.udp_hsrce_pageviews
    WHERE idsite = {idsite:UInt32} AND server_date BETWEEN {w0:Date} AND {w1:Date}
      AND idsitehsr = {idsitehsr:UInt64}
)`;

export const PAGES_CTE = `
pages AS (
    SELECT CAST(idvisit AS UInt64) AS idvisit,
           count() AS pageviews,
           sum(least(toUInt64(ifNull(time_on_page, 0)), ${TIME_ON_PAGE_CAP_MS})) AS capped_ms
    FROM default.udp_hsrce_pageviews
    WHERE idsite = {idsite:UInt32} AND server_date BETWEEN {w0:Date} AND {w1:Date}
    GROUP BY idvisit
)`;

export const SCROLL_CTE = `
scroll AS (
    SELECT CAST(idvisit AS UInt64) AS idvisit,
           max(ifNull(scroll_y_max_relative, 0)) AS scroll_max,
           count() AS landing_pageviews,
           sum(least(toUInt64(ifNull(time_on_page, 0)), ${TIME_ON_PAGE_CAP_MS})) AS page_capped_ms
    FROM default.udp_hsrce_pageviews
    WHERE idsite = {idsite:UInt32} AND idsitehsr = {idsitehsr:UInt64}
      AND server_date BETWEEN {w0:Date} AND {w1:Date}
    GROUP BY idvisit
)`;

/** @param {{w0: string, w1: string, idsite: number}} params */
export function windowParams(params) {
  return { w0: params.w0, w1: params.w1, idsite: params.idsite };
}

/**
 * Monday weeks covered by a window, as YYYY-MM-DD strings. A window can span
 * two Monday weeks (e.g. Thursday to Wednesday).
 * @param {string} w0 @param {string} w1
 * @returns {string[]}
 */
export function mondayWeeks(w0, w1) {
  const weeks = [];
  const d = new Date(`${w0}T00:00:00Z`);
  const end = new Date(`${w1}T00:00:00Z`);
  const day = (d.getUTCDay() + 6) % 7; // Monday = 0
  d.setUTCDate(d.getUTCDate() - day);
  while (d <= end) {
    weeks.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 7);
  }
  return weeks;
}

/** @param {string} firstDate YYYY-MM-DD */
export function returningEra(firstDate) {
  return firstDate < RETURNING_ERA_SPLIT ? 'pre_2026_09_07' : 'post_2026_09_07';
}

/**
 * A Monday week is full when all seven of its days lie inside the window.
 * Partial weeks stay in dataset rows but are excluded from trigger rows.
 * @param {string} monday @param {string} w0 @param {string} w1
 */
export function isFullWeek(monday, w0, w1) {
  const start = new Date(`${monday}T00:00:00Z`);
  const end = new Date(`${monday}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() + 6);
  return start >= new Date(`${w0}T00:00:00Z`) && end <= new Date(`${w1}T00:00:00Z`);
}
