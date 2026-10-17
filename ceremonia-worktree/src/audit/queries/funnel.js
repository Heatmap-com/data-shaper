/**
 * Funnel queries: the F1 site KPIs, the F2–F4 step funnels, and the
 * acquisition queries (entry templates, paths, next steps, exits,
 * loopbacks, step timing, and abandonment). Each aggregates in ClickHouse.
 * Computed series (F13, F15) are built from the F1 pull in interpret.js.
 */

import { trackedIds } from '../bounds.js';
import {
  botPredicate,
  channelExpr,
  conversionCte,
  datePredicate,
  deviceExpr,
  pagesCte,
  pageviewJoin,
  returningExpr,
} from '../sql.js';
import { pathExpr, range, spec } from './_lib.js';

export const FUNNEL_STEPS = [
  'session',
  'homepage_viewed',
  'collection_viewed',
  'product_viewed',
  'add_to_cart',
  'cart_viewed',
  'checkout_started',
  'checkout_completed',
];

export const EVENT_STEPS = FUNNEL_STEPS.filter((s) => s !== 'session');

/**
 * Weekly site KPIs for the extended (104-week) window, so the latest 52
 * weeks have a year-over-year partner. F1.
 * @param {number} idsite
 * @param {{extendedStart: string, trendEnd: string}} windows
 */
export function siteKpiQuery(idsite, windows) {
  return {
    id: 'F1',
    label: 'audit:F1',
    sql: `WITH ${conversionCte()}
          SELECT toString(toStartOfWeek(v.server_date, 1)) AS week,
                 ${deviceExpr('v')} AS device,
                 ${returningExpr('v')} AS returning,
                 ${channelExpr('v')} AS channel,
                 uniqExact(v.idvisit) AS sessions,
                 uniqExactIf(v.idvisit, c.orders > 0) AS buyers,
                 sum(c.orders) AS orders,
                 round(sum(c.revenue), 2) AS revenue
            FROM default.log_visit AS v
            LEFT JOIN conv AS c ON c.idvisit = CAST(v.idvisit AS UInt64)
           WHERE v.idsite = {idsite:UInt32}
             AND ${datePredicate('v')}
             AND ${botPredicate('v')}
           GROUP BY week, device, returning, channel
           ORDER BY week`,
    params: { idsite, start: windows.extendedStart, end: windows.trendEnd },
  };
}

/**
 * Weekly reach and progression by quadrant. F2.
 * Progression requires each step's first server_time to fall after the
 * previous step's first server_time in the same visit.
 * @param {number} idsite
 * @param {{trendStart: string, trendEnd: string}} windows
 */
export function funnelWeeklyQuery(idsite, windows) {
  return funnelQuery('F2', 'audit:F2', idsite, windows.trendStart, windows.trendEnd, true, false);
}

/**
 * Weekly funnel progression by channel. F3.
 * @param {number} idsite
 * @param {{trendStart: string, trendEnd: string}} windows
 */
export function funnelChannelQuery(idsite, windows) {
  return funnelQuery('F3', 'audit:F3', idsite, windows.trendStart, windows.trendEnd, true, true);
}

/**
 * Snapshot, prior 28 days, or year-ago snapshot. F4 is three calls.
 * @param {string} id
 * @param {number} idsite
 * @param {string} start
 * @param {string} end
 */
export function funnelSnapshotQuery(id, idsite, start, end) {
  return funnelQuery(id, `audit:${id}`, idsite, start, end, true, true);
}

/**
 * @param {string} id
 * @param {string} label
 * @param {number} idsite
 * @param {string} start
 * @param {string} end
 * @param {boolean} weekly
 * @param {boolean} [byChannel]
 */
