import { scrollScaleConfirmed } from '../_lib/checks.js';
import { deviceName } from '../_lib/dims.js';
import { ENTRY_VISITS_CTE, isFullWeek, mondayWeeks } from '../_lib/sql.js';

/**
 * strategy-triggers: the catalog's trigger table (lp-strategies.md "Trigger
 * rules"), encoded as data. It reads ctx.datasets and applies the thresholds
 * from IMPLEMENTATION-PLAN.md section 8. Two checks query when the stored
 * rows do not carry them: the scroll-scale flag, and each entry session's
 * viewport height for the hero fold. A replacement rule file is a new
 * adapter depending on the same datasets.
 *
 * States: blocked (a needed dataset/column/unit is absent), below_floor
 * (pattern visible, volume floor failed), triggered (comparison holds and
 * the floor passed), silent (data exists, comparison does not hold).
 *
 * Floors: a within-class comparison needs >= 10 clicking sessions on each
 * element in the week being read; a page-level rate needs >= 30 entry
 * sessions in the slice. Partial weeks are excluded from trigger rows.
 */

const FLOOR_CLICKING_SESSIONS = 10;
const FLOOR_ENTRY_SESSIONS = 30;
/** Order-rate lead required before a later item is a promotion. */
const PROMOTION_RATE_BAR = 1.25;
/** Share of entry sessions that must see the hero CTA above the fold. */
const ABOVE_FOLD_MIN_SHARE = 0.85;

/**
 * strategyId -> rule ids, the reverse of the trigger table's candidate
 * strategies column.
 */
export const STRATEGY_RULES = {
  J2: [1],
  B1: [2],
  B6: [2],
  A1: [2, 12],
  J1: [2],
  C5: [3],
  G3: [3],
  G4: [3],
  C1: [3, 4],
  B3: [4, 9],
  D3: [4, 9],
  D1: [5],
  F1: [5],
  F2: [5],
  B2: [5],
  E2: [5, 10],
  B5: [6],
  B4: [6],
  E3: [7],
  D6: [7, 8],
  E4: [7, 10],
  D7: [8],
  H2: [8, 9],
  H1: [9],
  C7: [9],
  E1: [10],
  K1: [11],
  K2: [11],
  D5: [11],
  A5: [12],
  A7: [12],
  A6: [13],
  A2: [13],
  L1: [13],
  F4: [14],
  F3: [14],
  F7: [14],
  P1: [15],
  P2: [16],
  P3: [17],
  P4: [18],
};

/** @param {Array<{dims: object, metrics: object}>} rows @param {string} tier */
function byTier(rows, tier = 'exclude_confirmed') {
  return rows.filter((r) => (r.dims.bot_filter ?? tier) === tier);
}

/** @param {Array<{metrics: object}>} rows @param {string} key */
const sum = (rows, key) => rows.reduce((a, r) => a + (Number(r.metrics[key]) || 0), 0);

/** @param {number} n */
const r4 = (n) => Math.round(n * 10000) / 10000;

/**
 * @param {import('../../../ports/dataset.js').RunContext} ctx
 * @param {import('../../../ports/qualifier.js').QualifiedPage} page
 */
