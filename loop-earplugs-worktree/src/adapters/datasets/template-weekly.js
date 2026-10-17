/**
 * template-weekly: page-dataset totals rolled up by template family, site
 * scope. The current batch's page targets come from
 * ae_page_target_current (template_family, falling back to page_type when
 * the family is blank); per-page totals come from the page-segment-weekly
 * rows the batch persisted in ae_dataset_row_current, summed in JS per
 * (idsitehsr, week) over the bot-excluded cells (exclude_confirmed: the
 * session-level cells partition the page's sessions, so one bot filter
 * avoids double counting). Analysis rows may not exist when this runs;
 * targets without rows contribute nothing. Pre-cutover the ae_ tables do
 * not exist: zero rows plus a note, never a throw (same contract as
 * element-binding/card-history). H25.
 */

import { configuredDatabase } from '../query-gateway/clickhouse.js';

export const adapter = {
  id: 'template-weekly',
  dependsOn: [],
  scope: 'site',
  provides: ['H25'],

  /**
   * @param {{idsite: number, siteName: string}} page site-level page arg
   * @param {import('../../../ports/dataset.js').RunContext} ctx
   */
  async collect(page, ctx) {
    const params = { batchId: ctx.batchId, idsite: page.idsite };
    const notes = {};

    /** @type {Array<object>} */
    let targets;
    try {
      targets = await ctx.gateway.query(
        `SELECT toString(idsitehsr) AS idsitehsr, page_type, template_family
           FROM ${configuredDatabase()}.ae_page_target_current
          WHERE batch_id = {batchId:UUID}
            AND idsite = {idsite:UInt32}`,
        params,
        'template-weekly:targets',
      );
    } catch (err) {
      if (!/UNKNOWN_TABLE|Unknown table/i.test(String(err?.message ?? err))) throw err;
      targets = [];
      notes.template_targets_note = `ae_page_target_current unreadable: ${err.message}`;
    }

    /** @type {Array<object>} */
    let pageRows;
    try {
      pageRows = await ctx.gateway.query(
        `SELECT toString(idsitehsr) AS idsitehsr,
                toString(dim_week) AS week,
                metrics
           FROM ${configuredDatabase()}.ae_dataset_row_current
          WHERE batch_id = {batchId:UUID}
            AND idsite = {idsite:UInt32}
            AND dataset_id = 'page-segment-weekly'
            AND bot_filter = 'exclude_confirmed'`,
        params,
        'template-weekly:page-rows',
      );
    } catch (err) {
      if (!/UNKNOWN_TABLE|Unknown table/i.test(String(err?.message ?? err))) throw err;
      pageRows = [];
      notes.template_dataset_rows_note = `ae_dataset_row_current unreadable: ${err.message}`;
    }

    /** @type {Map<string, string>} idsitehsr -> template family (or page_type fallback) */
    const familyByHsr = new Map();
    let fromFamily = 0;
    let fromPageType = 0;
    for (const t of targets) {
      const family = String(t.template_family ?? '').trim();
      const pageType = String(t.page_type ?? '').trim();
      if (family !== '') {
        familyByHsr.set(String(t.idsitehsr), family);
        fromFamily += 1;
      } else if (pageType !== '') {
        familyByHsr.set(String(t.idsitehsr), pageType);
        fromPageType += 1;
      }
    }
    notes.template_family_source =
      `template_family column: ${fromFamily} targets; page_type fallback: ${fromPageType} targets`;

    /** @type {Map<string, {sessions: number, orders: number, revenue: number}>} family|week */
    const cells = new Map();
    let unmappedRows = 0;
    for (const r of pageRows) {
      const family = familyByHsr.get(String(r.idsitehsr));
      if (!family) {
        unmappedRows += 1;
        continue;
      }
      const metrics = parseMetrics(r.metrics);
      if (!metrics) continue;
      const week = String(r.week ?? '');
      const key = `${family}|${week}`;
      let cell = cells.get(key);
      if (!cell) {
        cell = { sessions: 0, orders: 0, revenue: 0 };
        cells.set(key, cell);
      }
      cell.sessions += Number(metrics.sessions ?? 0);
      cell.orders += Number(metrics.orders_udp ?? 0);
      cell.revenue += Number(metrics.revenue_udp ?? 0);
    }
    if (unmappedRows > 0) {
      notes.template_unmapped_rows = `${unmappedRows} page-segment rows had no target in this batch`;
    }

    const rows = [...cells.entries()]
      .map(([key, cell]) => {
        const [template_family, week] = key.split('|');
        return {
          dims: { template_family, week },
          metrics: {
            entry_sessions: cell.sessions,
            orders: cell.orders,
            revenue: round2(cell.revenue),
            rps: cell.sessions > 0 ? round2(cell.revenue / cell.sessions) : 0,
          },
        };
      })
      .sort((a, b) => a.dims.template_family.localeCompare(b.dims.template_family) || a.dims.week.localeCompare(b.dims.week));

    return { id: adapter.id, rows, notes };
  },
};

/**
 * ae_dataset_row_current stores metrics as a JSON string; tolerate an
 * already-parsed object so fixtures can pass either shape.
 * @param {unknown} raw
 * @returns {object | null}
 */
function parseMetrics(raw) {
  if (raw == null) return null;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(String(raw));
  } catch {
    return null;
  }
}

/** @param {number} n */
function round2(n) {
  return Math.round(n * 100) / 100;
}
