import { fetchSessionRows, filtersFor } from '../_lib/session-stream.js';

/**
 * page-country: the chosen page's entry sessions grouped per country over
 * the window. Countries with at least 30 entry sessions (per bot filter)
 * are kept. Rule 12's country half.
 */

const MIN_SESSIONS = 30;

export const adapter = {
  id: 'page-country',
  dependsOn: [],
  scope: 'page',
  provides: ['H05'],

  /**
   * @param {import('../../../ports/qualifier.js').QualifiedPage} page
   * @param {import('../../../ports/dataset.js').RunContext} ctx
   */
  async collect(page, ctx) {
    const sessions = await fetchSessionRows(ctx, page.idsite);
    const hsr = String(page.idsitehsr);

    /** @type {Map<string, object>} */
    const cells = new Map();
    for (const s of sessions) {
      if (s.entryHsr !== hsr) continue;
      const country = s.country === '' ? 'unknown' : s.country;
      for (const filter of filtersFor(s.tier)) {
        const dims = { country, bot_filter: filter };
        const key = JSON.stringify(dims);
        let cell = cells.get(key);
        if (!cell) {
          cell = { dims, sessions: 0, orders: 0, revenue: 0 };
          cells.set(key, cell);
        }
        cell.sessions += 1;
        cell.orders += s.orders;
        cell.revenue += s.revenue;
      }
    }

    const rows = [...cells.values()]
      .filter((cell) => cell.sessions >= MIN_SESSIONS)
      .map((cell) => ({
        dims: cell.dims,
        metrics: {
          sessions: cell.sessions,
          orders_udp: cell.orders,
          revenue_udp: round2(cell.revenue),
        },
      }))
      .sort((a, b) => a.dims.country.localeCompare(b.dims.country) || a.dims.bot_filter.localeCompare(b.dims.bot_filter));

    return { id: adapter.id, rows };
  },
};

/** @param {number} n */
function round2(n) {
  return Math.round(n * 100) / 100;
}
