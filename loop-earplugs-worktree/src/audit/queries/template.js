/**
 * Template queries: the H1 weekly series, the element scorecards, and the
 * acquisition queries (scroll, exits, leagues, search, cart and checkout,
 * plus the click scans). A click scan runs only when the naming matrix has
 * a live selector for that template.
 */

import { templateIds, trackedIds } from '../bounds.js';
import { matrixValuesSql } from '../matrix.js';
import {
  botPredicate,
  channelExpr,
  clickFrom,
  clickJoin,
  clickWhere,
  conversionCte,
  datePredicate,
  deviceExpr,
  hsrClauseSql,
  hsrParams,
  pagesCte,
  pageviewJoin,
  returningExpr,
  scrollUnitsExpr,
  templateMultiIf,
  templateRuleParams,
  timeOnPageSecondsExpr,
} from '../sql.js';
import { groupTail, range, spec } from './_lib.js';
import { exitWeeklyQuery } from './funnel.js';

/** Plan id for the element scorecard on each template. */
export const SCORECARD_QUERY = {
  home: 'H4',
  plp: 'L4',
  pdp: 'P4',
  cart_page: 'C4',
  cart_drawer: 'C4',
  checkout: 'K4',
  global: 'G1',
};

/**
 * Weekly template KPIs, H1 and the L1/P1/C1/K twins, one query.
 * @param {number} idsite
 * @param {{trendStart: string, trendEnd: string}} windows
 * @param {Array<{pattern: string, template: string}>} [rules]
 */
export function templateWeeklyQuery(idsite, windows, rules = [], hsrIds = null) {
  const template = templateMultiIf('p.url', rules);
  const params = {
    idsite,
    start: windows.trendStart,
    end: windows.trendEnd,
    ...templateRuleParams(rules),
    ...hsrParams(hsrIds),
  };
  return {
    id: 'H1',
    label: 'audit:H1',
    sql: `WITH ${conversionCte()},
          ${pagesCte(hsrIds)}
          SELECT toString(toStartOfWeek(h.server_date, 1)) AS week,
                 ${template} AS template,
                 ${deviceExpr('v')} AS device,
                 ${returningExpr('v')} AS returning,
                 uniqExact(h.idvisit) AS sessions,
                 uniqExactIf(h.idvisit, c.orders > 0) AS buyers,
                 round(sum(c.revenue), 2) AS revenue
            FROM default.log_hsr AS h
            INNER JOIN pages AS p ON p.idsitehsr = h.idsitehsr
            INNER JOIN default.log_visit AS v
              ON v.idsite = {idsite:UInt32} AND v.idsite = h.idsite AND CAST(v.idvisit AS UInt64) = CAST(h.idvisit AS UInt64)
             AND ${datePredicate('v')}
            LEFT JOIN conv AS c ON c.idvisit = CAST(h.idvisit AS UInt64)
           WHERE h.idsite = {idsite:UInt32}
             AND ${datePredicate('h')}
             ${hsrClauseSql('h', hsrIds)}
             AND ${botPredicate('v')}
           GROUP BY week, template, device, returning`,
    params,
    chunkDays: 28,
  };
}

/**
 * Element scorecard for one template. Skips the click scan when every
 * required class is absent or unmapped; those classes are still reported.
 * @param {number} idsite
 * @param {string} template
 * @param {{snapshotStart: string, snapshotEnd: string}} windows
 * @param {object[]} entries
 */
export function elementScorecardQuery(idsite, template, windows, entries, rules = [], hsrIds = null) {
  const live = entries.filter((e) => e.idsite === idsite && e.template === template && !e.absent);
  if (live.length === 0) return null;
  const cte = matrixValuesSql(live, idsite);
  const pages = pageviewJoin(rules, hsrIds);
  const viewers = template === 'global'
    ? `viewers AS (
            SELECT ${deviceExpr('v')} AS device,
                   ${returningExpr('v')} AS returning,
                   uniqExact(v.idvisit) AS viewing_sessions,
                   round(sum(c.revenue), 2) AS viewing_revenue
              FROM default.log_visit AS v
              LEFT JOIN conv AS c ON c.idvisit = CAST(v.idvisit AS UInt64)
             WHERE v.idsite = {idsite:UInt32}
               AND ${datePredicate('v')}
               AND ${botPredicate('v')}
             GROUP BY device, returning
          )`
    : template === 'cart_drawer'
      ? `viewers AS (
            SELECT ${deviceExpr('v')} AS device,
                   ${returningExpr('v')} AS returning,
                   uniqExact(j.idvisit) AS viewing_sessions,
                   round(sum(c.revenue), 2) AS viewing_revenue
              FROM default.journey_events_map AS j
              INNER JOIN default.log_visit AS v
                ON v.idsite = {idsite:UInt32} AND v.idsite = j.idsite AND CAST(v.idvisit AS UInt64) = j.idvisit
               AND ${datePredicate('v')}
              LEFT JOIN conv AS c ON c.idvisit = j.idvisit
             WHERE j.idsite = {idsite:UInt32}
               AND j.server_date BETWEEN {start:Date} AND {end:Date}
               AND j.server_date <= today()
               AND j.event_type = 'cart_viewed'
               AND ${botPredicate('v')}
             GROUP BY device, returning
          )`
      : `viewers AS (
            SELECT ${deviceExpr('v')} AS device,
                   ${returningExpr('v')} AS returning,
                   uniqExact(h.idvisit) AS viewing_sessions,
                   round(sum(c.revenue), 2) AS viewing_revenue
              ${pages.sql.replace('WHERE h.idsite', () => `LEFT JOIN conv AS c ON c.idvisit = CAST(h.idvisit AS UInt64)
           WHERE ${pages.template} = {template:String}
             AND h.idsite`,
              )}
             GROUP BY device, returning
          )`;
  return {
    id: `${SCORECARD_QUERY[template] ?? 'H4'}:${template}`,
    label: `audit:${SCORECARD_QUERY[template] ?? 'H4'}:${template}`,
    sql: `WITH ${cte},
          ${conversionCte()}${template === 'global' || template === 'cart_drawer' ? '' : `,
          ${pagesCte(hsrIds)}`},
          ${viewers}
          SELECT m.element_class AS element_class,
                 any(m.element_name) AS element_name,
                 ${deviceExpr('v')} AS device,
                 ${returningExpr('v')} AS returning,
                 count() AS clicks,
                 uniqExact(e.idvisit) AS clicking_sessions,
                 countIf(e.meta1 = 'rage') AS rage_clicks,
                 round(sum(c.revenue), 2) AS revenue,
                 any(vwr.viewing_sessions) AS viewing_sessions,
                 any(vwr.viewing_revenue) AS viewing_revenue
            FROM default.log_hsr_event AS e
            INNER JOIN default.log_hsr AS h
              ON h.idsite = e.idsite AND h.idsitehsr = e.idsitehsr
             AND h.server_date = e.server_date
             AND h.idvisit = e.idvisit AND h.idloghsr = e.idloghsr
            INNER JOIN element_matrix AS m
              ON m.idsite = e.idsite AND match(e.selector, m.selector_match)
             AND e.server_date BETWEEN m.valid_from AND m.valid_to
            INNER JOIN default.log_visit AS v
              ON v.idsite = {idsite:UInt32} AND v.idsite = e.idsite AND CAST(v.idvisit AS UInt64) = CAST(e.idvisit AS UInt64)
             AND ${datePredicate('v')}
            LEFT JOIN conv AS c ON c.idvisit = CAST(e.idvisit AS UInt64)
            LEFT JOIN viewers AS vwr
              ON vwr.device = ${deviceExpr('v')}
             AND vwr.returning = ${returningExpr('v')}
           WHERE e.idsite = {idsite:UInt32}
             AND ${datePredicate('e')}
             ${hsrClauseSql('e', hsrIds)}
             AND h.idsite = {idsite:UInt32}
             AND ${datePredicate('h')}
             ${hsrClauseSql('h', hsrIds)}
             AND e.event_type = 2
             AND m.template = {template:String}
             AND ${botPredicate('v')}
           GROUP BY element_class, device, returning`,
    params: {
      idsite,
      start: windows.snapshotStart,
      end: windows.snapshotEnd,
      template,
      ...pages.params,
      ...hsrParams(hsrIds),
    },
  };
}

/**
 * @param {number} idsite
 * @param {object} windows
 * @param {Array<{pattern: string, template: string}>} rules
 * @param {object[]} entries
 * @param {boolean} checkoutTracked
 */
