/**
 * Statistics for experiment readouts: the sample-ratio check against a
 * declared allocation, and two-sided tests on conversion rate and revenue
 * per session. Sample sizes on a tagged arm are in the thousands, so the
 * revenue test uses the normal approximation to Welch's t.
 */

import { pooledProportionZ } from '../lib/stats/proportions.js';

/**
 * Chi-square SRM p-value of the observed arm assignment counts against the
 * declared allocation. Null when there is no declaration, fewer than two
 * declared arms, or an observed arm is not declared.
 * @param {Map<string, number>} observed arm -> sessions
 * @param {Array<{arm: string, allocation: number}> | null | undefined} declared shares summing to 1
 * @returns {number | null}
 */
export function srmPvalue(observed, declared) {
  if (!declared || declared.filter((a) => a.allocation > 0).length < 2) return null;
  const declaredArms = new Map(declared.filter((a) => a.allocation > 0).map((a) => [a.arm, a.allocation]));
  let total = 0;
  for (const count of observed.values()) total += count;
  if (total <= 0) return null;
  for (const arm of observed.keys()) {
    if (!declaredArms.has(arm)) return null;
  }
  const share = [...declaredArms.values()].reduce((sum, s) => sum + s, 0);
  let stat = 0;
  for (const [arm, allocation] of declaredArms) {
    const expected = (total * allocation) / share;
    const diff = (observed.get(arm) ?? 0) - expected;
    stat += (diff * diff) / expected;
  }
  return chi2Survival(stat, declaredArms.size - 1);
}

/**
 * Two-proportion z-test, pooled variance.
 * @param {number} x1 successes in the treatment
 * @param {number} n1
 * @param {number} x0 successes in the control
 * @param {number} n0
 * @returns {{lift: number | null, z: number | null, p: number | null}}
 */
export function twoProportion(x1, n1, x0, n0) {
  const test = pooledProportionZ(x1, n1, x0, n0);
  if (!test) return { lift: null, z: null, p: null };
  const lift = test.p2 > 0 ? test.p1 / test.p2 - 1 : null;
  if (test.z === null) return { lift, z: null, p: null };
  return { lift, z: test.z, p: zPvalue(test.z) };
}

/**
 * Difference in means from sums, unequal variances.
 * @param {{n: number, sum: number, sumSq: number}} treatment
 * @param {{n: number, sum: number, sumSq: number}} control
 * @returns {{lift: number | null, z: number | null, p: number | null}}
 */
export function meanDifference(treatment, control) {
  if (treatment.n < 2 || control.n < 2) return { lift: null, z: null, p: null };
  const m1 = treatment.sum / treatment.n;
  const m0 = control.sum / control.n;
  const v1 = Math.max(0, (treatment.sumSq - treatment.n * m1 * m1) / (treatment.n - 1));
  const v0 = Math.max(0, (control.sumSq - control.n * m0 * m0) / (control.n - 1));
  const lift = m0 > 0 ? m1 / m0 - 1 : null;
  const se = Math.sqrt(v1 / treatment.n + v0 / control.n);
  if (!(se > 0)) return { lift, z: null, p: null };
  const z = (m1 - m0) / se;
  return { lift, z, p: zPvalue(z) };
}

/** Two-sided normal p-value: P(|Z| > |z|) = P(chi2(1) > z^2). */
export function zPvalue(z) {
  return chi2Survival(z * z, 1);
}

/**
 * Chi-square survival function P(X > x) for X ~ chi2(dof), via the
 * regularized upper incomplete gamma. Numerical Recipes 6.2.
 * @param {number} x @param {number} dof
 * @returns {number | null}
 */
export function chi2Survival(x, dof) {
  if (x < 0 || dof < 1) return null;
  if (x === 0) return 1;
  return gammaQ(dof / 2, x / 2);
}

/** Regularized upper incomplete gamma Q(a, x). */
function gammaQ(a, x) {
  if (x < a + 1) return 1 - gammaSeries(a, x);
  return gammaContinuedFraction(a, x);
}

function gammaSeries(a, x) {
  const gln = lnGamma(a);
  let sum = 1 / a;
  let term = sum;
  for (let n = 1; n <= 200; n += 1) {
    term *= x / (a + n);
    sum += term;
    if (Math.abs(term) < Math.abs(sum) * 1e-12) break;
  }
  return sum * Math.exp(-x + a * Math.log(x) - gln);
}

function gammaContinuedFraction(a, x) {
  const gln = lnGamma(a);
  const eps = 1e-12;
  const fpmin = 1e-300;
  let b = x + 1 - a;
  let c = 1 / fpmin;
  let d = 1 / Math.max(b, fpmin);
  let h = d;
  for (let i = 1; i <= 200; i += 1) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < fpmin) d = fpmin;
    c = b + an / c;
    if (Math.abs(c) < fpmin) c = fpmin;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < eps) break;
  }
  return Math.exp(-x + a * Math.log(x) - gln) * h;
}

/** Numerical Recipes gammln: log-gamma for z > 0. */
function lnGamma(z) {
  const cof = [
    76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155,
    0.1208650973866179e-2, -0.5395239384953e-5,
  ];
  let y = z;
  let ser = 1.000000000190015;
  for (let j = 0; j < cof.length; j += 1) {
    y += 1;
    ser += cof[j] / y;
  }
  const tmp = z + 5.5 - (z + 0.5) * Math.log(z + 5.5);
  return -tmp + Math.log((2.5066282746310005 * ser) / z);
}