function readInputs(ctx, page) {
  const seg = ctx.datasets.get('page-segment-weekly')?.rows ?? [];
  const notes = ctx.datasets.get('page-segment-weekly')?.notes ?? {};
  const channel = ctx.datasets.get('entry-by-channel')?.rows ?? [];
  const decile = ctx.datasets.get('scroll-decile')?.rows ?? [];
  const selector = ctx.datasets.get('selector-weekly')?.rows ?? [];
  const rage = ctx.datasets.get('rage-clicks');
  const nav = ctx.datasets.get('nav-next-page');
  const country = ctx.datasets.get('page-country')?.rows ?? [];
  const campaign = ctx.datasets.get('campaign-weekly')?.rows ?? [];
  const hist = ctx.datasets.get('order-value-hist')?.rows ?? [];

  // LP reads the last LP.window_days complete days inside the batch window
  // (Appendix B, B2): with a 7-day batch nothing is filtered, so parity
  // holds; weekly-grained datasets cut at the Monday week that straddles
  // the cutoff, the finest cut their grain allows.
  const lpWindowDays = ctx.standards?.catalogs?.LP?.window_days ?? 7;
  const batchDays = Math.round((Date.parse(`${ctx.windowEnd}T00:00:00Z`) - Date.parse(`${ctx.windowStart}T00:00:00Z`)) / 86400000) + 1;
  const lpDays = Math.min(lpWindowDays, batchDays);
  const lpStart = new Date(`${ctx.windowEnd}T00:00:00Z`);
  lpStart.setUTCDate(lpStart.getUTCDate() - (lpDays - 1));
  const lpMonday = mondayWeeks(lpStart.toISOString().slice(0, 10), ctx.windowEnd)[0];

  const segX = byTier(seg).filter((r) => !r.dims.week || r.dims.week >= lpMonday);
  const totals = {
    sessions: sum(segX, 'sessions'),
    orders: sum(segX, 'orders_udp'),
    revenue: sum(segX, 'revenue_udp'),
    singlePageview: sum(segX, 'single_pageview_sessions'),
    scroll25: sum(segX, 'sessions_scroll_ge_25pct'),
    scroll70: sum(segX, 'sessions_scroll_ge_70pct'),
  };
  const deviceSlices = ['desktop', 'mobile'].map((device) => {
    const rows = segX.filter((r) => r.dims.device === device);
    const sessions = sum(rows, 'sessions');
    const revenue = sum(rows, 'revenue_udp');
    return { device, sessions, revenue, rps: sessions > 0 ? revenue / sessions : null };
  });

  const fullWeeks = mondayWeeks(ctx.windowStart, ctx.windowEnd).filter((w) =>
    isFullWeek(w, ctx.windowStart, ctx.windowEnd),
  );
  const weekly = fullWeeks.map((week) => {
    const rows = segX.filter((r) => r.dims.week === week);
    return {
      week,
      sessions: sum(rows, 'sessions'),
      singlePageviewShare: safeDiv(sum(rows, 'single_pageview_sessions'), sum(rows, 'sessions')),
    };
  });

  return {
    notes,
    totals,
    deviceSlices,
    weekly,
    channelX: byTier(channel),
    pageHsr: String(page.idsitehsr),
    decileX: byTier(decile).filter((r) => !r.dims.week || r.dims.week >= lpMonday),
    selectorX: byTier(selector),
    rageRows: rage ? byTier(rage.rows) : null,
    rageUnitUnknown: rage?.notes?.rage_clicks_unit === 'unknown',
    navRows: nav ? byTier(nav.rows) : null,
    navBlocked:
      nav?.notes?.nav_next_page_blocked === true ||
      /blocked/.test(String(nav?.notes?.nav_next_page_note ?? '')),
    countryX: byTier(country),
    campaignX: byTier(campaign),
    histX: byTier(hist),
    scaleConfirmed: notes.scroll_scale_confirmed === true,
  };
}

/** @param {number} a @param {number} b */
function safeDiv(a, b) {
  return b > 0 ? a / b : null;
}

/**
 * Runs the 18 rules. Each returns {state, metric?, value?, threshold?, detail?}.
 * @param {ReturnType<typeof readInputs>} in_
 */