function funnelQuery(id, label, idsite, start, end, weekly, byChannel = false) {
  const weekSelect = weekly ? `toString(toStartOfWeek(v.server_date, 1)) AS week,` : `'snapshot' AS week,`;
  const channelSelect = byChannel ? `${channelExpr('v')} AS channel,` : '';
  const group = `${weekly ? 'week, ' : ''}device, returning${byChannel ? ', channel' : ''}`;
  const reach = EVENT_STEPS.map((step) => {
    return `uniqExactIf(v.idvisit, w.t_${step} > toDateTime(0)) AS reach_${step},
                 sumIf(c.revenue, w.t_${step} > toDateTime(0)) AS revenue_${step}`;
  }).join(',\n                 ');
  const prog = EVENT_STEPS.map((step, i) => {
    if (i === 0) {
      return `uniqExactIf(v.idvisit, w.t_${step} > toDateTime(0)) AS prog_${step}`;
    }
    const prev = EVENT_STEPS[i - 1];
    return `uniqExactIf(v.idvisit, w.t_${step} > w.t_${prev} AND w.t_${prev} > toDateTime(0)) AS prog_${step}`;
  }).join(',\n                 ');
  const mins = EVENT_STEPS.map((step) => `minIf(server_time, event_type = '${step}') AS t_${step}`).join(',\n           ');
  return {
    id,
    label,
    sql: `WITH ${conversionCte()},
          wide AS (
            SELECT CAST(idvisit AS UInt64) AS idvisit,
                   ${mins}
              FROM default.journey_events_map
             WHERE idsite = {idsite:UInt32}
               AND server_date BETWEEN {start:Date} AND {end:Date}
               AND server_date <= today()
               AND event_type IN (${EVENT_STEPS.map((s) => `'${s}'`).join(', ')})
             GROUP BY idvisit
          )
          SELECT ${weekSelect}
                 ${channelSelect}
                 ${deviceExpr('v')} AS device,
                 ${returningExpr('v')} AS returning,
                 uniqExact(v.idvisit) AS sessions,
                 uniqExactIf(v.idvisit, c.orders > 0) AS buyers,
                 round(sum(c.revenue), 2) AS revenue,
                 ${reach},
                 ${prog}
            FROM default.log_visit AS v
            LEFT JOIN wide AS w ON w.idvisit = CAST(v.idvisit AS UInt64)
            LEFT JOIN conv AS c ON c.idvisit = CAST(v.idvisit AS UInt64)
           WHERE v.idsite = {idsite:UInt32}
             AND ${datePredicate('v')}
             AND ${botPredicate('v')}
           GROUP BY ${group}
           ORDER BY ${group}`,
    params: { idsite, start, end },
  };
}

/**
 * @param {number} idsite
 * @param {object} windows
 * @param {Array<{pattern: string, template: string}>} rules
 */
export function funnelAcquisitionQueries(idsite, windows, rules, scope = null) {
  const ids = trackedIds(scope);
  return [
    entryTemplateQuery(idsite, windows, rules, ids),
    pathSnapshotQuery(idsite, windows, rules, ids),
    nextTemplateQuery(idsite, windows, rules, ids),
    exitWeeklyQuery(idsite, windows, rules, ids),
    loopbackQuery(idsite, windows, rules, ids),
    stepTimingQuery(idsite, windows),
    abandonmentQuery(idsite, windows),
  ];
}

/**
 * Weekly share of the snapshot's top paths. F7.
 * @param {number} idsite
 * @param {object} windows
 * @param {Array<{pattern: string, template: string}>} rules
 * @param {string[]} paths
 */
export function pathTrendQuery(idsite, windows, rules, paths, hsrIds = null) {
  if (paths.length === 0) return null;
  const pages = pageviewJoin(rules, hsrIds);
  return spec('F7', `WITH ${pagesCte(hsrIds)}
    SELECT week, path, uniqExact(idvisit) AS sessions
      FROM (
        SELECT toString(toStartOfWeek(min(h.server_date), 1)) AS week,
               h.idvisit AS idvisit,
               ${pathExpr(pages.template)} AS path
          ${pages.sql}
         GROUP BY h.idvisit
      )
     WHERE path IN {paths:Array(String)}
     GROUP BY week, path
     ORDER BY week`, {
    ...range(idsite, windows.elementStart, windows.elementEnd, hsrIds),
    ...pages.params,
    paths,
  });
}

function entryTemplateQuery(idsite, windows, rules, hsrIds = null) {
  const pages = pageviewJoin(rules, hsrIds);
  return spec('F5', `WITH ${conversionCte()},
    ${pagesCte(hsrIds)}
    SELECT week, entry_template AS template, device, returning,
           uniqExact(idvisit) AS sessions,
           uniqExactIf(idvisit, orders > 0) AS buyers,
           round(sum(revenue), 2) AS revenue
      FROM (
        SELECT h.idvisit AS idvisit,
               toString(toStartOfWeek(argMin(h.server_date, h.server_time), 1)) AS week,
               argMin(${pages.template}, h.server_time) AS entry_template,
               any(${deviceExpr('v')}) AS device,
               any(${returningExpr('v')}) AS returning,
               any(c.orders) AS orders,
               any(c.revenue) AS revenue
          ${pages.from}
          LEFT JOIN conv AS c ON c.idvisit = CAST(h.idvisit AS UInt64)
         WHERE ${pages.where}
         GROUP BY h.idvisit
      )
     GROUP BY week, template, device, returning`, {
    ...range(idsite, windows.trendStart, windows.trendEnd, hsrIds),
    ...pages.params,
  });
}

