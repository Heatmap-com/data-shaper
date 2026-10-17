import { loadCatalog } from '../../catalog/index.js';
import { subjectCards } from '../_lib/subject-cards.js';

/**
 * cards-xp: one card per XP strategy for one experiment subject, read from
 * its experiment-readout rows, through subjectCards. The order floor is the
 * XP standard's; the sample-ratio card misses O04 when the allocation is
 * assumed equal, not declared.
 */

const DEFAULT_ORDER_FLOOR = 30;

export const adapter = {
  id: 'cards-xp',
  dependsOn: ['experiment-readout'],
  scope: 'subject',
  subjectTypes: ['experiment'],
  provides: [],

  /**
   * @param {{subjectKey: string}} _subject
   * @param {import('../../ports/dataset.js').RunContext} ctx
   */
  async collect(_subject, ctx) {
    const rows = ctx.datasets.get('experiment-readout')?.rows ?? [];
    const catalog = ctx.catalogs ?? loadCatalog();
    const floor = ctx.standards?.catalogs?.XP?.orders_per_compared_segment
      ?? catalog.standards.catalogs.XP?.orders_per_compared_segment
      ?? DEFAULT_ORDER_FLOOR;
    return {
      id: adapter.id,
      rows: subjectCards({ catalogId: 'XP', strategies: catalog.strategies.XP.strategies, rows, rules: RULES, readoutKey: 'H16', extra: floor, subjectNoun: 'experiment' }),
    };
  },
};

/** The readings each rule takes from the readout rows. */
const RULES = {
  srm(rows, spec) {
    const assigned = rows.filter((r) => r.dims.basis === 'assigned');
    const p = assigned.find((r) => r.metrics.srm_pvalue != null)?.metrics.srm_pvalue;
    if (p == null) return { evaluated: false, detail: 'no sample-ratio p-value: the declared allocation covers some arms only' };
    const declared = assigned[0].metrics.srm_basis === 'declared';
    return { evaluated: true, triggered: p < spec.threshold, value: p, threshold: spec.threshold, missing: declared ? [] : ['O04'] };
  },
  underpowered(rows, _spec, floor) {
    const assigned = rows.filter((r) => r.dims.basis === 'assigned');
    if (assigned.length === 0) return { evaluated: false, detail: 'no assigned-basis readout' };
    const fewest = Math.min(...assigned.map((r) => r.metrics.orders ?? 0));
    return { evaluated: true, triggered: fewest < floor, value: fewest, threshold: floor, missing: [] };
  },
  'basis-reversal'(rows) {
    const lifts = (basis) => new Map(rows
      .filter((r) => r.dims.basis === basis && r.metrics.is_control === 0 && r.metrics.cvr_lift != null)
      .map((r) => [r.dims.arm, r.metrics.cvr_lift]));
    const exposed = lifts('exposed');
    if (exposed.size === 0) return { evaluated: false, detail: 'no exposed basis: the experiment reads on assignment only' };
    const assigned = lifts('assigned');
    const reversed = [...exposed].filter(([arm, lift]) => assigned.has(arm) && Math.sign(lift) * Math.sign(assigned.get(arm)) < 0);
    return { evaluated: true, triggered: reversed.length > 0, value: reversed.length, threshold: 1, missing: [] };
  },
  'element-lift'(rows, spec) {
    const elements = rows.filter((r) => r.dims.basis === 'element' && r.metrics.is_control === 0);
    if (elements.length === 0) return { evaluated: false, detail: 'no element readout' };
    const lifted = elements.filter((r) => r.metrics.click_rate_pvalue != null && r.metrics.click_rate_pvalue < spec.threshold);
    return { evaluated: true, triggered: lifted.length > 0, value: lifted.length, threshold: spec.threshold, missing: [] };
  },
};
