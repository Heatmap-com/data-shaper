import { scrollScaleConfirmed } from '../_lib/checks.js';
import { deviceName, refererName } from '../_lib/dims.js';
import { pageMemo } from '../_lib/page-memo.js';
import { fetchSessionRows, filtersFor } from '../_lib/session-stream.js';

/**
 * scroll-decile: the chosen page's scroll reach curve per week, device, and
 * referrer. Effective depth uses the fold floor per the data plan:
 * scroll_eff = greatest(scroll_y_max_relative, fold_y_relative) per pageview,
 * maxed over the page's pageviews per session. depth_bin is 0..100 in steps
 * of 10 on the confirmed 0-1000 scale; a session counts in every bin it
 * reached, sessions_at_max_bin shows where each session's maximum sits, and
 * sessions_no_scroll counts sessions whose scroll_eff was 0 or null on every
 * pageview of the page. Rules 3 and 4.
 */

export const adapter = {
  id: 'scroll-decile',
  dependsOn: [],
  scope: 'page',
  provides: ['H08'],

  /**
   * @param {import('../../../ports/qualifier.js').QualifiedPage} page
   * @param {import('../../../ports/dataset.js').RunContext} ctx
   */
  async collect(page, ctx) {
    const scaleConfirmed = await scrollScaleConfirmed(ctx, page);
    const [sessions, scrollEffByVisit] = await Promise.all([
      fetchSessionRows(ctx, page.idsite, { idsitehsr: page.idsitehsr }),
      fetchScrollEff(ctx, page),
    ]);
    const hsr = String(page.idsitehsr);

    /** @type {Map<string, object>} slice -> {dims, entrySessions, noScroll, bins: Map<bin, {reached, atMax}>} */
    const slices = new Map();
    for (const s of sessions) {
      if (s.entryHsr !== hsr) continue;
      const base = { week: s.week, device: deviceName(s.device), referer: refererName(s.referer) };
      const scrollEff = scrollEffByVisit.get(s.idvisit) ?? 0;
      const maxBin = Math.min(Math.floor(scrollEff / 100), 10) * 10;
      for (const filter of filtersFor(s.tier)) {
        const dims = { ...base, bot_filter: filter };
        const key = JSON.stringify(dims);
        let slice = slices.get(key);
        if (!slice) {
          slice = { dims, entrySessions: 0, noScroll: 0, bins: new Map() };
          slices.set(key, slice);
        }
        slice.entrySessions += 1;
        if (scrollEff <= 0) slice.noScroll += 1;
        for (let bin = 0; bin <= 100; bin += 10) {
          if (scrollEff < bin * 10) break;
          let b = slice.bins.get(bin);
          if (!b) {
            b = { reached: 0, atMax: 0 };
            slice.bins.set(bin, b);
          }
          b.reached += 1;
          if (bin === maxBin) b.atMax += 1;
        }
      }
    }

    const rows = [];
    for (const slice of slices.values()) {
      for (let bin = 0; bin <= 100; bin += 10) {
        const b = slice.bins.get(bin) ?? { reached: 0, atMax: 0 };
        rows.push({
          dims: { ...slice.dims, depth_bin: bin },
          metrics: {
            entry_sessions: slice.entrySessions,
            sessions_reached: b.reached,
            sessions_at_max_bin: b.atMax,
            sessions_no_scroll: slice.noScroll,
          },
        });
      }
    }

    return {
      id: adapter.id,
      rows,
      notes: {
        scroll_scale_confirmed: scaleConfirmed,
        scroll_scale_note: scaleConfirmed ? 'scroll_y_max_relative is 0-1000 for 0-100 percent' : 'scroll scale NOT confirmed; scroll thresholds must not drive triggers',
      },
    };
  },
};

/**
 * Per-session max effective scroll depth on the page:
 * greatest(ifNull(scroll_y_max_relative, 0), ifNull(fold_y_relative, 0))
 * over the page's pageviews. A session absent from the map (no pageviews)
 * counts as scroll_eff 0, i.e. no-scroll.
 * @param {import('../../../ports/dataset.js').RunContext} ctx
 * @param {{idsite: number, idsitehsr: number}} page
 * @returns {Promise<Map<string, number>>} idvisit -> scroll_eff (0-1000)
 */
async function fetchScrollEff(ctx, page) {
  return pageMemo(ctx, `scroll-eff:${page.idsite}:${page.idsitehsr}`, async () => {
    const rows = await ctx.gateway.query(
      `SELECT toString(idvisit) AS idvisit,
              max(greatest(ifNull(scroll_y_max_relative, 0), ifNull(fold_y_relative, 0))) AS scroll_eff
         FROM default.udp_hsrce_pageviews
        WHERE idsite = {idsite:UInt32} AND idsitehsr = {idsitehsr:UInt64}
          AND server_date BETWEEN {w0:Date} AND {w1:Date}
        GROUP BY idvisit`,
      { idsite: page.idsite, idsitehsr: page.idsitehsr, w0: ctx.windowStart, w1: ctx.windowEnd },
      'scroll-decile:scroll-eff',
    );
    /** @type {Map<string, number>} */
    const byVisit = new Map();
    for (const r of rows) byVisit.set(r.idvisit, Number(r.scroll_eff));
    return byVisit;
  });
}
