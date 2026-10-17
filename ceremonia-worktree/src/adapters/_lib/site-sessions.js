import { fetchSessionRows, filtersFor } from './session-stream.js';

/**
 * Site memos for the non-page subjects: the window's sessions, read once
 * per site and shared by a selector and the subject datasets after it. A
 * memo holds one site; the next site's read replaces it.
 */

/**
 * @template T
 * @param {import('../../ports/dataset.js').RunContext} ctx
 * @param {string} key
 * @param {number} idsite
 * @param {() => Promise<T>} build
 * @returns {Promise<T>}
 */
export async function siteMemo(ctx, key, idsite, build) {
  const held = ctx.batchNotes?.get(key);
  if (held?.idsite === idsite) return held.value;
  const value = await build();
  ctx.batchNotes?.set(key, { idsite, value });
  return value;
}

/**
 * The window's session rows by visit id, with their bot tiers.
 * @param {import('../../ports/dataset.js').RunContext} ctx
 * @param {number} idsite
 * @returns {Promise<Map<string, Awaited<ReturnType<typeof fetchSessionRows>>[number]>>}
 */
export function siteSessions(ctx, idsite) {
  return siteMemo(ctx, 'site-sessions', idsite, async () => {
    const rows = await fetchSessionRows(ctx, idsite);
    return new Map(rows.map((s) => [s.idvisit, s]));
  });
}

/**
 * Step reach cells per (week, bot filter), with an `all` week over the
 * window. `reachOf(session)` gives how many steps the session reached in
 * order and, where measured, the minutes between consecutive steps.
 *
 * @param {Iterable<{week: string, tier: string | null, orders: number, revenue: number}>} sessions
 * @param {number} stepCount
 * @param {(session: object) => {reached: number, gaps?: number[]}} reachOf
 */
export function reachCells(sessions, stepCount, reachOf) {
  /** @type {Map<string, {week: string, filter: string, reached: number[], buyers: number[], orders: number[], revenue: number[], gaps: number[][]}>} */
  const cells = new Map();
  const cellOf = (week, filter) => {
    const key = `${week}|${filter}`;
    let cell = cells.get(key);
    if (!cell) {
      cell = {
        week,
        filter,
        reached: new Array(stepCount).fill(0),
        buyers: new Array(stepCount).fill(0),
        orders: new Array(stepCount).fill(0),
        revenue: new Array(stepCount).fill(0),
        gaps: Array.from({ length: stepCount }, () => []),
      };
      cells.set(key, cell);
    }
    return cell;
  };
  for (const s of sessions) {
    const { reached, gaps = [] } = reachOf(s);
    if (reached === 0) continue;
    for (const filter of filtersFor(s.tier)) {
      for (const week of [s.week, 'all']) {
        const cell = cellOf(week, filter);
        for (let i = 0; i < reached; i += 1) {
          cell.reached[i] += 1;
          cell.buyers[i] += s.orders > 0 ? 1 : 0;
          cell.orders[i] += s.orders;
          cell.revenue[i] += s.revenue;
          if (i > 0 && gaps[i - 1] != null) cell.gaps[i].push(gaps[i - 1]);
        }
      }
    }
  }
  return [...cells.values()].sort((a, b) => (a.week < b.week ? -1 : a.week > b.week ? 1 : a.filter < b.filter ? -1 : 1));
}

/**
 * The step rows of reach cells: reached sessions, the share that continued
 * from the step before, conversion, and the median minutes from the step
 * before where the reach measures them.
 * @param {ReturnType<typeof reachCells>} cells
 * @param {string[]} steps
 * @param {{minutes?: boolean}} [opts]
 */
export function stepRows(cells, steps, opts = {}) {
  const rows = [];
  for (const cell of cells) {
    steps.forEach((step, i) => {
      const reached = cell.reached[i];
      rows.push({
        dims: { week: cell.week, bot_filter: cell.filter, step_index: i, step },
        metrics: {
          reached_sessions: reached,
          continued_rate: i === 0 ? null : rate(reached, cell.reached[i - 1]),
          ...(opts.minutes ? { median_minutes_from_previous: i === 0 ? null : median(cell.gaps[i]) } : {}),
          orders: cell.orders[i],
          revenue_udp: Math.round(cell.revenue[i] * 100) / 100,
          cvr: rate(cell.buyers[i], reached),
        },
      });
    });
  }
  return rows;
}

/** @param {number} num @param {number} den */
export function rate(num, den) {
  return den > 0 ? Math.round((num / den) * 10000) / 10000 : null;
}

/** @param {number[]} values */
function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const m = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return Math.round(m * 100) / 100;
}
