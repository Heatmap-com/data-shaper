/**
 * Proportion statistics shared by the audit, experiment readouts, and
 * product-grid flags. Pure.
 */

/** Two-sided 95% normal critical value. */
export const Z_95 = 1.959963984540054;
/** Two-sided 90% normal critical value. */
export const Z_90 = 1.6448536269514722;

/**
 * Pooled-variance two-proportion z. Null when either sample is empty or not
 * a number. `z` is null when the pooled standard error is not positive
 * (both rates 0 or 1, or counts out of range).
 * @param {number} x1 successes in the first sample
 * @param {number} n1
 * @param {number} x2 successes in the second sample
 * @param {number} n2
 * @returns {{p1: number, p2: number, se: number, z: number | null} | null}
 */
export function pooledProportionZ(x1, n1, x2, n2) {
  if (!(n1 > 0) || !(n2 > 0)) return null;
  const p1 = x1 / n1;
  const p2 = x2 / n2;
  const pooled = (x1 + x2) / (n1 + n2);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n2));
  return { p1, p2, se, z: se > 0 ? (p1 - p2) / se : null };
}

/**
 * Wilson score interval for k successes in n, at critical value z.
 * The whole range [0, 1] when n is empty.
 * @param {number} k
 * @param {number} n
 * @param {number} z
 * @returns {[number, number]}
 */
export function wilsonInterval(k, n, z) {
  if (!(n > 0)) return [0, 1];
  const phat = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (phat + z2 / (2 * n)) / denom;
  const margin = (z * Math.sqrt((phat * (1 - phat) + z2 / (4 * n)) / n)) / denom;
  return [Math.max(0, center - margin), Math.min(1, center + margin)];
}
