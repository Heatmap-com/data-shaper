import { SUBJECT_MEASURES, ascending, mad, measureOf, median } from '../../domain/quality/stats.js';
import { checkParams } from '../_lib/quality-params.js';

/** The MAD of a normal distribution is 0.6745 of its standard deviation. */
const NORMAL_MAD = 0.6745;

const SPEC = {
  measure: { type: 'enum', values: [...new Set(Object.values(SUBJECT_MEASURES).flat())] },
  threshold: { type: 'number', min: 1 },
  side: { type: 'enum', values: ['upper', 'lower', 'both'] },
  minRows: { type: 'number', min: 4, integer: true },
};

/** @type {import('../../ports/quality.js').QualityMethodAdapter} */
export const adapter = {
  id: 'robust-z',
  subjects: ['orders', 'groups'],
  defaults: Object.freeze({ measure: 'revenue', threshold: 3.5, side: 'upper', minRows: 30 }),

  check(params, subject) {
    const problems = checkParams(params, SPEC);
    if (params.measure && !SUBJECT_MEASURES[subject.kind].includes(/** @type {string} */ (params.measure))) {
      problems.push(`measure ${params.measure} is not a ${subject.kind} measure (${SUBJECT_MEASURES[subject.kind].join(', ')})`);
    }
    return problems;
  },

  screen({ subject, rows, params }) {
    const measure = /** @type {string} */ (params.measure);
    const threshold = /** @type {number} */ (params.threshold);
    if (rows.length < /** @type {number} */ (params.minRows)) {
      return { candidates: [], stats: { rows: rows.length }, skipped: `${rows.length} rows, under the ${params.minRows} the score needs` };
    }
    const values = ascending(rows.map((row) => measureOf(row, measure)));
    const mid = median(values);
    const spread = mad(values);
    const stats = { rows: rows.length, median: mid, mad: spread };
    if (spread <= 0) return { candidates: [], stats, skipped: `half of the ${measure} values equal the median, so the MAD is 0 and every other value would score as an outlier` };
    const score = (row) => (NORMAL_MAD * (measureOf(row, measure) - mid)) / spread;
    const unit = measure === 'revenue' || measure === 'revenue_per_session' ? 'money' : measure.endsWith('_rate') ? 'share' : 'count';
    const noun = subject.kind === 'orders' ? 'orders' : `${subject.by} values`;
    const candidates = [];
    for (const side of params.side === 'both' ? ['upper', 'lower'] : [params.side]) {
      const flagged = rows.filter((row) => (side === 'upper' ? score(row) > threshold : score(row) < -threshold));
      if (flagged.length === 0) continue;
      const found = flagged.map((row) => measureOf(row, measure));
      const cut = side === 'upper' ? mid + (threshold * spread) / NORMAL_MAD : mid - (threshold * spread) / NORMAL_MAD;
      candidates.push({
        members: flagged.map((row) => String(row.key)),
        label: `${flagged.length} ${noun} ${side === 'upper' ? 'above' : 'below'} a robust z of ${side === 'upper' ? '' : '-'}${threshold}`,
        reason: `${measure} more than ${threshold} robust standard deviations ${side === 'upper' ? 'above' : 'below'} the median (beyond ${cut.toFixed(2)})`,
        values: {
          count: flagged.length, measure, fence: cut, median: mid, mad: spread, threshold,
          low: Math.min(...found), high: Math.max(...found), flaggedTotal: found.reduce((a, b) => a + b, 0),
        },
        units: { count: 'count', fence: unit, median: unit, mad: unit, low: unit, high: unit, flaggedTotal: unit, threshold: 'number' },
      });
    }
    return { candidates, stats };
  },
};
