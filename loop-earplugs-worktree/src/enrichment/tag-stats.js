/**
 * Spread of a per-unit mean across groups. A unit is a session for revenue
 * per session and an order for average order value. Each group carries its
 * unit count, the sum of the measure, and the sum of its squares, so the
 * within-group variance is exact and no unit-level rows are needed.
 *
 * The test is one-way ANOVA. Between-group mean square over within-group
 * mean square is F. (k - 1) * F is treated as chi-square on k - 1 degrees
 * of freedom, which holds when the unit count is large, and the
 * Wilson–Hilferty transform turns it into a z score. Revenue is heavy
 * tailed, which inflates the within-group variance, so the test leans
 * conservative.
 *
 * `spread` is the effect size: the unit-weighted standard deviation of the
 * group means over the grand mean.
 */

/**
 * @typedef {{n: number, sum: number, sumSq: number}} SpreadGroup
 * @typedef {{groups: number, units: number, grandMean: number, f: number, z: number, spread: number}} Spread
 */

/**
 * @param {SpreadGroup[]} groups
 * @returns {Spread}
 */
export function groupSpread(groups) {
  const kept = groups.filter((group) => Number(group.n) > 0);
  const k = kept.length;
  const units = kept.reduce((sum, group) => sum + Number(group.n), 0);
  const total = kept.reduce((sum, group) => sum + Number(group.sum), 0);
  const grandMean = units > 0 ? total / units : 0;
  const empty = { groups: k, units, grandMean, f: 0, z: 0, spread: 0 };
  if (k < 2 || units <= k || grandMean <= 0) return empty;

  let between = 0;
  let within = 0;
  for (const group of kept) {
    const n = Number(group.n);
    const mean = Number(group.sum) / n;
    between += n * (mean - grandMean) ** 2;
    within += Math.max(0, Number(group.sumSq) - n * mean * mean);
  }
  const spread = Math.sqrt(between / units) / grandMean;
  if (within <= 0) return { ...empty, spread };
  const f = (between / (k - 1)) / (within / (units - k));
  return { groups: k, units, grandMean, f, z: wilsonHilferty(f * (k - 1), k - 1), spread };
}

/**
 * Inverse standard normal CDF (Acklam's rational approximation, relative
 * error under 1.2e-9).
 * @param {number} p in (0, 1)
 */
export function normalQuantile(p) {
  if (!(p > 0 && p < 1)) throw new Error('p must be between 0 and 1');
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const tail = (q) => (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
    / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  if (p < 0.02425) return tail(Math.sqrt(-2 * Math.log(p)));
  if (p > 1 - 0.02425) return -tail(Math.sqrt(-2 * Math.log(1 - p)));
  const q = p - 0.5;
  const r = q * q;
  return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q)
    / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/**
 * z score of a chi-square statistic.
 * @param {number} chiSquare
 * @param {number} df
 */
export function wilsonHilferty(chiSquare, df) {
  if (!(df > 0) || !(chiSquare >= 0)) return 0;
  const scale = 2 / (9 * df);
  return (Math.cbrt(chiSquare / df) - (1 - scale)) / Math.sqrt(scale);
}
