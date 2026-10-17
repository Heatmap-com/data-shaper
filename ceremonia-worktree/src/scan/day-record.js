import { TIME_ON_PAGE_CAP_MS, UTM_COLUMNS, fpHashOfVisit, tagUtmCte } from '../adapters/_lib/sql.js';

/** The events the session stream turns into funnel flags. */
export const SESSION_EVENTS = Object.freeze(['product_viewed', 'add_to_cart', 'checkout_started', 'checkout_completed']);

const ON_DAY = 'idsite = {idsite:UInt32} AND server_date = {day:Date}';
const ON_RANGE = 'idsite = {idsite:UInt32} AND server_date BETWEEN {start:Date} AND {end:Date}';

/** The rows a query reads: one day, or the spread visits' rows over the range. */
function scopeOf(spread) {
  return {
    on: (id = 'idvisit') => (spread ? `${ON_RANGE} AND CAST(${id} AS UInt64) IN {visits:Array(UInt64)}` : ON_DAY),
    key: spread ? 'idvisit, server_date' : 'idvisit',
    day: spread ? ', toString(server_date) AS day' : '',
  };
}

/**
 * One row per visit with any fact on one site and one server_date. Each
 * column is the day's share of a per-visit reduction the session stream or
 * the trigger facts compute over a window, so a visit's days merge back to
 * the window value (see open-visits.js). The visit columns are the day's
 * earliest row by visit_first_action_time; `has_visit` is 0 when the visit
 * has facts that day and no visit row. utm_* are the visit's custom
 * variables and tag_utm_* the day's session tags (tagUtmCte); the scan
 * keeps a visit's first tag value and reads it before the custom variable
 * (see views.js).
 *
 * With `partnerTags`, an `arms` column carries the visit's A/B arms that
 * day as (Monday week, experience, variant); udp_partner_tags keeps the
 * visit id in its idloghsr column. Sites without the table leave it off.
 *
 * With `spread`, the query reads the listed visits over a range instead of
 * every visit on one day, and returns one row per visit and day with a
 * `day` column (see spreadVisitsSql).
 *
 * Parameters: {idsite:UInt32}, {day:Date}, {events:Array(String)}; with
 * `spread`, {start:Date}, {end:Date}, {visits:Array(UInt64)} for {day}.
 * @param {{partnerTags?: boolean, spread?: boolean}} [opts]
 */
