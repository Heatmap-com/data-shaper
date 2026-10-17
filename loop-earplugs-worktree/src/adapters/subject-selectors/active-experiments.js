import { scanExperiments } from '../_lib/experiment-scan.js';
import { subjectKey } from '../../domain/subject-types.js';

export const DEFAULT_LIMIT_PER_SITE = 25;

/** The lifecycle statuses each `state` criterion takes. */
const STATES = Object.freeze({
  active: new Set(['running', 'recent']),
  ended: new Set(['ended']),
  all: new Set(['running', 'recent', 'ended']),
});

/**
 * The site's partner experiments as experiment subjects, most assigned
 * visits first. An experiment is one with two or more live arms; rollouts,
 * personalizations, and trace tags are never subjects. Criteria: `state`
 * (active: running or ended within RECENT_DAYS; ended; all), `minAssignedVisits`,
 * `experiment` (an exact experiment key or name), and `limitPerSite`. The
 * experiment scan stays in the site memo for the experiment readout.
 * @type {import('../../ports/subject.js').SubjectSelectorPort}
 */
export const adapter = {
  id: 'active-experiments',
  subjectType: 'experiment',

  async select(site, _qualification, ctx, criteria = {}) {
    const scan = await scanExperiments(ctx, site.idsite);
    return chooseExperiments(scan.experiments, criteria).map(experimentSubject);
  },
};

/**
 * @param {Awaited<ReturnType<typeof scanExperiments>>['experiments']} experiments
 * @param {{state?: 'active' | 'ended' | 'all', minAssignedVisits?: number, experiment?: string, limitPerSite?: number}} criteria
 */
export function chooseExperiments(experiments, criteria) {
  const states = STATES[criteria.state ?? 'active'];
  const floor = criteria.minAssignedVisits ?? 0;
  const named = criteria.experiment;
  return experiments
    .filter((e) => e.kind === 'experiment'
      && states.has(e.status)
      && e.arms.filter((a) => !a.stray).length >= 2
      && e.lifecycle.visits >= floor
      && (named === undefined || e.key === named || e.name === named))
    .sort((a, b) => b.lifecycle.visits - a.lifecycle.visits || (a.key < b.key ? -1 : 1))
    .slice(0, criteria.limitPerSite ?? DEFAULT_LIMIT_PER_SITE);
}

/**
 * @param {Awaited<ReturnType<typeof scanExperiments>>['experiments'][number]} exp
 * @returns {import('../../ports/subject.js').SubjectTarget}
 */
function experimentSubject(exp) {
  const life = exp.lifecycle;
  return {
    subjectType: 'experiment',
    subjectKey: subjectKey('experiment', exp.key),
    label: exp.name || exp.key,
    dims: { state: exp.status, partner: exp.partner },
    role: 'subject',
    selectionReason: `${exp.status} experiment (${life.visits} assigned visits, ${life.observedStart} to ${life.observedEnd})`,
    evidence: {
      experimentKey: exp.key,
      observedStart: life.observedStart,
      observedEnd: life.observedEnd,
      arms: exp.arms.filter((a) => !a.stray).map((a) => a.arm),
    },
  };
}
