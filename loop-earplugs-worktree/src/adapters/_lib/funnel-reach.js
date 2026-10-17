import { loadCatalog } from '../../catalog/index.js';
import { reachCells, siteMemo, siteSessions } from './site-sessions.js';

/**
 * Ordered funnel reach over the window's sessions. A session reaches step i
 * when the funnel's steps 0..i occur in its journey events in that order,
 * other events between them allowed. The events are read once per site,
 * for every event of the funnel catalog's closed list.
 */

/**
 * @param {import('../../ports/dataset.js').RunContext} ctx
 * @returns {{events: string[], funnels: Array<{id: string, title: string, steps: string[]}>}}
 */
export function funnelCatalog(ctx) {
  return (ctx.catalogs ?? loadCatalog()).funnels;
}

/**
 * The window's funnel events per visit, in time order.
 * @param {import('../../ports/dataset.js').RunContext} ctx
 * @param {number} idsite
 * @returns {Promise<Map<string, Array<{eventType: string, tsMs: number}>>>}
 */
export function funnelEvents(ctx, idsite) {
  return siteMemo(ctx, 'funnel-events', idsite, async () => {
    const rows = await ctx.gateway.query(
      `SELECT toString(idvisit) AS idvisit,
              event_type,
              toUInt64(toUnixTimestamp(server_time)) * 1000 AS ts_ms
         FROM default.journey_events_map
        WHERE idsite = {idsite:UInt32}
          AND server_date BETWEEN {w0:Date} AND {w1:Date}
          AND event_type IN {events:Array(String)}
        ORDER BY idvisit, server_time`,
      { idsite, w0: ctx.windowStart, w1: ctx.windowEnd, events: funnelCatalog(ctx).events },
      'funnel:events',
    );
    /** @type {Map<string, Array<{eventType: string, tsMs: number}>>} */
    const byVisit = new Map();
    for (const r of rows) {
      const list = byVisit.get(r.idvisit) ?? [];
      list.push({ eventType: String(r.event_type ?? ''), tsMs: Number(r.ts_ms ?? 0) });
      byVisit.set(r.idvisit, list);
    }
    return byVisit;
  });
}

/**
 * How far one session's events walk the steps in order, and the minutes
 * between consecutive reached steps.
 * @param {Array<{eventType: string, tsMs: number}>} events in time order
 * @param {string[]} steps
 */
export function orderedReach(events, steps) {
  const times = [];
  for (const e of events) {
    if (times.length === steps.length) break;
    if (e.eventType === steps[times.length]) times.push(e.tsMs);
  }
  const gaps = times.slice(1).map((t, i) => Math.round(((t - times[i]) / 60000) * 100) / 100);
  return { reached: times.length, gaps };
}

/**
 * The reach cells of one funnel over the site's sessions.
 * @param {import('../../ports/dataset.js').RunContext} ctx
 * @param {number} idsite
 * @param {string[]} steps
 */
export async function funnelCells(ctx, idsite, steps) {
  const [sessions, events] = await Promise.all([siteSessions(ctx, idsite), funnelEvents(ctx, idsite)]);
  return reachCells(sessions.values(), steps.length, (s) => orderedReach(events.get(s.idvisit) ?? [], steps));
}
