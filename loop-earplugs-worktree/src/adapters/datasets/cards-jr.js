import { loadCatalog } from '../../catalog/index.js';
import { STEP_RULES, stepsOf, subjectCards } from '../_lib/subject-cards.js';

/**
 * cards-jr: one card per JR strategy for one journey subject, read from its
 * journey-path rows through subjectCards: the template step that keeps the
 * smallest share of the step before it, the conversion of the sessions that
 * complete the template against every session's, and the latest week's
 * completion against the weeks before it. The readings use the window's
 * rows after the confirmed-bot filter.
 */

const RULES = {
  ...STEP_RULES,
  /** The completers' conversion as a ratio of the site's. */
  'path-conversion'(rows, spec) {
    const steps = stepsOf(rows);
    const site = rows.find((r) => r.dims.week === 'all' && r.dims.bot_filter === 'exclude_confirmed' && r.dims.step_index === -1);
    const completed = steps[steps.length - 1];
    if (!completed || completed.metrics.cvr == null || !site?.metrics.cvr) {
      return { evaluated: false, detail: 'no completed sessions or no site conversion' };
    }
    const ratio = Math.round((completed.metrics.cvr / site.metrics.cvr) * 10000) / 10000;
    const floor = 1 - spec.threshold;
    return { evaluated: true, triggered: ratio < floor, value: ratio, threshold: floor, missing: [], detail: `${completed.metrics.reached_sessions} sessions completed the template` };
  },
};

export const adapter = {
  id: 'cards-jr',
  dependsOn: ['journey-path'],
  scope: 'subject',
  subjectTypes: ['journey'],
  provides: [],

  /**
   * @param {{subjectKey: string}} _subject
   * @param {import('../../ports/dataset.js').RunContext} ctx
   */
  async collect(_subject, ctx) {
    const rows = ctx.datasets.get('journey-path')?.rows ?? [];
    const catalog = ctx.catalogs ?? loadCatalog();
    return {
      id: adapter.id,
      rows: subjectCards({ catalogId: 'JR', strategies: catalog.strategies.JR.strategies, rows, rules: RULES, readoutKey: 'H20', subjectNoun: 'journey' }),
    };
  },
};
