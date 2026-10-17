import { pageMemo } from './page-memo.js';
import { PAGE_VISITS } from './sql.js';

/**
 * Viewport-class helpers shared by the Phase-3 datasets. page-segment-weekly
 * attaches the session's dominant viewport class to its grain; viewport-weekly
 * (same phase) counts sessions per class. Both read pageViewportHeights.
 *
 * The CTE keeps one row per pageview with a non-null viewport height, for
 * the visits that entered or viewed the page; the dominant CTE folds those
 * to one height per session (most frequent pageview height, ties to the
 * larger height).
 */

export const VIEWPORTS_CTE = `
viewports AS (
    SELECT CAST(idvisit AS UInt64) AS idvisit,
           viewport_h_px AS h
    FROM default.udp_hsrce_pageviews
    WHERE idsite = {idsite:UInt32} AND server_date BETWEEN {w0:Date} AND {w1:Date}
      AND viewport_h_px IS NOT NULL
      AND CAST(idvisit AS UInt64) IN ${PAGE_VISITS}
)`;

export const VIEWPORT_DOMINANT_CTE = `
viewport AS (
    SELECT idvisit, argMax(h, (n, h)) AS h
    FROM (
        SELECT idvisit, h, count() AS n
        FROM viewports
        GROUP BY idvisit, h
    )
    GROUP BY idvisit
)`;

/**
 * The dominant viewport height per session of the visits that entered or
 * viewed the page, memoized per page. Sessions without a viewport height
 * are absent.
 *
 * @param {import('../../ports/dataset.js').RunContext} ctx
 * @param {{idsite: number, idsitehsr: number}} page
 * @returns {Promise<Map<string, number>>} idvisit -> height in px
 */
export function pageViewportHeights(ctx, page) {
  return pageMemo(ctx, `viewport-heights:${page.idsite}:${page.idsitehsr}`, async () => {
    const rows = await ctx.gateway.query(
      `WITH
${VIEWPORTS_CTE},
${VIEWPORT_DOMINANT_CTE}
SELECT toString(idvisit) AS idvisit, h
  FROM viewport`,
      { idsite: page.idsite, idsitehsr: page.idsitehsr, w0: ctx.windowStart, w1: ctx.windowEnd },
      'viewport:heights',
    );
    return new Map(rows.map((r) => [String(r.idvisit), Number(r.h)]));
  });
}

/**
 * @param {number | null | undefined} h viewport height in px
 * @returns {'small' | 'medium' | 'large' | 'unknown'}
 */
export function viewportClass(h) {
  const height = Number(h);
  if (!Number.isFinite(height) || height <= 0) return 'unknown';
  if (height <= 667) return 'small';
  if (height <= 900) return 'medium';
  return 'large';
}