function runRules(in_) {
  const { totals, deviceSlices, weekly, scaleConfirmed } = in_;
  const pageRps = safeDiv(totals.revenue, totals.sessions);
  const pageOrderRate = safeDiv(totals.orders, totals.sessions);
  const results = {};

  // Rule 1: weekly session or single-pageview share steps and stays.
  {
    const rate = (w) => w.singlePageviewShare;
    if (weekly.length < 2) {
      results[1] = { state: 'silent', detail: 'fewer than two full weeks in the window; a weekly step cannot be established' };
    } else {
      const prev = weekly[weekly.length - 2];
      const last = weekly[weekly.length - 1];
      if (last.sessions < FLOOR_ENTRY_SESSIONS || prev.sessions < FLOOR_ENTRY_SESSIONS) {
        results[1] = { state: 'below_floor', metric: 'single_pageview_share', value: r4(rate(last)), threshold: 'step >= 5pp', detail: 'under 30 entry sessions in a compared week' };
      } else {
        const step = Math.abs(rate(last) - rate(prev));
        results[1] = step >= 0.05
          ? { state: 'triggered', metric: 'single_pageview_share', value: r4(rate(last)), threshold: 'step >= 5pp', detail: `week ${last.week} steps ${(step * 100).toFixed(1)}pp from ${prev.week}` }
          : { state: 'silent', metric: 'single_pageview_share', value: r4(rate(last)), threshold: 'step >= 5pp' };
      }
    }
  }

  // Rule 2: visitors leave on the first screen.
  {
    if (!scaleConfirmed) {
      results[2] = { state: 'blocked', metric: 'scroll_reach_25', detail: 'scroll scale not confirmed' };
    } else if (totals.sessions < FLOOR_ENTRY_SESSIONS) {
      results[2] = { state: 'below_floor', metric: 'scroll_reach_25', value: r4(safeDiv(totals.scroll25, totals.sessions)), threshold: '< 0.30' };
    } else {
      const reach25 = safeDiv(totals.scroll25, totals.sessions);
      const others = in_.channelX.filter(
        (r) => String(r.dims.idsitehsr) !== in_.pageHsr && Number(r.metrics.sessions) >= 20,
      );
      // compare single-pageview share against the site's other entry URLs
      const otherShares = others
        .map((r) => safeDiv(Number(r.metrics.single_pageview_sessions), Number(r.metrics.sessions)))
        .filter((v) => v != null);
      const ourShare = safeDiv(totals.singlePageview, totals.sessions);
      const aboveOthers = otherShares.length > 0 && ourShare != null && ourShare > Math.max(...otherShares);
      results[2] = reach25 != null && (reach25 < 0.3 || aboveOthers)
        ? { state: 'triggered', metric: 'scroll_reach_25', value: r4(reach25), threshold: '< 0.30 or single-pageview share above other entry URLs', detail: aboveOthers ? 'single-pageview share above all other entry URLs' : 'under 30% reach 25% depth' }
        : { state: 'silent', metric: 'scroll_reach_25', value: r4(reach25), threshold: '< 0.30' };
    }
  }

  // Rule 3: visitors scroll but do not act.
  {
    if (in_.decileX.length === 0) {
      results[3] = { state: 'blocked', metric: 'rps', detail: 'scroll-decile absent' };
    } else {
      const reached70 = sum(in_.decileX.filter((r) => Number(r.dims.depth_bin) === 70), 'sessions_reached');
      const at0 = sum(in_.decileX.filter((r) => Number(r.dims.depth_bin) === 0), 'entry_sessions');
      const deepShare = safeDiv(reached70, at0);
      const otherRps = in_.channelX
        .filter((r) => Number(r.metrics.sessions) >= 20)
        .map((r) => safeDiv(Number(r.metrics.revenue_udp), Number(r.metrics.sessions)))
        .filter((v) => v != null)
        .sort((a, b) => a - b);
      const medianOther = otherRps.length > 0 ? otherRps[Math.floor(otherRps.length / 2)] : null;
      if (deepShare == null || medianOther == null || pageRps == null) {
        results[3] = { state: 'silent', metric: 'rps', detail: 'insufficient comparison data' };
      } else {
        results[3] = deepShare >= 0.5 && pageRps < medianOther
          ? { state: 'triggered', metric: 'rps', value: r4(pageRps), threshold: `below median other entry URL RPS ${r4(medianOther)} with >= 50% deep scroll (${r4(deepShare)})` }
          : { state: 'silent', metric: 'rps', value: r4(pageRps), threshold: 'deep scroll and below-site RPS' };
      }
    }
  }

  // Rule 4: hero CTA above the fold. The element's top is above a
  // session's fold when that session's viewport is taller than the top.
  results[4] = in_.heroFold;

  // Rule 5: sibling controls diverge (same class, 10 clicking sessions each).
  {
    const byClass = new Map();
    for (const r of in_.selectorX) {
      const cls = r.dims.element_class;
      if (!cls) continue;
      const list = byClass.get(cls) ?? [];
      list.push(r);
      byClass.set(cls, list);
    }
    if (byClass.size === 0) {
      results[5] = { state: 'blocked', metric: 'same_class_gap', detail: 'no element classes available' };
    } else {
      let best = null;
      for (const [cls, rows] of byClass) {
        const byWeek = new Map();
        for (const r of rows) {
          const list = byWeek.get(r.dims.week) ?? [];
          list.push(r);
          byWeek.set(r.dims.week, list);
        }
        for (const [week, weekRows] of byWeek) {
          const eligible = weekRows.filter((r) => Number(r.metrics.clicking_sessions) >= FLOOR_CLICKING_SESSIONS);
          if (eligible.length < 2) continue;
          const clickRates = eligible.map((r) => safeDiv(Number(r.metrics.clicks), Number(r.metrics.entry_sessions))).filter((v) => v != null);
          const orderRates = eligible.map((r) => safeDiv(Number(r.metrics.sessions_with_order), Number(r.metrics.clicking_sessions))).filter((v) => v != null);
          const gap = (rates) => (rates.length >= 2 ? Math.max(...rates) / Math.min(...rates) : 1);
          const clickGap = gap(clickRates);
          const orderGap = gap(orderRates);
          if (Math.max(clickGap, orderGap) >= 2 && (!best || Math.max(clickGap, orderGap) > best.gap)) {
            best = { cls, week, gap: Math.max(clickGap, orderGap), clickGap, orderGap };
          }
        }
      }
      results[5] = best
        ? { state: 'triggered', metric: 'same_class_gap', value: r4(best.gap), threshold: '>= 2x within one class and week, 10 clicking sessions each', detail: `class ${best.cls} week ${best.week} click gap ${best.clickGap.toFixed(2)}x order gap ${best.orderGap.toFixed(2)}x` }
        : { state: 'silent', metric: 'same_class_gap', threshold: '>= 2x within one class and week, 10 clicking sessions each', detail: 'no qualifying same-class pair' };
    }
  }

  // Rule 6: hero CTA clickers underperform the page.
  {
    const hero = in_.selectorX.filter((r) => r.dims.element_class === 'hero_cta');
    if (hero.length === 0) {
      results[6] = { state: 'blocked', metric: 'hero_cta_order_rate', detail: 'no hero_cta classed selectors' };
    } else {
      const clickers = sum(hero, 'clicking_sessions');
      const clickerOrders = sum(hero, 'sessions_with_order');
      const rate = safeDiv(clickerOrders, clickers);
      results[6] = rate != null && pageOrderRate != null && rate < pageOrderRate
        ? { state: 'triggered', metric: 'hero_cta_order_rate', value: r4(rate), threshold: `below page order rate ${r4(pageOrderRate)}` }
        : { state: 'silent', metric: 'hero_cta_order_rate', value: r4(rate), threshold: 'below page order rate' };
    }
  }

  // Rule 7: element with 20+ clicks and zero revenue.
  {
    const offenders = in_.selectorX.filter((r) => Number(r.metrics.clicks) >= 20 && Number(r.metrics.revenue_udp) === 0);
    results[7] = offenders.length > 0
      ? { state: 'triggered', metric: 'clicks_with_zero_revenue', value: offenders.length, threshold: '>= 20 clicks and $0 revenue', detail: offenders.slice(0, 5).map((r) => r.dims.selector).join(' | ') }
      : { state: 'silent', metric: 'clicks_with_zero_revenue', threshold: '>= 20 clicks and $0 revenue' };
  }

  // Rule 8: repeated rapid clicks.
  {
    if (in_.rageRows == null) {
      results[8] = { state: 'blocked', metric: 'rage_sessions', detail: 'rage-clicks dataset absent' };
    } else if (in_.rageUnitUnknown) {
      results[8] = { state: 'blocked', metric: 'rage_sessions', detail: 'time_since_load unit not confirmed' };
    } else {
      const rages = sum(in_.rageRows, 'rage_sessions');
      results[8] = rages > 0
        ? { state: 'triggered', metric: 'rage_sessions', value: rages, threshold: '3+ clicks on one selector within 2 seconds' }
        : { state: 'silent', metric: 'rage_sessions', value: 0, threshold: '3+ clicks on one selector within 2 seconds' };
    }
  }

  // Rule 9: mobile far behind desktop.
  {
    const desktop = deviceSlices.find((d) => d.device === 'desktop');
    const mobile = deviceSlices.find((d) => d.device === 'mobile');
    if (!desktop || !mobile || desktop.rps == null || mobile.rps == null) {
      results[9] = { state: 'blocked', metric: 'mobile_to_desktop_rps', detail: 'device slices unavailable' };
    } else if (desktop.sessions < FLOOR_ENTRY_SESSIONS || mobile.sessions < FLOOR_ENTRY_SESSIONS) {
      results[9] = { state: 'below_floor', metric: 'mobile_to_desktop_rps', value: r4(mobile.rps / desktop.rps), threshold: '< 0.4', detail: `under ${FLOOR_ENTRY_SESSIONS} sessions in a device slice (desktop ${desktop.sessions}, mobile ${mobile.sessions})` };
    } else {
      const ratio = mobile.rps / desktop.rps;
      results[9] = ratio < 0.4
        ? { state: 'triggered', metric: 'mobile_to_desktop_rps', value: r4(ratio), threshold: '< 0.4', detail: `mobile RPS ${r4(mobile.rps)} vs desktop ${r4(desktop.rps)}` }
        : { state: 'silent', metric: 'mobile_to_desktop_rps', value: r4(ratio), threshold: '< 0.4' };
    }
  }

  // Rule 10: nav heavily used.
  {
    if (in_.navRows == null || in_.navBlocked || in_.navRows.length === 0) {
      results[10] = { state: 'blocked', metric: 'nav_click_share', detail: in_.navBlocked ? 'nav selectors not classed' : 'nav-next-page absent or empty' };
    } else if (totals.sessions < FLOOR_ENTRY_SESSIONS) {
      results[10] = { state: 'below_floor', metric: 'nav_click_share', detail: 'under 30 entry sessions' };
    } else {
      const navClickers = sum(in_.navRows, 'clicking_sessions');
      const navOrders = sum(in_.navRows, 'sessions_with_order');
      const share = safeDiv(navClickers, totals.sessions);
      const navOrderRate = safeDiv(navOrders, navClickers);
      const direction = navOrderRate != null && pageOrderRate != null && navOrderRate < pageOrderRate ? 'e1_strip_nav' : 'e2_reorder_nav';
      results[10] = share != null && share > 0.1
        ? { state: 'triggered', metric: 'nav_click_share', value: r4(share), threshold: '> 0.10 of entry sessions', detail: direction }
        : { state: 'silent', metric: 'nav_click_share', value: r4(share), threshold: '> 0.10 of entry sessions' };
    }
  }

  // Rule 11: cart opened but closed.
  {
    const close = in_.selectorX.filter((r) => r.dims.element_class === 'cart_drawer_close');
    const checkout = in_.selectorX.filter((r) => r.dims.element_class === 'cart_checkout');
    if (close.length === 0 && checkout.length === 0) {
      results[11] = { state: 'blocked', metric: 'drawer_close_vs_checkout', detail: 'drawer/checkout selectors not classed' };
    } else {
      const closeClicks = sum(close, 'clicks');
      const checkoutClicks = sum(checkout, 'clicks');
      results[11] = checkoutClicks > 0 && closeClicks >= 3 * checkoutClicks
        ? { state: 'triggered', metric: 'drawer_close_vs_checkout', value: r4(closeClicks / checkoutClicks), threshold: 'close clicks several times checkout clicks', detail: `close ${closeClicks} vs checkout ${checkoutClicks}` }
        : { state: 'silent', metric: 'drawer_close_vs_checkout', value: checkoutClicks > 0 ? r4(closeClicks / checkoutClicks) : null, threshold: 'close clicks several times checkout clicks' };
    }
  }

  // Rule 12: one campaign or country lags.
  {
    const segments = [
      ...in_.countryX.map((r) => ({ kind: 'country', key: r.dims.country, sessions: Number(r.metrics.sessions), revenue: Number(r.metrics.revenue_udp), orders: Number(r.metrics.orders_udp) })),
      ...in_.campaignX.map((r) => ({ kind: 'campaign', key: `${r.dims.utm_source}/${r.dims.utm_campaign}`, sessions: Number(r.metrics.sessions), revenue: Number(r.metrics.revenue_udp), orders: Number(r.metrics.orders_udp) })),
    ].filter((s) => s.sessions >= FLOOR_ENTRY_SESSIONS);
    if (segments.length === 0) {
      results[12] = { state: 'blocked', metric: 'segment_rps_lag', detail: 'no country or campaign segments with volume' };
    } else {
      const laggers = [];
      for (const s of segments) {
        const others = segments.filter((o) => o !== s && o.kind === s.kind);
        const otherRps = others.map((o) => safeDiv(o.revenue, o.sessions)).filter((v) => v != null).sort((a, b) => a - b);
        const medianOther = otherRps[Math.floor(otherRps.length / 2)];
        const rps = safeDiv(s.revenue, s.sessions);
        if (rps != null && medianOther != null && s.orders >= 3 && rps < 0.5 * medianOther) {
          laggers.push({ ...s, rps, medianOther });
        }
      }
      results[12] = laggers.length > 0
        ? { state: 'triggered', metric: 'segment_rps_lag', value: laggers.length, threshold: 'RPS well below other segments, volume floor', detail: laggers.slice(0, 5).map((l) => `${l.kind} ${l.key} rps ${r4(l.rps)} vs median ${r4(l.medianOther)}`).join(' | ') }
        : { state: 'silent', metric: 'segment_rps_lag', threshold: 'RPS well below other segments, volume floor' };
    }
  }

  // Rule 13: sister page outperforms for the same channel.
  {
    const ours = in_.channelX.filter((r) => String(r.dims.idsitehsr) === in_.pageHsr && Number(r.metrics.sessions) > 0);
    if (ours.length === 0) {
      results[13] = { state: 'blocked', metric: 'sister_page_rps', detail: 'entry-by-channel has no rows for the page' };
    } else if (pageRps == null) {
      results[13] = { state: 'silent', metric: 'sister_page_rps', detail: 'page RPS unavailable' };
    } else {
      const better = [];
      for (const cell of ours) {
        const referer = cell.dims.referer;
        const siblings = in_.channelX.filter(
          (r) => r.dims.referer === referer && String(r.dims.idsitehsr) !== String(cell.dims.idsitehsr) && Number(r.metrics.sessions) >= 20,
        );
        for (const sib of siblings) {
          const sibRps = safeDiv(Number(sib.metrics.revenue_udp), Number(sib.metrics.sessions));
          if (sibRps != null && sibRps > pageRps) better.push({ referer, url: sib.metrics.url ?? sib.dims.idsitehsr, sibRps });
        }
      }
      results[13] = better.length > 0
        ? { state: 'triggered', metric: 'sister_page_rps', value: r4(pageRps), threshold: 'higher RPS on another entry URL in the same referrer', detail: better.slice(0, 5).map((b) => `${b.referer}: ${b.url} rps ${r4(b.sibRps)}`).join(' | ') }
        : { state: 'silent', metric: 'sister_page_rps', value: r4(pageRps), threshold: 'higher RPS on another entry URL in the same referrer' };
    }
  }

  // Rule 14: order values bunch below a round threshold.
  {
    const buckets = in_.histX.filter((r) => !r.dims.kind);
    if (buckets.length === 0) {
      results[14] = { state: 'blocked', metric: 'modal_revenue_bucket', detail: 'order-value-hist has no bucket rows' };
    } else {
      const modal = buckets.reduce((a, b) => (Number(a.metrics.orders) >= Number(b.metrics.orders) ? a : b));
      const label = String(modal.dims.bucket);
      // the open bucket (200+) is values at or above the threshold; it cannot
      // be read as bunching just below one
      const open = label.includes('+');
      const upper = open ? null : Number(label.split('-')[1]);
      const round = upper != null && [50, 100, 150, 200].includes(upper) ? upper : null;
      results[14] = round != null
        ? { state: 'triggered', metric: 'modal_revenue_bucket', value: label, threshold: `round threshold ${round}`, detail: `modal bucket ${label} sits just below ${round}` }
        : { state: 'silent', metric: 'modal_revenue_bucket', value: label, threshold: 'bunching just below a round threshold', detail: open ? 'modal bucket is the open bucket; nothing bunches just below a threshold' : 'no modal bunching just below $50/$100/$150/$200' };
    }
  }

  results[15] = promoteByPosition(in_.selectorX, 'product_tile');
  results[16] = promoteByPosition(in_.selectorX, 'faq_item');
  results[17] = promoteMenu(in_.selectorX);
  results[18] = promoteAnyClassAboveFold(in_.selectorX);

  return results;
}

