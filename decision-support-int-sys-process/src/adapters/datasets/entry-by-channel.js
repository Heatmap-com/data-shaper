import { refererName } from '../_lib/dims.js';
import { fetchSessionRows, filtersFor } from '../_lib/session-stream.js';
import { fetchHsrUrls } from '../_lib/urls.js';
import { mapState } from '../../scan/snapshot.js';

/**
 * entry-by-channel: the sister-page file. Entry sessions for every page of
 * the site, grouped per (entry page, referrer) over the whole window. A cell
 * is kept at 20+ sessions, plus the top 25 pages per referrer, plus the
 * chosen page's cells even when small. Compare a URL only with other URLs
 * in the same referrer. Rules 2, 3, 13.
 */

const MIN_SESSIONS = 20;
const TOP_N = 25;

export const adapter = {
  id: 'entry-by-channel',
  dependsOn: [],
  scope: 'page',
  provides: ['H03', 'H24'],
  pass: 'site',

  /**
   * @param {import('../../../ports/qualifier.js').QualifiedPage} page
   * @param {import('../../../ports/dataset.js').RunContext} ctx
   */
  async collect(page, ctx) {
    const folder = adapter.open(page, ctx);
    folder.fold(await fetchSessionRows(ctx, page.idsite));
    return folder.finish(page, ctx);
  },

  /**
   * The cells are the same for every page of the site; finish keeps the
   * page's own cells on top of the shared ones, so the day scan's site pass
   * folds once and finishes per page.
   * @param {object} _page
   * @param {import('../../../ports/dataset.js').RunContext} _ctx
   */
  open(_page, _ctx) {
    /** @type {Map<string, object>} */
    const cells = new Map();
    return {
      ...mapState(cells),
      /** @param {object[]} sessions */
      fold(sessions) {
        for (const s of sessions) {
          if (s.entryHsr === '' || s.entryHsr === '0') continue;
          const referer = refererName(s.referer);
          for (const filter of filtersFor(s.tier)) {
            const dims = { idsitehsr: s.entryHsr, referer, bot_filter: filter };
            const key = JSON.stringify(dims);
            let cell = cells.get(key);
            if (!cell) {
              cell = { dims, sessions: 0, orders: 0, revenue: 0, singlePageview: 0 };
              cells.set(key, cell);
            }
            cell.sessions += 1;
            if (s.pageviews === 1) cell.singlePageview += 1;
            cell.orders += s.orders;
            cell.revenue += s.revenue;
          }
        }
      },
      /**
       * @param {{idsite: number, idsitehsr: number}} page
       * @param {import('../../../ports/dataset.js').RunContext} ctx
       */
      async finish(page, ctx) {
        return rowsFor(page, cells, await fetchHsrUrls(ctx, page.idsite));
      },
    };
  },
};

/**
 * @param {{idsitehsr: number}} page
 * @param {Map<string, object>} cells
 * @param {Map<string, string>} urls
 */
function rowsFor(page, cells, urls) {
  const chosen = String(page.idsitehsr);

  /** @type {Set<object>} */
  const kept = new Set();
  /** @type {Map<string, object[]>} */
  const byReferer = new Map();
  for (const cell of cells.values()) {
    if (cell.sessions >= MIN_SESSIONS) kept.add(cell);
    const rk = `${cell.dims.referer}|${cell.dims.bot_filter}`;
    const list = byReferer.get(rk) ?? [];
    list.push(cell);
    byReferer.set(rk, list);
  }
  for (const list of byReferer.values()) {
    list.sort((a, b) => b.sessions - a.sessions || a.dims.idsitehsr.localeCompare(b.dims.idsitehsr));
    for (const cell of list.slice(0, TOP_N)) kept.add(cell);
  }
  for (const cell of cells.values()) {
    if (cell.dims.idsitehsr === chosen) kept.add(cell);
  }

  const rows = [...kept]
    .map((cell) => ({
      dims: { ...cell.dims },
      metrics: {
        url: urls.get(cell.dims.idsitehsr) ?? '',
        sessions: cell.sessions,
        orders_udp: cell.orders,
        revenue_udp: round2(cell.revenue),
        single_pageview_sessions: cell.singlePageview,
      },
    }))
    .sort(
      (a, b) =>
        a.dims.idsitehsr.localeCompare(b.dims.idsitehsr) ||
        a.dims.referer.localeCompare(b.dims.referer) ||
        a.dims.bot_filter.localeCompare(b.dims.bot_filter),
    );

  return { id: adapter.id, rows };
}

/** @param {number} n */
function round2(n) {
  return Math.round(n * 100) / 100;
}
