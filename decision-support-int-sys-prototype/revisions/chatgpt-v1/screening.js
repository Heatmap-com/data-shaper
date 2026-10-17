// Eligibility and the "large enough to review" rule. Thresholds come from views.json.

const A = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
const B = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
const C = [-7.784894002430293e-03, -3.223964580411385e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
const D = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];

// Acklam's rational approximation of the standard-normal quantile function.
export function normsinv(p) {
  if (p <= 0 || p >= 1) return NaN;
  const plow = 0.02425;
  if (p < plow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((C[0] * q + C[1]) * q + C[2]) * q + C[3]) * q + C[4]) * q + C[5])
      / ((((D[0] * q + D[1]) * q + D[2]) * q + D[3]) * q + 1);
  }
  if (p > 1 - plow) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((C[0] * q + C[1]) * q + C[2]) * q + C[3]) * q + C[4]) * q + C[5])
      / ((((D[0] * q + D[1]) * q + D[2]) * q + D[3]) * q + 1);
  }
  const q = p - 0.5;
  const r = q * q;
  return (((((A[0] * r + A[1]) * r + A[2]) * r + A[3]) * r + A[4]) * r + A[5]) * q
    / (((((B[0] * r + B[1]) * r + B[2]) * r + B[3]) * r + B[4]) * r + 1);
}

export function zStar(M, alpha = 0.05) {
  if (!M) return Infinity;
  return normsinv(1 - alpha / (2 * M));
}

export function wilson(x, n, z = 1.959963984540054) {
  if (x === null || n === null || !n) return null;
  const phat = x / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (phat + z2 / (2 * n)) / denom;
  const margin = (z * Math.sqrt((phat * (1 - phat)) / n + z2 / (4 * n * n))) / denom;
  return [center - margin, center + margin];
}

function num(config, key, fallback) {
  const v = config?.[key];
  return typeof v === 'number' ? v : fallback;
}

export function screenRate(rec, { M, config }) {
  const fails = [];
  const n0 = rec.n0;
  const n1 = rec.n1;
  const x0 = rec.x0;
  const x1 = rec.x1;
  const p0 = n0 ? x0 / n0 : null;
  const p1 = n1 ? x1 / n1 : null;
  const minN = num(config, 'minimumDenominatorBothWeeks', 200);
  const minXF = num(config, 'minimumSuccessesAndFailuresBothWeeks', 20);
  const absFloor = num(config, 'minimumAbsoluteDelta', 0.002);
  const relFloor = num(config, 'minimumRelativeDelta', 0.1);
  const minEq = num(config, 'minimumEquivalentOutcomes', 20);
  const z = zStar(M);
  const eligible = rec.trust === 'ok' && rec.kind === 'rate';
  if (!eligible) {
    return { eligible: false, review: false, fails: [rec.trust === 'ok' ? 'not-a-rate' : rec.trust], M, z, checks: [] };
  }
  const delta = p1 - p0;
  const abs = Math.abs(delta);
  const se = Math.sqrt((p0 * (1 - p0)) / n0 + (p1 * (1 - p1)) / n1);
  const checks = [
    { id: 'denominator', pass: n0 >= minN && n1 >= minN, detail: `n ${n0} and ${n1}, minimum ${minN}` },
    { id: 'successes-failures', pass: x0 >= minXF && n0 - x0 >= minXF && x1 >= minXF && n1 - x1 >= minXF, detail: `successes and failures at least ${minXF} in both weeks` },
    { id: 'absolute-floor', pass: abs + 1e-12 >= absFloor, detail: `|Δ| ${(abs * 100).toFixed(2)} points, floor ${(absFloor * 100).toFixed(1)} points` },
    { id: 'relative-floor', pass: p0 ? abs + 1e-12 >= relFloor * p0 : false, detail: `|Δ| is ${p0 ? `${((abs / p0) * 100).toFixed(1)}%` : '—'} of the prior rate, floor ${(relFloor * 100).toFixed(0)}%` },
    { id: 'equivalent-outcomes', pass: n1 * abs + 1e-9 >= minEq, detail: `n × |Δ| ${(n1 * abs).toFixed(1)}, minimum ${minEq}` },
    { id: 'z', pass: abs > z * se, detail: `|Δ| ${(abs * 100).toFixed(2)} points against z* ${z.toFixed(2)} × se ${(se * 100).toFixed(2)}` },
  ];
  for (const c of checks) if (!c.pass) fails.push(c.id);
  return { eligible: true, review: fails.length === 0, fails, M, z, checks, p0, p1, delta };
}

export const TRUST_ORDER = ['missing-baseline', 'incompatible', 'partial', 'capped', 'outcome-defined', 'small', 'ok'];

export function trustState({ x0, n0, x1, n1, coverage, capped, buyerDefined }) {
  if (n0 === null || n0 === undefined || x0 === null || x0 === undefined) return 'missing-baseline';
  if (coverage === 'incompatible') return 'incompatible';
  if (coverage === 'partial' || coverage === 'partial-inferred') return 'partial';
  if (capped) return 'capped';
  if (buyerDefined) return 'outcome-defined';
  const small = (x, n) => n < 200 || x < 20 || (n - x) < 20;
  if (small(x0, n0) || small(x1, n1)) return 'small';
  return 'ok';
}

export function combineCoverage(a, b) {
  if (!a || !b) return 'missing-baseline';
  if (a === b && (a === 'verified' || a === 'unverified-complete')) return a === 'verified' ? 'verified' : 'unverified-complete';
  if (a !== b) return 'incompatible';
  if (a === 'partial' || a === 'partial-inferred') return a;
  return a;
}
