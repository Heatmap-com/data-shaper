import { describe, expect, it } from 'vitest';
import { adapter as cardsXp } from '../src/adapters/datasets/cards-xp.js';
import { chooseExperiments } from '../src/adapters/subject-selectors/active-experiments.js';

/**
 * The experiment subject: active-experiments chooses experiments by
 * lifecycle state, visits, and key or name; cards-xp reads each XP rule
 * from one experiment's readout rows.
 */

const exp = (key, overrides = {}) => ({
  key,
  name: key.toUpperCase(),
  partner: 'shoplift',
  kind: 'experiment',
  status: 'running',
  arms: [{ arm: 'control', stray: false }, { arm: 'b', stray: false }],
  lifecycle: { visits: 1000 },
  ...overrides,
});

const EXPERIMENTS = [
  exp('a', { lifecycle: { visits: 500 } }),
  exp('b', { status: 'recent', lifecycle: { visits: 3000 } }),
  exp('c', { status: 'ended', lifecycle: { visits: 9000 } }),
  exp('d', { kind: 'rollout', lifecycle: { visits: 9999 } }),
  exp('e', { arms: [{ arm: 'control', stray: false }, { arm: 'x', stray: true }] }),
  exp('f', { status: 'trace', lifecycle: { visits: 50 } }),
];

describe('active-experiments', () => {
  it('chooses experiments with two live arms by state, most visits first', () => {
    const keys = (criteria) => chooseExperiments(EXPERIMENTS, criteria).map((e) => e.key);
    expect(keys({})).toEqual(['b', 'a']);
    expect(keys({ state: 'ended' })).toEqual(['c']);
    expect(keys({ state: 'all' })).toEqual(['c', 'b', 'a']);
    expect(keys({ state: 'all', minAssignedVisits: 1000 })).toEqual(['c', 'b']);
    expect(keys({ state: 'all', limitPerSite: 1 })).toEqual(['c']);
    expect(keys({ experiment: 'A' })).toEqual(['a']);
    expect(keys({ experiment: 'c' })).toEqual([]);
  });
});

const row = (basis, arm, metrics, dims = {}) => ({ dims: { experiment_key: 'k', arm, basis, ...dims }, metrics: { is_control: arm === 'control' ? 1 : 0, ...metrics } });

async function cards(rows) {
  const ctx = { datasets: new Map([['experiment-readout', { id: 'experiment-readout', rows }]]), standards: {} };
  const out = await cardsXp.collect({ subjectKey: 'exp:k' }, ctx);
  return Object.fromEntries(out.rows.map((r) => [r.dims.strategy_id, r.metrics]));
}

describe('cards-xp', () => {
  it('includes a failed sample-ratio check on declared allocations and holds an assumed one as conditional', async () => {
    const declared = await cards([
      row('assigned', 'control', { srm_pvalue: 0.0001, srm_basis: 'declared', orders: 50 }),
      row('assigned', 'b', { srm_pvalue: 0.0001, srm_basis: 'declared', orders: 60 }),
    ]);
    expect(declared['XP:A1']).toMatchObject({ verdict: 'include', trigger_state: 'triggered', value: 0.0001, threshold: 0.01, missing_requirements: [] });
    expect(declared['XP:A2']).toMatchObject({ verdict: 'exclude', trigger_state: 'silent', value: 50, threshold: 30 });
    const assumed = await cards([row('assigned', 'control', { srm_pvalue: 0.0001, srm_basis: 'assumed_equal', orders: 10 })]);
    expect(assumed['XP:A1']).toMatchObject({ verdict: 'conditional', trigger_state: 'triggered', missing_requirements: ['O04'] });
    expect(assumed['XP:A2']).toMatchObject({ verdict: 'include', trigger_state: 'triggered', value: 10 });
  });

  it('reads a reversal between the assigned and exposed lifts, and lifted elements', async () => {
    const xp = await cards([
      row('assigned', 'b', { cvr_lift: 0.1, srm_pvalue: 0.5, srm_basis: 'declared', orders: 40 }),
      row('exposed', 'b', { cvr_lift: -0.05 }),
      row('element', 'b', { click_rate_pvalue: 0.001 }, { selector: '#hero a' }),
      row('element', 'b', { click_rate_pvalue: 0.4 }, { selector: '#nav' }),
    ]);
    expect(xp['XP:A3']).toMatchObject({ verdict: 'include', trigger_state: 'triggered', value: 1 });
    expect(xp['XP:A4']).toMatchObject({ verdict: 'include', trigger_state: 'triggered', value: 1, threshold: 0.05 });
    expect(xp['XP:A1']).toMatchObject({ verdict: 'exclude', trigger_state: 'silent' });
  });

  it('holds every card as conditional, unevaluated, when the experiment has no readout', async () => {
    const xp = await cards([]);
    expect(Object.keys(xp)).toEqual(['XP:A1', 'XP:A2', 'XP:A3', 'XP:A4']);
    for (const metrics of Object.values(xp)) {
      expect(metrics).toMatchObject({ verdict: 'conditional', trigger_state: '', trigger_evaluated: 0, missing_requirements: ['H16'] });
    }
  });
});