export function templateAcquisitionQueries(idsite, windows, rules, entries, checkoutTracked, scope = null) {
  const live = entries.filter((e) => e.idsite === idsite && !e.absent && e.selector_match);
  const tracked = trackedIds(scope);
  const home = templateIds(scope, ['home']);
  const plp = templateIds(scope, ['plp']);
  const pdp = templateIds(scope, ['pdp']);
  const checkoutPages = templateIds(scope, ['checkout']);
  const searchAndPdp = templateIds(scope, ['search', 'pdp']);
  const plpPdp = templateIds(scope, ['plp', 'pdp']);
  /** @type {Array<{id: string, label: string, sql: string, params: object} | null>} */
  const queries = [
    scrollQuery(idsite, windows, rules, tracked),
    histogramQuery(idsite, windows, rules, tracked),
    exitCountQuery(idsite, windows, rules, tracked),
    templateProgressQuery(idsite, windows, rules, tracked),
    homeRoutingQuery(idsite, windows, rules, tracked),
    homeEntryQuery(idsite, windows, rules, tracked),
    collectionLeagueQuery(idsite, windows, rules, plp),
    productLeagueQuery(idsite, windows, rules, pdp),
    searchQuery(idsite, windows, rules, searchAndPdp),
    pogoQuery(idsite, windows, rules, plpPdp),
    atcWeeklyQuery(idsite, windows),
    priceBandQuery(idsite, windows, rules, pdp),
    drawerKpiQuery(idsite, windows),
    orderValueQuery(idsite, windows),
    abandonedValueQuery(idsite, windows),
    checkoutWeeklyQuery(idsite, windows),
    checkoutSnapshotQuery('K2', idsite, windows.snapshotStart, windows.snapshotEnd),
    checkoutSnapshotQuery('K2prior', idsite, windows.priorStart, windows.priorEnd),
    checkoutSnapshotQuery('K2yoy', idsite, windows.yoySnapshotStart, windows.yoySnapshotEnd),
    checkoutReturnQuery(idsite, windows, rules, tracked),
    checkoutFormQuery(idsite, windows),
    checkoutTimeQuery(idsite, windows),
  ];
  if (checkoutTracked) queries.push(checkoutStepQuery(idsite, windows, rules, checkoutPages));
  if (live.length > 0) {
    queries.push(
      elementTrendQuery(idsite, windows, live, tracked),
      heroSlideQuery(idsite, windows, live, home),
      carouselQuery(idsite, windows, live, home),
      tilePositionQuery(idsite, windows, live, plp),
      filterUseQuery(idsite, windows, live, plp),
      filterFrictionQuery(idsite, windows, live, rules, plpPdp),
      quickAddQuery(idsite, windows, live, plp),
      buyBoxQuery(idsite, windows, live, pdp),
      atcFrictionQuery(idsite, windows, live, pdp),
      reviewQuery(idsite, windows, live, rules, pdp),
      contentTabQuery(idsite, windows, live, pdp),
      recommendationQuery(idsite, windows, live, pdp),
      expressPdpQuery(idsite, windows, live, pdp),
      backInStockQuery(idsite, windows, live, pdp),
      cartOutcomeQuery(idsite, windows, live, tracked),
      drawerTriggerQuery(idsite, windows, live, tracked),
      cartEditQuery(idsite, windows, live, tracked),
      upsellQuery(idsite, windows, live, tracked),
      discountFrictionQuery(idsite, windows, live, tracked),
      expressCartQuery(idsite, windows, live, tracked),
      navQuery(idsite, windows, live, rules, tracked),
      popupQuery(idsite, windows, live, tracked),
      chatQuery(idsite, windows, live, tracked),
      unmatchedQuery(idsite, windows, live, rules, tracked),
      frustrationQuery(idsite, windows, live, tracked),
      exposureQuery(idsite, windows, live, tracked),
    );
  }
  return queries.filter(Boolean);
}

function scrollQuery(idsite, windows, rules, hsrIds = null) {
  const pages = pageviewJoin(rules, hsrIds);
  return spec('H2', `WITH ${pagesCte(hsrIds)}
    SELECT toString(toStartOfWeek(h.server_date, 1)) AS week,
           ${pages.template} AS template,
           ${deviceExpr('v')} AS device,
           round(avg(${scrollUnitsExpr('h')}) / 10, 2) AS scroll_depth,
           round(countIf(ifNull(h.scroll_y_max_relative, 0) > ifNull(h.fold_y_relative, 0) AND ifNull(h.fold_y_relative, 0) > 0) / count(), 4) AS past_fold,
           round(avg(${timeOnPageSecondsExpr('h')}), 2) AS time_on_page_seconds,
           count() AS pageviews
      ${pages.sql}
     GROUP BY week, template, device`, {
    ...range(idsite, windows.trendStart, windows.trendEnd, hsrIds),
    ...pages.params,
  });
}

function histogramQuery(idsite, windows, rules, hsrIds = null) {
  const pages = pageviewJoin(rules, hsrIds);
  return spec('H3', `WITH ${conversionCte()},
    ${pagesCte(hsrIds)}
    SELECT template, band, device,
           uniqExact(idvisit) AS sessions,
           uniqExactIf(idvisit, orders > 0) AS buyers,
           round(sum(revenue), 2) AS revenue
      FROM (
        SELECT ${pages.template} AS template,
               ${deviceExpr('v')} AS device,
               h.idvisit AS idvisit,
               toString(intDiv(least(toUInt16(ifNull(h.scroll_y_max_relative, 0)), 1000), 100) * 10) AS band,
               any(ifNull(c.orders, 0)) AS orders,
               any(ifNull(c.revenue, 0)) AS revenue
          ${pages.from}
          LEFT JOIN conv AS c ON c.idvisit = CAST(h.idvisit AS UInt64)
         WHERE ${pages.where}
         GROUP BY template, device, idvisit, band
      )
     GROUP BY template, band, device`, {
    ...range(idsite, windows.snapshotStart, windows.snapshotEnd, hsrIds),
    ...pages.params,
  });
}

function exitCountQuery(idsite, windows, rules, hsrIds = null) {
  const built = exitWeeklyQuery(idsite, windows, rules, hsrIds);
  return { ...built, id: 'H1exit', label: 'audit:H1:exit' };
}

function templateProgressQuery(idsite, windows, rules, hsrIds = null) {
  const pages = pageviewJoin(rules, hsrIds);
  return spec('H1progress', `WITH ${pagesCte(hsrIds)}
    SELECT week, template, device, returning,
           uniqExact(idvisit) AS sessions,
           uniqExactIf(idvisit, progressed = 1) AS progressed
      FROM (
        SELECT toString(toStartOfWeek(min(h.server_date), 1)) AS week,
               ${pages.template} AS template,
               any(${deviceExpr('v')}) AS device,
               any(${returningExpr('v')}) AS returning,
               h.idvisit AS idvisit,
               toUInt8(
                 (${pages.template} = 'home' AND (any(j.t_plp) > min(h.server_time) OR any(j.t_pdp) > min(h.server_time)))
                 OR (${pages.template} = 'plp' AND any(j.t_pdp) > min(h.server_time))
                 OR (${pages.template} = 'pdp' AND any(j.t_atc) > min(h.server_time))
                 OR (${pages.template} = 'cart_page' AND any(j.t_checkout) > min(h.server_time))
                 OR (${pages.template} = 'checkout' AND any(j.t_done) > min(h.server_time))
               ) AS progressed
          ${pages.from}
          LEFT JOIN (
            SELECT idvisit,
                   minIf(server_time, event_type = 'collection_viewed') AS t_plp,
                   minIf(server_time, event_type = 'product_viewed') AS t_pdp,
                   minIf(server_time, event_type = 'add_to_cart') AS t_atc,
                   minIf(server_time, event_type = 'checkout_started') AS t_checkout,
                   minIf(server_time, event_type = 'checkout_completed') AS t_done
              FROM default.journey_events_map
             WHERE idsite = {idsite:UInt32}
               AND server_date BETWEEN {start:Date} AND {end:Date}
               AND server_date <= today()
             GROUP BY idvisit
          ) AS j ON j.idvisit = CAST(h.idvisit AS UInt64)
         WHERE ${pages.where}
         GROUP BY h.idvisit, template
      )
     GROUP BY week, template, device, returning`, {
    ...range(idsite, windows.trendStart, windows.trendEnd, hsrIds),
    ...pages.params,
  });
}

