/**
 * The order statistics the quality methods read. Quantiles interpolate
 * linearly between order statistics (type 7, the default of R and NumPy),
 * so a fence computed here matches one computed in a notebook.
 */

/** @param {readonly number[]} sorted ascending @param {number} p from 0 to 1 */
export function quantile(sorted, p) {
  if (sorted.length === 0) return Number.NaN;
  const at = (sorted.length - 1) * p;
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo);
}

/** @param {readonly number[]} values */
export function ascending(values) {
  return [...values].sort((a, b) => a - b);
}

/** @param {readonly number[]} sorted ascending */
export const median = (sorted) => quantile(sorted, 0.5);

/** Median absolute deviation from the median. @param {readonly number[]} sorted ascending */
export function mad(sorted) {
  const mid = median(sorted);
  return median(ascending(sorted.map((value) => Math.abs(value - mid))));
}

/** A ratio, or null when the denominator is not positive. */
export const ratio = (numerator, denominator) => (denominator > 0 ? numerator / denominator : null);

/**
 * The value of one measure on a subject row. Group rows also read the
 * session ratios a method may screen on.
 * @param {Record<string, number | string>} row
 * @param {string} measure
 */
export function measureOf(row, measure) {
  switch (measure) {
    case 'conversion_rate':
      return ratio(Number(row.buyers) || 0, Number(row.sessions) || 0) ?? 0;
    case 'checkout_rate':
      return ratio(Number(row.progressed) || 0, Number(row.sessions) || 0) ?? 0;
    case 'revenue_per_session':
      return ratio(Number(row.revenue) || 0, Number(row.sessions) || 0) ?? 0;
    default:
      return Number(row[measure]) || 0;
  }
}

/** The measures each subject's rows carry. */
export const SUBJECT_MEASURES = Object.freeze({
  orders: Object.freeze(['revenue']),
  groups: Object.freeze(['sessions', 'buyers', 'orders', 'revenue', 'progressed', 'conversion_rate', 'checkout_rate', 'revenue_per_session']),
});
