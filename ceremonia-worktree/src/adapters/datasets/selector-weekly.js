import { timeSinceLoadUnit, median, quantile } from '../_lib/checks.js';
import { getClickRows } from '../_lib/clicks.js';
import { deviceName } from '../_lib/dims.js';
import { namesForPage } from '../_lib/element-names.js';
import { fetchSessionRows, filtersFor } from '../_lib/session-stream.js';

/**
 * selector-weekly: click inventory per (week, selector, device, bot filter)
 * for the chosen page's entry sessions. Revenue is the entry-session revenue
 * of clicking sessions, deduplicated per selector; it is not additive across
 * selectors. A selector is kept at 20+ clicks over the window, or one order,
 * or an exact match in element-names.json. First-click share (H21): per
 * session the earliest click by (server_time, time_since_load) and its
 * selector; time to first click is the first click's time_since_load when
 * non-negative. Rules 4, 5, 7, 11.
 */

const MIN_CLICKS = 20;

export const adapter = {
  id: 'selector-weekly',
  dependsOn: [],
  scope: 'page',
  provides: ['H09', 'H21'],

  /**
   * @param {import('../../../ports/qualifier.js').QualifiedPage} page
   * @param {import('../../../ports/dataset.js').RunContext} ctx
   */
  async collect(page, ctx) {
    const [clicks, sessions, unit, amBySelector] = await Promise.all([
      getClickRows(ctx, page),
      fetchSessionRows(ctx, page.idsite),
      timeSinceLoadUnit(ctx, page),
      fetchAmElements(ctx, page.idsite),
    ]);
    const hsr = String(page.idsitehsr);

    /** @type {Map<string, object>} idvisit -> session, page entry sessions only */
    const pageSessions = new Map();
    /** @type {Map<string, object>} week|device|filter -> entry session count */
    const entryTotals = new Map();
    for (const s of sessions) {
      if (s.entryHsr !== hsr) continue;
      pageSessions.set(s.idvisit, s);
      for (const filter of filtersFor(s.tier)) {
        const key = `${s.week}|${deviceName(s.device)}|${filter}`;
        entryTotals.set(key, (entryTotals.get(key) ?? 0) + 1);
      }
    }

    const elementFor = await namesForPage(ctx, page);

    /** @type {Map<string, object>} */
    const cells = new Map();
    /** @type {Map<string, {clicks: number, orderVisits: Set<string>, matchedElement: boolean}>} */
    const selectorTotals = new Map();
    /** @type {Map<string, object>} idvisit -> earliest click by (serverTime, timeSinceLoad) */
    const firstClickByVisit = new Map();

    for (const click of clicks) {
      const session = pageSessions.get(click.idvisit);
      if (!session) continue;
      const first = firstClickByVisit.get(click.idvisit);
      if (
        !first ||
        click.serverTime < first.serverTime ||
        (click.serverTime === first.serverTime && click.timeSinceLoad < first.timeSinceLoad)
      ) {
        firstClickByVisit.set(click.idvisit, click);
      }
      const element = await elementFor(click.selector);
      let totals = selectorTotals.get(click.selector);
      if (!totals) {
        totals = { clicks: 0, orderVisits: new Set(), matchedElement: Boolean(element) };
        selectorTotals.set(click.selector, totals);
      }
      totals.clicks += 1;

      const device = deviceName(session.device);
      for (const filter of filtersFor(session.tier)) {
        const dims = {
          week: click.week,
          selector: click.selector,
          device,
          bot_filter: filter,
          element_id: element?.element.element_id ?? '',
          element_class: element?.element.element_class ?? '',
          am_label: amBySelector.get(click.selector)?.label ?? '',
          am_role: amBySelector.get(click.selector)?.role ?? '',
        };
        const key = JSON.stringify(dims);
        let cell = cells.get(key);
        if (!cell) {
          cell = {
            dims,
            clicks: 0,
            clickVisits: new Set(),
            orderVisits: new Set(),
            revenue: 0,
            ys: [],
            xs: [],
            tsls: [],
            under8: 0,
          };
          cells.set(key, cell);
        }
        cell.clicks += 1;
        if (Number.isFinite(click.y)) cell.ys.push(click.y);
        if (Number.isFinite(click.x)) cell.xs.push(click.x);
        if (click.timeSinceLoad >= 0) {
          cell.tsls.push(click.timeSinceLoad);
          if ((unit === 'ms' && click.timeSinceLoad <= 8000) || (unit === 's' && click.timeSinceLoad <= 8)) {
            cell.under8 += 1;
          }
        }
        if (!cell.clickVisits.has(click.idvisit)) {
          cell.clickVisits.add(click.idvisit);
          cell.revenue += session.revenue;
        }
        if (session.orders > 0) {
          cell.orderVisits.add(click.idvisit);
          totals.orderVisits.add(click.idvisit);
        }
      }
    }

    /** @type {Map<string, {sessions: Set<string>, tsls: number[]}>} week|selector|device|filter -> first clicks */
    const firstClickCells = new Map();
    for (const [idvisit, click] of firstClickByVisit) {
      const session = pageSessions.get(idvisit);
      if (!session) continue;
      const device = deviceName(session.device);
      for (const filter of filtersFor(session.tier)) {
        const key = `${click.week}|${click.selector}|${device}|${filter}`;
        let cell = firstClickCells.get(key);
        if (!cell) {
          cell = { sessions: new Set(), tsls: [] };
          firstClickCells.set(key, cell);
        }
        cell.sessions.add(idvisit);
        if (click.timeSinceLoad >= 0) cell.tsls.push(click.timeSinceLoad);
      }
    }

    const rows = [];
    for (const cell of cells.values()) {
      const totals = selectorTotals.get(cell.dims.selector);
      const keep =
        totals.clicks >= MIN_CLICKS || totals.orderVisits.size >= 1 || totals.matchedElement;
      if (!keep) continue;
      const ys = [...cell.ys].sort((a, b) => a - b);
      const xs = [...cell.xs].sort((a, b) => a - b);
      const tsls = [...cell.tsls].sort((a, b) => a - b);
      const entryKey = `${cell.dims.week}|${cell.dims.device}|${cell.dims.bot_filter}`;
      const firstClick = firstClickCells.get(
        `${cell.dims.week}|${cell.dims.selector}|${cell.dims.device}|${cell.dims.bot_filter}`,
      );
      const firstTsls = firstClick ? [...firstClick.tsls].sort((a, b) => a - b) : [];
      /** @type {object} */
      const metrics = {
        clicks: cell.clicks,
        clicking_sessions: cell.clickVisits.size,
        sessions_with_order: cell.orderVisits.size,
        revenue_udp: round2(cell.revenue),
        entry_sessions: entryTotals.get(entryKey) ?? 0,
        first_click_sessions: firstClick ? firstClick.sessions.size : 0,
        median_time_to_first_click_ms: firstTsls.length === 0 ? null : round2(median(firstTsls)),
        median_y: ys.length === 0 ? null : round2(median(ys)),
        p25_y: ys.length === 0 ? null : round2(quantile(ys, 0.25)),
        p75_y: ys.length === 0 ? null : round2(quantile(ys, 0.75)),
        median_x: xs.length === 0 ? null : round2(median(xs)),
        median_time_since_load: median(cell.tsls) == null ? null : round2(median(cell.tsls)),
      };
      if (unit !== 'unknown') metrics.clicks_under_8s = cell.under8;
      rows.push({ dims: cell.dims, metrics });
    }

    return {
      id: adapter.id,
      rows,
      notes: {
        time_since_load_unit: unit,
        ...(unit === 'unknown'
          ? { selector_weekly_note: 'time_since_load unit not confirmed; clicks_under_8s omitted' }
          : {}),
      },
    };
  },
};

