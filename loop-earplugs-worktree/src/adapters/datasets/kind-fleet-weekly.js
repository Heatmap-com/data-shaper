/**
 * kind-fleet-weekly: cross-page element-kind aggregation, site scope.
 * Selector-level click/revenue rows the batch persisted for every page
 * (ae_dataset_row_current, dataset_id 'selector-weekly', bot-excluded
 * cells only) join per selector to ae_element_binding_current for the
 * element_role and position_index, then aggregate per
 * (element_class, element_role, position_index bucket) — the exact index
 * when known, 'unknown' when the binding says -1. Revenue per click
 * (rpc_clicks) is the kind's revenue over its clicks; instances is the
 * distinct selector count. Pre-cutover the ae_ tables do not exist: each
 * read degrades to zero rows plus a note, never a throw (same contract as
 * element-binding/card-history); without bindings a selector keeps role
 * '' and position 'unknown'. H25 (the kind leg; template-weekly is the
 * template leg).
 */

import { configuredDatabase } from '../query-gateway/clickhouse.js';

export const adapter = {
  id: 'kind-fleet-weekly',
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
    let selectorRows;
    try {
      selectorRows = await ctx.gateway.query(
        `SELECT dim_selector, dim_element_class, metrics
           FROM ${configuredDatabase()}.ae_dataset_row_current
          WHERE batch_id = {batchId:UUID}
            AND idsite = {idsite:UInt32}
            AND dataset_id = 'selector-weekly'
            AND bot_filter = 'exclude_confirmed'`,
        params,
        'kind-fleet-weekly:rows',
      );
    } catch (err) {
      if (!/UNKNOWN_TABLE|Unknown table/i.test(String(err?.message ?? err))) throw err;
      selectorRows = [];
      notes.kind_fleet_rows_note = `ae_dataset_row_current unreadable: ${err.message}`;
    }

    /** @type {Array<object>} */
    let bindings;
    try {
      bindings = await ctx.gateway.query(
        `SELECT selector, any(element_role) AS element_role, any(position_index) AS position_index
           FROM ${configuredDatabase()}.ae_element_binding_current
          WHERE idsite = {idsite:UInt32}
          GROUP BY selector`,
        { idsite: page.idsite },
        'kind-fleet-weekly:bindings',
      );
    } catch (err) {
      if (!/UNKNOWN_TABLE|Unknown table/i.test(String(err?.message ?? err))) throw err;
      bindings = [];
      notes.kind_fleet_bindings_note = `ae_element_binding_current unreadable: ${err.message}`;
    }

    /** @type {Map<string, {role: string, position: number}>} */
    const bindingBySelector = new Map();
    for (const b of bindings) {
      bindingBySelector.set(String(b.selector ?? ''), {
        role: String(b.element_role ?? ''),
        position: Number(b.position_index ?? -1),
      });
    }

    /** @type {Map<string, {dims: object, selectors: Set<string>, clicks: number, clickingSessions: number, revenue: number}>} */
    const groups = new Map();
    let matchedBindings = 0;
    for (const r of selectorRows) {
      const selector = String(r.dim_selector ?? '');
      if (selector === '') continue;
      const metrics = parseMetrics(r.metrics);
      if (!metrics) continue;
      const binding = bindingBySelector.get(selector);
      if (binding) matchedBindings += 1;
      const position = binding && Number.isInteger(binding.position) && binding.position >= 0 ? binding.position : 'unknown';
      const dims = {
        element_class: String(r.dim_element_class ?? ''),
        element_role: binding?.role ?? '',
        position_index: position,
      };
      const key = JSON.stringify(dims);
      let group = groups.get(key);
      if (!group) {
        group = { dims, selectors: new Set(), clicks: 0, clickingSessions: 0, revenue: 0 };
        groups.set(key, group);
      }
      group.selectors.add(selector);
      group.clicks += Number(metrics.clicks ?? 0);
      group.clickingSessions += Number(metrics.clicking_sessions ?? 0);
      group.revenue += Number(metrics.revenue_udp ?? 0);
    }

    const rows = [...groups.values()]
      .map((group) => ({
        dims: group.dims,
        metrics: {
          instances: group.selectors.size,
          clicks: group.clicks,
          clicking_sessions: group.clickingSessions,
          revenue: round2(group.revenue),
          rpc_clicks: group.clicks > 0 ? round2(group.revenue / group.clicks) : 0,
        },
      }))
      .sort(
        (a, b) =>
          String(a.dims.element_class).localeCompare(String(b.dims.element_class)) ||
          String(a.dims.element_role).localeCompare(String(b.dims.element_role)) ||
          String(a.dims.position_index).localeCompare(String(b.dims.position_index)),
      );

    notes.kind_fleet_bindings_matched = `${matchedBindings} of ${selectorRows.length} dataset rows matched a binding`;
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
