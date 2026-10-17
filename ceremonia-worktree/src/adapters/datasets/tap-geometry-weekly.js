import { configuredDatabase } from '../query-gateway/clickhouse.js';
import { median } from '../_lib/checks.js';
import { getClickRows } from '../_lib/clicks.js';
import { deviceName } from '../_lib/dims.js';
import { fetchSessionRows, filtersFor } from '../_lib/session-stream.js';

/**
 * tap-geometry-weekly: click positions against captured element boxes,
 * per (week, device, selector, bot filter). Off-target taps are clicks
 * more than 24 px outside the selector's box; offset from center is the
 * click's distance from the box center; a correction pair is two clicks
 * on the same selector by one session whose time_since_load values are
 * both non-negative and span at most 2000 ms (counted on adjacent sorted
 * clicks, attributed to the later click's week). Boxes come from
 * ae_render_node_current element nodes; clicks join per session for the
 * device and bot tier. Device matching: nodes carry a device_class
 * dimension, so a click matches its own device's box; when the selector's
 * boxes carry no device class any box stands in (counts in the
 * tap_geometry_device_match note). Pre-cutover there is no render
 * geometry at all: zero rows plus a note, never a throw. H22.
 */

const OFF_TARGET_PX = 24;
const CORRECTION_SPAN_MS = 2000;

