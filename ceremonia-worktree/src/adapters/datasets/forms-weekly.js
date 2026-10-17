import { deviceName } from '../_lib/dims.js';
import { fetchSessionRows, filtersFor } from '../_lib/session-stream.js';

/**
 * forms-weekly: form_filled and form_submitted events from
 * journey_events_map, per page entry session. Completion share is
 * submitted / filled over sessions that filled. H19.
 */

export const adapter = {
  id: 'forms-weekly',
  dependsOn: [],
  scope: 'page',
  provides: ['H19'],

  /**
   * @param {import('../../../ports/qualifier.js').QualifiedPage} page
   * @param {import('../../../ports/dataset.js').RunContext} ctx
   */
  async collect(page, ctx) {
    const [sessions, formRows] = await Promise.all([
      fetchSessionRows(ctx, page.idsite),
      fetchFormEvents(ctx, page.idsite),
    ]);
    const hsr = String(page.idsitehsr);

    /** @type {Map<string, object>} idvisit -> session, page entry sessions only */
    const pageSessions = new Map();
    for (const s of sessions) {
      if (s.entryHsr === hsr) pageSessions.set(s.idvisit, s);
    }

    /** @type {Map<string, {filled: boolean, submitted: boolean}>} */
    const flagsByVisit = new Map();
    for (const row of formRows) {
      let flags = flagsByVisit.get(row.idvisit);
      if (!flags) {
        flags = { filled: false, submitted: false };
        flagsByVisit.set(row.idvisit, flags);
      }
      if (row.eventType === 'form_filled') flags.filled = true;
      if (row.eventType === 'form_submitted') flags.submitted = true;
    }

    /** @type {Map<string, object>} */
    const cells = new Map();
    for (const [idvisit, flags] of flagsByVisit) {
      const session = pageSessions.get(idvisit);
      if (!session) continue;
      for (const filter of filtersFor(session.tier)) {
        const dims = { week: session.week, device: deviceName(session.device), bot_filter: filter };
        const key = JSON.stringify(dims);
        let cell = cells.get(key);
        if (!cell) {
          cell = { dims, filled: 0, submitted: 0, filledNotSubmitted: 0 };
          cells.set(key, cell);
        }
        if (flags.filled) cell.filled += 1;
        if (flags.submitted) cell.submitted += 1;
        if (flags.filled && !flags.submitted) cell.filledNotSubmitted += 1;
      }
    }

    const rows = [...cells.values()].map((cell) => ({
      dims: cell.dims,
      metrics: {
        form_filled_sessions: cell.filled,
        form_submitted_sessions: cell.submitted,
        filled_not_submitted_sessions: cell.filledNotSubmitted,
        form_completion_share: cell.filled > 0 ? round4(cell.submitted / cell.filled) : null,
      },
    }));

    return { id: adapter.id, rows };
  },
};

/**
 * Per-session form flags over the window.
 * @param {import('../../../ports/dataset.js').RunContext} ctx
 * @param {number} idsite
 */
async function fetchFormEvents(ctx, idsite) {
  const rows = await ctx.gateway.query(
    `SELECT toString(idvisit) AS idvisit, event_type
       FROM default.journey_events_map
      WHERE idsite = {idsite:UInt32}
        AND server_date BETWEEN {w0:Date} AND {w1:Date}
        AND event_type IN ('form_filled', 'form_submitted')`,
    { idsite, w0: ctx.windowStart, w1: ctx.windowEnd },
    'forms-weekly:events',
  );
  return rows.map((r) => ({ idvisit: r.idvisit, eventType: String(r.event_type ?? '') }));
}

/** @param {number} n */
function round4(n) {
  return Math.round(n * 10000) / 10000;
}
