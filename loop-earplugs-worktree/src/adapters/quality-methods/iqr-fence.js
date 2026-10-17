import { SUBJECT_MEASURES, ascending, measureOf, median, quantile } from '../../domain/quality/stats.js';
import { checkParams } from '../_lib/quality-params.js';

const SPEC = {
  measure: { type: 'enum', values: [...new Set(Object.values(SUBJECT_MEASURES).flat())] },
  k: { type: 'number', min: 0.5 },
  side: { type: 'enum', values: ['upper', 'lower', 'both'] },
  minRows: { type: 'number', min: 4, integer: true },
};

/** @type {import('../../ports/quality.js').QualityMethodAdapter} */
export const adapter = {
  id: 'iqr-fence',
  subjects: ['orders', 'groups'],
  defaults: Object.freeze({ measure: 'revenue', k: 3, side: 'upper', minRows: 30 }),

  check(params, subject) {
    const problems = checkParams(params, SPEC);
    if (params.measure && !SUBJECT_MEASURES[subject.kind].includes(/** @type {string} */ (params.measure))) {
      problems.push(`measure ${params.measure} is not a ${subject.kind} measure (${SUBJECT_MEASURES[subject.kind].join(', ')})`);
    }
    return problems;
  },

  screen({ subject, rows, params }) {
    const measure = /** @type {string} */ (params.measure);
    const k = /** @type {number} */ (params.k);
    if (rows.length < /** @type {number} */ (params.minRows)) {
      return { candidates: [], stats: { rows: rows.length }, skipped: `${rows.length} rows, under the ${params.minRows} the fence needs` };
    }
    const values = ascending(rows.map((row) => measureOf(row, measure)));
    const q1 = quantile(values, 0.25);
    const q3 = quantile(values, 0.75);
    const iqr = q3 - q1;
    const mid = median(values);
    const stats = { rows: rows.length, q1, median: mid, q3, iqr };
    if (iqr <= 0) return { candidates: [], stats, skipped: `the middle half of ${measure} has no spread (Q1 = Q3 = ${q3}), so a fence would flag every other value` };
    const upper = q3 + k * iqr;
    const lower = q1 - k * iqr;
    const unit = measure === 'revenue' || measure === 'revenue_per_session' ? 'money' : measure.endsWith('_rate') ? 'share' : 'count';
    const noun = subject.kind === 'orders' ? 'orders' : `${subject.by} values`;
    const candidates = [];
    for (const side of params.side === 'both' ? ['upper', 'lower'] : [params.side]) {
      const fence = side === 'upper' ? upper : lower;
      const flagged = rows.filter((row) => (side === 'upper' ? measureOf(row, measure) > fence : measureOf(row, measure) < fence));
      if (flagged.length === 0) continue;
      const found = flagged.map((row) => measureOf(row, measure));
      candidates.push({
        members: flagged.map((row) => String(row.key)),
        label: `${flagged.length} ${noun} ${side === 'upper' ? 'above' : 'below'} the fence`,
        reason: `${measure} ${side === 'upper' ? 'above Q3' : 'below Q1'} ${side === 'upper' ? '+' : '-'} ${k} x IQR (${fence.toFixed(2)})`,
        values: {
          count: flagged.length, measure, fence, q1, median: mid, q3, k,
          low: Math.min(...found), high: Math.max(...found), flaggedTotal: found.reduce((a, b) => a + b, 0),
        },
        units: { count: 'count', fence: unit, q1: unit, median: unit, q3: unit, low: unit, high: unit, flaggedTotal: unit, k: 'number' },
      });
    }
    return { candidates, stats: { ...stats, upper, lower } };
  },
};
