/**
 * tool-registry: the site's tool facts from ae_tool_registry_current
 * (schema 2, plan §7.3), site scope. One row per installed-or-observed
 * tool with its modules, owned surfaces, join class and taxonomy/API
 * status; V13 is the registry leg and s16 (region owners) derives from
 * these rows. A tool whose event_taxonomy_status is 'undocumented' flags
 * metrics.undocumented_events = 1 — cards read this and stay conditional
 * per TG's "do not invent client event names". Pre-cutover the ae_ table
 * does not exist: the read degrades to zero rows plus a note, never a
 * throw. Absence of a row is not evidence: 3199/3207 carry no tool facts
 * until detection or the operator adds them.
 */

import { configuredDatabase } from '../query-gateway/clickhouse.js';

export const adapter = {
  id: 'tool-registry',
  dependsOn: [],
  scope: 'site',
  provides: ['V13', 's16'],

  /**
   * @param {{idsite: number, siteName: string}} page site-level page arg
   * @param {import('../../../ports/dataset.js').RunContext} ctx
   */
  async collect(page, ctx) {
    /** @type {Array<object>} */
    let tools;
    try {
      tools = await ctx.gateway.query(
        `SELECT tool, installed, modules, surfaces_owned, revenue_join_class,
                event_taxonomy_status, api_status, detection_sources,
                detection_confidence, verified_by_walk_at, note
           FROM ${configuredDatabase()}.ae_tool_registry_current
          WHERE idsite = {idsite:UInt32}
          ORDER BY tool`,
        { idsite: page.idsite },
        'tool-registry:rows',
      );
    } catch (err) {
      if (!/UNKNOWN_TABLE|Unknown table/i.test(String(err?.message ?? err))) throw err;
      tools = [];
      return {
        id: adapter.id,
        rows: [],
        notes: { tool_registry_note: `ae_tool_registry_current unreadable: ${err.message}` },
      };
    }

    const rows = tools.map((r) => {
      const eventTaxonomyStatus = String(r.event_taxonomy_status ?? '');
      return {
        dims: { tool: String(r.tool ?? '') },
        metrics: {
          installed: Number(r.installed ?? 0),
          modules: Array.isArray(r.modules) ? [...r.modules] : [],
          surfaces_owned: Array.isArray(r.surfaces_owned) ? [...r.surfaces_owned] : [],
          revenue_join_class: String(r.revenue_join_class ?? ''),
          event_taxonomy_status: eventTaxonomyStatus,
          api_status: String(r.api_status ?? ''),
          detection_sources: Array.isArray(r.detection_sources) ? [...r.detection_sources] : [],
          detection_confidence: String(r.detection_confidence ?? ''),
          verified_by_walk_at: r.verified_by_walk_at ?? null,
          note: String(r.note ?? ''),
          ...(eventTaxonomyStatus === 'undocumented' ? { undocumented_events: 1 } : {}),
        },
      };
    });

    return { id: adapter.id, rows, notes: { tool_registry_tools: rows.length } };
  },
};