function homeRoutingQuery(idsite, windows, rules, hsrIds = null) {
  const pages = pageviewJoin(rules, hsrIds);
  return spec('H7', `WITH ${conversionCte()},
    ${pagesCte(hsrIds)}
    SELECT next_template, device,
           uniqExact(idvisit) AS sessions,
           round(sum(revenue), 2) AS revenue
      FROM (
        SELECT h.idvisit AS idvisit,
               any(${deviceExpr('v')}) AS device,
               arrayElement(arrayFilter(x -> x != 'home', arrayMap(t -> t.2, arraySort(s -> s.1, groupArray(tuple(toUnixTimestamp(h.server_time), ${pages.template}))))), 1) AS next_template,
               any(ifNull(c.revenue, 0)) AS revenue
          ${pages.from}
          LEFT JOIN conv AS c ON c.idvisit = CAST(h.idvisit AS UInt64)
         WHERE ${pages.where}
         GROUP BY h.idvisit
        HAVING countIf(${pages.template} = 'home') > 0
      )
     GROUP BY next_template, device`, {
    ...range(idsite, windows.snapshotStart, windows.snapshotEnd, hsrIds),
    ...pages.params,
  });
}

function homeEntryQuery(idsite, windows, rules, hsrIds = null) {
  const pages = pageviewJoin(rules, hsrIds);
  return spec('H10', `WITH ${conversionCte()},
    ${pagesCte(hsrIds)}
    SELECT entry_template, device, returning,
           uniqExact(idvisit) AS sessions,
           uniqExactIf(idvisit, orders > 0) AS buyers,
           round(sum(revenue), 2) AS revenue
      FROM (
        SELECT h.idvisit AS idvisit,
               any(${deviceExpr('v')}) AS device,
               any(${returningExpr('v')}) AS returning,
               if(argMin(${pages.template}, h.server_time) = 'home', 'landing', 'mid_session') AS entry_template,
               any(ifNull(c.orders, 0)) AS orders,
               any(ifNull(c.revenue, 0)) AS revenue
          ${pages.from}
          LEFT JOIN conv AS c ON c.idvisit = CAST(h.idvisit AS UInt64)
         WHERE ${pages.where}
         GROUP BY h.idvisit
        HAVING countIf(${pages.template} = 'home') > 0
      )
     GROUP BY entry_template, device, returning`, {
    ...range(idsite, windows.snapshotStart, windows.snapshotEnd, hsrIds),
    ...pages.params,
  });
}

function collectionLeagueQuery(idsite, windows, rules, hsrIds = null) {
  const pages = pageviewJoin(rules, hsrIds);
  return spec('L6', `WITH ${conversionCte()},
    ${pagesCte(hsrIds)}
    SELECT toString(idsitehsr) AS page, template, sessions, buyers, revenue, exits
      FROM (
        SELECT h.idsitehsr AS idsitehsr,
               any(${pages.template}) AS template,
               uniqExact(h.idvisit) AS sessions,
               uniqExactIf(h.idvisit, c.orders > 0) AS buyers,
               round(sum(c.revenue), 2) AS revenue,
               uniqExactIf(h.idvisit, h.server_time = last_time) AS exits
          ${pages.sql.replace('WHERE h.idsite', () => `LEFT JOIN conv AS c ON c.idvisit = CAST(h.idvisit AS UInt64)
            LEFT JOIN (
              SELECT idvisit, max(server_time) AS last_time
                FROM default.log_hsr
               WHERE idsite = {idsite:UInt32}
                 AND server_date BETWEEN {start:Date} AND {end:Date}
                 AND server_date <= today()
               GROUP BY idvisit
            ) AS tail ON tail.idvisit = h.idvisit
           WHERE ${pages.template} = 'plp'
             AND h.idsite`,
          )}
         GROUP BY h.idsitehsr
         ORDER BY sessions DESC
         LIMIT 50
      )`, {
    ...range(idsite, windows.snapshotStart, windows.snapshotEnd, hsrIds),
    ...pages.params,
  });
}

function productLeagueQuery(idsite, windows, rules, hsrIds = null) {
  const pages = pageviewJoin(rules, hsrIds);
  return spec('P6', `WITH ${conversionCte()},
    ${pagesCte(hsrIds)}
    SELECT toString(h.idsitehsr) AS page,
           uniqExact(h.idvisit) AS sessions,
           uniqExactIf(h.idvisit, j.atc = 1) AS atc_sessions,
           uniqExactIf(h.idvisit, c.orders > 0) AS buyers,
           round(sum(c.revenue), 2) AS revenue
      ${pages.sql.replace('WHERE h.idsite', () => `LEFT JOIN conv AS c ON c.idvisit = CAST(h.idvisit AS UInt64)
          LEFT JOIN (
            SELECT idvisit, toUInt8(countIf(event_type = 'add_to_cart') > 0) AS atc
              FROM default.journey_events_map
             WHERE idsite = {idsite:UInt32}
               AND server_date BETWEEN {start:Date} AND {end:Date}
               AND server_date <= today()
             GROUP BY idvisit
          ) AS j ON j.idvisit = CAST(h.idvisit AS UInt64)
         WHERE ${pages.template} = 'pdp'
           AND h.idsite`,
      )}
     GROUP BY h.idsitehsr
     ORDER BY sessions DESC
     LIMIT 50`, {
    ...range(idsite, windows.snapshotStart, windows.snapshotEnd, hsrIds),
    ...pages.params,
  });
}

function searchQuery(idsite, windows, rules, hsrIds = null) {
  const pages = pageviewJoin(rules, hsrIds);
  return spec('L12', `WITH ${conversionCte()},
    ${pagesCte(hsrIds)}
    SELECT toString(toStartOfWeek(v.server_date, 1)) AS week,
           ${deviceExpr('v')} AS device,
           uniqExact(v.idvisit) AS sessions,
           uniqExactIf(v.idvisit, s.searched = 1) AS search_sessions,
           uniqExactIf(v.idvisit, s.searched = 1 AND s.saw_pdp = 1) AS search_to_pdp,
           uniqExactIf(v.idvisit, s.searched = 1 AND c.orders > 0) AS search_buyers,
           uniqExactIf(v.idvisit, s.searched = 0 AND c.orders > 0) AS other_buyers,
           uniqExactIf(v.idvisit, s.searched = 0) AS other_sessions,
           round(sumIf(c.revenue, s.searched = 1), 2) AS search_revenue
      FROM default.log_visit AS v
      LEFT JOIN (
        SELECT h.idvisit AS idvisit,
               toUInt8(countIf(${pages.template} = 'search') > 0) AS searched,
               toUInt8(maxIf(h.server_time, ${pages.template} = 'pdp') > minIf(h.server_time, ${pages.template} = 'search')) AS saw_pdp
          ${pages.sql}
         GROUP BY h.idvisit
      ) AS s ON s.idvisit = CAST(v.idvisit AS UInt64)
      LEFT JOIN conv AS c ON c.idvisit = CAST(v.idvisit AS UInt64)
     WHERE v.idsite = {idsite:UInt32}
       AND ${datePredicate('v')}
       AND ${botPredicate('v')}
     GROUP BY week, device`, {
    ...range(idsite, windows.trendStart, windows.trendEnd, hsrIds),
    ...pages.params,
  });
}

function pogoQuery(idsite, windows, rules, hsrIds = null) {
  const pages = pageviewJoin(rules, hsrIds);
  return spec('L13', `WITH ${pagesCte(hsrIds)}
    SELECT toString(idsitehsr) AS page,
           uniqExact(idvisit) AS sessions,
           uniqExactIf(idvisit, came_back = 1 AND atc = 0) AS pogo_sessions
      FROM (
        SELECT h.idvisit AS idvisit,
               plp.idsitehsr AS idsitehsr,
               toUInt8(minIf(h.server_time, ${pages.template} = 'pdp') > toDateTime(0)
                       AND maxIf(h.server_time, h.idsitehsr = plp.idsitehsr) > minIf(h.server_time, ${pages.template} = 'pdp')) AS came_back,
               any(ifNull(j.atc, 0)) AS atc
          ${pages.sql.replace('WHERE h.idsite', () => `INNER JOIN (
              SELECT h.idvisit AS idvisit, h.idsitehsr AS idsitehsr
                ${pages.sql}
                 AND ${pages.template} = 'plp'
               GROUP BY h.idvisit, h.idsitehsr
            ) AS plp ON plp.idvisit = h.idvisit
            LEFT JOIN (
              SELECT idvisit, toUInt8(countIf(event_type = 'add_to_cart') > 0) AS atc
                FROM default.journey_events_map
               WHERE idsite = {idsite:UInt32}
                 AND server_date BETWEEN {start:Date} AND {end:Date}
                 AND server_date <= today()
               GROUP BY idvisit
            ) AS j ON j.idvisit = CAST(h.idvisit AS UInt64)
           WHERE h.idsite`,
          )}
         GROUP BY h.idvisit, plp.idsitehsr
      )
     GROUP BY page
     ORDER BY pogo_sessions DESC
     LIMIT 50`, {
    ...range(idsite, windows.snapshotStart, windows.snapshotEnd, hsrIds),
    ...pages.params,
  });
}

