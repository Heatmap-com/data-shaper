import { funnelCatalog, funnelEvents } from '../_lib/funnel-reach.js';
import { siteSessions } from '../_lib/site-sessions.js';
import { filtersFor } from '../_lib/session-stream.js';
import { subjectKey } from '../../domain/subject-types.js';

export const DEFAULT_MIN_SESSIONS = 100;
export const DEFAULT_LIMIT_PER_SITE = 3;

/**
 * The funnel catalog's funnels as funnel subjects. Criteria: `funnel` (one
 * catalog funnel by id, whatever its volume), else every funnel whose first
 * step holds `minSessions` sessions after the confirmed-bot filter, most
 * first, up to `limitPerSite`. The sessions and events stay in the site
 * memo for the funnel readout.
 * @type {import('../../ports/subject.js').SubjectSelectorPort}
 */
export const adapter = {
  id: 'catalog-funnels',
  subjectType: 'funnel',

  async select(site, _qualification, ctx, criteria = {}) {
    const { funnels } = funnelCatalog(ctx);
    const [sessions, events] = await Promise.all([siteSessions(ctx, site.idsite), funnelEvents(ctx, site.idsite)]);
    const firstStep = new Map(funnels.map((f) => [f.id, 0]));
    for (const s of sessions.values()) {
      if (!filtersFor(s.tier).includes('exclude_confirmed')) continue;
      const visitEvents = events.get(s.idvisit);
      if (!visitEvents) continue;
      for (const f of funnels) {
        if (visitEvents.some((e) => e.eventType === f.steps[0])) firstStep.set(f.id, firstStep.get(f.id) + 1);
      }
    }
    return chooseFunnels(funnels, firstStep, criteria).map((c) => funnelSubject(c, criteria));
  },
};

/**
 * @param {Array<{id: string, title: string, steps: string[]}>} funnels
 * @param {Map<string, number>} firstStep sessions on each funnel's first step
 * @param {{funnel?: string, minSessions?: number, limitPerSite?: number}} criteria
 * @returns {Array<{funnel: {id: string, title: string, steps: string[]}, sessions: number}>}
 */
export function chooseFunnels(funnels, firstStep, criteria) {
  const withVolume = funnels.map((funnel) => ({ funnel, sessions: firstStep.get(funnel.id) ?? 0 }));
  if (criteria.funnel !== undefined) {
    const named = withVolume.filter((c) => c.funnel.id === criteria.funnel);
    if (named.length === 0) throw new Error(`unknown funnel "${criteria.funnel}"; known: ${funnels.map((f) => f.id).join(', ')}`);
    return named;
  }
  const floor = criteria.minSessions ?? DEFAULT_MIN_SESSIONS;
  return withVolume
    .filter((c) => c.sessions > 0 && c.sessions >= floor)
    .sort((a, b) => b.sessions - a.sessions || funnels.indexOf(a.funnel) - funnels.indexOf(b.funnel))
    .slice(0, criteria.limitPerSite ?? DEFAULT_LIMIT_PER_SITE);
}

/**
 * @param {{funnel: {id: string, title: string, steps: string[]}, sessions: number}} chosen
 * @param {{funnel?: string}} criteria
 * @returns {import('../../ports/subject.js').SubjectTarget}
 */
function funnelSubject({ funnel, sessions }, criteria) {
  return {
    subjectType: 'funnel',
    subjectKey: subjectKey('funnel', funnel.id),
    label: funnel.title,
    dims: { funnel: funnel.id, steps: funnel.steps.length },
    role: 'subject',
    selectionReason: criteria.funnel !== undefined
      ? `named by the criteria (${sessions} sessions on ${funnel.steps[0]})`
      : `${sessions} exclude_confirmed sessions on ${funnel.steps[0]}`,
    evidence: { funnelId: funnel.id, steps: [...funnel.steps], firstStepSessions: sessions },
  };
}
