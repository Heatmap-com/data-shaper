// Which rows of a grouped table stand out. No DOM here.
//   high / low  — value per unit at least `spread` robust spreads from the typical row (log scale, MAD), and the
//                 rate's two-proportion z against the rest of the table at least `z` in the same direction
//   none        — no orders where the rest's rate predicts at least `expectZero` (P(0) ≈ e^-7 ≈ 0.001)
//   jump / drop — volume moved beyond the row's own weekly wobble (whole weeks only)
//   valueup / valuedown — value per unit moved beyond the row's own weekly wobble
//   new         — volume this week, none in any earlier week
// Moves and new rows must also be material: at least `material` of the table's volume (or of its value numerator).
// Rows under the panel's floor never stand out.
import { aggregate, measureValue } from './query.js';
import { bandFor, changeOf } from './wobble.js';

export const OUTLIER_DEFAULTS = { spread: 2, z: 3, expectZero: 7, material: 0.005 };

const keyOf = (g, keys) => keys.map((k) => g.key[k]).join('\u0001');
const median = (xs) => {
  const v = [...xs].sort((a, b) => a - b);
  const n = v.length;
  return n ? (n % 2 ? v[(n - 1) / 2] : (v[n / 2 - 1] + v[n / 2]) / 2) : null;
};

function zTest(x1, n1, x2, n2) {
  if (!n1 || !n2) return null;
  const p = (x1 + x2) / (n1 + n2);
  const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
  return se ? (x1 / n1 - x2 / n2) / se : null;
}

// groups: aggregated table rows (sums must include the volume, rate and value columns).
// history: { rows, weekField, week, compare, full(week) } when a single week is picked, else null.
export function findOutliers({ groups, keys, cfg, measure, floorMin = 0, history }) {
  const volume = measure(cfg.volume); const rate = measure(cfg.rate); const value = measure(cfg.value); const count = cfg.count ? measure(cfg.count) : null;
  const spreadMin = cfg.spread ?? OUTLIER_DEFAULTS.spread; const zMin = cfg.z ?? OUTLIER_DEFAULTS.z; const expectZero = cfg.expectZero ?? OUTLIER_DEFAULTS.expectZero;
  const total = {};
  for (const g of groups) for (const [c, v] of Object.entries(g.sums)) total[c] = (total[c] ?? 0) + v;
  const restOf = (g) => ({ sums: Object.fromEntries(Object.entries(total).map(([c, v]) => [c, v - (g.sums[c] ?? 0)])) });
  // Typical value and spread on a log scale, over rows above the floor that earned anything.
  const logs = groups.filter((g) => (measureValue(volume, g) ?? 0) >= floorMin && measureValue(value, g) > 0).map((g) => Math.log(measureValue(value, g)));
  const mid = median(logs);
  const mad = logs.length >= 8 ? 1.4826 * median(logs.map((x) => Math.abs(x - mid))) : null;
  const typical = mid === null ? null : Math.exp(mid);
  const spread = mad ? Math.exp(mad) : null;
  const material = cfg.material ?? OUTLIER_DEFAULTS.material;
  const minVolMove = material * (total[volume.sum] ?? 0);
  const minValueMove = material * (total[value.ratio[0]] ?? 0);

  let hist = null;
  if (history) {
    const weeks = [...new Set(history.rows.map((r) => r[history.weekField]))].filter(Boolean).sort();
    const byKey = new Map();
    for (const g of aggregate(history.rows, [...keys, history.weekField], [volume, value])) {
      const k = keyOf(g, keys);
      if (!byKey.has(k)) byKey.set(k, new Map());
      byKey.get(k).set(g.key[history.weekField], g);
    }
    hist = { weeks, byKey, idx: weeks.indexOf(history.week), cIdx: history.compare ? weeks.indexOf(history.compare) : -1, fullFlags: weeks.map(history.full) };
  }

  const out = new Map();
  for (const g of groups) {
    const reasons = [];
    const vol = measureValue(volume, g) ?? 0;
    if (vol >= floorMin) {
      const rest = restOf(g);
      const v = measureValue(value, g); const rv = measureValue(value, rest);
      const z = zTest(g.sums[rate.ratio[0]], g.sums[rate.ratio[1]], rest.sums[rate.ratio[0]], rest.sums[rate.ratio[1]]);
      const away = mad && v > 0 ? (Math.log(v) - mid) / mad : null;
      const facts = { value: v, restValue: rv, typical, spread, away, times: typical && v !== null ? v / typical : null, rate: measureValue(rate, g), restRate: measureValue(rate, rest), z };
      if (away !== null && z !== null && away >= spreadMin && z >= zMin) reasons.push({ kind: 'high', ...facts });
      else if (away !== null && z !== null && away <= -spreadMin && z <= -zMin) reasons.push({ kind: 'low', ...facts });
      if (count) {
        const restVol = measureValue(volume, rest);
        const expected = restVol ? (measureValue(count, rest) / restVol) * vol : 0;
        if ((measureValue(count, g) ?? 0) === 0 && expected >= expectZero) reasons.push({ kind: 'none', expected, label: count.label });
      }

      if (hist && hist.idx >= 0) {
        const series = hist.byKey.get(keyOf(g, keys));
        const vols = hist.weeks.map((w) => (series?.get(w) ? measureValue(volume, series.get(w)) ?? 0 : 0));
        const vals = hist.weeks.map((w, i) => (vols[i] >= floorMin ? measureValue(value, series.get(w)) : null));
        const earlier = vols.slice(0, hist.idx);
        if (earlier.length && earlier.every((x) => !x)) { if (vol >= minVolMove) reasons.push({ kind: 'new', earlierWeeks: earlier.length }); }
        else if (hist.cIdx >= 0) {
          const bothFull = hist.fullFlags[hist.idx] && hist.fullFlags[hist.cIdx];
          const prevVol = vols[hist.cIdx];
          if (bothFull && prevVol >= floorMin) {
            const d = changeOf(vols[hist.idx], prevVol, '%');
            const b = bandFor(vols, hist.fullFlags, hist.idx, '%');
            if (d !== null && b.band !== null && Math.abs(d) > b.band && Math.abs(vols[hist.idx] - prevVol) >= minVolMove) reasons.push({ kind: d > 0 ? 'jump' : 'drop', delta: d, band: b.band, n: b.n, prev: prevVol, cur: vols[hist.idx] });
          }
          if (vals[hist.idx] !== null && vals[hist.cIdx] !== null) {
            const d = changeOf(vals[hist.idx], vals[hist.cIdx], '%');
            const b = bandFor(vals, hist.fullFlags, hist.idx, '%');
            if (d !== null && b.band !== null && Math.abs(d) > b.band && Math.abs(vals[hist.idx] - vals[hist.cIdx]) * vol >= minValueMove) reasons.push({ kind: d > 0 ? 'valueup' : 'valuedown', delta: d, band: b.band, n: b.n, prev: vals[hist.cIdx], cur: vals[hist.idx] });
          }
        }
      }
    }
    if (reasons.length) out.set(g, reasons);
  }
  return out;
}