function atcWeeklyQuery(idsite, windows) {
  return spec('P7', `SELECT toString(toStartOfWeek(v.server_date, 1)) AS week,
           ${deviceExpr('v')} AS device,
           ${returningExpr('v')} AS returning,
           ${channelExpr('v')} AS channel,
           uniqExactIf(v.idvisit, w.viewed = 1) AS pdp_sessions,
           uniqExactIf(v.idvisit, w.viewed = 1 AND w.atc = 1 AND w.t_atc > w.t_pdp) AS atc_sessions
      FROM default.log_visit AS v
      INNER JOIN (
        SELECT idvisit,
               toUInt8(countIf(event_type = 'product_viewed') > 0) AS viewed,
               toUInt8(countIf(event_type = 'add_to_cart') > 0) AS atc,
               minIf(server_time, event_type = 'product_viewed') AS t_pdp,
               minIf(server_time, event_type = 'add_to_cart') AS t_atc
          FROM default.journey_events_map
         WHERE idsite = {idsite:UInt32}
           AND server_date BETWEEN {start:Date} AND {end:Date}
           AND server_date <= today()
         GROUP BY idvisit
      ) AS w ON w.idvisit = CAST(v.idvisit AS UInt64)
     WHERE v.idsite = {idsite:UInt32}
       AND ${datePredicate('v')}
       AND ${botPredicate('v')}
     GROUP BY week, device, returning, channel`, range(idsite, windows.trendStart, windows.trendEnd));
}

function priceBandQuery(idsite, windows, rules, hsrIds = null) {
  const pages = pageviewJoin(rules, hsrIds);
  return spec('P16', `WITH ${pagesCte(hsrIds)},
    cuts AS (
      SELECT quantile(0.25)(price) AS q1, quantile(0.5)(price) AS q2, quantile(0.75)(price) AS q3
        FROM (
          SELECT avg(price) AS price
            FROM default.conversion_item
           WHERE idsite = {idsite:UInt32}
             AND toDate(server_time) BETWEEN {start:Date} AND {end:Date}
             AND toDate(server_time) <= today()
           GROUP BY idvisit
        )
    )
    SELECT band, uniqExact(idvisit) AS sessions, uniqExactIf(idvisit, atc = 1) AS atc_sessions
      FROM (
        SELECT h.idvisit AS idvisit,
               any(j.atc) AS atc,
               any(multiIf(
                 prices.price = 0, 'unknown',
                 prices.price <= cuts.q1, 'q1',
                 prices.price <= cuts.q2, 'q2',
                 prices.price <= cuts.q3, 'q3',
                 'q4')) AS band
          ${pages.sql.replace('WHERE h.idsite', () => `LEFT JOIN (
              SELECT idvisit, avg(price) AS price
                FROM default.conversion_item
               WHERE idsite = {idsite:UInt32}
                 AND toDate(server_time) BETWEEN {start:Date} AND {end:Date}
                 AND toDate(server_time) <= today()
               GROUP BY idvisit
            ) AS prices ON prices.idvisit = CAST(h.idvisit AS UInt64)
            LEFT JOIN (
              SELECT idvisit, toUInt8(countIf(event_type = 'add_to_cart') > 0) AS atc
                FROM default.journey_events_map
               WHERE idsite = {idsite:UInt32}
                 AND server_date BETWEEN {start:Date} AND {end:Date}
                 AND server_date <= today()
               GROUP BY idvisit
            ) AS j ON j.idvisit = CAST(h.idvisit AS UInt64)
            CROSS JOIN cuts
           WHERE ${pages.template} = 'pdp'
             AND h.idsite`,
          )}
         GROUP BY h.idvisit
      )
     GROUP BY band`, {
    ...range(idsite, windows.snapshotStart, windows.snapshotEnd, hsrIds),
    ...pages.params,
  });
}

function drawerKpiQuery(idsite, windows) {
  return spec('C1', `WITH ${conversionCte()}
    SELECT toString(toStartOfWeek(v.server_date, 1)) AS week,
           'cart_drawer' AS template,
           ${deviceExpr('v')} AS device,
           ${returningExpr('v')} AS returning,
           uniqExactIf(v.idvisit, w.viewed = 1) AS sessions,
           uniqExactIf(v.idvisit, w.viewed = 1 AND w.started = 1 AND w.t_started > w.t_viewed) AS progressed,
           uniqExactIf(v.idvisit, w.viewed = 1 AND c.orders > 0) AS buyers,
           round(sumIf(c.revenue, w.viewed = 1), 2) AS revenue
      FROM default.log_visit AS v
      INNER JOIN (
        SELECT idvisit,
               toUInt8(countIf(event_type = 'cart_viewed') > 0) AS viewed,
               toUInt8(countIf(event_type = 'checkout_started') > 0) AS started,
               minIf(server_time, event_type = 'cart_viewed') AS t_viewed,
               minIf(server_time, event_type = 'checkout_started') AS t_started
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
     GROUP BY week, template, device, returning`, range(idsite, windows.trendStart, windows.trendEnd));
}

function orderValueQuery(idsite, windows) {
  return spec('C10', `SELECT multiIf(
             c.revenue < 25, '0-25',
             c.revenue < 50, '25-50',
             c.revenue < 75, '50-75',
             c.revenue < 100, '75-100',
             '100+') AS band,
           count() AS orders,
           round(sum(c.revenue), 2) AS revenue
      FROM default.log_conversion AS c FINAL
      INNER JOIN default.log_visit AS v
        ON v.idsite = {idsite:UInt32} AND v.idsite = c.idsite AND CAST(v.idvisit AS UInt64) = CAST(c.idvisit AS UInt64)
       AND ${datePredicate('v')}
     WHERE c.idsite = {idsite:UInt32}
       AND c.server_date BETWEEN {start:Date} AND {end:Date}
       AND c.server_date <= today()
       AND c.revenue > 0
       AND ${botPredicate('v')}
     GROUP BY band`, range(idsite, windows.snapshotStart, windows.snapshotEnd));
}

function abandonedValueQuery(idsite, windows) {
  return spec('C12', `SELECT toString(toStartOfWeek(server_date, 1)) AS week,
           uniqExactIf(idvisit, atc = 1 AND bought = 0) AS abandoned_sessions,
           round(sumIf(item_value, atc = 1 AND bought = 0), 2) AS abandoned_item_value,
           uniqExactIf(idvisit, bought = 1) AS completed_sessions,
           round(sumIf(order_revenue, bought = 1), 2) AS completed_revenue
      FROM (
        SELECT v.idvisit AS idvisit,
               min(v.server_date) AS server_date,
               toUInt8(countIf(j.event_type = 'add_to_cart') > 0) AS atc,
               toUInt8(countIf(j.event_type = 'checkout_completed') > 0) AS bought,
               any(ifNull(items.value, 0)) AS item_value,
               any(ifNull(c.revenue, 0)) AS order_revenue
          FROM default.log_visit AS v
          LEFT JOIN default.journey_events_map AS j
            ON j.idsite = {idsite:UInt32} AND j.idsite = v.idsite AND j.idvisit = CAST(v.idvisit AS UInt64)
           AND j.server_date BETWEEN {start:Date} AND {end:Date}
           AND j.server_date <= today()
          LEFT JOIN (
            SELECT idvisit, sum(price * quantity) AS value
              FROM default.conversion_item
             WHERE idsite = {idsite:UInt32}
               AND toDate(server_time) BETWEEN {start:Date} AND {end:Date}
               AND toDate(server_time) <= today()
             GROUP BY idvisit
          ) AS items ON items.idvisit = CAST(v.idvisit AS UInt64)
          LEFT JOIN (
            SELECT CAST(idvisit AS UInt64) AS idvisit, sum(revenue) AS revenue
              FROM default.log_conversion FINAL
             WHERE idsite = {idsite:UInt32}
               AND server_date BETWEEN {start:Date} AND {end:Date}
               AND server_date <= today()
             GROUP BY idvisit
          ) AS c ON c.idvisit = CAST(v.idvisit AS UInt64)
         WHERE v.idsite = {idsite:UInt32}
           AND ${datePredicate('v')}
           AND ${botPredicate('v')}
         GROUP BY v.idvisit
      )
     GROUP BY week`, range(idsite, windows.trendStart, windows.trendEnd));
}