export function daySql({ partnerTags = false, spread = false } = {}) {
  const { on, key, day } = scopeOf(spread);
  const join = (alias) => `LEFT JOIN ${alias} ON ${alias}.idvisit = s.idvisit${spread ? ` AND ${alias}.day = s.day` : ''}`;
  return `
WITH
v AS (
    SELECT CAST(idvisit AS UInt64) AS idvisit${day},
           1 AS has_visit,
           toString(min(visit_first_action_time)) AS started_at,
           ifNull(toString(argMin(config_id, visit_first_action_time)), '') AS config_id,
           toUInt8(argMin(config_device_type, visit_first_action_time)) AS device_type,
           toInt32(argMin(referer_type, visit_first_action_time)) AS referer_type,
           toUInt8(ifNull(argMin(visitor_returning, visit_first_action_time), false)) AS visitor_returning,
           trim(toString(argMin(location_country, visit_first_action_time))) AS country,
           trim(toString(argMin(config_browser_name, visit_first_action_time))) AS browser,
           toString(argMin(visit_entry_idaction_url, visit_first_action_time)) AS entry_hsr,
           lower(trim(toString(argMin(custom_var_k5, visit_first_action_time)))) AS utm_source,
           trim(toString(argMin(referer_name, visit_first_action_time))) AS ref_name,
           ifNull(lower(trim(toString(argMin(custom_var_v1, visit_first_action_time)))), '') AS utm_medium,
           ifNull(trim(toString(argMin(custom_var_v4, visit_first_action_time))), '') AS utm_campaign,
           toString(${fpHashOfVisit()}) AS fp_hash
    FROM default.udp_hsrce_visits
    WHERE ${on()}
    GROUP BY ${key}
),
p AS (
    SELECT CAST(idvisit AS UInt64) AS idvisit${day},
           count() AS pageview_rows,
           groupUniqArray(toString(idsitehsr)) AS hsrs,
           sum(least(toUInt64(ifNull(time_on_page, 0)), ${TIME_ON_PAGE_CAP_MS})) AS capped_ms,
           max(ifNull(scroll_y_max_relative, 0)) AS scroll_max,
           arraySlice(arraySort(groupArray((toString(server_time), toUInt64(idloghsr), toString(idsitehsr)))), 1, 2) AS first_pages
    FROM default.udp_hsrce_pageviews
    WHERE ${on()}
    GROUP BY ${key}
),
e AS (
    SELECT CAST(idvisit AS UInt64) AS idvisit${day},
           groupUniqArray(event_type) AS events
    FROM default.journey_events_map
    WHERE ${on()} AND event_type IN {events:Array(String)}
    GROUP BY ${key}
),
o AS (
    SELECT CAST(idvisit AS UInt64) AS idvisit${day},
           groupArray((toString(idorder), revenue)) AS orders
    FROM (
        SELECT idvisit, ${spread ? 'server_date, ' : ''}idorder, max(revenue) AS revenue
        FROM default.udp_conversions FINAL
        WHERE ${on()}
        GROUP BY idvisit, ${spread ? 'server_date, ' : ''}idorder
    )
    GROUP BY ${key}
),
c AS (
    SELECT CAST(idvisit AS UInt64) AS idvisit${day}, count() AS clicks
    FROM default.udp_clicksce_clicks
    WHERE ${on()}
    GROUP BY ${key}
),
t AS (
    SELECT CAST(idvisit AS UInt64) AS idvisit${day}, min(session_tags) AS tags
    FROM default.udp_session_tags
    WHERE ${on()} AND session_tags NOT IN ('{}', '')
    GROUP BY ${key}
),${tagUtmCte('tu', spread
    ? { keys: [['idvisit', 'CAST(idvisit AS UInt64)'], ['day', 'toString(server_date)']], from: '{start:Date}', to: '{end:Date}', and: ' AND CAST(idvisit AS UInt64) IN {visits:Array(UInt64)}' }
    : { keys: [['idvisit', 'CAST(idvisit AS UInt64)']], from: '{day:Date}', to: '{day:Date}' })},${partnerTags ? `
pt AS (
    SELECT CAST(idloghsr AS UInt64) AS idvisit${day},
           groupUniqArray((toString(toMonday(server_date)), toString(experience_id), toString(variant_id))) AS arms
    FROM default.udp_partner_tags
    WHERE ${on('idloghsr')}
    GROUP BY ${key}
),` : ''}
spine AS (
    SELECT ${spread ? 'idvisit, day' : 'idvisit'} FROM v
    UNION DISTINCT SELECT ${spread ? 'idvisit, day' : 'idvisit'} FROM p
    UNION DISTINCT SELECT ${spread ? 'idvisit, day' : 'idvisit'} FROM e
    UNION DISTINCT SELECT ${spread ? 'idvisit, day' : 'idvisit'} FROM o
    UNION DISTINCT SELECT ${spread ? 'idvisit, day' : 'idvisit'} FROM c
    UNION DISTINCT SELECT ${spread ? 'idvisit, day' : 'idvisit'} FROM t${partnerTags ? `
    UNION DISTINCT SELECT ${spread ? 'idvisit, day' : 'idvisit'} FROM pt` : ''}
)
SELECT
    toString(s.idvisit) AS idvisit,${spread ? `
    s.day AS day,` : ''}
    v.has_visit AS has_visit,
    v.started_at AS started_at,
    v.config_id AS config_id,
    v.device_type AS device,
    v.referer_type AS referer,
    v.visitor_returning AS returning,
    v.country AS country,
    v.browser AS browser,
    v.entry_hsr AS entry_hsr,
    v.utm_source AS utm_source,
    v.ref_name AS referer_name,
    v.utm_medium AS utm_medium,
    v.utm_campaign AS utm_campaign,
    ${UTM_COLUMNS.map((key) => `ifNull(tu.${key}, '') AS tag_${key}`).join(',\n    ')},
    v.fp_hash AS fp_hash,
    p.pageview_rows AS pageview_rows,
    p.hsrs AS hsrs,
    p.capped_ms AS capped_ms,
    p.scroll_max AS scroll_max,
    p.first_pages AS first_pages,
    e.events AS events,
    o.orders AS orders,
    c.clicks AS clicks,
    t.tags AS tags${partnerTags ? `,
    pt.arms AS arms` : ''}
FROM spine s
${['v', 'p', 'e', 'o', 'c', 't', 'tu', ...(partnerTags ? ['pt'] : [])].map(join).join('\n')}
SETTINGS join_use_nulls = 0
`;
}

