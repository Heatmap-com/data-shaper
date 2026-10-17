import { pageMemo } from './page-memo.js';
import { PAGE_VISITS } from './sql.js';

/**
 * Non-empty udp_session_tags rows in the window for the visits that entered
 * or viewed the page, memoized per page so campaign-coverage and
 * campaign-weekly share one scan. A visit with several rows takes the
 * smallest, as the day record does, so runs repeat.
 */

/**
 * @param {import('../../ports/dataset.js').RunContext} ctx
 * @param {{idsite: number, idsitehsr: number}} page
 * @returns {Promise<Map<string, string>>} key: idvisit as string, value: raw session_tags JSON
 */
export async function fetchSessionTags(ctx, page) {
  return pageMemo(ctx, `session-tags:${page.idsite}:${page.idsitehsr}`, async () => {
    const rows = await ctx.gateway.query(
      `SELECT toString(idvisit) AS idvisit, min(session_tags) AS tag_json
         FROM default.udp_session_tags
        WHERE idsite = {idsite:UInt32} AND server_date BETWEEN {w0:Date} AND {w1:Date}
          AND session_tags NOT IN ('{}', '')
          AND CAST(idvisit AS UInt64) IN ${PAGE_VISITS}
        GROUP BY idvisit`,
      { idsite: page.idsite, idsitehsr: page.idsitehsr, w0: ctx.windowStart, w1: ctx.windowEnd },
      'session-tags:rows',
    );
    /** @type {Map<string, string>} */
    const byVisit = new Map();
    for (const r of rows) byVisit.set(r.idvisit, String(r.tag_json ?? ''));
    return byVisit;
  });
}