function checkoutWeeklyQuery(idsite, windows) {
  return spec('K1', `SELECT toString(toStartOfWeek(v.server_date, 1)) AS week,
           ${deviceExpr('v')} AS device,
           ${returningExpr('v')} AS returning,
           ${channelExpr('v')} AS channel,
           uniqExactIf(v.idvisit, w.started = 1) AS started,
           uniqExactIf(v.idvisit, w.started = 1 AND w.done = 1 AND w.t_done > w.t_started) AS completed
      FROM default.log_visit AS v
      INNER JOIN (
        SELECT idvisit,
               toUInt8(countIf(event_type = 'checkout_started') > 0) AS started,
               toUInt8(countIf(event_type = 'checkout_completed') > 0) AS done,
               minIf(server_time, event_type = 'checkout_started') AS t_started,
               minIf(server_time, event_type = 'checkout_completed') AS t_done
          FROM default.journey_events_map
         WHERE idsite = {idsite:UInt32}
           AND server_date BETWEEN {start:Date} AND {end:Date}
           AND server_date <= today()
         GROUP BY idvisit
      ) AS w ON w.idvisit = CAST(v.idvisit AS UInt64)
     WHERE v.idsite = {idsite:UInt32}
       AND ${datePredicate('v')}
       AND ${botPredicate('v')}
     GROUP BY week, device, returning, channel`, range(idsite, windows.trendStart, windows.trendEnd));
}

function checkoutSnapshotQuery(id, idsite, start, end) {
  const built = checkoutWeeklyQuery(idsite, { trendStart: start, trendEnd: end });
  return {
    ...built,
    id,
    label: `audit:${id}`,
    params: { ...built.params, start, end },
  };
}

function checkoutReturnQuery(idsite, windows, rules, hsrIds = null) {
  const pages = pageviewJoin(rules, hsrIds);
  return spec('K6', `WITH ${conversionCte()},
    ${pagesCte(hsrIds)}
    SELECT ${deviceExpr('v')} AS device,
           uniqExactIf(v.idvisit, w.started = 1) AS started,
           uniqExactIf(v.idvisit, w.started = 1 AND back.returned = 1) AS returned,
           uniqExactIf(v.idvisit, w.started = 1 AND back.returned = 1 AND c.orders > 0) AS returned_buyers,
           uniqExactIf(v.idvisit, w.started = 1 AND c.orders > 0) AS buyers
      FROM default.log_visit AS v
      INNER JOIN (
        SELECT idvisit,
               toUInt8(countIf(event_type = 'checkout_started') > 0) AS started,
               minIf(server_time, event_type = 'checkout_started') AS t_started
          FROM default.journey_events_map
         WHERE idsite = {idsite:UInt32}
           AND server_date BETWEEN {start:Date} AND {end:Date}
           AND server_date <= today()
         GROUP BY idvisit
      ) AS w ON w.idvisit = CAST(v.idvisit AS UInt64)
      LEFT JOIN (
        SELECT h.idvisit AS idvisit,
               toUInt8(maxIf(h.server_time, ${pages.template} IN ('cart_page', 'pdp')) > any(w2.t_started)) AS returned
          ${pages.sql.replace('WHERE h.idsite', () => `INNER JOIN (
              SELECT idvisit, minIf(server_time, event_type = 'checkout_started') AS t_started
                FROM default.journey_events_map
               WHERE idsite = {idsite:UInt32}
                 AND server_date BETWEEN {start:Date} AND {end:Date}
                 AND server_date <= today()
                 AND event_type = 'checkout_started'
               GROUP BY idvisit
            ) AS w2 ON w2.idvisit = CAST(h.idvisit AS UInt64)
           WHERE h.idsite`,
          )}
         GROUP BY h.idvisit
      ) AS back ON back.idvisit = CAST(v.idvisit AS UInt64)
      LEFT JOIN conv AS c ON c.idvisit = CAST(v.idvisit AS UInt64)
     WHERE v.idsite = {idsite:UInt32}
       AND ${datePredicate('v')}
       AND ${botPredicate('v')}
     GROUP BY device`, {
    ...range(idsite, windows.snapshotStart, windows.snapshotEnd, hsrIds),
    ...pages.params,
  });
}

function checkoutFormQuery(idsite, windows) {
  return spec('K7', `SELECT toString(toStartOfWeek(j.server_date, 1)) AS week,
           j.event_type AS step,
           uniqExact(j.idvisit) AS sessions
      FROM default.journey_events_map AS j
      INNER JOIN default.log_visit AS v
        ON v.idsite = {idsite:UInt32} AND v.idsite = j.idsite AND CAST(v.idvisit AS UInt64) = j.idvisit
       AND ${datePredicate('v')}
      INNER JOIN (
        SELECT DISTINCT idvisit
          FROM default.journey_events_map
         WHERE idsite = {idsite:UInt32}
           AND server_date BETWEEN {start:Date} AND {end:Date}
           AND server_date <= today()
           AND event_type = 'checkout_started'
      ) AS started ON started.idvisit = j.idvisit
     WHERE j.idsite = {idsite:UInt32}
       AND j.server_date BETWEEN {start:Date} AND {end:Date}
       AND j.server_date <= today()
       AND j.event_type IN ('form_filled', 'form_submitted')
       AND ${botPredicate('v')}
     GROUP BY week, step`, range(idsite, windows.elementStart, windows.elementEnd));
}

function checkoutTimeQuery(idsite, windows) {
  return spec('K5', `SELECT toString(toStartOfWeek(server_date, 1)) AS week,
           device,
           quantile(0.5)(minutes) AS median_minutes,
           quantile(0.75)(minutes) AS p75_minutes
      FROM (
        SELECT min(j.server_date) AS server_date,
               any(${deviceExpr('v')}) AS device,
               dateDiff('minute', minIf(j.server_time, j.event_type = 'checkout_started'), minIf(j.server_time, j.event_type = 'checkout_completed')) AS minutes
          FROM default.journey_events_map AS j
          INNER JOIN default.log_visit AS v
            ON v.idsite = {idsite:UInt32} AND v.idsite = j.idsite AND CAST(v.idvisit AS UInt64) = j.idvisit
           AND ${datePredicate('v')}
         WHERE j.idsite = {idsite:UInt32}
           AND j.server_date BETWEEN {start:Date} AND {end:Date}
           AND j.server_date <= today()
           AND j.event_type IN ('checkout_started', 'checkout_completed')
           AND ${botPredicate('v')}
         GROUP BY j.idvisit
        HAVING minutes > 0
      )
     GROUP BY week, device`, range(idsite, windows.trendStart, windows.trendEnd));
}

function checkoutStepQuery(idsite, windows, rules, hsrIds = null) {
  const pages = pageviewJoin(rules, hsrIds);
  const path = `lower(replaceRegexpOne(splitByChar('?', ifNull(p.url, ''))[1], '^https?://[^/]+', ''))`;
  const step = `multiIf(
      position(${path}, 'thank') > 0 OR position(${path}, 'confirmation') > 0 OR position(${path}, 'processing') > 0, 'confirmation',
      position(${path}, 'payment') > 0, 'payment',
      position(${path}, 'shipping') > 0, 'shipping',
      position(${path}, 'information') > 0 OR position(${path}, 'contact') > 0, 'information',
      'checkout')`;
  return spec('K3', `WITH ${pagesCte(hsrIds)}
    SELECT toString(toStartOfWeek(h.server_date, 1)) AS week,
           ${step} AS checkout_step,
           ${deviceExpr('v')} AS device,
           uniqExact(h.idvisit) AS sessions
      ${pages.sql}
       AND ${pages.template} = 'checkout'
     GROUP BY week, checkout_step, device`, {
    ...range(idsite, windows.trendStart, windows.trendEnd, hsrIds),
    ...pages.params,
  });
}