function pathSnapshotQuery(idsite, windows, rules, hsrIds = null) {
  const pages = pageviewJoin(rules, hsrIds);
  return spec('F6', `WITH ${conversionCte()},
    ${pagesCte(hsrIds)}
    SELECT path, device, returning,
           uniqExact(idvisit) AS sessions,
           uniqExactIf(idvisit, orders > 0) AS buyers,
           round(sum(revenue), 2) AS revenue
      FROM (
        SELECT h.idvisit AS idvisit,
               any(${deviceExpr('v')}) AS device,
               any(${returningExpr('v')}) AS returning,
               ${pathExpr(pages.template)} AS path,
               any(c.orders) AS orders,
               any(c.revenue) AS revenue
          ${pages.from}
          LEFT JOIN conv AS c ON c.idvisit = CAST(h.idvisit AS UInt64)
         WHERE ${pages.where}
         GROUP BY h.idvisit
      )
     GROUP BY path, device, returning
     ORDER BY sessions DESC
     LIMIT 25`, {
    ...range(idsite, windows.snapshotStart, windows.snapshotEnd, hsrIds),
    ...pages.params,
  });
}

function nextTemplateQuery(idsite, windows, rules, hsrIds = null) {
  const pages = pageviewJoin(rules, hsrIds);
  return spec('F8', `WITH ${pagesCte(hsrIds)}
    SELECT template, next_template, device, returning, count() AS moves
      FROM (
        SELECT arrayJoin(arrayZip(
                 arraySlice(seq, 1, greatest(length(seq) - 1, 0)),
                 arraySlice(seq, 2)
               )) AS pair,
               pair.1 AS template,
               pair.2 AS next_template,
               device, returning
          FROM (
            SELECT h.idvisit AS idvisit,
                   any(${deviceExpr('v')}) AS device,
                   any(${returningExpr('v')}) AS returning,
                   arrayMap(x -> x.2, arraySort(x -> x.1, groupArray(tuple(toUnixTimestamp(h.server_time), ${pages.template})))) AS seq
              ${pages.sql}
             GROUP BY h.idvisit
          )
      )
     GROUP BY template, next_template, device, returning
     ORDER BY moves DESC
     LIMIT 200`, {
    ...range(idsite, windows.snapshotStart, windows.snapshotEnd, hsrIds),
    ...pages.params,
  });
}

export function exitWeeklyQuery(idsite, windows, rules, hsrIds = null) {
  const pages = pageviewJoin(rules, hsrIds);
  return spec('F9', `WITH ${pagesCte(hsrIds)}
    SELECT toString(toStartOfWeek(server_date, 1)) AS week, template, device, returning,
           uniqExact(idvisit) AS exits
      FROM (
        SELECT h.idvisit AS idvisit,
               argMax(${pages.template}, h.server_time) AS template,
               argMax(h.server_date, h.server_time) AS server_date,
               any(${deviceExpr('v')}) AS device,
               any(${returningExpr('v')}) AS returning
          ${pages.sql}
         GROUP BY h.idvisit
      )
     GROUP BY week, template, device, returning`, {
    ...range(idsite, windows.trendStart, windows.trendEnd, hsrIds),
    ...pages.params,
  });
}

function loopbackQuery(idsite, windows, rules, hsrIds = null) {
  const pages = pageviewJoin(rules, hsrIds);
  return spec('F10', `WITH ${conversionCte()},
    ${pagesCte(hsrIds)}
    SELECT toString(toStartOfWeek(server_date, 1)) AS week, device, returning,
           uniqExact(idvisit) AS sessions,
           uniqExactIf(idvisit, pdp_then_plp = 1) AS pdp_then_plp,
           uniqExactIf(idvisit, cart_then_pdp = 1) AS cart_then_pdp,
           round(avg(pdp_n), 2) AS pdp_views,
           round(avgIf(pdp_n, orders > 0), 2) AS pdp_views_buyers,
           round(avgIf(pdp_n, orders = 0), 2) AS pdp_views_non_buyers
      FROM (
        SELECT h.idvisit AS idvisit,
               min(h.server_date) AS server_date,
               any(${deviceExpr('v')}) AS device,
               any(${returningExpr('v')}) AS returning,
               toUInt8(maxIf(h.server_time, ${pages.template} = 'plp') > minIf(h.server_time, ${pages.template} = 'pdp')
                       AND minIf(h.server_time, ${pages.template} = 'pdp') > toDateTime(0)) AS pdp_then_plp,
               toUInt8(maxIf(h.server_time, ${pages.template} = 'pdp') > minIf(h.server_time, ${pages.template} = 'cart_page')
                       AND minIf(h.server_time, ${pages.template} = 'cart_page') > toDateTime(0)) AS cart_then_pdp,
               countIf(${pages.template} = 'pdp') AS pdp_n,
               any(ifNull(c.orders, 0)) AS orders
          ${pages.from}
          LEFT JOIN conv AS c ON c.idvisit = CAST(h.idvisit AS UInt64)
         WHERE ${pages.where}
         GROUP BY h.idvisit
      )
     GROUP BY week, device, returning`, {
    ...range(idsite, windows.trendStart, windows.trendEnd, hsrIds),
    ...pages.params,
  });
}

