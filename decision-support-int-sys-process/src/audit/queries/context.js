/**
 * Context acquisition queries: campaigns, speed, experiments, and the
 * industry series. Computed series (X1, X6) are built in interpret.js.
 */

import { trackedIds } from '../bounds.js';
import { botPredicate, conversionCte, datePredicate, hsrClauseSql, pagesCte, pageviewJoin } from '../sql.js';
import { range, spec } from './_lib.js';

/**
 * @param {number} idsite
 * @param {object} windows
 * @param {Array<{pattern: string, template: string}>} rules
 */
export function contextAcquisitionQueries(idsite, windows, rules, scope = null) {
  const ids = trackedIds(scope);
  return [
    campaignQuery(idsite, windows, rules, ids),
    speedQuery(idsite, windows, rules, ids),
    experimentQuery(idsite, windows, rules, ids),
    industryQuery(idsite, windows),
  ];
}

function campaignQuery(idsite, windows, rules, hsrIds = null) {
  const pages = pageviewJoin(rules, hsrIds);
  return spec('X2', `WITH ${conversionCte()},
    ${pagesCte(hsrIds)}
    SELECT utm_source, utm_medium, utm_campaign, entry_template AS template,
           uniqExact(idvisit) AS sessions,
           uniqExactIf(idvisit, orders > 0) AS buyers,
           round(sum(revenue), 2) AS revenue
      FROM (
        SELECT st.idvisit AS idvisit,
               JSONExtractString(st.session_tags, 'utm_source') AS utm_source,
               JSONExtractString(st.session_tags, 'utm_medium') AS utm_medium,
               JSONExtractString(st.session_tags, 'utm_campaign') AS utm_campaign,
               argMin(${pages.template}, h.server_time) AS entry_template,
               any(ifNull(c.orders, 0)) AS orders,
               any(ifNull(c.revenue, 0)) AS revenue
          FROM default.session_tags AS st
          INNER JOIN default.log_hsr AS h
            ON h.idsite = st.idsite AND h.idsitehsr = st.idsitehsr AND h.idloghsr = st.idloghsr
           AND h.server_date = st.server_date
          INNER JOIN pages AS p ON p.idsitehsr = h.idsitehsr
          INNER JOIN default.log_visit AS v
            ON v.idsite = {idsite:UInt32} AND v.idsite = st.idsite AND CAST(v.idvisit AS UInt64) = st.idvisit
           AND ${datePredicate('v')}
          LEFT JOIN conv AS c ON c.idvisit = st.idvisit
         WHERE st.idsite = {idsite:UInt32}
           AND st.server_date BETWEEN {start:Date} AND {end:Date}
           AND st.server_date <= today()
           ${hsrClauseSql('st', hsrIds)}
           AND h.idsite = {idsite:UInt32}
           AND ${datePredicate('h')}
           ${hsrClauseSql('h', hsrIds)}
           AND ${botPredicate('v')}
           AND JSONExtractString(st.session_tags, 'utm_source') != ''
         GROUP BY st.idvisit, utm_source, utm_medium, utm_campaign
      )
     GROUP BY utm_source, utm_medium, utm_campaign, template
     ORDER BY sessions DESC
     LIMIT 100`, {
    ...range(idsite, windows.snapshotStart, windows.snapshotEnd, hsrIds),
    ...pages.params,
  });
}

function speedQuery(idsite, windows, rules, hsrIds = null) {
  const pages = pageviewJoin(rules, hsrIds);
  return spec('X3', `WITH ${pagesCte(hsrIds)}
    SELECT ${pages.template} AS template,
           quantile(0.5)(s.lcp_ms) AS lcp_ms_p50,
           quantile(0.5)(s.fcp_ms) AS fcp_ms_p50,
           count() AS rows
      FROM journey_events.page_speed_cache AS s
      INNER JOIN pages AS p
        ON positionCaseInsensitive(s.url, p.url) > 0 OR positionCaseInsensitive(p.url, s.url) > 0
     WHERE s.idsite = {idsite:UInt32}
       AND toDate(s.fetched_at) BETWEEN {start:Date} AND {end:Date}
       AND p.url != ''
     GROUP BY template`, {
    ...range(idsite, windows.snapshotStart, windows.snapshotEnd, hsrIds),
    ...pages.params,
  });
}

function experimentQuery(idsite, windows, rules, hsrIds = null) {
  const pages = pageviewJoin(rules, hsrIds);
  return spec('X4', `WITH ${conversionCte()},
    ${pagesCte(hsrIds)}
    SELECT partner, experience, variant, template,
           uniqExact(idvisit) AS sessions,
           uniqExactIf(idvisit, orders > 0) AS buyers,
           round(sum(revenue), 2) AS revenue
      FROM (
        SELECT pt.idvisit AS idvisit,
               pt.partner AS partner,
               pt.experience_id AS experience,
               pt.variant_id AS variant,
               any(${pages.template}) AS template,
               any(ifNull(c.orders, 0)) AS orders,
               any(ifNull(c.revenue, 0)) AS revenue
          FROM default.partner_tags AS pt
          INNER JOIN default.log_hsr AS h
            ON h.idsite = pt.idsite AND h.idsitehsr = pt.idsitehsr AND h.idloghsr = pt.idloghsr
           AND h.server_date = pt.server_date
          INNER JOIN pages AS p ON p.idsitehsr = h.idsitehsr
          INNER JOIN default.log_visit AS v
            ON v.idsite = {idsite:UInt32} AND v.idsite = pt.idsite AND CAST(v.idvisit AS UInt64) = pt.idvisit
           AND ${datePredicate('v')}
          LEFT JOIN conv AS c ON c.idvisit = pt.idvisit
         WHERE pt.idsite = {idsite:UInt32}
           AND pt.server_date BETWEEN {start:Date} AND {end:Date}
           AND pt.server_date <= today()
           ${hsrClauseSql('pt', hsrIds)}
           AND h.idsite = {idsite:UInt32}
           AND ${datePredicate('h')}
           ${hsrClauseSql('h', hsrIds)}
           AND ${botPredicate('v')}
         GROUP BY pt.idvisit, partner, experience, variant
      )
     GROUP BY partner, experience, variant, template
     ORDER BY sessions DESC
     LIMIT 100`, {
    ...range(idsite, windows.snapshotStart, windows.snapshotEnd, hsrIds),
    ...pages.params,
  });
}

function industryQuery(idsite, windows) {
  return spec('X8', `SELECT toString(server_date) AS week,
           toFloat64(conversion_rate) AS conversion_rate,
           toFloat64(revenue_per_session) AS rps,
           toFloat64(average_order_value) AS aov,
           sessions,
           purchasers
      FROM default.industry_insight
     WHERE server_date BETWEEN {start:Date} AND {end:Date}
       AND server_date <= today()
       AND {idsite:UInt32} > 0
     ORDER BY week`, range(idsite, windows.snapshotStart, windows.snapshotEnd));
}