/**
 * Aggregate exclude_confirmed selector rows into one member per selector.
 * Smaller median_y is higher on the page.
 * @param {import('../../ports/dataset.js').DatasetRow[]} rows
 * @param {string} className
 */
function membersOf(rows, className) {
  /** @type {Map<string, {selector: string, clicking: number, orders: number, revenue: number, entry: number, ySum: number, yWeight: number}>} */
  const bySelector = new Map();
  for (const row of rows) {
    if (row.dims.element_class !== className) continue;
    if (row.dims.bot_filter && row.dims.bot_filter !== 'exclude_confirmed') continue;
    const selector = String(row.dims.selector ?? '');
    if (!selector) continue;
    const cur = bySelector.get(selector) ?? {
      selector,
      clicking: 0,
      orders: 0,
      revenue: 0,
      entry: 0,
      ySum: 0,
      yWeight: 0,
    };
    const clicks = Number(row.metrics.clicks) || 0;
    cur.clicking += Number(row.metrics.clicking_sessions) || 0;
    cur.orders += Number(row.metrics.sessions_with_order) || 0;
    cur.revenue += Number(row.metrics.revenue_udp) || 0;
    cur.entry = Math.max(cur.entry, Number(row.metrics.entry_sessions) || 0);
    const y = Number(row.metrics.median_y);
    if (Number.isFinite(y) && clicks > 0) {
      cur.ySum += y * clicks;
      cur.yWeight += clicks;
    }
    bySelector.set(selector, cur);
  }
  return [...bySelector.values()].map((m) => ({
    selector: m.selector,
    clicking: m.clicking,
    orderRate: m.clicking > 0 ? m.orders / m.clicking : null,
    rps: m.entry > 0 ? m.revenue / m.entry : null,
    y: m.yWeight > 0 ? m.ySum / m.yWeight : null,
  }));
}