/**
 * Each selector's label and role in the window: the smallest non-empty
 * one, else empty, so every read gives the same. The window is bound on
 * server_date (F11: unbounded, the table scan hit every partition).
 */
export const AM_ELEMENTS_SQL = `SELECT selector,
       if(countIf(label != '') > 0, minIf(label, label != ''), '') AS label,
       if(countIf(role != '') > 0, minIf(role, role != ''), '') AS role
  FROM default.udp_am_elements
 WHERE idsite = {idsite:UInt32}
   AND server_date BETWEEN {w0:Date} AND {w1:Date}
 GROUP BY selector`;

/**
 * Exact-match label/role lookup from udp_am_elements, memoized per site.
 * @param {import('../../../ports/dataset.js').RunContext} ctx
 * @param {number} idsite
 */
async function fetchAmElements(ctx, idsite) {
  const memoKey = `am:${idsite}`;
  if (ctx.batchNotes.has(memoKey)) return ctx.batchNotes.get(memoKey);
  const load = (async () => {
    const rows = await ctx.gateway.query(
      AM_ELEMENTS_SQL,
      { idsite, w0: ctx.windowStart, w1: ctx.windowEnd },
      'selector-weekly:am-elements',
    );
    /** @type {Map<string, {label: string, role: string}>} */
    const bySelector = new Map();
    for (const r of rows) {
      bySelector.set(r.selector, { label: String(r.label ?? ''), role: String(r.role ?? '') });
    }
    return bySelector;
  })();
  ctx.batchNotes.set(memoKey, load);
  return load;
}

/** @param {number} n */
function round2(n) {
  return Math.round(n * 100) / 100;
}
