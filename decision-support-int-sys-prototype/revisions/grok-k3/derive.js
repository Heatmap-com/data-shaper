// Numbers for the home and "What moved?" tabs, built from whole-week flow data. No DOM here.
import { bandFor, changeOf, judge } from './wobble.js';

export const HOME_MEASURES = [
  { id: 'sessions', label: 'Sessions', unit: '%', fmt: 'int', of: (t) => t.sessions },
  { id: 'orders', label: 'Orders', unit: '%', fmt: 'int', of: (t) => t.orders },
  { id: 'revenue', label: 'Revenue', unit: '%', fmt: 'money', of: (t) => t.revenue },
  { id: 'order_rate', label: 'Order rate', unit: 'pp', fmt: 'pct', of: (t) => (t.sessions ? t.orders / t.sessions : null), floor: 100 },
];
export const MOVER_MEASURES = HOME_MEASURES.filter((m) => m.id !== 'orders');
export const JOURNEY_FLOOR = 100;
const SUMS = ['sessions', 'orders', 'revenue', 'buyers'];
const DEVICES = ['mobile', 'desktop', 'tablet'];

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : null;
};

export function weeksOf(rows) {
  return [...new Set(rows.map((r) => r.week))].sort();
}

export function compareWeek(weeks, week, mode, full) {
  const idx = weeks.indexOf(week);
  if (mode === 'none' || idx < 0) return null;
  if (mode === 'firstFull') { const f = weeks.find((w) => full(w)); return f && f !== week ? f : null; }
  if (mode && mode !== 'prev' && weeks.includes(mode)) return mode === week ? null : mode;
  return idx > 0 ? weeks[idx - 1] : null;
}

// One total per week for a slice of funnel rows (summed over entry pages).
export function weeklyTotals(rows, pick) {
  const by = new Map();
  for (const r of rows) {
    if (!pick(r)) continue;
    const t = by.get(r.week) ?? Object.fromEntries(SUMS.map((k) => [k, 0]));
    for (const k of SUMS) t[k] += Number(r[k]) || 0;
    by.set(r.week, t);
  }
  return by;
}

const siteSlice = (device) => (r) => r.segment === 'all' && r.viewport_type === device;

function judgeSeries({ series, weeks, week, cmp, full, m, band }) {
  const idx = weeks.indexOf(week);
  const values = weeks.map((w) => (series.get(w) ? m.of(series.get(w)) : null));
  const cur = values[idx];
  const prev = cmp ? values[weeks.indexOf(cmp)] : null;
  const delta = changeOf(cur, prev, m.unit);
  const b = band ?? bandFor(values, weeks.map(full), idx, m.unit);
  const nCur = series.get(week)?.sessions ?? 0;
  const nPrev = cmp ? series.get(cmp)?.sessions ?? 0 : 0;
  const thin = m.floor ? nCur < m.floor || nPrev < m.floor : false;
  const partial = !full(week) || (cmp && !full(cmp));
  const j = judge({ delta, band: b.band, partial, thin });
  return { values, cur, prev, delta, band: b.band, median: b.median, n: b.n, ...j, sessions: nCur };
}

// The site row for each home measure: the basis of the answer line.
export function wobbleCheck(funnel, { week, compare, device = 'all', full }) {
  const weeks = weeksOf(funnel);
  const series = weeklyTotals(funnel, siteSlice(device));
  const cmp = compareWeek(weeks, week, compare, full);
  return {
    week, compare: cmp, weeks,
    measures: HOME_MEASURES.map((m) => ({ id: m.id, label: m.label, unit: m.unit, fmt: m.fmt, ...judgeSeries({ series, weeks, week, cmp, full, m }) })),
  };
}

function journeySeries(journeys, path, device) {
  const by = new Map();
  for (const r of journeys) {
    if (r.kind !== 'general' || r.path !== path || r.segment !== 'all' || r.viewport_type !== device) continue;
    by.set(r.week, { start: r.start_sessions, end: r.end_sessions });
  }
  return by;
}