/**
 * The visits on one site whose row days, over [start, end], are more than
 * `hold` days apart. The day scan closes a visit after `hold` quiet days,
 * so it reads these visits' rows ahead, over the range (daySql with
 * `spread`), and merges each one whole the first day it appears. The rows
 * are the facts that make a day record: the same tables and filters.
 * Parameters: {idsite:UInt32}, {start:Date}, {end:Date}, {events:Array(String)}, {hold:UInt32}.
 * @param {{partnerTags?: boolean}} [opts]
 */
export function spreadVisitsSql({ partnerTags = false } = {}) {
  const day = (id, table, extra = '') => `SELECT CAST(${id} AS UInt64) AS idvisit, toUInt32(server_date) AS d
        FROM ${table}
        WHERE ${ON_RANGE}${extra}`;
  const parts = [
    day('idvisit', 'default.udp_hsrce_visits'),
    day('idvisit', 'default.udp_hsrce_pageviews'),
    day('idvisit', 'default.journey_events_map', ' AND event_type IN {events:Array(String)}'),
    day('idvisit', 'default.udp_conversions FINAL'),
    day('idvisit', 'default.udp_clicksce_clicks'),
    day('idvisit', 'default.udp_session_tags', " AND session_tags NOT IN ('{}', '')"),
    ...(partnerTags ? [day('idloghsr', 'default.udp_partner_tags')] : []),
  ];
  return `
SELECT toString(idvisit) AS idvisit
FROM (
        ${parts.join('\n        UNION ALL\n        ')}
)
GROUP BY idvisit
HAVING arrayMax(arrayDifference(arraySort(groupUniqArray(d)))) > {hold:UInt32}
`;
}

/**
 * Per visit and page, for the given pages on one day: the facts the session
 * stream's scroll CTE computes for a chosen page.
 * With `spread`, the listed visits over a range, one row per visit, page,
 * and day (see daySql).
 * Parameters: {idsite:UInt32}, {day:Date}, {pages:Array(UInt64)}.
 * @param {{spread?: boolean}} [opts]
 */
export function pageFactsSql({ spread = false } = {}) {
  const { on, day } = scopeOf(spread);
  return `
SELECT toString(idvisit) AS idvisit${day},
       toString(idsitehsr) AS hsr,
       max(ifNull(scroll_y_max_relative, 0)) AS scroll_max,
       count() AS landing_pageviews,
       sum(least(toUInt64(ifNull(time_on_page, 0)), ${TIME_ON_PAGE_CAP_MS})) AS page_capped_ms
FROM default.udp_hsrce_pageviews
WHERE ${on()} AND idsitehsr IN {pages:Array(UInt64)}
GROUP BY idvisit, idsitehsr${spread ? ', server_date' : ''}
`;
}

/**
 * @param {object} row a pageFactsSql() result row
 * @returns {{idvisit: string, day?: string, hsr: string, scrollMax: number, landingPageviews: number, pageCappedMs: number}}
 */
export function parsePageFact(row) {
  return {
    idvisit: String(row.idvisit),
    ...(row.day ? { day: String(row.day) } : {}),
    hsr: String(row.hsr),
    scrollMax: Number(row.scroll_max) || 0,
    landingPageviews: Number(row.landing_pageviews) || 0,
    pageCappedMs: Number(row.page_capped_ms) || 0,
  };
}