/**
 * The class leader on order rate sits below a worse sibling.
 * @param {import('../../ports/dataset.js').DatasetRow[]} rows
 * @param {string} className
 */
function promoteByPosition(rows, className) {
  const all = membersOf(rows, className);
  const metric = `${className}_promotion`;
  if (all.length < 2) {
    return { state: 'blocked', metric, detail: `fewer than two ${className} selectors are classed` };
  }
  const eligible = all.filter((m) => m.clicking >= FLOOR_CLICKING_SESSIONS && m.orderRate != null && m.y != null);
  if (eligible.length < 2) {
    return {
      state: 'below_floor',
      metric,
      detail: `need two ${className} selectors with ${FLOOR_CLICKING_SESSIONS}+ clicking sessions and a click y`,
    };
  }
  const winner = [...eligible].sort((a, b) => b.orderRate - a.orderRate)[0];
  const buriedUnder = eligible.filter(
    (m) => m.selector !== winner.selector && m.orderRate * PROMOTION_RATE_BAR <= winner.orderRate && m.y + 50 < winner.y,
  );
  if (buriedUnder.length > 0) {
    return {
      state: 'triggered',
      metric,
      value: winner.selector,
      detail: `${className} ${winner.selector} order rate ${winner.orderRate.toFixed(3)} sits below ${buriedUnder[0].selector}`,
    };
  }
  return { state: 'silent', metric, value: winner.selector, detail: `${className} leader is already above weaker siblings` };
}

