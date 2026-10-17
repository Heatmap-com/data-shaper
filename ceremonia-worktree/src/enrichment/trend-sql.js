/**
 * Site-scoped trend scans. Every fact alias carries idsite and server_date.
 * idsitehsr is bound only on the selector scan, where the page is known.
 */

import { UTM_COLUMNS, sessionUtmSql, tagUtmCte } from '../adapters/_lib/sql.js';
import { botPredicate } from '../audit/sql.js';
import { LABELS, pageClassSql } from '../domain/page-class/index.js';
import { groupParts, segmentedSelect } from './segmentation-sql.js';

/**
 * Page type names the coach reads: home, pdp, plp, cart, and the rest.
 * The Shopify preset with the trend labels, so it agrees with pageType.
 * @param {string} urlExpr
 */
export function templateSql(urlExpr) {
  return pageClassSql(urlExpr, { labels: LABELS.trend });
}

/**
 * The page's URL path. Host, query, and hash are removed, and a trailing
 * slash is removed except for the root. A journey is these paths joined
 * with ` > `, so two product URLs stay two journeys.
 * @param {string} urlExpr
 */
export function urlPathSql(urlExpr) {
  const noHash = `splitByChar('#', splitByChar('?', ifNull(${urlExpr}, ''))[1])[1]`;
  const path = `lower(replaceRegexpOne(${noHash}, '^https?://[^/]+', ''))`;
  return `if(trim(ifNull(${urlExpr}, '')) = '', '(unknown)', if(${path} = '' OR ${path} = '/', '/', replaceRegexpOne(${path}, '/+$', '')))`;
}

function keptWhere() {
  return botPredicate('v').replaceAll('v.location_city', 'city').replaceAll('v.referer_name', 'referer_name');
}

/**
 * visits (one row per visit and week, at its first action that week), kept
 * (after the portal bot predicate), orders, checkout, and, when a
 * segmentation reads rage clicks, ragers. orders carries the visit revenue
 * and the sum of squared order revenue, for a spread test on AOV. A session
 * is a visit's rows in one week, and every fact joins on visit and week, so
 * a week reads only its own seven days and reads the same from any window
 * that holds it. Every field a segmentation reads is non-null. referer_name
 * stays raw, because the bot predicate reads it. The UTMs are the session's
 * tags over the same visit and week, with the custom variables as the
 * fallback (tagUtmCte).
 *
 * `period` replaces the Monday as the session key, for a shaped dataset's
 * days, months, or window; the column is still `week`, so every join reads
 * the same. `extra` adds `expression AS name` columns to visits, each an
 * aggregate over the session's rows. `excludeOrders` drops the order ids
 * bound to {qualityOrders:Array(String)} from orders, for a data-quality
 * exclusion: the session stays, without that order's count and revenue.
 * @param {{ragers?: boolean, period?: (dateExpr: string) => string, extra?: string[], excludeOrders?: boolean}} [options]
 */
