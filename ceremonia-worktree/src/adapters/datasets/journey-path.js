import { MAX_STEPS, pathCells } from '../_lib/session-paths.js';
import { rate, siteSessions, stepRows } from '../_lib/site-sessions.js';
import { filtersFor } from '../_lib/session-stream.js';

/**
 * journey-path: one journey subject's template over the window's sessions.
 * Per (week, bot filter), with an `all` week, each step's sessions whose
 * page-type path opens with the template up to it, the share that continued
 * from the step before, and their orders, revenue, and conversion. A `site`
 * row (step_index -1) per cell holds every session's conversion for the
 * comparison the JR cards read.
 */

export const adapter = {
  id: 'journey-path',
  dependsOn: [],
  scope: 'subject',
  subjectTypes: ['journey'],
  provides: ['H20'],

  /**
   * @param {{idsite: number, evidence: {steps?: string[]}}} subject the subject page
   * @param {import('../../ports/dataset.js').RunContext} ctx
   */
  async collect(subject, ctx) {
    const steps = subject.evidence?.steps ?? [];
    const [cells, sessions] = await Promise.all([pathCells(ctx, subject.idsite, steps), siteSessions(ctx, subject.idsite)]);
    const site = siteConversion(sessions.values());
    const rows = cells.map((cell) => {
      const tally = site.get(`${cell.week}|${cell.filter}`) ?? { sessions: 0, buyers: 0 };
      return {
        dims: { week: cell.week, bot_filter: cell.filter, step_index: -1, step: 'site' },
        metrics: { reached_sessions: tally.sessions, cvr: rate(tally.buyers, tally.sessions) },
      };
    });
    rows.push(...stepRows(cells, steps));
    return {
      id: adapter.id,
      rows,
      notes: { journey_template: steps.join(' > '), journey_path: `the first ${MAX_STEPS} page types of a session, a run of one type as one step` },
    };
  },
};

/**
 * Sessions and buyers per week|filter, with an `all` week.
 * @param {Iterable<{week: string, tier: string | null, orders: number}>} sessions
 */
function siteConversion(sessions) {
  /** @type {Map<string, {sessions: number, buyers: number}>} */
  const tallies = new Map();
  for (const s of sessions) {
    for (const filter of filtersFor(s.tier)) {
      for (const week of [s.week, 'all']) {
        const key = `${week}|${filter}`;
        const tally = tallies.get(key) ?? { sessions: 0, buyers: 0 };
        tally.sessions += 1;
        if (s.orders > 0) tally.buyers += 1;
        tallies.set(key, tally);
      }
    }
  }
  return tallies;
}