/** @param {import('../../ports/dataset.js').DatasetRow[]} rows */
function promoteMenu(rows) {
  const all = membersOf(rows, 'nav_link');
  const metric = 'nav_link_promotion';
  if (all.length < 2) {
    return { state: 'blocked', metric, detail: 'fewer than two nav_link selectors are classed' };
  }
  const eligible = all.filter((m) => m.clicking >= FLOOR_CLICKING_SESSIONS && m.orderRate != null);
  if (eligible.length < 2) {
    return { state: 'below_floor', metric, detail: `need two nav_link selectors with ${FLOOR_CLICKING_SESSIONS}+ clicking sessions` };
  }
  const byRate = [...eligible].sort((a, b) => b.orderRate - a.orderRate);
  const byClicks = [...eligible].sort((a, b) => b.clicking - a.clicking);
  const winner = byRate[0];
  const mostClicked = byClicks[0];
  if (winner.selector !== mostClicked.selector && mostClicked.orderRate != null && winner.orderRate >= mostClicked.orderRate * PROMOTION_RATE_BAR) {
    return {
      state: 'triggered',
      metric,
      value: winner.selector,
      detail: `nav_link ${winner.selector} converts at ${winner.orderRate.toFixed(3)} versus most-clicked ${mostClicked.selector} at ${mostClicked.orderRate.toFixed(3)}`,
    };
  }
  return { state: 'silent', metric, value: winner.selector, detail: 'the highest-converting menu item is also the most clicked' };
}