export function sessionCtes({ ragers = false, period = (dateExpr) => `toMonday(${dateExpr})`, extra = [], excludeOrders = false } = {}) {
  return `${tagUtmCte('visit_tags', { keys: [['idvisit', 'CAST(idvisit AS UInt64)'], ['week', period('server_date')]] })},
visit_rows AS (
    SELECT CAST(idvisit AS UInt64) AS idvisit,
           ${period('server_date')} AS week,
           toUInt8(argMin(config_device_type, visit_first_action_time)) AS device,
           toInt32(ifNull(argMin(referer_type, visit_first_action_time), 0)) AS referer_type,
           toUInt8(ifNull(argMin(visitor_returning, visit_first_action_time), false)) AS returning,
           ifNull(lower(trim(toString(argMin(custom_var_k5, visit_first_action_time)))), '') AS utm_source,
           ifNull(lower(trim(toString(argMin(custom_var_v1, visit_first_action_time)))), '') AS utm_medium,
           ifNull(trim(toString(argMin(custom_var_v4, visit_first_action_time))), '') AS utm_campaign,
           ifNull(trim(toString(argMin(location_country, visit_first_action_time))), '') AS country,
           trim(toString(argMin(location_city, visit_first_action_time))) AS city,
           trim(toString(argMin(referer_name, visit_first_action_time))) AS referer_name,
           ifNull(lower(referer_name), '') AS referer_name_lc${extra.map((column) => `,\n           ${column}`).join('')}
    FROM default.udp_hsrce_visits
    WHERE idsite = {idsite:UInt32}
      AND server_date BETWEEN {w0:Date} AND {w1:Date}
    GROUP BY idvisit, week
),
visits AS (
    SELECT r.* REPLACE (${UTM_COLUMNS.map((key) => `${sessionUtmSql(key, 't', `r.${key}`)} AS ${key}`).join(', ')})
    FROM visit_rows AS r
    LEFT JOIN visit_tags AS t ON t.idvisit = r.idvisit AND t.week = r.week
),
kept AS (
    SELECT * FROM visits
    WHERE ${keptWhere()}
),
orders AS (
    SELECT CAST(idvisit AS UInt64) AS idvisit,
           week,
           uniqExact(idorder) AS orders,
           sum(order_revenue) AS revenue,
           sum(order_revenue * order_revenue) AS order_revenue_sq
    FROM (
        SELECT idvisit, idorder, ${period('min(server_date)')} AS week, any(revenue) AS order_revenue
        FROM default.udp_conversions
        WHERE idsite = {idsite:UInt32}
          AND server_date BETWEEN {w0:Date} AND {w1:Date}${excludeOrders ? '\n          AND toString(idorder) NOT IN {qualityOrders:Array(String)}' : ''}
        GROUP BY idvisit, idorder
    )
    GROUP BY idvisit, week
),
checkout AS (
    SELECT CAST(idvisit AS UInt64) AS idvisit, ${period('server_date')} AS week
    FROM default.journey_events_map
    WHERE idsite = {idsite:UInt32}
      AND server_date BETWEEN {w0:Date} AND {w1:Date}
      AND event_type = 'checkout_started'
    GROUP BY idvisit, week
)${ragers ? `,
ragers AS (
    SELECT CAST(idvisit AS UInt64) AS idvisit, ${period('server_date')} AS week
    FROM default.udp_clicksce_clicks
    WHERE idsite = {idsite:UInt32}
      AND server_date BETWEEN {w0:Date} AND {w1:Date}
      AND meta1 = 'rage'
    GROUP BY idvisit, week
)` : ''}`;
}

/**
 * Where each segmentation field is in the trend and tag-trend queries:
 * `k` is kept, `o` orders, `ck` checkout, `r` ragers. Every expression is
 * non-null.
 */
export const TREND_COLUMNS = Object.freeze({
  referer_type: 'k.referer_type',
  referer_name: 'k.referer_name_lc',
  utm_source: 'k.utm_source',
  source_or_referrer: "if(k.utm_source != '', k.utm_source, k.referer_name_lc)",
  utm_medium: 'k.utm_medium',
  utm_campaign: 'k.utm_campaign',
  returning: 'toUInt8(k.returning)',
  country: 'k.country',
  has_order: 'toUInt8(ifNull(o.orders, 0) > 0)',
  has_checkout: 'toUInt8(ck.idvisit = k.idvisit)',
  has_rage_click: 'toUInt8(r.idvisit = k.idvisit)',
});

export const VIEWPORT_EXPR = `multiIf(k.device = 1, 'desktop', k.device = 2, 'tablet', k.device = 3, 'mobile', 'unknown')`;