/**
 * The event names a day query reads: the session-stream funnel events plus
 * any the caller's folders name (the trigger predicates).
 * @param {Iterable<string>} [extra]
 */
export function dayEvents(extra = []) {
  return [...new Set([...SESSION_EVENTS, ...extra])].sort();
}

/**
 * @typedef {object} DayRow
 * @property {string} idvisit
 * @property {string} day
 * @property {boolean} hasVisit
 * @property {string} startedAt
 * @property {string} configId
 * @property {number} device
 * @property {number} referer
 * @property {number} returning
 * @property {string} country
 * @property {string} browser
 * @property {string} entryHsr
 * @property {string} utmSource
 * @property {string} refererName
 * @property {string} utmMedium
 * @property {string} utmCampaign
 * @property {string} tagUtmSource the day's first utm_source session tag
 * @property {string} tagUtmMedium
 * @property {string} tagUtmCampaign
 * @property {string} fpHash
 * @property {number} pageviewRows
 * @property {string[]} hsrs
 * @property {number} cappedMs
 * @property {number} scrollMax
 * @property {Array<[string, string, string]>} firstPages the day's first two pageviews as (server time, idloghsr, idsitehsr)
 * @property {string[]} events
 * @property {Array<[string, number]>} orders
 * @property {number} clicks
 * @property {string} tags
 * @property {string[]} arms the day's A/B arms, each armKey(week, experience, variant)
 */

/**
 * @param {object} row a daySql() result row
 * @param {string} day
 * @returns {DayRow}
 */
export function parseDayRow(row, day) {
  return {
    idvisit: String(row.idvisit),
    day,
    hasVisit: Number(row.has_visit) === 1,
    startedAt: String(row.started_at ?? ''),
    configId: String(row.config_id ?? ''),
    device: Number(row.device) || 0,
    referer: Number(row.referer) || 0,
    returning: Number(row.returning) || 0,
    country: String(row.country ?? ''),
    browser: String(row.browser ?? ''),
    entryHsr: String(row.entry_hsr ?? ''),
    utmSource: String(row.utm_source ?? ''),
    refererName: String(row.referer_name ?? ''),
    utmMedium: String(row.utm_medium ?? ''),
    utmCampaign: String(row.utm_campaign ?? ''),
    tagUtmSource: String(row.tag_utm_source ?? ''),
    tagUtmMedium: String(row.tag_utm_medium ?? ''),
    tagUtmCampaign: String(row.tag_utm_campaign ?? ''),
    fpHash: String(row.fp_hash ?? ''),
    pageviewRows: Number(row.pageview_rows) || 0,
    hsrs: (row.hsrs ?? []).map(String).sort(),
    cappedMs: Number(row.capped_ms) || 0,
    scrollMax: Number(row.scroll_max) || 0,
    firstPages: (row.first_pages ?? []).map((page) => [String(page[0]), String(page[1]), String(page[2])]),
    events: (row.events ?? []).map(String).sort(),
    orders: (row.orders ?? []).map((pair) => [String(pair[0]), Number(pair[1]) || 0]).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    clicks: Number(row.clicks) || 0,
    tags: String(row.tags ?? ''),
    arms: (row.arms ?? []).map((arm) => armKey(String(arm[0]), String(arm[1]), String(arm[2]))).sort(),
  };
}

/**
 * A day's rows in idvisit order, so the visits that close together reach
 * the consumers in the same order on every read.
 * @param {DayRow[]} rows
 */
export function byIdvisit(rows) {
  return rows.sort((a, b) => {
    const left = BigInt(a.idvisit || '0');
    const right = BigInt(b.idvisit || '0');
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

/**
 * One A/B arm cell's key: the Monday week, the experience, and the variant.
 * @param {string} week @param {string} experienceId @param {string} variantId
 */
export function armKey(week, experienceId, variantId) {
  return JSON.stringify([week, experienceId, variantId]);
}