/** @param {import('../../ports/dataset.js').DatasetRow[]} rows */
function promoteAnyClassAboveFold(rows) {
  const classes = [...new Set(rows.map((r) => r.dims.element_class).filter(Boolean))];
  const metric = 'above_fold_promotion';
  if (classes.length === 0) {
    return { state: 'blocked', metric, detail: 'no element classes on the page' };
  }
  const hits = [];
  for (const className of classes) {
    const verdict = promoteByPosition(rows, className);
    if (verdict.state === 'triggered') hits.push(verdict);
  }
  if (hits.length > 0) {
    return {
      state: 'triggered',
      metric,
      value: hits[0].value,
      detail: hits.map((h) => h.detail).join('; '),
    };
  }
  const anyPair = classes.some((className) => membersOf(rows, className).length >= 2);
  if (!anyPair) {
    return { state: 'blocked', metric, detail: 'no element class has two classed selectors to compare' };
  }
  return { state: 'silent', metric, detail: 'no class has a revenue leader sitting below a weaker sibling' };
}

/**
 * @param {Record<number, {state: string}>} ruleResults
 * @param {number[]} ruleIds
 */
function strategyState(ruleResults, ruleIds) {
  const states = ruleIds.map((id) => ruleResults[id]?.state ?? 'blocked');
  if (states.includes('triggered')) return 'triggered';
  if (states.every((s) => s === 'blocked')) return 'blocked';
  if (states.includes('below_floor')) return 'below_floor';
  return 'silent';
}

/**
 * Tops of hero_cta elements, one y per device. Tablet uses the desktop top
 * when the capture has no tablet box.
 * @param {Array<{device: string, y: number}>} boxes
 * @returns {Map<string, number>}
 */
export function heroTopsByDevice(boxes) {
  /** @type {Map<string, number>} */
  const byDevice = new Map();
  for (const box of boxes) {
    const prev = byDevice.get(box.device);
    if (prev == null || box.y < prev) byDevice.set(box.device, box.y);
  }
  if (!byDevice.has('tablet') && byDevice.has('desktop')) byDevice.set('tablet', byDevice.get('desktop'));
  return byDevice;
}

/**
 * Share of sessions whose viewport is taller than the hero CTA's top.
 * @param {Array<{device: string, y: number}>} boxes
 * @param {Array<{device: string, h: number, sessions: number}>} viewports
 */
export function aboveFoldShare(boxes, viewports) {
  const tops = heroTopsByDevice(boxes);
  let sessions = 0;
  let above = 0;
  for (const row of viewports) {
    const y = tops.get(row.device);
    if (y == null || !(row.sessions > 0) || !(row.h > 0)) continue;
    sessions += row.sessions;
    if (row.h > y) above += row.sessions;
  }
  return { sessions, above, share: sessions > 0 ? above / sessions : null };
}

/**
 * @param {import('../../../ports/dataset.js').RunContext} ctx
 */
function heroBoxes(ctx) {
  const selectors = new Set(
    (ctx.datasets.get('element-binding')?.rows ?? [])
      .filter((row) => row.dims.element_class === 'hero_cta' && row.dims.selector)
      .map((row) => String(row.dims.selector)),
  );
  /** @type {Array<{device: string, y: number}>} */
  const boxes = [];
  for (const row of ctx.datasets.get('render-snapshot')?.rows ?? []) {
    if (row.dims.node_kind !== 'element' || !selectors.has(String(row.dims.selector ?? ''))) continue;
    const y = Number(row.metrics.y);
    const device = String(row.dims.device_class ?? '');
    if (!device || !Number.isFinite(y)) continue;
    boxes.push({ device, y });
  }
  return boxes;
}

/**
 * Dominant viewport height on this page, for entry sessions.
 * @param {import('../../../ports/dataset.js').RunContext} ctx
 * @param {{idsite: number, idsitehsr: number}} page
 */
async function fetchEntryViewports(ctx, page) {
  const rows = await ctx.gateway.query(
    `WITH
${ENTRY_VISITS_CTE},
heights AS (
    SELECT CAST(idvisit AS UInt64) AS idvisit, viewport_h_px AS h, count() AS n
    FROM default.udp_hsrce_pageviews
    WHERE idsite = {idsite:UInt32}
      AND idsitehsr = {idsitehsr:UInt64}
      AND server_date BETWEEN {w0:Date} AND {w1:Date}
      AND viewport_h_px > 0
    GROUP BY idvisit, viewport_h_px
),
dominant AS (
    SELECT idvisit, argMax(h, (n, h)) AS h
    FROM heights
    GROUP BY idvisit
),
device AS (
    SELECT CAST(idvisit AS UInt64) AS idvisit,
           toUInt8(argMin(config_device_type, visit_first_action_time)) AS device_type
    FROM default.udp_hsrce_visits
    WHERE idsite = {idsite:UInt32} AND server_date BETWEEN {w0:Date} AND {w1:Date}
    GROUP BY idvisit
)
SELECT d.device_type AS device_type, p.h AS h, count() AS sessions
FROM dominant AS p
INNER JOIN entry AS e ON e.idvisit = p.idvisit
INNER JOIN device AS d ON d.idvisit = p.idvisit
GROUP BY device_type, h`,
    {
      idsite: page.idsite,
      idsitehsr: page.idsitehsr,
      hsr: String(page.idsitehsr),
      w0: ctx.windowStart,
      w1: ctx.windowEnd,
    },
    'strategy-triggers:hero-fold',
  );
  return rows.map((row) => ({
    device: deviceName(Number(row.device_type)),
    h: Number(row.h),
    sessions: Number(row.sessions),
  }));
}

