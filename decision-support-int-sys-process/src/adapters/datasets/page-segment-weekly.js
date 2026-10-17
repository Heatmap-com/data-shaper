import { missingColumns, scrollScaleConfirmed } from '../_lib/checks.js';
import { deviceName, refererName, returningName } from '../_lib/dims.js';
import { fetchSessionRows, filtersFor } from '../_lib/session-stream.js';
import { returningEra } from '../_lib/sql.js';
import { pageViewportHeights, viewportClass } from '../_lib/viewport.js';

/**
 * page-segment-weekly: the page's entry sessions by week, device, referrer,
 * returning flag (split at 2026-09-07), browser family, dominant viewport
 * class, and bot filter. Fills the atomic analysis columns and rules 1, 2,
 * 9, 13. Grain per DATA-GENERATION-PLAN Phase 3 (H06 browser cut, H07
 * viewport class); numbers use the measurement contract, not the facet canon.
 */

export const adapter = {
  id: 'page-segment-weekly',
  dependsOn: [],
  scope: 'page',
  provides: ['H01', 'H02', 'H23', 'H06', 'H07'],

  /**
   * @param {import('../../../ports/qualifier.js').QualifiedPage} page
   * @param {import('../../../ports/dataset.js').RunContext} ctx
   */
  async collect(page, ctx) {
    const missing = await missingColumns(ctx, 'udp_hsrce_visits', ['visitor_returning', 'custom_var_k5']);
    if (missing.length > 0) {
      return {
        id: adapter.id,
        rows: [],
        notes: { page_segment_weekly_blocked: `missing columns: ${missing.join(', ')}` },
      };
    }

    const scaleConfirmed = await scrollScaleConfirmed(ctx, page);
    const [sessions, heights] = await Promise.all([
      fetchSessionRows(ctx, page.idsite, { idsitehsr: page.idsitehsr }),
      pageViewportHeights(ctx, page),
    ]);
    const hsr = String(page.idsitehsr);

    /** @type {Map<string, object>} */
    const cells = new Map();
    const cellFor = (dims) => {
      const key = JSON.stringify(dims);
      let cell = cells.get(key);
      if (!cell) {
        cell = {
          dims,
          sessions: 0,
          singlePageview: 0,
          sub5s: 0,
          zeroTime: 0,
          productViewed: 0,
          addToCart: 0,
          checkoutStarted: 0,
          checkoutNoProduct: 0,
          orders: 0,
          revenue: 0,
          scroll25: 0,
          scroll50: 0,
          scroll70: 0,
          scroll75: 0,
          scroll100: 0,
          times: [],
        };
        cells.set(key, cell);
      }
      return cell;
    };

    let ordersOnExcluded = 0;
    for (const s of sessions) {
      if (s.entryHsr !== hsr) continue;
      if (s.tier === 'confirmed' && s.orders > 0) ordersOnExcluded += s.orders;
      const baseDims = {
        week: s.week,
        device: deviceName(s.device),
        referer: refererName(s.referer),
        returning: returningName(s.returning),
        returning_era: returningEra(s.firstDate),
        browser: s.browser.trim().toLowerCase() === '' ? 'unknown' : s.browser.trim().toLowerCase(),
        viewport_class: viewportClass(heights.get(s.idvisit) ?? 0),
      };
      for (const filter of filtersFor(s.tier)) {
        const cell = cellFor({ ...baseDims, bot_filter: filter });
        cell.sessions += 1;
        if (s.pageviews === 1) cell.singlePageview += 1;
        if (s.pageCappedMs < 5000) cell.sub5s += 1;
        if (s.pageCappedMs === 0) cell.zeroTime += 1;
        if (s.sawProduct) cell.productViewed += 1;
        if (s.sawAtc) cell.addToCart += 1;
        if (s.sawCheckout) {
          cell.checkoutStarted += 1;
          if (!s.sawProduct) cell.checkoutNoProduct += 1;
        }
        cell.orders += s.orders;
        cell.revenue += s.revenue;
        if (s.scrollMax >= 250) cell.scroll25 += 1;
        if (s.scrollMax >= 500) cell.scroll50 += 1;
        if (s.scrollMax >= 700) cell.scroll70 += 1;
        if (s.scrollMax >= 750) cell.scroll75 += 1;
        if (s.scrollMax >= 1000) cell.scroll100 += 1;
        if (s.landingPageviews > 0) cell.times.push(s.pageCappedMs);
      }
    }

    const rows = [...cells.values()].map((cell) => {
      const { dims, times, ...acc } = cell;
      times.sort((a, b) => a - b);
      const mid = times.length % 2 === 1 ? times[(times.length - 1) / 2] : times.length > 0 ? (times[times.length / 2 - 1] + times[times.length / 2]) / 2 : null;
      return {
        dims,
        metrics: {
          sessions: acc.sessions,
          single_pageview_sessions: acc.singlePageview,
          sub_5s_sessions: acc.sub5s,
          zero_time_sessions: acc.zeroTime,
          product_viewed_sessions: acc.productViewed,
          add_to_cart_sessions: acc.addToCart,
          checkout_started_sessions: acc.checkoutStarted,
          checkout_without_product_view_sessions: acc.checkoutNoProduct,
          orders_udp: acc.orders,
          revenue_udp: round2(acc.revenue),
          sessions_scroll_ge_25pct: acc.scroll25,
          sessions_scroll_ge_50pct: acc.scroll50,
          sessions_scroll_ge_70pct: acc.scroll70,
          sessions_scroll_ge_75pct: acc.scroll75,
          sessions_scroll_ge_100pct: acc.scroll100,
          median_time_on_page_ms: mid == null ? null : Math.round(mid),
        },
      };
    });

    return {
      id: adapter.id,
      rows,
      notes: {
        scroll_scale_confirmed: scaleConfirmed,
        scroll_scale_note: scaleConfirmed ? 'scroll_y_max_relative is 0-1000 for 0-100 percent' : 'scroll scale NOT confirmed; scroll thresholds must not drive triggers',
        orders_on_excluded_confirmed_sessions: ordersOnExcluded,
      },
    };
  },
};

/** @param {number} n */
function round2(n) {
  return Math.round(n * 100) / 100;
}