function stepTimingQuery(idsite, windows) {
  return spec('F11', `SELECT toString(toStartOfWeek(server_date, 1)) AS week,
           quantile(0.5)(if(atc_seconds > 0, atc_seconds, NULL)) AS median_pdp_to_atc_seconds,
           quantile(0.75)(if(atc_seconds > 0, atc_seconds, NULL)) AS p75_pdp_to_atc_seconds,
           quantile(0.5)(if(checkout_seconds > 0, checkout_seconds, NULL)) AS median_atc_to_checkout_seconds,
           quantile(0.75)(if(checkout_seconds > 0, checkout_seconds, NULL)) AS p75_atc_to_checkout_seconds,
           quantile(0.5)(if(purchase_seconds > 0, purchase_seconds, NULL)) AS median_checkout_to_purchase_seconds,
           quantile(0.75)(if(purchase_seconds > 0, purchase_seconds, NULL)) AS p75_checkout_to_purchase_seconds
      FROM (
        SELECT min(j.server_date) AS server_date,
               dateDiff('second', minIf(j.server_time, j.event_type = 'product_viewed'), minIf(j.server_time, j.event_type = 'add_to_cart')) AS atc_seconds,
               dateDiff('second', minIf(j.server_time, j.event_type = 'add_to_cart'), minIf(j.server_time, j.event_type = 'checkout_started')) AS checkout_seconds,
               dateDiff('second', minIf(j.server_time, j.event_type = 'checkout_started'), minIf(j.server_time, j.event_type = 'checkout_completed')) AS purchase_seconds
          FROM default.journey_events_map AS j
          INNER JOIN default.log_visit AS v
            ON v.idsite = {idsite:UInt32} AND v.idsite = j.idsite AND CAST(v.idvisit AS UInt64) = j.idvisit
           AND ${datePredicate('v')}
         WHERE j.idsite = {idsite:UInt32}
           AND j.server_date BETWEEN {start:Date} AND {end:Date}
           AND j.server_date <= today()
           AND j.event_type IN ('product_viewed', 'add_to_cart', 'checkout_started', 'checkout_completed')
           AND ${botPredicate('v')}
         GROUP BY j.idvisit
      )
     GROUP BY week
     ORDER BY week`, range(idsite, windows.trendStart, windows.trendEnd));
}

function abandonmentQuery(idsite, windows) {
  return spec('F12', `WITH ${conversionCte()}
    SELECT toString(toStartOfWeek(v.server_date, 1)) AS week,
           ${deviceExpr('v')} AS device,
           ${returningExpr('v')} AS returning,
           uniqExactIf(v.idvisit, w.atc = 1 AND w.started = 0) AS atc_no_checkout,
           uniqExactIf(v.idvisit, w.started = 1 AND w.bought = 0) AS checkout_no_purchase,
           round(sumIf(c.revenue, w.bought = 1), 2) AS completed_revenue,
           uniqExactIf(v.idvisit, w.bought = 1) AS completed_sessions
      FROM default.log_visit AS v
      INNER JOIN (
        SELECT idvisit,
               toUInt8(countIf(event_type = 'add_to_cart') > 0) AS atc,
               toUInt8(countIf(event_type = 'checkout_started') > 0) AS started,
               toUInt8(countIf(event_type = 'checkout_completed') > 0) AS bought
          FROM default.journey_events_map
         WHERE idsite = {idsite:UInt32}
           AND server_date BETWEEN {start:Date} AND {end:Date}
           AND server_date <= today()
         GROUP BY idvisit
      ) AS w ON w.idvisit = CAST(v.idvisit AS UInt64)
      LEFT JOIN conv AS c ON c.idvisit = CAST(v.idvisit AS UInt64)
     WHERE v.idsite = {idsite:UInt32}
       AND ${datePredicate('v')}
       AND ${botPredicate('v')}
     GROUP BY week, device, returning`, range(idsite, windows.trendStart, windows.trendEnd));
}
