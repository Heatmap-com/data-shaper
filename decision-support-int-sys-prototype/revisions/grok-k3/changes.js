// Important week-over-week changes per grouped row (e.g. campaign). No DOM here.
// A metric change is important when it is beyond the row's own weekly wobble AND material:
//   counts — the change is at least `material` of the table's total for that metric in the judged week
//   rates  — the change × the row's volume is at least `material` of the table's total numerator
// Counts need whole weeks on both sides; rates read fine in a part week.
// One tile per row, in one section:
//   started — volume this week, none in any earlier week, and material
//   stopped — material volume in the compared week, at most `stopShare` of it now
//   traffic — the volume metric is important
//   value   — some other metric is important
import { aggregate, measureValue } from './query.js';
import { bandFor, changeOf } from './wobble.js';

export const CHANGE_DEFAULTS = { material: 0.005, stopShare: 0.1 };
export const SECTIONS = ['traffic', 'value', 'started', 'stopped'];

const keyOf = (key, keys) => keys.map((k) => key[k]).join('\u0001');

export function findChanges({ rows, keys, weekField = 'week', week, compare, full, cfg, measure, floorMin = 0 }) {
  const metrics = cfg.metrics.map((id) => ({ id, def: measure(id) }));
  const vol = measure(cfg.volume); const money = measure(cfg.money);
  const material = cfg.material ?? CHANGE_DEFAULTS.material; const stopShare = cfg.stopShare ?? CHANGE_DEFAULTS.stopShare;
  const defs = [...metrics.map((m) => m.def), vol, money];
  const weeks = [...new Set(rows.map((r) => r[weekField]))].filter(Boolean).sort();
  const idx = weeks.indexOf(week); const cIdx = compare ? weeks.indexOf(compare) : -1;
  const fullFlags = weeks.map(full);
  const partial = idx >= 0 && (!fullFlags[idx] || (cIdx >= 0 && !fullFlags[cIdx]));
  const out = { weeks, week, compare, idx, cIdx, partial, judged: 0, tooShort: 0, sections: Object.fromEntries(SECTIONS.map((s) => [s, []])) };
  if (idx < 0) return out;

  const totals = new Map(aggregate(rows, [weekField], defs).map((g) => [g.key[weekField], g]));
  const tot = (w, col) => totals.get(w)?.sums[col] ?? 0;
  const byRow = new Map();
  for (const g of aggregate(rows, [...keys, weekField], defs)) {
    const k = keyOf(g.key, keys);
    if (!byRow.has(k)) byRow.set(k, { key: Object.fromEntries(keys.map((x) => [x, g.key[x]])), first: g.first, weeks: new Map() });
    byRow.get(k).weeks.set(g.key[weekField], g);
  }

  for (const r of byRow.values()) {
    const at = (i, def) => (i < 0 ? null : r.weeks.get(weeks[i]) ? measureValue(def, r.weeks.get(weeks[i])) : def.sum ? 0 : null);
    const vols = weeks.map((w, i) => at(i, vol) ?? 0);
    const cur = vols[idx]; const prev = cIdx >= 0 ? vols[cIdx] : null;
    const moneyCur = at(idx, money) ?? 0; const moneyPrev = cIdx >= 0 ? at(cIdx, money) ?? 0 : null;
    const base = { key: r.key, first: r.first, vols, cur, prev, moneyCur, moneyPrev, moneyDelta: moneyPrev === null ? null : moneyCur - moneyPrev };
    const earlier = vols.slice(0, idx);

    if (earlier.length && earlier.every((x) => !x) && cur >= Math.max(floorMin, material * tot(weeks[idx], vol.sum))) {
      out.sections.started.push({ ...base, kind: 'started', earlierWeeks: earlier.length, moneyDelta: moneyCur });
      continue;
    }
    if (prev !== null && prev >= Math.max(floorMin, material * tot(compare, vol.sum)) && cur <= stopShare * prev) {
      out.sections.stopped.push({ ...base, kind: 'stopped' });
      continue;
    }
    if (cIdx < 0 || cur < floorMin || prev < floorMin) continue;
    out.judged += 1;

    const results = metrics.map(({ id, def }) => {
      const unit = def.format === 'pct' ? 'pp' : '%';
      const series = weeks.map((w, i) => at(i, def));
      const c = series[idx]; const p = series[cIdx];
      const res = { id, label: def.label, format: def.format, unit, cur: c, prev: p, series, delta: changeOf(c, p, unit) };
      if (def.sum && partial) return { ...res, status: 'cantsay', reason: 'part week' };
      const b = bandFor(series, fullFlags, idx, unit);
      Object.assign(res, { band: b.band, n: b.n });
      if (res.delta === null || !Number.isFinite(res.delta)) return { ...res, status: 'cantsay', reason: 'no comparison' };
      if (b.band === null) return { ...res, status: 'cantsay', reason: 'too few whole weeks' };
      const beyond = Math.abs(res.delta) > b.band;
      const size = def.sum ? Math.abs(c - p) : Math.abs(c - p) * cur;
      const scale = def.sum ? tot(weeks[idx], def.sum) : tot(weeks[idx], def.ratio[0]);
      const matters = size >= material * scale;
      return { ...res, status: beyond && matters ? 'important' : beyond ? 'small' : 'within' };
    });
    if (results.every((m) => m.status === 'cantsay' && m.reason === 'too few whole weeks')) { out.tooShort += 1; continue; }
    const important = results.filter((m) => m.status === 'important');
    if (!important.length) continue;
    const section = important.some((m) => m.id === cfg.volume) ? 'traffic' : 'value';
    out.sections[section].push({ ...base, kind: section, metrics: results });
  }
  for (const s of SECTIONS) out.sections[s].sort((a, b) => Math.abs(b.moneyDelta ?? 0) - Math.abs(a.moneyDelta ?? 0));
  return out;
}
