/**
 * Strategy cards for one non-page subject. A strategy's `spec.rule` names
 * the reading its catalog's rules take from the subject's readout rows and
 * `spec.threshold` its cut. A triggered card is `include` when its
 * requirements are met and `conditional` when one is missing; a silent card
 * is `exclude`; a card the readout cannot evaluate is `conditional` with
 * trigger_evaluated 0. With no readout rows every card misses `readoutKey`.
 */

/**
 * @typedef {{evaluated: boolean, triggered?: boolean, value?: number | null, threshold?: number | null, missing?: string[], detail?: string}} Reading
 * @typedef {(rows: Array<{dims: object, metrics: object}>, spec: object, extra?: any) => Reading} Rule
 */

/**
 * @param {{catalogId: string, strategies: Array<{id: string, title: string, spec: {rule: string, metric: string}}>,
 *   rows: Array<{dims: object, metrics: object}>, rules: Object<string, Rule>, readoutKey: string, extra?: any, subjectNoun?: string}} input
 */
export function subjectCards({ catalogId, strategies, rows, rules, readoutKey, extra, subjectNoun = 'subject' }) {
  return strategies.map((strategy) => {
    const rule = rules[strategy.spec.rule];
    if (!rule) throw new Error(`cards-${catalogId.toLowerCase()}: strategy ${strategy.id} names unknown rule "${strategy.spec.rule}"`);
    const reading = rows.length === 0 ? { evaluated: false, detail: `no readout rows for this ${subjectNoun}` } : rule(rows, strategy.spec, extra);
    return card(catalogId, strategy, reading, rows.length === 0 ? [readoutKey] : reading.missing ?? []);
  });
}

/**
 * @param {string} catalogId
 * @param {{id: string, title: string, spec: {metric: string}}} strategy
 * @param {Reading} reading
 * @param {string[]} missing
 */
function card(catalogId, strategy, reading, missing) {
  const triggerState = !reading.evaluated ? '' : reading.triggered ? 'triggered' : 'silent';
  const verdict = triggerState === 'silent' ? 'exclude' : triggerState === 'triggered' && missing.length === 0 ? 'include' : 'conditional';
  return {
    dims: { strategy_id: strategy.id },
    metrics: {
      catalog_id: catalogId,
      title: strategy.title,
      verdict,
      trigger_state: triggerState,
      trigger_evaluated: reading.evaluated ? 1 : 0,
      missing_requirements: missing,
      gate_failed: '',
      floor_standard: catalogId,
      metric: strategy.spec.metric,
      value: reading.value ?? null,
      threshold: reading.threshold ?? null,
      detail: reading.detail ?? '',
      attribution_label: 'associated',
    },
  };
}

/**
 * The step rows of one week and filter, in step order.
 * @param {Array<{dims: object, metrics: object}>} rows
 * @param {string} [week]
 */
export function stepsOf(rows, week = 'all') {
  return rows
    .filter((r) => r.dims.week === week && r.dims.bot_filter === 'exclude_confirmed' && r.dims.step_index >= 0)
    .sort((a, b) => a.dims.step_index - b.dims.step_index);
}

/**
 * The rules funnels and journeys share over step rows.
 * @type {Object<string, Rule>}
 */
export const STEP_RULES = {
  /** The step that keeps the smallest share of the step before it. */
  bottleneck(rows, spec) {
    const steps = stepsOf(rows).filter((r) => r.dims.step_index > 0 && r.metrics.continued_rate != null);
    if (steps.length === 0) return { evaluated: false, detail: 'no session reached the first step' };
    const worst = steps.reduce((a, b) => (b.metrics.continued_rate < a.metrics.continued_rate ? b : a));
    return {
      evaluated: true,
      triggered: worst.metrics.continued_rate < spec.threshold,
      value: worst.metrics.continued_rate,
      threshold: spec.threshold,
      missing: [],
      detail: `step ${worst.dims.step_index} ${worst.dims.step}`,
    };
  },
  /** The latest week's completion against the mean of the weeks before it. */
  'weekly-drop'(rows, spec) {
    const weeks = [...new Set(rows.map((r) => r.dims.week).filter((w) => w !== 'all'))].sort();
    const completion = weeks
      .map((week) => {
        const steps = stepsOf(rows, week);
        const first = steps[0]?.metrics.reached_sessions ?? 0;
        return first > 0 ? { week, rate: steps[steps.length - 1].metrics.reached_sessions / first } : null;
      })
      .filter(Boolean);
    if (completion.length < 2) return { evaluated: false, detail: 'fewer than two weeks with sessions on the first step' };
    const latest = completion[completion.length - 1];
    const earlier = completion.slice(0, -1);
    const base = earlier.reduce((sum, w) => sum + w.rate, 0) / earlier.length;
    if (base === 0) return { evaluated: false, detail: 'no completions before the latest week' };
    const drop = Math.round((1 - latest.rate / base) * 10000) / 10000;
    return { evaluated: true, triggered: drop >= spec.threshold, value: drop, threshold: spec.threshold, missing: [], detail: `week ${latest.week}` };
  },
};
