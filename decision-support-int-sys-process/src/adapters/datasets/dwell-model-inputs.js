import { deviceName } from '../_lib/dims.js';
import { fetchSessionRows, filtersFor } from '../_lib/session-stream.js';

/**
 * dwell-model-inputs: session-grain rows for PO's dwell-to-RPS model. One
 * row per page entry session: per-band dwell from udp_am_zones (dw summed
 * per session and band), total engaged time on the page (page_capped_ms
 * from the session stream), orders and revenue. Row count is the page's
 * session count, capped at MAX_ROWS with a truncation note. H18.
 */

const MAX_ROWS = 200000;

export const adapter = {
  id: 'dwell-model-inputs',
  dependsOn: [],
  scope: 'page',
  provides: ['H18'],

  /**
   * @param {import('../../../ports/qualifier.js').QualifiedPage} page
   * @param {import('../../../ports/dataset.js').RunContext} ctx
   */
  async collect(page, ctx) {
    const [sessions, zoneRows] = await Promise.all([
      fetchSessionRows(ctx, page.idsite, { idsitehsr: page.idsitehsr }),
      fetchSessionBandDwell(ctx, page),
    ]);
    const hsr = String(page.idsitehsr);

    /** @type {Map<string, Map<string, number>>} idvisit -> zone_d -> dwell seconds */
    const dwellByVisit = new Map();
    for (const row of zoneRows) {
      let bands = dwellByVisit.get(row.idvisit);
      if (!bands) {
        bands = new Map();
        dwellByVisit.set(row.idvisit, bands);
      }
      bands.set(row.zoneD, (bands.get(row.zoneD) ?? 0) + row.dwell);
    }

    const pageSessions = sessions.filter((s) => s.entryHsr === hsr);
    const truncated = pageSessions.length > MAX_ROWS;
    const kept = truncated ? pageSessions.slice(0, MAX_ROWS) : pageSessions;

    const rows = [];
    for (const s of kept) {
      const bands = dwellByVisit.get(s.idvisit);
      /** @type {Object<string, number>} */
      const bandDwell = {};
      if (bands) {
        for (const [zoneD, dwell] of [...bands.entries()].sort((a, b) => Number(a[0]) - Number(b[0]))) {
          bandDwell[zoneD] = round2(dwell);
        }
      }
      for (const filter of filtersFor(s.tier)) {
        rows.push({
          dims: { week: s.week, device: deviceName(s.device), bot_filter: filter, session: s.idvisit },
          metrics: {
            band_dwell: bandDwell,
            total_engaged_ms: s.pageCappedMs,
            orders: s.orders,
            revenue: round2(s.revenue),
          },
        });
      }
    }

    return {
      id: adapter.id,
      rows,
      notes: {
        dwell_model_rows: rows.length,
        ...(truncated ? { dwell_model_truncated: `capped at ${MAX_ROWS} sessions of ${pageSessions.length}` } : {}),
        dwell_model_note: 'band_dwell sums dw (seconds) per session and zone_d band; total_engaged_ms is the page-capped time on the chosen page',
      },
    };
  },
};

/**
 * Per (zone_d, idvisit) summed dw on the page, server_date bound (F11).
 * @param {import('../../../ports/dataset.js').RunContext} ctx
 * @param {{idsite: number, idsitehsr: number}} page
 */
async function fetchSessionBandDwell(ctx, page) {
  const rows = await ctx.gateway.query(
    `SELECT toString(zone_d) AS zone_d,
            toString(idvisit) AS idvisit,
            sum(dw) AS dwell
       FROM default.udp_am_zones
      WHERE idsite = {idsite:UInt32}
        AND idsitehsr = {idsitehsr:UInt64}
        AND server_date BETWEEN {w0:Date} AND {w1:Date}
      GROUP BY zone_d, idvisit`,
    { idsite: page.idsite, idsitehsr: page.idsitehsr, w0: ctx.windowStart, w1: ctx.windowEnd },
    'dwell-model-inputs:zones',
  );
  return rows.map((r) => ({
    zoneD: String(r.zone_d ?? ''),
    idvisit: r.idvisit,
    dwell: Number(r.dwell ?? 0),
  }));
}

/** @param {number} n */
function round2(n) {
  return Math.round(n * 100) / 100;
}
