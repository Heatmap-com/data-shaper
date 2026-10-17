import { configuredDatabase } from '../query-gateway/clickhouse.js';
import { loadCatalog } from '../../catalog/index.js';

/**
 * descriptor-snapshot (data-capture-plan.md §10.6, Phase 5): the site's
 * page and store descriptors as read, with expiry evaluation — the G1 input
 * for the gate pipeline. Page rows are read per template family carried by
 * ctx.pageTargets (§7.1: descriptors are stored per template and device
 * class); store rows are per-site. Reads go through ctx.persistence when
 * the run carries it; otherwise through the gateway against
 * ae_*_descriptor_current with the idsite bound, degrading to zero rows
 * plus a note on pre-cutover clusters (UNKNOWN_TABLE), never a throw.
 *
 * Expiry (§7): a field is 'current' when expires_at > now AND
 * invalidated_by == ''; 'expired' otherwise. A low-confidence field counts
 * as Unknown for gating (§7.1), so it reports 'unknown' whatever its dates.
 *
 * Output rows, consumed by src/domain/gates.js:
 *   dims:    {scope: 'page'|'store', template_key?, device_class, field_path}
 *   metrics: {status: 'current'|'expired'|'unknown', value_json, provenance,
 *             confidence, expires_at, owner}
 * notes: {descriptor_fields_current, expired, unknown}
 */

export const adapter = {
  id: 'descriptor-snapshot',
  dependsOn: [],
  scope: 'site',
  provides: [],

  /**
   * @param {import('../../../ports/qualifier.js').QualifiedPage} page site-scope page ({idsite, idsitehsr: 0})
   * @param {import('../../../ports/dataset.js').RunContext} ctx
   */
  async collect(page, ctx) {
    const idsite = page.idsite;
    const deviceClasses = loadCatalog().descriptorSchema.device_classes;
    const targets = Array.isArray(ctx.pageTargets) ? ctx.pageTargets : [];
    const templates = [
      ...new Set(
        targets.flatMap((t) => {
          const family = String(t.templateFamily ?? t.template_key ?? '').trim();
          if (family) return [family];
          const hsr = t.idsitehsr ?? '';
          return hsr === '' || Number(hsr) === 0 ? [] : [`url:${hsr}`];
        }),
      ),
    ].sort();

    /** @type {object[]} raw ae_page_descriptor rows */
    let pageRows = [];
    /** @type {object[]} raw ae_store_descriptor rows */
    let storeRows = [];
    /** @type {Record<string, string>} */
    const notes = {};

    if (ctx.persistence?.readPageDescriptor && ctx.persistence?.readStoreDescriptor) {
      for (const template of templates) {
        for (const deviceClass of deviceClasses) {
          pageRows.push(
            ...(await ctx.persistence.readPageDescriptor({
              idsite,
              template_key: template,
              device_class: deviceClass,
            })),
          );
        }
      }
      storeRows = await ctx.persistence.readStoreDescriptor({ idsite });
    } else {
      for (const template of templates) {
        try {
          pageRows.push(
            ...(await ctx.gateway.query(
              `SELECT template_key, device_class, field_path, value_json, provenance,
                      confidence, expires_at, invalidated_by
                 FROM ${configuredDatabase()}.ae_page_descriptor_current
                WHERE idsite = {idsite:UInt32} AND template_key = {templateKey:String}
                ORDER BY device_class, field_path`,
              { idsite, templateKey: template },
              'descriptor-snapshot:page',
            )),
          );
        } catch (err) {
          if (!/UNKNOWN_TABLE|Unknown table/i.test(String(err?.message ?? err))) throw err;
          notes.descriptor_snapshot_note = `ae_page_descriptor_current unreadable: ${err.message}`;
        }
      }
      try {
        storeRows = await ctx.gateway.query(
          `SELECT field_path, value_json, provenance, confidence, expires_at, invalidated_by
             FROM ${configuredDatabase()}.ae_store_descriptor_current
            WHERE idsite = {idsite:UInt32}
            ORDER BY field_path`,
          { idsite },
          'descriptor-snapshot:store',
        );
      } catch (err) {
        if (!/UNKNOWN_TABLE|Unknown table/i.test(String(err?.message ?? err))) throw err;
        notes.descriptor_snapshot_note = `ae_store_descriptor_current unreadable: ${err.message}`;
      }
    }

    const nowMs = Date.now();
    /** @type {Array<{dims: object, metrics: object}>} */
    const rows = [];
    let current = 0;
    let expired = 0;
    let unknown = 0;

    /** @param {'page'|'store'} scope @param {string} templateKey @param {object} row */
    const push = (scope, templateKey, row) => {
      const low = String(row.confidence ?? '') === 'low';
      const invalidated = String(row.invalidated_by ?? '') !== '';
      const expiresMs = parseTimestamp(row.expires_at);
      const fresh = expiresMs !== null && expiresMs > nowMs && !invalidated;
      const status = low ? 'unknown' : fresh ? 'current' : 'expired';
      if (status === 'current') current += 1;
      else if (status === 'expired') expired += 1;
      else unknown += 1;
      rows.push({
        dims: {
          scope,
          ...(scope === 'page' ? { template_key: templateKey } : {}),
          device_class: String(row.device_class ?? 'all'),
          field_path: String(row.field_path ?? ''),
        },
        metrics: {
          status,
          value_json: String(row.value_json ?? 'null'),
          provenance: String(row.provenance ?? ''),
          confidence: String(row.confidence ?? ''),
          expires_at: String(row.expires_at ?? ''),
          owner: String(row.owner ?? ''),
        },
      });
    };

    for (const template of templates) {
      for (const row of pageRows.filter((r) => String(r.template_key ?? '') === template)) {
        push('page', template, row);
      }
    }
    for (const row of storeRows) push('store', '', row);

    notes.descriptor_fields_current = current;
    notes.expired = expired;
    notes.unknown = unknown;
    return { id: adapter.id, rows, notes };
  },
};

/**
 * ClickHouse DateTime64 strings ('2026-12-31 00:00:00.000') and ISO strings
 * both parse; anything unparseable (including '') is not current.
 * @param {*} value
 */
function parseTimestamp(value) {
  if (value === undefined || value === null || value === '') return null;
  const ms = Date.parse(String(value).replace(' ', 'T'));
  return Number.isFinite(ms) ? ms : null;
}
