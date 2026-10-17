import { eachDate } from '../../triggers/time.js';
import { createClickTable } from './click-table.js';
import { pageMemo } from './page-memo.js';
import { ENTRY_VISITS_CTE, PAGE_VISITS } from './sql.js';

/**
 * Raw click rows for the chosen page, memoized per page so selector-weekly,
 * rage-clicks, tap-geometry-weekly, nav-next-page, and product-grid share
 * one read. The read runs one window day per query into a click table, so
 * no more than a day of rows is ever parsed at once.
 * Position comes from a_x / a_y (the element's place on the page). The
 * cursor columns x / y follow scroll and run off the document for a
 * fixed or off-canvas control, so they are not read.
 */

/**
 * @param {import('../../ports/dataset.js').RunContext} ctx
 * @param {{idsite: number, idsitehsr: number}} page
 * @returns {Promise<ReturnType<typeof createClickTable>>} the page's entry-session clicks, in day order
 */
export async function getClickRows(ctx, page) {
  return pageMemo(ctx, `clicks:${page.idsite}:${page.idsitehsr}`, async () => {
    const sql = `
WITH
${ENTRY_VISITS_CTE},
clicks AS (
    SELECT idvisit, idloghsr, idselector, idsite, idsitehsr, server_date,
           toDateTime(concat(date, ' ', hour, ':00:00')) AS server_time,
           meta1, a_x, a_y, time_since_load
    FROM default.udp_clicksce_clicks
    WHERE idsite = {idsite:UInt32}
      AND idsitehsr = {idsitehsr:UInt64}
      AND server_date = {day:Date}
)
SELECT toString(c.idvisit) AS idvisit,
       toString(c.idloghsr) AS idloghsr,
       c.idselector AS selector,
       toMonday(c.server_date) AS week,
       toString(c.server_date) AS date,
       toString(c.server_time) AS server_time,
       c.meta1 AS meta1,
       c.a_x AS x,
       c.a_y AS y,
       ifNull(c.time_since_load, -1) AS time_since_load
FROM clicks c
INNER JOIN entry e ON e.idvisit = CAST(c.idvisit AS UInt64)
`;
    const table = createClickTable();
    for (const day of eachDate(ctx.windowStart, ctx.windowEnd)) {
      const rows = await ctx.gateway.query(
        sql,
        {
          idsite: page.idsite,
          idsitehsr: page.idsitehsr,
          hsr: String(page.idsitehsr),
          w0: ctx.windowStart,
          w1: ctx.windowEnd,
          day,
        },
        'clicks:page',
      );
      for (const r of rows) {
        table.push({
          idvisit: r.idvisit,
          idloghsr: r.idloghsr,
          selector: String(r.selector ?? ''),
          week: r.week,
          date: r.date,
          serverTime: String(r.server_time ?? ''),
          meta1: String(r.meta1 ?? ''),
          x: r.x == null ? null : Number(r.x),
          y: r.y == null ? null : Number(r.y),
          timeSinceLoad: Number(r.time_since_load),
        });
      }
    }
    return table;
  });
}

/**
 * Pageview sequences (idvisit ordered) of the visits that entered or viewed
 * the page, memoized per page. Used by nav-next-page to find where a
 * clicker went next.
 *
 * @param {import('../../ports/dataset.js').RunContext} ctx
 * @param {{idsite: number, idsitehsr: number}} page
 * @returns {Promise<Map<string, Array<{idloghsr: string, hsr: string}>>>}
 */
export async function getPageviewSequences(ctx, page) {
  return pageMemo(ctx, `pvs:${page.idsite}:${page.idsitehsr}`, async () => {
    const rows = await ctx.gateway.query(
      `SELECT toString(idvisit) AS idvisit, toString(idloghsr) AS idloghsr, toString(idsitehsr) AS hsr
         FROM default.udp_hsrce_pageviews
        WHERE idsite = {idsite:UInt32} AND server_date BETWEEN {w0:Date} AND {w1:Date}
          AND CAST(idvisit AS UInt64) IN ${PAGE_VISITS}
        ORDER BY idvisit, server_time, idloghsr`,
      { idsite: page.idsite, idsitehsr: page.idsitehsr, w0: ctx.windowStart, w1: ctx.windowEnd },
      'pageviews:sequences',
    );
    /** @type {Map<string, Array<{idloghsr: string, hsr: string}>>} */
    const byVisit = new Map();
    for (const r of rows) {
      const seq = byVisit.get(r.idvisit) ?? [];
      seq.push({ idloghsr: r.idloghsr, hsr: r.hsr });
      byVisit.set(r.idvisit, seq);
    }
    return byVisit;
  });
}
