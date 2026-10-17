/**
 * element-binding: the page's stored element bindings from
 * ae_element_binding_current (schema 2, written by the capture consumer).
 * One row per (selector, element_class) with the display name; the
 * taxonomy_version note records which naming taxonomy the rows carry.
 * M05; a missing table is a result (zero rows), not a failure.
 */

import { configuredDatabase } from '../query-gateway/clickhouse.js';

export const adapter = {
  id: 'element-binding',
  dependsOn: [],
  scope: 'page',
  provides: ['M05'],

  /**
   * @param {import('../../../ports/qualifier.js').QualifiedPage} page
   * @param {import('../../../ports/dataset.js').RunContext} ctx
   */
  async collect(page, ctx) {
    let raw;
    try {
      raw = await ctx.gateway.query(
        `SELECT selector, element_class, any(name) AS name, any(taxonomy_version) AS taxonomy_version
           FROM ${configuredDatabase()}.ae_element_binding_current
          WHERE idsite = {idsite:UInt32}
            AND idsitehsr = {idsitehsr:UInt64}
          GROUP BY selector, element_class`,
        { idsite: page.idsite, idsitehsr: page.idsitehsr },
        'element-binding:rows',
      );
    } catch (err) {
      return {
        id: adapter.id,
        rows: [],
        notes: {
          taxonomy_version: 'unknown',
          element_binding_note: `ae_element_binding_current unreadable: ${err.message}`,
        },
      };
    }

    const versions = new Set();
    const rows = [];
    for (const r of raw) {
      const version = String(r.taxonomy_version ?? '');
      if (version) versions.add(version);
      rows.push({
        dims: { selector: String(r.selector ?? ''), element_class: String(r.element_class ?? '') },
        metrics: { name: String(r.name ?? '') },
      });
    }

    return {
      id: adapter.id,
      rows,
      notes: { taxonomy_version: versions.size > 0 ? [...versions].sort().join(',') : 'unknown' },
    };
  },
};
