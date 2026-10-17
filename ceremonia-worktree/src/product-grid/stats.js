/**
 * Counting statistics the grid rules share: proportion intervals, the
 * Poisson tail, the median, and rank correlation.
 */

import { Z_90, wilsonInterval as wilson } from '../lib/stats/proportions.js';

/**
 * 90% Wilson interval.
 * @param {number} k
 * @param {number} n
 */
export function wilsonInterval(k, n) {
  return wilson(k, n, Z_90);
}

/**
 * @param {number} clicks
 * @param {number} reached
 * @param {number} baselineCtr
 */
export function liftIntervalExcludesOne(clicks, reached, baselineCtr) {
  if (!(reached > 0) || !(baselineCtr > 0)) return false;
  const [lo, hi] = wilsonInterval(clicks, reached);
  return hi / baselineCtr < 1 || lo / baselineCtr > 1;
}

/**
 * @param {number} lambda
 * @param {number} observed
 */
export function poissonAtMost(lambda, observed) {
  if (!(lambda > 0)) return observed === 0 ? 1 : 0;
  let term = Math.exp(-lambda);
  let sum = term;
  for (let k = 1; k <= observed; k++) {
    term *= lambda / k;
    sum += term;
  }
  return Math.min(1, sum);
}

/**
 * @param {number[]} xs
 */
export function median(xs) {
  const sorted = [...xs].sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Rank correlation. Highest score is treated as rank 1 when the caller
 * passes the negated score, so a grid already sorted by pull scores near 1.
 * @param {number[]} slotOrder
 * @param {number[]} pullRankInput higher means more pull; caller passes raw or lift
 */
export function spearman(slotOrder, pullRankInput) {
  const left = ranks(slotOrder);
  const right = ranks(pullRankInput);
  const n = left.length;
  const meanL = left.reduce((s, v) => s + v, 0) / n;
  const meanR = right.reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let dl = 0;
  let dr = 0;
  for (let i = 0; i < n; i++) {
    const a = left[i] - meanL;
    const b = right[i] - meanR;
    num += a * b;
    dl += a * a;
    dr += b * b;
  }
  if (dl === 0 || dr === 0) return 1;
  return num / Math.sqrt(dl * dr);
}

/**
 * @param {number[]} values
 */
export function ranks(values) {
  const order = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value || a.index - b.index);
  const out = new Array(values.length);
  for (let i = 0; i < order.length; i++) out[order[i].index] = i + 1;
  return out;
}