function elementTrendQuery(idsite, windows, live, hsrIds = null) {
  const cte = matrixValuesSql(live, idsite);
  if (!cte) return null;
  return spec('H5', `WITH ${cte},
    ${conversionCte()}
    SELECT toString(toStartOfWeek(e.server_date, 1)) AS week,
           m.template AS template,
           m.element_class AS element_class,
           count() AS clicks,
           uniqExact(e.idvisit) AS clicking_sessions,
           countIf(e.meta1 = 'rage') AS rage_clicks,
           round(sum(c.revenue), 2) AS revenue
      ${clickFrom()}
      LEFT JOIN conv AS c ON c.idvisit = CAST(e.idvisit AS UInt64)
     WHERE ${clickWhere(hsrIds)}
     GROUP BY week, template, element_class`, range(idsite, windows.elementStart, windows.elementEnd, hsrIds));
}

function classQuery(id, idsite, windows, live, classes, selectList, extraWhere = '', hsrIds = null) {
  if (Array.isArray(extraWhere) || extraWhere == null) {
    hsrIds = extraWhere;
    extraWhere = '';
  }
  const wanted = live.filter((e) => classes.includes(e.element_class));
  const cte = matrixValuesSql(wanted, idsite);
  if (!cte) return null;
  return spec(id, `WITH ${cte},
    ${conversionCte()}
    SELECT ${selectList}
      ${clickFrom()}
      LEFT JOIN conv AS c ON c.idvisit = CAST(e.idvisit AS UInt64)
     WHERE ${clickWhere(hsrIds)}
       ${extraWhere}
     GROUP BY ${groupTail(selectList)}`, range(idsite, windows.snapshotStart, windows.snapshotEnd, hsrIds));
}

function heroSlideQuery(idsite, windows, live, hsrIds = null) {
  return classQuery(
    'H6',
    idsite,
    windows,
    live,
    ['home.hero_slide'],
    `m.position AS position, ${deviceExpr('v')} AS device, count() AS clicks, uniqExact(e.idvisit) AS clicking_sessions, round(sum(c.revenue), 2) AS revenue`,
    hsrIds,
  );
}

function carouselQuery(idsite, windows, live, hsrIds = null) {
  return classQuery(
    'H9',
    idsite,
    windows,
    live,
    ['home.hero_carousel_control', 'home.product_carousel_control', 'home.hero_slide', 'home.product_tile', 'home.category_tile'],
    `m.element_class AS element_class, count() AS clicks, uniqExact(e.idvisit) AS clicking_sessions`,
    hsrIds,
  );
}

function tilePositionQuery(idsite, windows, live, hsrIds = null) {
  return classQuery(
    'L7',
    idsite,
    windows,
    live,
    ['plp.product_tile_image', 'plp.product_tile_title'],
    `m.position AS position, ${deviceExpr('v')} AS device, count() AS clicks, uniqExact(e.idvisit) AS clicking_sessions, round(sum(c.revenue), 2) AS revenue`,
    `AND m.position >= 0`,
    hsrIds,
  );
}

function filterUseQuery(idsite, windows, live, hsrIds = null) {
  return classQuery(
    'L9',
    idsite,
    windows,
    live,
    ['plp.filter_open', 'plp.filter_option', 'plp.sort_control'],
    `m.element_class AS element_class, any(m.element_name) AS element_name, uniqExact(e.idvisit) AS clicking_sessions, round(sum(c.revenue), 2) AS revenue`,
    hsrIds,
  );
}

function filterFrictionQuery(idsite, windows, live, rules, hsrIds = null) {
  const wanted = live.filter((e) => e.element_class === 'plp.filter_option' || e.element_class === 'plp.filter_open');
  const cte = matrixValuesSql(wanted, idsite);
  if (!cte) return null;
  const pages = pageviewJoin(rules, hsrIds);
  return spec('L10', `WITH ${cte},
    ${pagesCte(hsrIds)}
    SELECT count() AS filter_clicks,
           countIf(e.meta1 = 'rage') AS rage_clicks,
           uniqExact(e.idvisit) AS filter_sessions,
           uniqExactIf(e.idvisit, later.saw_pdp = 0) AS filter_then_no_pdp
      ${clickFrom()}
      LEFT JOIN (
        SELECT h.idvisit AS idvisit, toUInt8(countIf(${pages.template} = 'pdp') > 0) AS saw_pdp
          ${pages.sql}
         GROUP BY h.idvisit
      ) AS later ON later.idvisit = CAST(e.idvisit AS UInt64)
     WHERE ${clickWhere(hsrIds)}`, {
    ...range(idsite, windows.snapshotStart, windows.snapshotEnd, hsrIds),
    ...pages.params,
  });
}

function quickAddQuery(idsite, windows, live, hsrIds = null) {
  const cte = matrixValuesSql(live.filter((e) => e.element_class === 'plp.quick_add'), idsite);
  if (!cte) return null;
  return spec('L11', `WITH ${cte},
    ${conversionCte()}
    SELECT uniqExactIf(v.idvisit, q.clicked = 1) AS quick_add_sessions,
           uniqExactIf(v.idvisit, q.clicked = 1 AND w.atc = 1) AS quick_add_atc,
           uniqExactIf(v.idvisit, q.clicked = 0 AND w.atc = 1 AND w.viewed = 1) AS pdp_atc,
           round(sumIf(c.revenue, q.clicked = 1 AND c.orders > 0), 2) AS quick_add_revenue,
           uniqExactIf(v.idvisit, q.clicked = 1 AND c.orders > 0) AS quick_add_buyers,
           round(sumIf(c.revenue, q.clicked = 0 AND w.atc = 1 AND c.orders > 0), 2) AS pdp_revenue,
           uniqExactIf(v.idvisit, q.clicked = 0 AND w.atc = 1 AND c.orders > 0) AS pdp_buyers
      FROM default.log_visit AS v
      LEFT JOIN (
        SELECT e.idvisit AS idvisit, toUInt8(1) AS clicked
          ${clickJoin(hsrIds)}
         GROUP BY e.idvisit
      ) AS q ON q.idvisit = CAST(v.idvisit AS UInt64)
      LEFT JOIN (
        SELECT idvisit,
               toUInt8(countIf(event_type = 'add_to_cart') > 0) AS atc,
               toUInt8(countIf(event_type = 'product_viewed') > 0) AS viewed
          FROM default.journey_events_map
         WHERE idsite = {idsite:UInt32}
           AND server_date BETWEEN {start:Date} AND {end:Date}
           AND server_date <= today()
         GROUP BY idvisit
      ) AS w ON w.idvisit = CAST(v.idvisit AS UInt64)
      LEFT JOIN conv AS c ON c.idvisit = CAST(v.idvisit AS UInt64)
     WHERE v.idsite = {idsite:UInt32}
       AND ${datePredicate('v')}
       AND ${botPredicate('v')}`, range(idsite, windows.snapshotStart, windows.snapshotEnd, hsrIds));
}

function buyBoxQuery(idsite, windows, live, hsrIds = null) {
  const classes = ['pdp.add_to_cart', 'pdp.variant_size', 'pdp.variant_color', 'pdp.size_guide', 'pdp.review_stars', 'pdp.reviews_section', 'pdp.gallery_main', 'pdp.gallery_thumbnail'];
  const cte = matrixValuesSql(live.filter((e) => classes.includes(e.element_class)), idsite);
  if (!cte) return null;
  return spec('P8', `WITH ${cte}
    SELECT uniqExact(idvisit) AS atc_sessions,
           uniqExactIf(idvisit, variant_before = 1) AS variant_before,
           uniqExactIf(idvisit, guide_before = 1) AS guide_before,
           uniqExactIf(idvisit, review_before = 1) AS review_before,
           uniqExactIf(idvisit, gallery_before = 1) AS gallery_before
      FROM (
        SELECT e.idvisit AS idvisit,
               toUInt8(minIf(e.time_since_load, m.element_class IN ('pdp.variant_size', 'pdp.variant_color')) < minIf(e.time_since_load, m.element_class = 'pdp.add_to_cart')) AS variant_before,
               toUInt8(minIf(e.time_since_load, m.element_class = 'pdp.size_guide') < minIf(e.time_since_load, m.element_class = 'pdp.add_to_cart')) AS guide_before,
               toUInt8(minIf(e.time_since_load, m.element_class IN ('pdp.review_stars', 'pdp.reviews_section')) < minIf(e.time_since_load, m.element_class = 'pdp.add_to_cart')) AS review_before,
               toUInt8(minIf(e.time_since_load, m.element_class IN ('pdp.gallery_main', 'pdp.gallery_thumbnail')) < minIf(e.time_since_load, m.element_class = 'pdp.add_to_cart')) AS gallery_before
          ${clickJoin(hsrIds)}
         GROUP BY e.idvisit
        HAVING countIf(m.element_class = 'pdp.add_to_cart') > 0
      )`, range(idsite, windows.snapshotStart, windows.snapshotEnd, hsrIds));
}