function journeyPathsCte() {
  return `
hsr_pages AS (
    SELECT toUInt64(idsitehsr) AS idsitehsr, any(screenshot_url) AS url
    FROM default.site_hsr
    WHERE idsite = {idsite:UInt32}
    GROUP BY idsitehsr
),
ordered AS (
    SELECT CAST(h.idvisit AS UInt64) AS idvisit,
           toMonday(h.server_date) AS week,
           arraySort(x -> (x.1, x.2), groupArray(tuple(
             toUnixTimestamp(h.server_time),
             toUInt64(h.idloghsr),
             ${templateSql('p.url')},
             ${urlPathSql('p.url')}
           ))) AS steps
    FROM default.udp_hsrce_pageviews AS h
    INNER JOIN hsr_pages AS p ON p.idsitehsr = toUInt64(h.idsitehsr)
    WHERE h.idsite = {idsite:UInt32}
      AND h.server_date BETWEEN {w0:Date} AND {w1:Date}
    GROUP BY idvisit, week
),
paths AS (
    SELECT idvisit,
           week,
           arrayStringConcat(arrayCompact(arrayMap(x -> x.3, steps)), ' > ') AS template_path,
           arrayStringConcat(arrayCompact(arrayMap(x -> x.4, steps)), ' > ') AS url_path
    FROM ordered
)`;
}

export function pathRankSql() {
  return `
WITH
${sessionCtes()},
${journeyPathsCte()}
SELECT 'template' AS kind, s.template_path AS path,
       uniqExact(k.idvisit) AS sessions,
       sum(ifNull(o.revenue, 0)) AS revenue
FROM kept AS k
INNER JOIN paths AS s ON s.idvisit = k.idvisit AND s.week = k.week
LEFT JOIN orders AS o ON o.idvisit = k.idvisit AND o.week = k.week
WHERE position(s.template_path, ' > ') > 0
GROUP BY s.template_path
UNION ALL
SELECT 'url' AS kind, s.url_path AS path,
       uniqExact(k.idvisit) AS sessions,
       sum(ifNull(o.revenue, 0)) AS revenue
FROM kept AS k
INNER JOIN paths AS s ON s.idvisit = k.idvisit AND s.week = k.week
LEFT JOIN orders AS o ON o.idvisit = k.idvisit AND o.week = k.week
WHERE position(s.url_path, ' > ') > 0
GROUP BY s.url_path
`;
}

/**
 * The trailing joins of a segmented trend aggregate.
 * @param {{ragers: boolean, joins: string}} parts
 */
export function measureJoins(parts) {
  return [
    'LEFT JOIN orders AS o ON o.idvisit = k.idvisit AND o.week = k.week',
    'LEFT JOIN checkout AS ck ON ck.idvisit = k.idvisit AND ck.week = k.week',
    ...(parts.ragers ? ['LEFT JOIN ragers AS r ON r.idvisit = k.idvisit AND r.week = k.week'] : []),
    ...(parts.joins ? [parts.joins] : []),
  ].join('\n    ');
}

/**
 * One segmentation and `all` over every kept session of the window, for
 * `--segmentation-check`.
 * @param {import('../ports/segmentation.js').Segmentation} seg a declared segmentation
 */
export function segmentationCheckSql(seg) {
  const group = { segmentations: [seg], withAll: true };
  const parts = groupParts(group, {});
  return `
WITH
${sessionCtes(parts)}${parts.ctes}
${segmentedSelect({
    group,
    columns: TREND_COLUMNS,
    viewport: "'all'",
    keys: [],
    from: 'kept AS k',
    joins: measureJoins(parts),
  })}`;
}

/**
 * @param {'template' | 'url'} kind
 * @param {import('./segmentation-sql.js').QueryGroup} group
 * @param {object} [inputs] the run inputs computed segmentations read
 */
