import { loadCatalog } from '../../catalog/index.js';
import { STEP_RULES, stepsOf, subjectCards } from '../_lib/subject-cards.js';

/**
 * cards-fn: one card per FN strategy for one funnel subject, read from its
 * funnel-steps rows through subjectCards: the step that keeps the smallest
 * share of the step before it, the slowest step, and the latest week's
 * completion against the weeks before it. The readings use the window's
 * rows after the confirmed-bot filter.
 */

const RULES = {
  ...STEP_RULES,
  /** The step with the longest median minutes from the step before. */
  'slow-step'(rows, spec) {
    const timed = stepsOf(rows).filter((r) => r.metrics.median_minutes_from_previous != null);
    if (timed.length === 0) return { evaluated: false, detail: 'no step timings: no session reached a second step' };
    const slowest = timed.reduce((a, b) => (b.metrics.median_minutes_from_previous > a.metrics.median_minutes_from_previous ? b : a));
    return {
      evaluated: true,
      triggered: slowest.metrics.median_minutes_from_previous > spec.threshold,
      value: slowest.metrics.median_minutes_from_previous,
      threshold: spec.threshold,
      missing: [],
      detail: `step ${slowest.dims.step_index} ${slowest.dims.step}`,
    };
  },
};

export const adapter = {
  id: 'cards-fn',
  dependsOn: ['funnel-steps'],
  scope: 'subject',
  subjectTypes: ['funnel'],
  provides: [],

  /**
   * @param {{subjectKey: string}} _subject
   * @param {import('../../ports/dataset.js').RunContext} ctx
   */
  async collect(_subject, ctx) {
    const rows = ctx.datasets.get('funnel-steps')?.rows ?? [];
    const catalog = ctx.catalogs ?? loadCatalog();
    return {
      id: adapter.id,
      rows: subjectCards({ catalogId: 'FN', strategies: catalog.strategies.FN.strategies, rows, rules: RULES, readoutKey: 'H12', subjectNoun: 'funnel' }),
    };
  },
};