function atcFrictionQuery(idsite, windows, live, hsrIds = null) {
  const classes = ['pdp.add_to_cart', 'pdp.variant_size', 'pdp.variant_color'];
  const cte = matrixValuesSql(live.filter((e) => classes.includes(e.element_class)), idsite);
  if (!cte) return null;
  return spec('P9', `WITH ${cte}
    SELECT m.element_class AS element_class,
           count() AS clicks,
           countIf(e.meta1 = 'rage') AS rage_clicks,
           uniqExactIf(e.idvisit, m.element_class = 'pdp.add_to_cart' AND j.atc = 0) AS atc_click_without_event
      ${clickFrom()}
      LEFT JOIN (
        SELECT idvisit, toUInt8(countIf(event_type = 'add_to_cart') > 0) AS atc
          FROM default.journey_events_map
         WHERE idsite = {idsite:UInt32}
           AND server_date BETWEEN {start:Date} AND {end:Date}
           AND server_date <= today()
         GROUP BY idvisit
      ) AS j ON j.idvisit = CAST(e.idvisit AS UInt64)
     WHERE ${clickWhere(hsrIds)}
     GROUP BY element_class`, range(idsite, windows.snapshotStart, windows.snapshotEnd, hsrIds));
}

function reviewQuery(idsite, windows, live, rules, hsrIds = null) {
  const cte = matrixValuesSql(live.filter((e) => e.element_class === 'pdp.review_stars' || e.element_class === 'pdp.reviews_section'), idsite);
  if (!cte) return null;
  const pages = pageviewJoin(rules, hsrIds);
  return spec('P11', `WITH ${cte},
    ${conversionCte()},
    ${pagesCte(hsrIds)}
    SELECT uniqExactIf(v.idvisit, viewed = 1) AS pdp_sessions,
           uniqExactIf(v.idvisit, viewed = 1 AND reviewed = 1) AS review_sessions,
           uniqExactIf(v.idvisit, viewed = 1 AND reviewed = 1 AND atc = 1) AS review_atc,
           uniqExactIf(v.idvisit, viewed = 1 AND reviewed = 0 AND atc = 1) AS other_atc,
           round(sumIf(c.revenue, viewed = 1 AND reviewed = 1), 2) AS review_revenue,
           round(sumIf(c.revenue, viewed = 1 AND reviewed = 0), 2) AS other_revenue
      FROM default.log_visit AS v
      LEFT JOIN (
        SELECT h.idvisit AS idvisit, toUInt8(1) AS viewed
          ${pages.sql}
           AND ${pages.template} = 'pdp'
         GROUP BY h.idvisit
      ) AS pv ON pv.idvisit = CAST(v.idvisit AS UInt64)
      LEFT JOIN (
        SELECT e.idvisit AS idvisit, toUInt8(1) AS reviewed
          ${clickJoin(hsrIds)}
         GROUP BY e.idvisit
      ) AS rv ON rv.idvisit = v.idvisit
      LEFT JOIN (
        SELECT idvisit, toUInt8(countIf(event_type = 'add_to_cart') > 0) AS atc
          FROM default.journey_events_map
         WHERE idsite = {idsite:UInt32}
           AND server_date BETWEEN {start:Date} AND {end:Date}
           AND server_date <= today()
         GROUP BY idvisit
      ) AS w ON w.idvisit = CAST(v.idvisit AS UInt64)
      LEFT JOIN conv AS c ON c.idvisit = CAST(v.idvisit AS UInt64)
     WHERE v.idsite = {idsite:UInt32}
       AND ${datePredicate('v')}
       AND ${botPredicate('v')}`, {
    ...range(idsite, windows.snapshotStart, windows.snapshotEnd, hsrIds),
    ...pages.params,
  });
}

function contentTabQuery(idsite, windows, live, hsrIds = null) {
  return classQuery(
    'P12',
    idsite,
    windows,
    live,
    ['pdp.content_tab'],
    `m.element_name AS element_name, uniqExact(e.idvisit) AS sessions, count() AS clicks`,
    hsrIds,
  );
}

function recommendationQuery(idsite, windows, live, hsrIds = null) {
  return classQuery(
    'P13',
    idsite,
    windows,
    live,
    ['pdp.recommendation_tile', 'pdp.bundle_offer'],
    `m.element_class AS element_class, count() AS clicks, uniqExact(e.idvisit) AS clicking_sessions, round(sum(c.revenue), 2) AS revenue`,
    hsrIds,
  );
}

function expressPdpQuery(idsite, windows, live, hsrIds = null) {
  return classQuery(
    'P14',
    idsite,
    windows,
    live,
    ['pdp.express_pay', 'pdp.add_to_cart'],
    `m.element_class AS element_class, uniqExact(e.idvisit) AS clicking_sessions, round(sum(c.revenue), 2) AS revenue, uniqExactIf(e.idvisit, c.orders > 0) AS buyers`,
    hsrIds,
  );
}

function backInStockQuery(idsite, windows, live, hsrIds = null) {
  const cte = matrixValuesSql(live.filter((e) => e.element_class === 'pdp.back_in_stock'), idsite);
  if (!cte) return null;
  return spec('P15', `WITH ${cte}
    SELECT toString(toStartOfWeek(e.server_date, 1)) AS week,
           toString(e.idsitehsr) AS page,
           count() AS clicks,
           uniqExact(e.idvisit) AS clicking_sessions
      ${clickJoin(hsrIds)}
     GROUP BY week, page
     ORDER BY clicks DESC
     LIMIT 100`, range(idsite, windows.elementStart, windows.elementEnd, hsrIds));
}

function cartOutcomeQuery(idsite, windows, live, hsrIds = null) {
  const classes = ['cart.close', 'cart.continue_shopping', 'cart.line_item_link', 'cart.checkout_button'];
  const cte = matrixValuesSql(live.filter((e) => classes.includes(e.element_class)), idsite);
  if (!cte) return null;
  return spec('C6', `WITH ${cte}
    SELECT m.template AS template,
           m.element_class AS element_class,
           uniqExact(e.idvisit) AS sessions
      ${clickJoin(hsrIds)}
     AND m.template IN ('cart_drawer', 'cart_page')
     GROUP BY template, element_class`, range(idsite, windows.snapshotStart, windows.snapshotEnd, hsrIds));
}

function drawerTriggerQuery(idsite, windows, live, hsrIds = null) {
  const cte = matrixValuesSql(live.filter((e) => e.element_class === 'global.cart_icon'), idsite);
  if (!cte) return null;
  return spec('C7', `WITH ${cte}
    SELECT uniqExactIf(w.idvisit, icon.clicked = 1) AS icon_then_cart,
           uniqExactIf(w.idvisit, icon.clicked = 0) AS cart_without_icon
      FROM (
        SELECT idvisit
          FROM default.journey_events_map
         WHERE idsite = {idsite:UInt32}
           AND server_date BETWEEN {start:Date} AND {end:Date}
           AND server_date <= today()
           AND event_type = 'cart_viewed'
         GROUP BY idvisit
      ) AS w
      LEFT JOIN (
        SELECT e.idvisit AS idvisit, toUInt8(1) AS clicked
          ${clickJoin(hsrIds)}
         GROUP BY e.idvisit
      ) AS icon ON icon.idvisit = w.idvisit`, range(idsite, windows.snapshotStart, windows.snapshotEnd, hsrIds));
}

function cartEditQuery(idsite, windows, live, hsrIds = null) {
  return classQuery(
    'C8',
    idsite,
    windows,
    live,
    ['cart.quantity', 'cart.remove'],
    `m.element_class AS element_class, uniqExact(e.idvisit) AS sessions, count() AS clicks`,
    hsrIds,
  );
}

function upsellQuery(idsite, windows, live, hsrIds = null) {
  return classQuery(
    'C9',
    idsite,
    windows,
    live,
    ['cart.upsell_tile'],
    `m.element_class AS element_class, count() AS clicks, uniqExact(e.idvisit) AS clicking_sessions, round(sum(c.revenue), 2) AS revenue, uniqExactIf(e.idvisit, c.orders > 0) AS buyers`,
    hsrIds,
  );
}