export const adapter = {
  id: 'tap-geometry-weekly',
  dependsOn: ['selector-weekly'],
  scope: 'page',
  provides: ['H22'],

  /**
   * @param {import('../../../ports/qualifier.js').QualifiedPage} page
   * @param {import('../../../ports/dataset.js').RunContext} ctx
   */
  async collect(page, ctx) {
    const [clicks, sessions, boxes] = await Promise.all([
      getClickRows(ctx, page),
      fetchSessionRows(ctx, page.idsite),
      fetchElementBoxes(ctx, page),
    ]);

    const notes = {};
    if (boxes.note) {
      // No render geometry: every geometry metric would be a lie, so the
      // whole dataset degrades to zero rows (same contract as the other
      // ae_ reads, but at the dataset level because boxes feed all rows).
      notes.tap_geometry_note = boxes.note;
      notes.tap_geometry_device_match = 'no render geometry until capture';
      return { id: adapter.id, rows: [], notes };
    }

    /** @type {Map<string, object>} idvisit -> session, page entry sessions only */
    const hsr = String(page.idsitehsr);
    const pageSessions = new Map();
    for (const s of sessions) {
      if (s.entryHsr === hsr) pageSessions.set(s.idvisit, s);
    }

    /** @type {Map<string, {byDevice: Map<string, object>, any: object | null, deviceDim: boolean}>} */
    const boxBySelector = new Map();
    for (const b of boxes.rows) {
      const selector = String(b.selector ?? '');
      let entry = boxBySelector.get(selector);
      if (!entry) {
        entry = { byDevice: new Map(), any: null, deviceDim: false };
        boxBySelector.set(selector, entry);
      }
      const box = { x: Number(b.x ?? 0), y: Number(b.y ?? 0), w: Number(b.w ?? 0), h: Number(b.h ?? 0) };
      const device = String(b.device_class ?? '');
      if (device !== '') {
        entry.deviceDim = true;
        if (!entry.byDevice.has(device)) entry.byDevice.set(device, box);
      }
      if (!entry.any) entry.any = box;
    }

    const matchCounts = { device_exact: 0, device_fallback: 0, selector_only: 0, no_box: 0 };

    /**
     * @param {string} selector
     * @param {string} device
     * @returns {{box: object | null, how: string}}
     */
    function matchBox(selector, device) {
      const entry = boxBySelector.get(selector);
      if (!entry || !entry.any) return { box: null, how: 'no_box' };
      if (entry.deviceDim) {
        const exact = entry.byDevice.get(device);
        if (exact) return { box: exact, how: 'device_exact' };
        return { box: entry.any, how: 'device_fallback' };
      }
      return { box: entry.any, how: 'selector_only' };
    }

    /** @type {Map<string, object>} */
    const cells = new Map();
    /** @type {Map<string, {selector: string, device: string, filters: string[], tsls: number[], weeks: string[]}>} selector|idvisit -> correction-pair candidates */
    const pairCandidates = new Map();

    for (const click of clicks) {
      const session = pageSessions.get(click.idvisit);
      if (!session) continue;
      const device = deviceName(session.device);
      const { box, how } = matchBox(click.selector, device);
      matchCounts[how] += 1;

      if (click.timeSinceLoad >= 0) {
        const pairKey = `${click.selector}|${click.idvisit}`;
        let candidate = pairCandidates.get(pairKey);
        if (!candidate) {
          candidate = { selector: click.selector, device, filters: filtersFor(session.tier), tsls: [], weeks: [] };
          pairCandidates.set(pairKey, candidate);
        }
        candidate.tsls.push(click.timeSinceLoad);
        candidate.weeks.push(click.week);
      }

      for (const filter of filtersFor(session.tier)) {
        const dims = { week: click.week, device, selector: click.selector, bot_filter: filter };
        const key = JSON.stringify(dims);
        let cell = cells.get(key);
        if (!cell) {
          cell = { dims, clicks: 0, offTarget: 0, offsets: [] };
          cells.set(key, cell);
        }
        cell.clicks += 1;
        if (box && Number.isFinite(click.x) && Number.isFinite(click.y)) {
          const outside =
            click.x < box.x - OFF_TARGET_PX ||
            click.x > box.x + box.w + OFF_TARGET_PX ||
            click.y < box.y - OFF_TARGET_PX ||
            click.y > box.y + box.h + OFF_TARGET_PX;
          if (outside) cell.offTarget += 1;
          cell.offsets.push(Math.hypot(click.x - (box.x + box.w / 2), click.y - (box.y + box.h / 2)));
        }
      }
    }

    for (const candidate of pairCandidates.values()) {
      const { tsls, weeks } = candidate;
      // a stable sort of the click order, so tied clicks keep their order
      const order = tsls.map((_, i) => i).sort((a, b) => tsls[a] - tsls[b]);
      for (let i = 0; i + 1 < order.length; i += 1) {
        const span = tsls[order[i + 1]] - tsls[order[i]];
        if (span > CORRECTION_SPAN_MS) continue;
        for (const filter of candidate.filters) {
          const dims = {
            week: weeks[order[i + 1]],
            device: candidate.device,
            selector: candidate.selector,
            bot_filter: filter,
          };
          const key = JSON.stringify(dims);
          let cell = cells.get(key);
          if (!cell) {
            cell = { dims, clicks: 0, offTarget: 0, offsets: [], correctionPairs: 0 };
            cells.set(key, cell);
          }
          cell.correctionPairs = (cell.correctionPairs ?? 0) + 1;
        }
      }
    }

    const rows = [...cells.values()].map((cell) => ({
      dims: cell.dims,
      metrics: {
        clicks: cell.clicks,
        off_target_taps: cell.offTarget,
        median_offset_from_center_px: cell.offsets.length > 0 ? round2(median(cell.offsets)) : null,
        correction_pairs: cell.correctionPairs ?? 0,
      },
    }));

    notes.tap_geometry_device_match =
      `device_exact: ${matchCounts.device_exact}, device_fallback: ${matchCounts.device_fallback}, ` +
      `selector_only: ${matchCounts.selector_only}, no_box: ${matchCounts.no_box}`;
    return { id: adapter.id, rows, notes };
  },
};

/**
 * Element boxes for the page from ae_render_node_current. Pre-cutover the
 * table does not exist: {rows: [], note} instead of a throw (same
 * contract as element-binding/card-history).
 * @param {import('../../../ports/dataset.js').RunContext} ctx
 * @param {{idsite: number, idsitehsr: number}} page
 * @returns {Promise<{rows: Array<object>, note?: string}>}
 */
async function fetchElementBoxes(ctx, page) {
  try {
    const rows = await ctx.gateway.query(
      `SELECT device_class, selector, x, y, w, h
         FROM ${configuredDatabase()}.ae_render_node_current
        WHERE idsite = {idsite:UInt32}
          AND idsitehsr = {idsitehsr:UInt64}
          AND node_kind = 'element'`,
      { idsite: page.idsite, idsitehsr: page.idsitehsr },
      'tap-geometry-weekly:boxes',
    );
    return { rows };
  } catch (err) {
    if (!/UNKNOWN_TABLE|Unknown table/i.test(String(err?.message ?? err))) throw err;
    return { rows: [], note: 'no render geometry until capture' };
  }
}

/** @param {number} n */
function round2(n) {
  return Math.round(n * 100) / 100;
}
