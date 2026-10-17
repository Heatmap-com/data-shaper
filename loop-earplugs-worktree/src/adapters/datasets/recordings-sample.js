import { median } from '../_lib/checks.js';
import { deviceName } from '../_lib/dims.js';

/**
 * recordings-sample: the recordings index (recordings_new1) for the page,
 * filterable by time_on_page, pageview_click_count and device, sampled to
 * recording ids (up to 50, the smallest ids, so every read samples the
 * same) with medians. One population today: 'all'.
 * Named populations arrive with card triggers (Phase 10); element-level
 * filtering uses selector-weekly join rates rather than replay parsing
 * (D-06). H17.
 */

const SAMPLE_LIMIT = 50;

export const adapter = {
  id: 'recordings-sample',
  dependsOn: [],
  scope: 'page',
  provides: ['H17'],

  /**
   * @param {import('../../../ports/qualifier.js').QualifiedPage} page
   * @param {import('../../../ports/dataset.js').RunContext} ctx
   */
  async collect(page, ctx) {
    const columns = await ctx.gateway.columns('recordings_new1');
    const hasDevice = columns.some((c) => c.name === 'config_device_type');
    const recordings = (await fetchRecordings(ctx, page, hasDevice))
      .sort((a, b) => (a.recordingId < b.recordingId ? -1 : a.recordingId > b.recordingId ? 1 : 0));

    /** @type {Map<string, object>} device -> cell */
    const cells = new Map();
    for (const rec of recordings) {
      const device = hasDevice ? (rec.device == null ? 'unknown' : deviceName(rec.device)) : 'all';
      let cell = cells.get(device);
      if (!cell) {
        cell = { device, count: 0, ids: [], times: [], clicks: [] };
        cells.set(device, cell);
      }
      cell.count += 1;
      if (cell.ids.length < SAMPLE_LIMIT) cell.ids.push(rec.recordingId);
      if (rec.timeOnPage != null) cell.times.push(rec.timeOnPage);
      if (rec.clickCount != null) cell.clicks.push(rec.clickCount);
    }

    const rows = [...cells.values()].map((cell) => ({
      dims: { population: 'all', device: cell.device, bot_filter: '', sample_recording_ids: cell.ids },
      metrics: {
        recording_count: cell.count,
        median_time_on_page_ms: median(cell.times) == null ? null : Math.round(median(cell.times)),
        median_click_count: median(cell.clicks) == null ? null : round2(median(cell.clicks)),
      },
    }));

    return {
      id: adapter.id,
      rows,
      notes: {
        population_contract: 'named populations arrive with card triggers (Phase 10)',
        recordings_device_column: hasDevice ? 'config_device_type (null -> unknown)' : 'absent; device dim = all',
        recordings_page_join: 'recordings_new1 has no idsitehsr; page filter via idloghsr join to udp_hsrce_pageviews',
      },
    };
  },
};

/**
 * Recording rows for the page over the window. recordings_new1 carries no
 * idsitehsr, so the page filter is an idloghsr join through
 * udp_hsrce_pageviews; the recordings scan stays bounded by idsite and
 * server_date. Device selected only when the column exists.
 * @param {import('../../../ports/dataset.js').RunContext} ctx
 * @param {{idsite: number, idsitehsr: number}} page
 * @param {boolean} hasDevice
 */
async function fetchRecordings(ctx, page, hasDevice) {
  const rows = await ctx.gateway.query(
    `SELECT toString(r.group_recording_id) AS recording_id,
            r.time_on_page,
            r.pageview_click_count
            ${hasDevice ? ', r.config_device_type AS device' : ''}
       FROM default.recordings_new1 r
      INNER JOIN (
            SELECT DISTINCT CAST(idloghsr AS UInt64) AS idloghsr
              FROM default.udp_hsrce_pageviews
             WHERE idsite = {idsite:UInt32} AND idsitehsr = {idsitehsr:UInt64}
               AND server_date BETWEEN {w0:Date} AND {w1:Date}
            ) p ON p.idloghsr = r.idloghsr
      WHERE r.idsite = {idsite:UInt32}
        AND r.server_date BETWEEN {w0:Date} AND {w1:Date}`,
    { idsite: page.idsite, idsitehsr: page.idsitehsr, w0: ctx.windowStart, w1: ctx.windowEnd },
    'recordings-sample:rows',
  );
  return rows.map((r) => ({
    recordingId: String(r.recording_id ?? ''),
    device: hasDevice ? (r.device == null ? null : Number(r.device)) : null,
    timeOnPage: r.time_on_page == null ? null : Number(r.time_on_page),
    clickCount: r.pageview_click_count == null ? null : Number(r.pageview_click_count),
  }));
}

/** @param {number} n */
function round2(n) {
  return Math.round(n * 100) / 100;
}
