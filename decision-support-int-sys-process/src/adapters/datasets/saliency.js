/**
 * saliency: predicted saliency per render node from
 * ae_render_node_current, restricted to rows a model has scored
 * (saliency_model != ''). Element rows key on selector, section rows on
 * section_id. M04; until a model is chosen (decision
 * docs/decisions/2026-10-04-d08-saliency-and-object-store.md, Q8) no node
 * carries a model, the dataset emits zero rows plus an explicit
 * requirements override marking M04 missing with detail
 * model_not_selected, and M04-dependent strategies (PO C-family,
 * PI:C1-C3/E3/G3, PG:A1/A2/A4) get conditional cards per the plan. A
 * missing table pre-cutover degrades to zero rows plus a note, never a
 * throw (same contract as element-binding/card-history).
 */

import { configuredDatabase } from '../query-gateway/clickhouse.js';

export const adapter = {
  id: 'saliency',
  dependsOn: ['render-snapshot'],
  scope: 'page',
  provides: ['M04'],

  /**
   * @param {import('../../../ports/qualifier.js').QualifiedPage} page
   * @param {import('../../../ports/dataset.js').RunContext} ctx
   */
  async collect(page, ctx) {
    /** @type {Array<object>} */
    let nodes;
    const notes = {};
    try {
      nodes = await ctx.gateway.query(
        `SELECT device_class,
                node_kind,
                node_id,
                selector,
                dom_order,
                saliency_share,
                saliency_quartile,
                saliency_model
           FROM ${configuredDatabase()}.ae_render_node_current
          WHERE idsite = {idsite:UInt32}
            AND idsitehsr = {idsitehsr:UInt64}
            AND saliency_model != ''
          ORDER BY device_class, node_kind, dom_order`,
        { idsite: page.idsite, idsitehsr: page.idsitehsr },
        'saliency:nodes',
      );
    } catch (err) {
      if (!/UNKNOWN_TABLE|Unknown table/i.test(String(err?.message ?? err))) throw err;
      nodes = [];
      notes.saliency_note = `ae_render_node_current unreadable: ${err.message}`;
    }

    const rows = [];
    const models = new Set();
    for (const n of nodes) {
      const model = String(n.saliency_model ?? '');
      if (model) models.add(model);
      const kind = String(n.node_kind ?? '');
      rows.push({
        dims:
          kind === 'section'
            ? { device_class: String(n.device_class ?? ''), node_kind: kind, section_id: String(n.node_id ?? '') }
            : { device_class: String(n.device_class ?? ''), node_kind: kind, selector: String(n.selector ?? '') },
        metrics: {
          saliency_share: n.saliency_share == null ? null : Number(n.saliency_share),
          saliency_quartile: n.saliency_quartile == null ? null : Number(n.saliency_quartile),
          saliency_model: model,
        },
      });
    }

    notes.saliency_nodes = rows.length;
    notes.saliency_model = models.size > 0 ? [...models].sort().join(',') : 'none';

    const dataset = { id: adapter.id, rows, notes };
    if (rows.length === 0) {
      dataset.requirements = [
        {
          key: 'M04',
          status: 'missing',
          rowCount: 0,
          detail: 'model_not_selected (Q8)',
        },
      ];
    }
    return dataset;
  },
};
