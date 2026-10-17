import { median } from '../_lib/checks.js';
import { fetchSessionRows, filtersFor } from '../_lib/session-stream.js';

/**
 * funnel-sequence-weekly: step-to-step reach for the commerce funnel from
 * journey_events_map, per session ordered by server_time, restricted to
 * sessions whose entry page is this page. Reach is any-order: a session
 * counts toward from -> to when it contains both steps with to after from;
 * the median is minutes from the session's first from to its first to.
 * Also emits per-step reached_sessions, with checkout_without_atc_sessions
 * on the checkout_started row. H12.
 */

const STEPS = [
  'product_viewed',
  'collection_viewed',
  'add_to_cart',
  'cart_viewed',
  'checkout_started',
  'checkout_completed',
];

export const adapter = {
  id: 'funnel-sequence-weekly',
  dependsOn: [],
  scope: 'page',
  provides: ['H12'],

  /**
   * @param {import('../../../ports/qualifier.js').QualifiedPage} page
   * @param {import('../../../ports/dataset.js').RunContext} ctx
   */
  async collect(page, ctx) {
    const [sessions, eventRows] = await Promise.all([
      fetchSessionRows(ctx, page.idsite),
      fetchFunnelEvents(ctx, page.idsite),
    ]);
    const hsr = String(page.idsitehsr);

    /** @type {Map<string, object>} idvisit -> session, page entry sessions only */
    const pageSessions = new Map();
    for (const s of sessions) {
      if (s.entryHsr === hsr) pageSessions.set(s.idvisit, s);
    }

    /** @type {Map<string, Array<{step: string, ts: number}>>} */
    const eventsByVisit = new Map();
    for (const row of eventRows) {
      if (!pageSessions.has(row.idvisit)) continue;
      let list = eventsByVisit.get(row.idvisit);
      if (!list) {
        list = [];
        eventsByVisit.set(row.idvisit, list);
      }
      list.push({ step: row.eventType, ts: row.tsMs });
    }

    /** @type {Map<string, object>} */
    const cells = new Map();
    const cellFor = (dims) => {
      const key = JSON.stringify(dims);
      let cell = cells.get(key);
      if (!cell) {
        cell = { dims, visits: new Set(), minutes: [] };
        cells.set(key, cell);
      }
      return cell;
    };

    for (const [idvisit, events] of eventsByVisit) {
      const session = pageSessions.get(idvisit);
      /** @type {Map<string, number>} step -> first event time */
      const firstAt = new Map();
      for (const e of events) {
        if (!firstAt.has(e.step)) firstAt.set(e.step, e.ts);
      }
      const stepsPresent = STEPS.filter((step) => firstAt.has(step));
      if (stepsPresent.length === 0) continue;

      for (const filter of filtersFor(session.tier)) {
        for (const step of stepsPresent) {
          const cell = cellFor({ week: session.week, bot_filter: filter, step });
          cell.visits.add(idvisit);
          if (step === 'checkout_started' && !firstAt.has('add_to_cart')) {
            cell.noAtc = (cell.noAtc ?? 0) + 1;
          }
        }
        for (const from of stepsPresent) {
          const fromTs = firstAt.get(from);
          for (const to of stepsPresent) {
            const toTs = firstAt.get(to);
            if (toTs <= fromTs) continue;
            const cell = cellFor({ week: session.week, bot_filter: filter, from_step: from, to_step: to });
            cell.visits.add(idvisit);
            cell.minutes.push((toTs - fromTs) / 60000);
          }
        }
      }
    }

    const rows = [...cells.values()].map((cell) => {
      /** @type {object} */
      const metrics = {};
      if ('step' in cell.dims) {
        metrics.reached_sessions = cell.visits.size;
        if (cell.dims.step === 'checkout_started') {
          metrics.checkout_without_atc_sessions = cell.noAtc ?? 0;
        }
      } else {
        metrics.sessions = cell.visits.size;
        const mid = median(cell.minutes);
        metrics.median_minutes_to_step = mid == null ? null : round2(mid);
      }
      return { dims: cell.dims, metrics };
    });

    return {
      id: adapter.id,
      rows,
      notes: {
        funnel_scope: 'events carry no idsitehsr; page-filtered by session entry page',
      },
    };
  },
};

/**
 * Funnel events for the site in the window, ordered per session.
 * @param {import('../../../ports/dataset.js').RunContext} ctx
 * @param {number} idsite
 */
async function fetchFunnelEvents(ctx, idsite) {
  const rows = await ctx.gateway.query(
    `SELECT toString(idvisit) AS idvisit,
            event_type,
            toUInt64(toUnixTimestamp(server_time)) * 1000 AS ts_ms
       FROM default.journey_events_map
      WHERE idsite = {idsite:UInt32}
        AND server_date BETWEEN {w0:Date} AND {w1:Date}
        AND event_type IN ('product_viewed', 'collection_viewed', 'add_to_cart', 'cart_viewed', 'checkout_started', 'checkout_completed')
      ORDER BY idvisit, server_time`,
    { idsite, w0: ctx.windowStart, w1: ctx.windowEnd },
    'funnel-sequence-weekly:events',
  );
  return rows.map((r) => ({
    idvisit: r.idvisit,
    eventType: String(r.event_type ?? ''),
    tsMs: Number(r.ts_ms ?? 0),
  }));
}

/** @param {number} n */
function round2(n) {
  return Math.round(n * 100) / 100;
}