/**
 * @param {import('../../../ports/dataset.js').RunContext} ctx
 * @param {{idsite: number, idsitehsr: number}} page
 */
async function measureHeroFold(ctx, page) {
  const metric = 'hero_above_fold';
  const boxes = heroBoxes(ctx);
  if (boxes.length === 0) {
    return { state: 'blocked', metric, detail: 'no hero_cta box on the render' };
  }
  if (!ctx.gateway?.query) {
    return { state: 'blocked', metric, detail: 'viewport heights unavailable' };
  }
  const counted = aboveFoldShare(boxes, await fetchEntryViewports(ctx, page));
  if (counted.sessions < FLOOR_ENTRY_SESSIONS || counted.share == null) {
    return {
      state: 'below_floor',
      metric,
      value: counted.share == null ? null : r4(counted.share),
      detail: `need ${FLOOR_ENTRY_SESSIONS}+ entry sessions with a viewport`,
    };
  }
  const pct = (counted.share * 100).toFixed(1);
  const detail = `hero CTA above the fold on ${pct}% of entry sessions`;
  return counted.share < ABOVE_FOLD_MIN_SHARE
    ? { state: 'triggered', metric, value: r4(counted.share), threshold: '< 0.85', detail }
    : { state: 'silent', metric, value: r4(counted.share), threshold: '>= 0.85', detail };
}

export const adapter = {
  id: 'strategy-triggers',
  dependsOn: [
    'page-segment-weekly',
    'entry-by-channel',
    'order-value-hist',
    'page-country',
    'scroll-decile',
    'selector-weekly',
    'rage-clicks',
    'nav-next-page',
    'campaign-coverage',
    'campaign-weekly',
    'line-items',
    'coverage',
  ],
  scope: 'page',
  provides: [],

  /**
   * @param {import('../../../ports/qualifier.js').QualifiedPage} page
   * @param {import('../../../ports/dataset.js').RunContext} ctx
   */
  async collect(page, ctx) {
    const inputs = readInputs(ctx, page);
    if (!Object.prototype.hasOwnProperty.call(inputs.notes, 'scroll_scale_confirmed') && ctx.gateway?.query) {
      inputs.scaleConfirmed = await scrollScaleConfirmed(ctx, page);
    }
    inputs.heroFold = await measureHeroFold(ctx, page);
    const ruleResults = runRules(inputs);

    const desktop = inputs.deviceSlices.find((d) => d.device === 'desktop');
    const mobile = inputs.deviceSlices.find((d) => d.device === 'mobile');
    const t = inputs.totals;
    const analysis = {
      rps: r4(safeDiv(t.revenue, t.sessions) ?? 0),
      singlePageviewShare: r4(safeDiv(t.singlePageview, t.sessions) ?? 0),
      scrollReach25: r4(safeDiv(t.scroll25, t.sessions) ?? 0),
      scrollReach70: r4(safeDiv(t.scroll70, t.sessions) ?? 0),
      desktopRps: r4(desktop?.rps ?? 0),
      mobileRps: r4(mobile?.rps ?? 0),
      mobileToDesktopRps: r4(desktop?.rps ? (mobile?.rps ?? 0) / desktop.rps : 0),
      strategiesTriggered: 0,
      strategiesBelowFloor: 0,
      strategiesBlocked: 0,
      strategiesSilent: 0,
    };

    const rows = [];
    const strategyRecords = {};
    for (const [strategyId, ruleIds] of Object.entries(STRATEGY_RULES)) {
      const state = strategyState(ruleResults, ruleIds);
      const triggeredRule = ruleIds.find((id) => ruleResults[id]?.state === 'triggered');
      const primary = triggeredRule != null ? ruleResults[triggeredRule] : ruleResults[ruleIds[0]];
      strategyRecords[strategyId] = { state, rules: ruleIds.map((id) => ({ rule: id, ...ruleResults[id] })) };
      analysis[`strategies${cap(state)}`] += 1;
      rows.push({
        dims: { strategy_id: strategyId },
        metrics: {
          state,
          metric: primary?.metric ?? null,
          value: primary?.value ?? null,
          threshold: primary?.threshold ?? null,
          floor_result: state === 'below_floor' ? 'under_floor' : 'met',
          rules: ruleIds.map((id) => `${id}:${ruleResults[id]?.state ?? 'blocked'}`).join(','),
          detail: primary?.detail ?? null,
        },
      });
    }

    return {
      id: adapter.id,
      rows,
      notes: {
        strategy_rule_results: ruleResults,
        strategies: strategyRecords,
      },
      analysis,
    };
  },
};

/** @param {string} state */
function cap(state) {
  return state[0].toUpperCase() + state.slice(1);
}
