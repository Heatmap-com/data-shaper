import { PATH_SEPARATOR, parsePath, prefixReach, sessionPaths } from '../_lib/session-paths.js';
import { siteSessions } from '../_lib/site-sessions.js';
import { filtersFor } from '../_lib/session-stream.js';
import { subjectKey } from '../../domain/subject-types.js';

export const DEFAULT_DEPTH = 3;
export const DEFAULT_MIN_SESSIONS = 100;
export const DEFAULT_MIN_CLUSTER_SHARE = 0.02;
export const DEFAULT_LIMIT_PER_SITE = 5;

/**
 * Page-type path templates as journey subjects. Criteria: `path` (one
 * template such as "home>collection>product"), else the clusters of the
 * multi-page sessions' paths cut at `depth` steps that hold `minSessions`
 * sessions and `minClusterShare` of the multi-page sessions, most first, up
 * to `limitPerSite`. Sessions count after the confirmed-bot filter. The
 * sessions and paths stay in the site memo for the journey readout.
 * @type {import('../../ports/subject.js').SubjectSelectorPort}
 */
export const adapter = {
  id: 'journey-paths',
  subjectType: 'journey',

  async select(site, _qualification, ctx, criteria = {}) {
    const [sessions, paths] = await Promise.all([siteSessions(ctx, site.idsite), sessionPaths(ctx, site.idsite)]);
    const kept = [];
    for (const s of sessions.values()) {
      if (filtersFor(s.tier).includes('exclude_confirmed') && paths.has(s.idvisit)) kept.push(paths.get(s.idvisit));
    }
    return chooseJourneys(kept, criteria).map((c) => journeySubject(c, criteria));
  },
};

/**
 * @param {string[][]} paths the typed paths of the counted sessions
 * @param {{path?: string, depth?: number, minSessions?: number, minClusterShare?: number, limitPerSite?: number}} criteria
 * @returns {Array<{steps: string[], sessions: number, share: number | null}>}
 */
export function chooseJourneys(paths, criteria) {
  const multiPage = paths.filter((p) => p.length >= 2);
  const shareOf = (n) => (multiPage.length > 0 ? Math.round((n / multiPage.length) * 10000) / 10000 : null);
  if (criteria.path !== undefined) {
    const steps = parsePath(criteria.path);
    const sessions = multiPage.filter((p) => prefixReach(p, steps) === steps.length).length;
    return [{ steps, sessions, share: shareOf(sessions) }];
  }
  const depth = criteria.depth ?? DEFAULT_DEPTH;
  /** @type {Map<string, number>} */
  const clusters = new Map();
  for (const p of multiPage) {
    const key = p.slice(0, depth).join(PATH_SEPARATOR);
    clusters.set(key, (clusters.get(key) ?? 0) + 1);
  }
  const minSessions = criteria.minSessions ?? DEFAULT_MIN_SESSIONS;
  const minShare = criteria.minClusterShare ?? DEFAULT_MIN_CLUSTER_SHARE;
  return [...clusters]
    .map(([key, sessions]) => ({ steps: key.split(PATH_SEPARATOR), sessions, share: shareOf(sessions) }))
    .filter((c) => c.sessions >= minSessions && c.share >= minShare)
    .sort((a, b) => b.sessions - a.sessions || (a.steps.join(PATH_SEPARATOR) < b.steps.join(PATH_SEPARATOR) ? -1 : 1))
    .slice(0, criteria.limitPerSite ?? DEFAULT_LIMIT_PER_SITE);
}

/**
 * @param {{steps: string[], sessions: number, share: number | null}} chosen
 * @param {{path?: string}} criteria
 * @returns {import('../../ports/subject.js').SubjectTarget}
 */
function journeySubject({ steps, sessions, share }, criteria) {
  const template = steps.join(PATH_SEPARATOR);
  const counted = `${sessions} exclude_confirmed sessions${share == null ? '' : `, ${share} of multi-page sessions`}`;
  return {
    subjectType: 'journey',
    subjectKey: subjectKey('journey', template),
    label: steps.join(' > '),
    dims: { path: template, steps: steps.length },
    role: 'subject',
    selectionReason: criteria.path !== undefined ? `named by the criteria (${counted})` : `path cluster (${counted})`,
    evidence: { steps: [...steps], sessions, share },
  };
}
