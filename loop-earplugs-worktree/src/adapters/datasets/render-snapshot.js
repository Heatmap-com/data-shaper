/**
 * render-snapshot: the page's captured render state from
 * ae_page_render_current (one row per device render) and
 * ae_render_node_current (one row per section or element node).
 * Render rows carry the viewport, page height, fold, content/DOM hashes,
 * section count and render time (M01). Section rows carry their geometry
 * and type (M02); element rows carry boxes, DOM order, control and
 * clickable-looking flags, sticky status, visual class, image type, word
 * count and first-viewport membership (M02, M03, M06). Saliency itself is
 * the saliency dataset's M04; element rows only expose has_saliency here
 * (0 until the worker rewrites the nodes). capture_id rides in dim_extra
 * (_lib/rows.js promotes only week/device/referer/selector). Pre-cutover
 * clusters have no ae_ tables: each read degrades to zero rows plus a
 * note, never a throw (same contract as element-binding/card-history).
 */

import { configuredDatabase } from '../query-gateway/clickhouse.js';

export const adapter = {
  id: 'render-snapshot',
  dependsOn: ['element-binding'],
  scope: 'page',
  provides: ['M01', 'M02', 'M03', 'M06'],

  /**
   * @param {import('../../../ports/qualifier.js').QualifiedPage} page
   * @param {import('../../../ports/dataset.js').RunContext} ctx
   */
  async collect(page, ctx) {
    const params = { idsite: page.idsite, idsitehsr: page.idsitehsr };
    const notes = {};

    /** @type {Array<object>} */
    let renders;
    try {
      renders = await ctx.gateway.query(
        `SELECT device_class,
                toString(capture_id) AS capture_id,
                viewport_w,
                viewport_h,
                page_height_px,
                fold_px,
                content_hash,
                dom_hash,
                length(section_order) AS section_count,
                toString(rendered_at) AS rendered_at
           FROM ${configuredDatabase()}.ae_page_render_current
          WHERE idsite = {idsite:UInt32}
            AND idsitehsr = {idsitehsr:UInt64}
          ORDER BY device_class`,
        params,
        'render-snapshot:renders',
      );
    } catch (err) {
      if (!/UNKNOWN_TABLE|Unknown table/i.test(String(err?.message ?? err))) throw err;
      renders = [];
      notes.render_snapshot_note = `ae_page_render_current unreadable: ${err.message}`;
    }

    /** @type {Array<object>} */
    let nodes;
    try {
      nodes = await ctx.gateway.query(
        `SELECT device_class,
                node_kind,
                node_id,
                parent_section_id,
                selector,
                section_type,
                dom_order,
                x,
                y,
                w,
                h,
                is_control,
                looks_clickable,
                is_sticky,
                visual_class,
                image_type,
                word_count,
                in_first_viewport,
                saliency_model
           FROM ${configuredDatabase()}.ae_render_node_current
          WHERE idsite = {idsite:UInt32}
            AND idsitehsr = {idsitehsr:UInt64}
          ORDER BY device_class, node_kind, dom_order`,
        params,
        'render-snapshot:nodes',
      );
    } catch (err) {
      if (!/UNKNOWN_TABLE|Unknown table/i.test(String(err?.message ?? err))) throw err;
      nodes = [];
      notes.render_nodes_note = `ae_render_node_current unreadable: ${err.message}`;
    }

    const rows = [];
    const devices = new Set();
    for (const r of renders) {
      const device = String(r.device_class ?? '');
      devices.add(device);
      rows.push({
        dims: { device_class: device, capture_id: String(r.capture_id ?? '') },
        metrics: {
          viewport_w: Number(r.viewport_w ?? 0),
          viewport_h: Number(r.viewport_h ?? 0),
          page_height_px: Number(r.page_height_px ?? 0),
          fold_px: Number(r.fold_px ?? 0),
          content_hash: String(r.content_hash ?? ''),
          dom_hash: String(r.dom_hash ?? ''),
          section_count: Number(r.section_count ?? 0),
          rendered_at: String(r.rendered_at ?? ''),
        },
      });
    }

    for (const n of nodes) {
      const device = String(n.device_class ?? '');
      devices.add(device);
      const base = {
        device_class: device,
        in_first_viewport: Number(n.in_first_viewport ?? 0),
        word_count: Number(n.word_count ?? 0),
      };
      if (String(n.node_kind ?? '') === 'section') {
        rows.push({
          dims: { device_class: device, node_kind: 'section', section_id: String(n.node_id ?? '') },
          metrics: {
            selector: String(n.selector ?? ''),
            top: Number(n.y ?? 0),
            height: Number(n.h ?? 0),
            section_type: String(n.section_type ?? ''),
            word_count: base.word_count,
            in_first_viewport: base.in_first_viewport,
          },
        });
      } else {
        rows.push({
          dims: { device_class: device, node_kind: 'element', selector: String(n.selector ?? '') },
          metrics: {
            section_id: String(n.parent_section_id ?? ''),
            dom_order: Number(n.dom_order ?? 0),
            x: Number(n.x ?? 0),
            y: Number(n.y ?? 0),
            w: Number(n.w ?? 0),
            h: Number(n.h ?? 0),
            is_control: Number(n.is_control ?? 0),
            looks_clickable: Number(n.looks_clickable ?? 0),
            is_sticky: Number(n.is_sticky ?? 0),
            visual_class: String(n.visual_class ?? ''),
            image_type: String(n.image_type ?? ''),
            word_count: base.word_count,
            in_first_viewport: base.in_first_viewport,
            has_saliency: String(n.saliency_model ?? '') !== '' ? 1 : 0,
          },
        });
      }
    }

    notes.render_devices = [...devices].sort();
    return { id: adapter.id, rows, notes };
  },
};
