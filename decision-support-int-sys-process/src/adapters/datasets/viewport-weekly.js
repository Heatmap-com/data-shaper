import { deviceName } from '../_lib/dims.js';
import { fetchSessionRows, filtersFor } from '../_lib/session-stream.js';
import { pageViewportHeights, viewportClass } from '../_lib/viewport.js';

/**
 * viewport-weekly: the dominant viewport class per page session, counted
 * per (week, device, viewport class, bot filter) with the class share
 * within week+device+tier. The dominant viewport and the class mapping
 * (small/medium/large/unknown) come from the shared _lib/viewport.js
 * helper. H07.
 */

export const adapter = {
  id: 'viewport-weekly',
  dependsOn: [],
  scope: 'page',
  provides: ['H07'],

  /**
   * @param {import('../../../ports/qualifier.js').QualifiedPage} page
   * @param {import('../../../ports/dataset.js').RunContext} ctx
   */
  async collect(page, ctx) {
    const [sessions, heights] = await Promise.all([fetchSessionRows(ctx, page.idsite), pageViewportHeights(ctx, page)]);
    const hsr = String(page.idsitehsr);

    /** @type {Map<string, {dims: object, sessions: number}>} */
    const cells = new Map();
    /** @type {Map<string, number>} week|device|filter -> device sessions */
    const deviceTotals = new Map();
    for (const s of sessions) {
      if (s.entryHsr !== hsr) continue;
      const height = heights.get(s.idvisit);
      if (height === undefined) continue;
      const cls = viewportClass(height);
      for (const filter of filtersFor(s.tier)) {
        const device = deviceName(s.device);
        const totalKey = `${s.week}|${device}|${filter}`;
        deviceTotals.set(totalKey, (deviceTotals.get(totalKey) ?? 0) + 1);
        const dims = { week: s.week, device, viewport_class: cls, bot_filter: filter };
        const key = JSON.stringify(dims);
        let cell = cells.get(key);
        if (!cell) {
          cell = { dims, sessions: 0 };
          cells.set(key, cell);
        }
        cell.sessions += 1;
      }
    }

    const rows = [...cells.values()].map((cell) => {
      const total = deviceTotals.get(`${cell.dims.week}|${cell.dims.device}|${cell.dims.bot_filter}`) ?? 0;
      return {
        dims: cell.dims,
        metrics: {
          sessions: cell.sessions,
          share_of_device_sessions: total > 0 ? round4(cell.sessions / total) : null,
        },
      };
    });

    return {
      id: adapter.id,
      rows,
      notes: {
        viewport_class_mapping: 'dominant session viewport height: small <=667, medium <=900, large >900, unknown when absent',
        viewport_helper: 'via _lib/viewport.js',
      },
    };
  },
};

/** @param {number} n */
function round4(n) {
  return Math.round(n * 10000) / 10000;
}
