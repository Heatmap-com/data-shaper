import { deviceName } from '../_lib/dims.js';
import { fetchSessionRows, filtersFor } from '../_lib/session-stream.js';

/**
 * exposure-weekly: measured exposure and dwell for the page from the
 * attention tables. Two row kinds, both joined to the page's entry sessions:
 * (a) per enrolled element (udp_am_elements): exposed sessions (dw > 0),
 * dwell, exposed orders and revenue, RPeS; (b) per zone depth band
 * (udp_am_zones, zone_d 5..100 step 5): exposed sessions and dwell. Bands
 * are not section ids: section mapping arrives with M02 geometry or the
 * descriptor's p10 section tops (Phase 4/5). H18; the T14 tracker events do
 * not exist yet (D-01), so T14 stays at zero rows here.
 */

export const adapter = {
  id: 'exposure-weekly',
  dependsOn: [],
  scope: 'page',
  provides: ['H18', 'T14'],

  /**
   * @param {import('../../../ports/qualifier.js').QualifiedPage} page
   * @param {import('../../../ports/dataset.js').RunContext} ctx
   */
  async collect(page, ctx) {
    const [sessions, elementRows, zoneRows] = await Promise.all([
      fetchSessionRows(ctx, page.idsite),
      fetchElementExposure(ctx, page),
      fetchZoneExposure(ctx, page),
    ]);
    const hsr = String(page.idsitehsr);

    /** @type {Map<string, object>} idvisit -> session, page entry sessions only */
    const pageSessions = new Map();
    for (const s of sessions) {
      if (s.entryHsr === hsr) pageSessions.set(s.idvisit, s);
    }

    /** @type {Map<string, object>} */
    const cells = new Map();
    const cellFor = (dims) => {
      const key = JSON.stringify(dims);
      let cell = cells.get(key);
      if (!cell) {
        cell = { dims, exposedVisits: new Set(), dwell: 0, orders: 0, revenue: 0 };
        cells.set(key, cell);
      }
      return cell;
    };

    for (const row of elementRows) {
      const session = pageSessions.get(row.idvisit);
      if (!session) continue;
      const exposed = row.dwMax > 0;
      for (const filter of filtersFor(session.tier)) {
        const dims = {
          week: session.week,
          device: deviceName(session.device),
          element: row.selector,
          bot_filter: filter,
        };
        const cell = cellFor(dims);
        if (exposed && !cell.exposedVisits.has(row.idvisit)) {
          cell.exposedVisits.add(row.idvisit);
          cell.dwell += row.dwMax;
          cell.orders += session.orders;
          cell.revenue += session.revenue;
        }
      }
    }

    for (const row of zoneRows) {
      const session = pageSessions.get(row.idvisit);
      if (!session) continue;
      const exposed = row.dwMax > 0;
      for (const filter of filtersFor(session.tier)) {
        const dims = {
          week: session.week,
          device: deviceName(session.device),
          depth_band: row.zoneD,
          element: '',
          bot_filter: filter,
          section_id: '',
        };
        const cell = cellFor(dims);
        if (exposed && !cell.exposedVisits.has(row.idvisit)) {
          cell.exposedVisits.add(row.idvisit);
          cell.dwell += row.dwMax;
        }
      }
    }

    const rows = [...cells.values()].map((cell) => {
      const exposedSessions = cell.exposedVisits.size;
      /** @type {object} */
      const metrics = {
        exposed_sessions: exposedSessions,
        dwell_seconds: round2(cell.dwell),
      };
      if (cell.dims.element !== '') {
        metrics.exposed_orders = cell.orders;
        metrics.exposed_revenue = round2(cell.revenue);
        metrics.rpes = exposedSessions > 0 ? round2(cell.revenue / exposedSessions) : null;
      }
      return { dims: cell.dims, metrics };
    });

    return {
      id: adapter.id,
      rows,
      notes: {
        exposure_section_mapping:
          'bands unmapped until M02 geometry or descriptor p10 (Phase 4/5)',
        exposure_tracker_events: 'none observed (D-01)',
      },
    };
  },
};

/**
 * Per (selector, idvisit) max dw/dur on the page, server_date bound (F11).
 * @param {import('../../../ports/dataset.js').RunContext} ctx
 * @param {{idsite: number, idsitehsr: number}} page
 */
async function fetchElementExposure(ctx, page) {
  const rows = await ctx.gateway.query(
    `SELECT toString(selector) AS selector,
            toString(idvisit) AS idvisit,
            max(dw) AS dw_max,
            max(dur) AS dur_max
       FROM default.udp_am_elements
      WHERE idsite = {idsite:UInt32}
        AND idsitehsr = {idsitehsr:UInt64}
        AND server_date BETWEEN {w0:Date} AND {w1:Date}
      GROUP BY selector, idvisit`,
    { idsite: page.idsite, idsitehsr: page.idsitehsr, w0: ctx.windowStart, w1: ctx.windowEnd },
    'exposure-weekly:elements',
  );
  return rows.map((r) => ({
    selector: String(r.selector ?? ''),
    idvisit: r.idvisit,
    dwMax: Number(r.dw_max ?? 0),
    durMax: Number(r.dur_max ?? 0),
  }));
}

/**
 * Per (zone_d, idvisit) max dw on the page, server_date bound (F11).
 * @param {import('../../../ports/dataset.js').RunContext} ctx
 * @param {{idsite: number, idsitehsr: number}} page
 */
async function fetchZoneExposure(ctx, page) {
  const rows = await ctx.gateway.query(
    `SELECT toString(zone_d) AS zone_d,
            toString(idvisit) AS idvisit,
            max(dw) AS dw_max
       FROM default.udp_am_zones
      WHERE idsite = {idsite:UInt32}
        AND idsitehsr = {idsitehsr:UInt64}
        AND server_date BETWEEN {w0:Date} AND {w1:Date}
      GROUP BY zone_d, idvisit`,
    { idsite: page.idsite, idsitehsr: page.idsitehsr, w0: ctx.windowStart, w1: ctx.windowEnd },
    'exposure-weekly:zones',
  );
  return rows.map((r) => ({
    zoneD: String(r.zone_d ?? ''),
    idvisit: r.idvisit,
    dwMax: Number(r.dw_max ?? 0),
  }));
}

/** @param {number} n */
function round2(n) {
  return Math.round(n * 100) / 100;
}