function discountFrictionQuery(idsite, windows, live, hsrIds = null) {
  return classQuery(
    'C11',
    idsite,
    windows,
    live,
    ['cart.discount_code', 'checkout.discount_field'],
    `m.element_class AS element_class, count() AS clicks, countIf(e.meta1 = 'rage') AS rage_clicks, uniqExact(e.idvisit) AS sessions, uniqExactIf(e.idvisit, c.orders > 0) AS buyers`,
    hsrIds,
  );
}

function expressCartQuery(idsite, windows, live, hsrIds = null) {
  return classQuery(
    'C13',
    idsite,
    windows,
    live,
    ['cart.express_checkout', 'cart.checkout_button'],
    `m.element_class AS element_class, uniqExact(e.idvisit) AS sessions, uniqExactIf(e.idvisit, c.orders > 0) AS buyers`,
    hsrIds,
  );
}

function navQuery(idsite, windows, live, rules, hsrIds = null) {
  const cte = matrixValuesSql(live.filter((e) => e.element_class === 'global.nav_item' || e.element_class === 'global.nav_menu_link'), idsite);
  if (!cte) return null;
  const pages = pageviewJoin(rules, hsrIds);
  return spec('G3', `WITH ${cte},
    ${conversionCte()},
    ${pagesCte(hsrIds)}
    SELECT m.element_name AS element_name,
           ${pages.template} AS template,
           count() AS clicks,
           uniqExact(e.idvisit) AS clicking_sessions,
           round(sum(c.revenue), 2) AS revenue
      ${clickFrom()}
      INNER JOIN pages AS p ON p.idsitehsr = h.idsitehsr
      LEFT JOIN conv AS c ON c.idvisit = CAST(e.idvisit AS UInt64)
     WHERE ${clickWhere(hsrIds)}
     GROUP BY element_name, template
     ORDER BY clicks DESC
     LIMIT 100`, {
    ...range(idsite, windows.snapshotStart, windows.snapshotEnd, hsrIds),
    ...pages.params,
  });
}

function popupQuery(idsite, windows, live, hsrIds = null) {
  return classQuery(
    'G4',
    idsite,
    windows,
    live,
    ['global.popup'],
    `m.element_name AS element_name, ${deviceExpr('v')} AS device, count() AS clicks, uniqExact(e.idvisit) AS sessions, round(avg(${timeOnPageSecondsExpr('h')}), 2) AS time_on_page_seconds, round(sum(c.revenue), 2) AS revenue, uniqExactIf(e.idvisit, c.orders > 0) AS buyers`,
    hsrIds,
  );
}

function chatQuery(idsite, windows, live, hsrIds = null) {
  const cte = matrixValuesSql(live.filter((e) => e.element_class === 'global.chat_widget'), idsite);
  if (!cte) return null;
  return spec('G5', `WITH ${cte},
    ${conversionCte()}
    SELECT uniqExactIf(v.idvisit, chat.clicked = 1) AS chat_sessions,
           uniqExactIf(v.idvisit, chat.clicked = 1 AND c.orders > 0) AS chat_buyers,
           round(sumIf(c.revenue, chat.clicked = 1), 2) AS chat_revenue,
           uniqExactIf(v.idvisit, chat.clicked = 0) AS other_sessions,
           uniqExactIf(v.idvisit, chat.clicked = 0 AND c.orders > 0) AS other_buyers
      FROM default.log_visit AS v
      LEFT JOIN (
        SELECT e.idvisit AS idvisit, toUInt8(1) AS clicked
          ${clickJoin(hsrIds)}
         GROUP BY e.idvisit
      ) AS chat ON chat.idvisit = v.idvisit
      LEFT JOIN conv AS c ON c.idvisit = CAST(v.idvisit AS UInt64)
     WHERE v.idsite = {idsite:UInt32}
       AND ${datePredicate('v')}
       AND ${botPredicate('v')}`, range(idsite, windows.snapshotStart, windows.snapshotEnd, hsrIds));
}

function unmatchedQuery(idsite, windows, live, rules, hsrIds = null) {
  const cte = matrixValuesSql(live, idsite);
  if (!cte) return null;
  const pages = pageviewJoin(rules, hsrIds);
  return spec('G6', `WITH ${cte},
    ${pagesCte(hsrIds)}
    SELECT ${pages.template} AS template,
           e.selector AS path,
           count() AS clicks
      FROM default.log_hsr_event AS e
      INNER JOIN default.log_hsr AS h
        ON h.idsite = e.idsite AND h.idsitehsr = e.idsitehsr
       AND h.server_date = e.server_date
       AND h.idvisit = e.idvisit AND h.idloghsr = e.idloghsr
      INNER JOIN pages AS p ON p.idsitehsr = h.idsitehsr
      INNER JOIN default.log_visit AS v
        ON v.idsite = {idsite:UInt32} AND v.idsite = e.idsite AND CAST(v.idvisit AS UInt64) = CAST(e.idvisit AS UInt64)
       AND ${datePredicate('v')}
      LEFT JOIN element_matrix AS m
        ON m.idsite = e.idsite
       AND m.template = ${pages.template}
       AND match(ifNull(e.selector, ''), m.selector_match)
       AND e.server_date BETWEEN m.valid_from AND m.valid_to
     WHERE e.idsite = {idsite:UInt32}
       AND ${datePredicate('e')}
       ${hsrClauseSql('e', hsrIds)}
       AND h.idsite = {idsite:UInt32}
       AND ${datePredicate('h')}
       ${hsrClauseSql('h', hsrIds)}
       AND e.event_type = 2
       AND ${botPredicate('v')}
       AND m.idsite = 0
     GROUP BY template, path
     ORDER BY clicks DESC
     LIMIT 50`, {
    ...range(idsite, windows.snapshotStart, windows.snapshotEnd, hsrIds),
    ...pages.params,
  });
}

function frustrationQuery(idsite, windows, live, hsrIds = null) {
  const cte = matrixValuesSql(live, idsite);
  if (!cte) return null;
  return spec('G7', `WITH ${cte}
    SELECT toString(toStartOfWeek(e.server_date, 1)) AS week,
           m.template AS template,
           m.element_class AS element_class,
           countIf(e.meta1 = 'rage') AS rage_clicks,
           countIf(e.meta1 IN ('dead', 'deadclick')) AS dead_clicks,
           count() AS clicks
      ${clickJoin(hsrIds)}
     GROUP BY week, template, element_class`, range(idsite, windows.elementStart, windows.elementEnd, hsrIds));
}

function exposureQuery(idsite, windows, live, hsrIds = null) {
  const cte = matrixValuesSql(live, idsite);
  if (!cte) return null;
  return spec('H8', `WITH ${cte},
    ${conversionCte()}
    SELECT m.template AS template,
           m.element_class AS element_class,
           ${deviceExpr('v')} AS device,
           uniqExactIf(z.idvisit, z.dw > 0) AS exposed_sessions,
           round(sumIf(c.revenue, z.dw > 0), 2) AS exposed_revenue
      FROM default.udp_am_zones AS z
      INNER JOIN default.udp_am_elements AS el
        ON el.idsite = z.idsite
       AND el.idsitehsr = z.idsitehsr
       AND el.server_date = z.server_date
       AND CAST(el.idloghsr AS UInt64) = CAST(z.idloghsr AS UInt64)
      INNER JOIN element_matrix AS m
        ON m.idsite = el.idsite
       AND match(ifNull(el.selector, ''), m.selector_match)
       AND z.server_date BETWEEN m.valid_from AND m.valid_to
      INNER JOIN default.log_visit AS v
        ON v.idsite = {idsite:UInt32} AND v.idsite = z.idsite AND CAST(v.idvisit AS UInt64) = CAST(z.idvisit AS UInt64)
       AND ${datePredicate('v')}
      LEFT JOIN conv AS c ON c.idvisit = CAST(z.idvisit AS UInt64)
     WHERE z.idsite = {idsite:UInt32}
       AND z.server_date BETWEEN {start:Date} AND {end:Date}
       AND z.server_date <= today()
       ${hsrClauseSql('z', hsrIds)}
       AND el.idsite = {idsite:UInt32}
       AND el.server_date BETWEEN {start:Date} AND {end:Date}
       AND el.server_date <= today()
       ${hsrClauseSql('el', hsrIds)}
       AND ${botPredicate('v')}
     GROUP BY template, element_class, device`, range(idsite, windows.snapshotStart, windows.snapshotEnd, hsrIds));
}