export function pathAggregateSql(kind, group, inputs = {}) {
  const column = kind === 'url' ? 'url_path' : 'template_path';
  const exact = kind === 'url' ? 'urlExact' : 'templateExact';
  const ext = kind === 'url' ? 'urlExt' : 'templateExt';
  const parts = groupParts(group, inputs);
  return `
WITH
${sessionCtes(parts)},
${journeyPathsCte()}${parts.ctes}
${segmentedSelect({
    group,
    columns: TREND_COLUMNS,
    viewport: VIEWPORT_EXPR,
    keys: [[`s.${column}`, 'path']],
    from: 'kept AS k\n    INNER JOIN paths AS s ON s.idvisit = k.idvisit AND s.week = k.week',
    joins: measureJoins(parts),
    where: `s.${column} IN {${exact}:Array(String)}\n       OR arrayExists(prefix -> startsWith(s.${column}, prefix), {${ext}:Array(String)})`,
  })}`;
}

export function pageRankSql() {
  return `
WITH
${sessionCtes()}
SELECT toString(h.idsitehsr) AS idsitehsr,
       uniqExact(h.idvisit) AS sessions
FROM default.udp_hsrce_pageviews AS h
INNER JOIN kept AS k ON k.idvisit = CAST(h.idvisit AS UInt64) AND k.week = toMonday(h.server_date)
WHERE h.idsite = {idsite:UInt32}
  AND h.server_date BETWEEN {w0:Date} AND {w1:Date}
GROUP BY h.idsitehsr
ORDER BY sessions DESC
LIMIT {pageLimit:UInt32}
`;
}

/**
 * @param {import('./segmentation-sql.js').QueryGroup} group
 * @param {object} [inputs]
 */
export function pageAggregateSql(group, inputs = {}) {
  const parts = groupParts(group, inputs);
  return `
WITH
${sessionCtes(parts)},
viewed AS (
    SELECT CAST(h.idvisit AS UInt64) AS idvisit,
           toMonday(h.server_date) AS week,
           toUInt64(h.idsitehsr) AS idsitehsr
    FROM default.udp_hsrce_pageviews AS h
    WHERE h.idsite = {idsite:UInt32}
      AND h.server_date BETWEEN {w0:Date} AND {w1:Date}
      AND h.idsitehsr IN {pages:Array(UInt64)}
    GROUP BY idvisit, week, idsitehsr
)${parts.ctes}
${segmentedSelect({
    group,
    columns: TREND_COLUMNS,
    viewport: VIEWPORT_EXPR,
    keys: [['toString(v.idsitehsr)', 'idsitehsr']],
    from: 'viewed AS v\n    INNER JOIN kept AS k ON k.idvisit = v.idvisit AND k.week = v.week',
    joins: measureJoins(parts),
  })}`;
}

export function pageUrlSql() {
  return `
SELECT toString(idsitehsr) AS idsitehsr, any(screenshot_url) AS url
FROM default.site_hsr
WHERE idsite = {idsite:UInt32}
  AND idsitehsr IN {pages:Array(UInt64)}
GROUP BY idsitehsr
`;
}

/**
 * @param {import('./segmentation-sql.js').QueryGroup} group
 * @param {object} [inputs]
 */
export function selectorAggregateSql(group, inputs = {}) {
  const parts = groupParts(group, inputs);
  return `
WITH
${sessionCtes(parts)},
clicks AS (
    SELECT CAST(idvisit AS UInt64) AS idvisit,
           toMonday(server_date) AS week,
           idselector AS selector,
           count() AS clicks
    FROM default.udp_clicksce_clicks
    WHERE idsite = {idsite:UInt32}
      AND idsitehsr = {idsitehsr:UInt64}
      AND server_date BETWEEN {w0:Date} AND {w1:Date}
      AND idselector IN {selectors:Array(String)}
    GROUP BY idvisit, week, idselector
)${parts.ctes}
${segmentedSelect({
    group,
    columns: TREND_COLUMNS,
    viewport: VIEWPORT_EXPR,
    keys: [['c.selector', 'selector']],
    extra: [['c.clicks', 'v_clicks', 'sum(v_clicks) AS clicks']],
    from: 'clicks AS c\n    INNER JOIN kept AS k ON k.idvisit = c.idvisit AND k.week = c.week',
    joins: measureJoins(parts),
  })}`;
}