// Every candidate mover: segments x measures, devices x measures, journeys x completion.
export function moverCandidates(funnel, journeys, { week, compare, device = 'all', full, scope = 'self', measures = MOVER_MEASURES, families = ['traffic_source', 'returning'] }) {
  const weeks = weeksOf(funnel);
  const idx = weeks.indexOf(week);
  const cmp = compareWeek(weeks, week, compare, full);
  const site = weeklyTotals(funnel, siteSlice(device));
  const siteSessions = site.get(week)?.sessions ?? 0;
  const siteBand = Object.fromEntries(measures.map((m) => [m.id, bandFor(weeks.map((w) => (site.get(w) ? m.of(site.get(w)) : null)), weeks.map(full), idx, m.unit)]));
  const out = [];
  const push = (family, value, series) => {
    for (const m of measures) {
      const r = judgeSeries({ series, weeks, week, cmp, full, m, band: scope === 'site' ? siteBand[m.id] : null });
      out.push({ family, value, measure: m.id, measureLabel: m.label, unit: m.unit, fmt: m.fmt, ...r, share: siteSessions ? r.sessions / siteSessions : 0 });
    }
  };
  for (const family of families) {
    const values = [...new Set(funnel.filter((r) => r.segment === family).map((r) => r.segment_value))];
    for (const v of values) push(family, v, weeklyTotals(funnel, (r) => r.segment === family && r.segment_value === v && r.viewport_type === device));
  }
  if (device === 'all') for (const d of DEVICES) push('device', d, weeklyTotals(funnel, siteSlice(d)));

  const general = (journeys ?? []).filter((r) => r.kind === 'general' && r.segment === 'all' && r.viewport_type === device);
  const paths = [...new Set(general.map((r) => r.path))];
  const comp = (s) => (s && s.start ? s.end / s.start : null);
  const fullArr = weeks.map(full);
  let pooled = null;
  if (scope === 'site') {
    const changes = [];
    for (const p of paths) {
      const s = journeySeries(journeys, p, device);
      for (let i = 1; i < idx; i += 1) {
        if (!fullArr[i] || !fullArr[i - 1]) continue;
        const c = changeOf(comp(s.get(weeks[i])), comp(s.get(weeks[i - 1])), 'pp');
        if (c !== null) changes.push(Math.abs(c));
      }
    }
    const m = median(changes);
    pooled = changes.length >= 3 ? { band: 2 * m, median: m, n: changes.length } : { band: null, median: null, n: changes.length };
  }
  for (const p of paths) {
    const s = journeySeries(journeys, p, device);
    const values = weeks.map((w) => comp(s.get(w)));
    const b = pooled ?? bandFor(values, fullArr, idx, 'pp');
    const cur = values[idx];
    const prev = cmp ? values[weeks.indexOf(cmp)] : null;
    const delta = changeOf(cur, prev, 'pp');
    const nCur = s.get(week)?.start ?? 0;
    const thin = nCur < JOURNEY_FLOOR || (cmp ? (s.get(cmp)?.start ?? 0) < JOURNEY_FLOOR : false);
    const j = judge({ delta, band: b.band, partial: !full(week) || (cmp && !full(cmp)), thin });
    out.push({ family: 'journey', value: p, measure: 'completion', measureLabel: 'Completion', unit: 'pp', fmt: 'pct', values, cur, prev, delta, band: b.band, median: b.median, n: b.n, ...j, sessions: nCur, share: siteSessions ? nCur / siteSessions : 0 });
  }
  for (const c of out) c.score = c.badge === 'moved' && c.band ? (Math.abs(c.delta) / c.band) * c.share : 0;
  return { week, compare: cmp, weeks, candidates: out };
}

// Same measure and direction from a different breakdown family is the same change. Journeys never merge.
export function mergeMovers(candidates) {
  const moved = candidates.filter((c) => c.badge === 'moved').sort((a, b) => b.score - a.score);
  const kept = [];
  for (const c of moved) {
    const host = c.family === 'journey' ? null : kept.find((k) => k.family !== 'journey' && k.measure === c.measure
      && Math.sign(k.delta) === Math.sign(c.delta) && k.family !== c.family && !k.also.some((a) => a.family === c.family));
    if (host) host.also.push(c);
    else kept.push({ ...c, also: [] });
  }
  return kept;
}

// Revenue (or orders) change split by one segmentation, with two-week average weights (exact, no interaction term).
export function mixDecomp(funnel, { split = 'traffic_source', week, compare, device = 'all', full, outcome = 'revenue' }) {
  const field = outcome === 'orders' ? 'orders' : 'revenue';
  const weeks = weeksOf(funnel);
  const cmp = compareWeek(weeks, week, compare, full);
  if (!cmp) return null;
  let slices;
  if (split === 'none' || split === 'device') {
    if (device !== 'all') return null;
    slices = DEVICES.map((d) => ({ value: d, pick: siteSlice(d) }));
  } else {
    const values = [...new Set(funnel.filter((r) => r.segment === split).map((r) => r.segment_value))];
    slices = values.map((v) => ({ value: v, pick: (r) => r.segment === split && r.segment_value === v && r.viewport_type === device }));
  }
  const rows = slices.map(({ value, pick }) => {
    const t = weeklyTotals(funnel, pick);
    const a = t.get(cmp) ?? { sessions: 0, revenue: 0, orders: 0 };
    const b = t.get(week) ?? { sessions: 0, revenue: 0, orders: 0 };
    const r0 = a.sessions ? a[field] / a.sessions : 0;
    const r1 = b.sessions ? b[field] / b.sessions : 0;
    const volume = (b.sessions - a.sessions) * (r0 + r1) / 2;
    const rate = (a.sessions + b.sessions) / 2 * (r1 - r0);
    return { value, s0: a.sessions, s1: b.sessions, rps0: r0, rps1: r1, rev0: a[field], rev1: b[field], volume, rate, total: volume + rate };
  }).filter((r) => r.s0 || r.s1).sort((x, y) => Math.abs(y.total) - Math.abs(x.total));
  const site = weeklyTotals(funnel, siteSlice(device));
  const A = site.get(cmp); const B = site.get(week);
  if (!A || !B) return null;
  const S0 = A.sessions; const S1 = B.sessions;
  const RPS0 = A[field] / S0; const RPS1 = B[field] / S1;
  const volume = rows.reduce((s, r) => s + r.volume, 0);
  const rate = rows.reduce((s, r) => s + r.rate, 0);
  const growth = (S1 - S0) * (RPS0 + RPS1) / 2;
  return {
    split, outcome: field, week, compare: cmp, rows,
    volume, rate, growth, mix: volume - growth, total: volume + rate,
    siteDelta: B[field] - A[field],
    partial: !full(week) || !full(cmp),
  };
}
