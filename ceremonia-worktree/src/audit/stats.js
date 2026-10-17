/**
 * Trend and point-in-time statistics from the Roswell query plan.
 * Pure. Callers pass series already aggregated in ClickHouse.
 */

import { Z_95, pooledProportionZ } from '../lib/stats/proportions.js';

/** @param {number[]} values index is the week number */
export function simpleLinearRegression(values) {
  const n = values.length;
  if (n < 2) return { slope: null, intercept: null };
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;
  for (let i = 0; i < n; i += 1) {
    const y = values[i];
    if (!Number.isFinite(y)) return { slope: null, intercept: null };
    sumX += i;
    sumY += y;
    sumXY += i * y;
    sumXX += i * i;
  }
  const denom = n * sumXX - sumX * sumX;
  if (denom === 0) return { slope: null, intercept: null };
  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;
  return { slope, intercept };
}

/**
 * Slope as a percent of the series midpoint, per step (per week when the
 * series is weekly).
 * @param {number[]} values
 */
export function slopePercentPerStep(values) {
  const { slope, intercept } = simpleLinearRegression(values);
  if (slope == null || intercept == null) return null;
  const mid = intercept + slope * ((values.length - 1) / 2);
  if (!Number.isFinite(mid) || mid === 0) return null;
  return (slope / Math.abs(mid)) * 100;
}

/**
 * improving or deteriorating only when the 13-week slope and the
 * year-over-year change have the same sign. A missing year-over-year
 * value stays insufficient. Opposite signs stay disputed.
 *
 * @param {number | null} slopePctPerWeek
 * @param {number | null} yoyChange relative change, (now - then) / then
 */
export function trendLabel(slopePctPerWeek, yoyChange) {
  if (slopePctPerWeek == null || yoyChange == null) return 'insufficient';
  if (!Number.isFinite(slopePctPerWeek) || !Number.isFinite(yoyChange)) return 'insufficient';
  const slopeSign = Math.sign(slopePctPerWeek);
  const yoySign = Math.sign(yoyChange);
  if (slopeSign === 0 || yoySign === 0) return 'stable';
  if (slopeSign === yoySign) return slopeSign > 0 ? 'improving' : 'deteriorating';
  return 'disputed';
}

/**
 * Two-proportion z-test. significant is two-sided at 95%.
 * @param {number} x1 successes
 * @param {number} n1
 * @param {number} x2
 * @param {number} n2
 */
export function twoProportionZ(x1, n1, x2, n2) {
  const test = pooledProportionZ(x1, n1, x2, n2);
  if (!test) return { z: null, significant: false };
  if (test.z === null) return { z: 0, significant: false };
  return { z: test.z, significant: Math.abs(test.z) > Z_95 };
}

/** Plan threshold: under 1,000 sessions or under 30 conversions. */
export function isDirectional(sessions, conversions) {
  return !(sessions >= 1000) || !(conversions >= 30);
}

/**
 * Sessions in the segment × (benchmark − observed) × downstream value.
 * Positive means the segment is behind the benchmark.
 */
export function revenueAtStake(sessions, benchmarkRate, observedRate, downstreamValue) {
  if (![sessions, benchmarkRate, observedRate, downstreamValue].every(Number.isFinite)) return null;
  return sessions * (benchmarkRate - observedRate) * downstreamValue;
}

/**
 * Weeks whose 4-week average sits more than two standard deviations from
 * the prior 8 weeks.
 * @param {number[]} series
 */
export function changePoints(series) {
  /** @type {Array<{index: number, weekAvg: number, priorMean: number, priorSd: number}>} */
  const flags = [];
  for (let i = 11; i < series.length; i += 1) {
    const recent = series.slice(i - 3, i + 1);
    const prior = series.slice(i - 11, i - 3);
    const weekAvg = mean(recent);
    const priorMean = mean(prior);
    const priorSd = stdev(prior, priorMean);
    if (priorSd === 0 || weekAvg == null || priorMean == null) continue;
    if (Math.abs(weekAvg - priorMean) > 2 * priorSd) {
      flags.push({ index: i, weekAvg, priorMean, priorSd });
    }
  }
  return flags;
}

/**
 * Shift-share of a rate. rateEffect + mixEffect + interaction = the change
 * in the session-weighted rate.
 * @param {Array<{key: string, sessions: number, rate: number}>} base
 * @param {Array<{key: string, sessions: number, rate: number}>} next
 */
export function mixRateDecomposition(base, next) {
  const baseSessions = base.reduce((s, r) => s + r.sessions, 0);
  const nextSessions = next.reduce((s, r) => s + r.sessions, 0);
  if (baseSessions <= 0 || nextSessions <= 0) {
    return { rateEffect: null, mixEffect: null, interaction: null };
  }
  const baseByKey = new Map(base.map((r) => [r.key, r]));
  const nextByKey = new Map(next.map((r) => [r.key, r]));
  const keys = new Set([...baseByKey.keys(), ...nextByKey.keys()]);
  let rateEffect = 0;
  let mixEffect = 0;
  let interaction = 0;
  for (const key of keys) {
    const b = baseByKey.get(key) ?? { sessions: 0, rate: 0 };
    const n = nextByKey.get(key) ?? { sessions: 0, rate: b.rate };
    const shareB = b.sessions / baseSessions;
    const shareN = n.sessions / nextSessions;
    rateEffect += shareB * (n.rate - b.rate);
    mixEffect += b.rate * (shareN - shareB);
    interaction += (shareN - shareB) * (n.rate - b.rate);
  }
  return { rateEffect, mixEffect, interaction };
}

/** @param {number[]} values */
function mean(values) {
  if (values.length === 0) return null;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

/** @param {number[]} values @param {number} avg */
function stdev(values, avg) {
  if (values.length < 2) return 0;
  const variance = values.reduce((s, v) => s + (v - avg) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

/** @param {number} n */
export function round4(n) {
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 10000) / 10000;
}
