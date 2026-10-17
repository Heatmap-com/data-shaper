import { configuredDatabase } from '../query-gateway/clickhouse.js';
import { refererName } from '../_lib/dims.js';
import { fetchSessionRows, filtersFor } from '../_lib/session-stream.js';

/**
 * sister-pages: destination-comparison inputs across the site's selected
 * page targets (plan §9.2 stage 1; PI:F2, PG:J6 read across targets).
 * For every ae_page_target row of this site in the current batch, entry
 * sessions on that page from the whole-site session stream, per referrer
 * group: sessions, orders, revenue, RPS and the single-pageview share.
 * Site scope; the page arg is the minimal {idsite, siteName} shape.
 */

export const adapter = {
  id: 'sister-pages',
  dependsOn: [],
  scope: 'site',
  sessions: 'targets',
  provides: ['H24'],

  /**
   * @param {{idsite: number, siteName: string}} page site-level page arg
   * @param {import('../../../ports/dataset.js').RunContext} ctx
   */
  async collect(page, ctx) {
    let targets;
    try {
      targets = await ctx.gateway.query(
      `SELECT toString(idsitehsr) AS idsitehsr,
              url,
              page_title,
              page_type,
              role
         FROM ${configuredDatabase()}.ae_page_target_current
        WHERE batch_id = {batchId:UUID} AND idsite = {idsite:UInt32}`,
      { batchId: ctx.batchId, idsite: page.idsite },
      'sister-pages:page-targets',
      );
    } catch (err) {
      // Pre-cutover clusters have no ae_ tables: zero targets is a result,
      // not a failure (same contract as element-binding/card-history).
      if (!/UNKNOWN_TABLE|Unknown table/i.test(String(err?.message ?? err))) throw err;
      targets = [];
    }

    if (targets.length === 0) {
      return {
        id: adapter.id,
        rows: [],
        notes: { sister_pages_note: 'no page targets for this site in the batch' },
      };
    }

    /** @type {Map<string, object>} */
    const targetByHsr = new Map();
    for (const t of targets) {
      targetByHsr.set(String(t.idsitehsr), {
        url: String(t.url ?? ''),
        role: String(t.role ?? ''),
      });
    }

    const sessions = await fetchSessionRows(ctx, page.idsite);

    /** @type {Map<string, object>} */
    const cells = new Map();
    for (const s of sessions) {
      const target = targetByHsr.get(s.entryHsr);
      if (!target) continue;
      const channel = refererName(s.referer);
      for (const filter of filtersFor(s.tier)) {
        const dims = { idsitehsr: s.entryHsr, url: target.url, role: target.role, channel, bot_filter: filter };
        const key = JSON.stringify(dims);
        let cell = cells.get(key);
        if (!cell) {
          cell = { dims, entrySessions: 0, singlePageview: 0, orders: 0, revenue: 0 };
          cells.set(key, cell);
        }
        cell.entrySessions += 1;
        if (s.pageviews === 1) cell.singlePageview += 1;
        cell.orders += s.orders;
        cell.revenue += s.revenue;
      }
    }

    const rows = [...cells.values()]
      .map((cell) => ({
        dims: cell.dims,
        metrics: {
          entry_sessions: cell.entrySessions,
          orders_udp: cell.orders,
          revenue_udp: round2(cell.revenue),
          rps: cell.entrySessions > 0 ? round4(cell.revenue / cell.entrySessions) : 0,
          single_pageview_share: cell.entrySessions > 0 ? round4(cell.singlePageview / cell.entrySessions) : 0,
        },
      }))
      .sort(
        (a, b) =>
          a.dims.idsitehsr.localeCompare(b.dims.idsitehsr) ||
          a.dims.channel.localeCompare(b.dims.channel) ||
          a.dims.bot_filter.localeCompare(b.dims.bot_filter),
      );

    return { id: adapter.id, rows };
  },
};

/** @param {number} n */
function round2(n) {
  return Math.round(n * 100) / 100;
}

/** @param {number} n */
function round4(n) {
  return Math.round(n * 10000) / 10000;
}
