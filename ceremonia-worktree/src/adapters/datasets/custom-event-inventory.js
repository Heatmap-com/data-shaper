import { loadCatalog } from '../../catalog/index.js';

/**
 * custom-event-inventory: every custom event emitted for the page, per
 * (event_name, week), with first/last seen and whether the name is in the
 * T-family registry (src/catalog/events.json). The tracker emits nothing
 * on the pilots today (D-01), so zero rows is the expected live result;
 * H28's status stays with the presence-based requirement rule. H28, T21.
 */

export const adapter = {
  id: 'custom-event-inventory',
  dependsOn: [],
  scope: 'page',
  provides: ['H28', 'T21'],

  /**
   * @param {import('../../../ports/qualifier.js').QualifiedPage} page
   * @param {import('../../../ports/dataset.js').RunContext} ctx
   */
  async collect(page, ctx) {
    const [raw, registry] = await Promise.all([fetchCustomEvents(ctx, page), registryNames()]);
    const hsr = String(page.idsitehsr);

    /** @type {Map<string, object>} */
    const cells = new Map();
    for (const row of raw) {
      if (row.idsitehsr !== hsr) continue;
      const dims = { event_name: row.eventName, week: row.week };
      const key = JSON.stringify(dims);
      let cell = cells.get(key);
      if (!cell) {
        cell = { dims, events: 0, firstSeen: row.firstSeen, lastSeen: row.lastSeen };
        cells.set(key, cell);
      }
      cell.events += row.events;
      if (row.firstSeen < cell.firstSeen) cell.firstSeen = row.firstSeen;
      if (row.lastSeen > cell.lastSeen) cell.lastSeen = row.lastSeen;
    }

    const rows = [...cells.values()].map((cell) => ({
      dims: cell.dims,
      metrics: {
        events: cell.events,
        first_seen: cell.firstSeen,
        last_seen: cell.lastSeen,
        registry: registry.has(cell.dims.event_name) ? 'registered' : 'unregistered',
      },
    }));

    return {
      id: adapter.id,
      rows,
      notes: {
        custom_event_inventory_note:
          'zero rows expected on the pilots today (D-01: tracker emits nothing yet); unregistered names flag taxonomy drift',
      },
    };
  },
};

/**
 * Per (event_type, idsitehsr, Monday week) counts and date range.
 * @param {import('../../../ports/dataset.js').RunContext} ctx
 * @param {{idsite: number}} page
 */
async function fetchCustomEvents(ctx, page) {
  const rows = await ctx.gateway.query(
    `SELECT toString(event_type) AS event_name,
            toString(idsitehsr) AS idsitehsr,
            toString(toMonday(server_date)) AS week,
            count() AS events,
            toString(min(server_date)) AS first_seen,
            toString(max(server_date)) AS last_seen
       FROM default.udp_custom_events
      WHERE idsite = {idsite:UInt32}
        AND server_date BETWEEN {w0:Date} AND {w1:Date}
      GROUP BY event_name, idsitehsr, week`,
    { idsite: page.idsite, w0: ctx.windowStart, w1: ctx.windowEnd },
    'custom-event-inventory:events',
  );
  return rows.map((r) => ({
    eventName: String(r.event_name ?? ''),
    idsitehsr: String(r.idsitehsr ?? ''),
    week: r.week,
    events: Number(r.events ?? 0),
    firstSeen: String(r.first_seen ?? ''),
    lastSeen: String(r.last_seen ?? ''),
  }));
}

let registryCache = null;

/** @returns {Promise<Set<string>>} every registered event name, all families */
async function registryNames() {
  if (registryCache) return registryCache;
  const bundle = loadCatalog();
  registryCache = new Set(
    (bundle.events.families ?? []).flatMap((family) => family.events ?? []),
  );
  return registryCache;
}
