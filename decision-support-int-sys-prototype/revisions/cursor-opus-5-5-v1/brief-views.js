import { weekCoverage, coverageCheck } from './coverage.js';
import { classify } from './noise.js';
import { change, distinct, format, priorWeeks } from './query.js';
import { h, noiseBadge, s } from './views.js';

const SUMS = ['sessions', 'buyers', 'orders', 'revenue', 'product_viewed', 'added_to_cart', 'checkout_started'];
const STEPS = [
  { id: 'step_pv', label: 'Viewed a product', num: 'product_viewed', den: 'sessions' },
  { id: 'step_cart', label: 'Added to cart', num: 'added_to_cart', den: 'product_viewed' },
  { id: 'step_checkout', label: 'Started checkout', num: 'checkout_started', den: 'added_to_cart' },
  { id: 'step_buy', label: 'Purchased', num: 'buyers', den: 'checkout_started' },
];
const HEADLINE = [
  { id: 'revenue', label: 'Revenue', format: 'money', kind: 'money' },
  { id: 'sessions', label: 'Sessions', format: 'int', kind: 'count' },
  { id: 'session_conversion', label: 'Sessions that bought', format: 'pct', kind: 'rate', num: 'buyers', den: 'sessions' },
  { id: 'rps', label: 'Revenue per session', format: 'money', kind: 'money', num: 'revenue', den: 'sessions' },
  { id: 'aov', label: 'Average order', format: 'money', kind: 'money', num: 'revenue', den: 'orders' },
];
const DIMENSIONS = [
  ['traffic_source', 'Traffic source'],
  ['device', 'Device'],
  ['entry', 'Entry page'],
  ['returning', 'New or returning'],
];

export function siteWeek(rows) {
  const groups = new Map();
  for (const r of rows) {
    const key = [r.segment, r.segment_value, r.viewport_type, r.week].join('|');
    const g = groups.get(key) ?? {
      segment: r.segment, segment_value: r.segment_value, viewport_type: r.viewport_type, week: r.week,
      sessions: 0, product_viewed: 0, added_to_cart: 0, checkout_started: 0, buyers: 0, orders: 0, revenue: 0,
    };
    for (const k of SUMS) g[k] += Number(r[k]) || 0;
    groups.set(key, g);
  }
  return [...groups.values()];
}

function blank() {
  return Object.fromEntries(SUMS.map((k) => [k, 0]));
}

function add(into, row) {
  for (const k of SUMS) into[k] += Number(row[k]) || 0;
}

function accumulate(rows, pred) {
  const out = new Map();
  for (const r of rows) {
    if (!pred(r)) continue;
    const g = out.get(r.week) ?? blank();
    add(g, r);
    out.set(r.week, g);
  }
  return out;
}

function at(map, week) {
  return map.get(week) ?? blank();
}

function blend(map, weeks) {
  const out = blank();
  if (!weeks.length) return out;
  for (const w of weeks) add(out, at(map, w));
  for (const k of SUMS) out[k] /= weeks.length;
  return out;
}

function metrics(t) {
  return {
    ...t,
    session_conversion: t.sessions ? t.buyers / t.sessions : null,
    rps: t.sessions ? t.revenue / t.sessions : null,
    aov: t.orders ? t.revenue / t.orders : null,
  };
}

export function headlineNumbers(rows, { week, compareWeeks = [], weeks }) {
  const map = accumulate(rows, () => true);
  const list = weeks ?? [...map.keys()].sort();
  return {
    current: metrics(at(map, week)),
    previous: compareWeeks.length ? metrics(blend(map, compareWeeks)) : null,
    series: list.map((w) => ({ week: w, ...metrics(at(map, w)) })),
  };
}

function cutOf(rows, week, dimension, device) {
  const map = new Map();
  for (const r of rows) {
    if (r.week !== week) continue;
    let key = null;
    if (dimension === 'device') {
      if (r.segment !== 'all' || r.segment_value !== 'all' || r.viewport_type === 'all') continue;
      key = r.viewport_type;
    } else if (dimension === 'entry') {
      if (r.segment !== 'all' || r.segment_value !== 'all' || r.viewport_type !== device) continue;
      key = r.entry;
    } else if (r.segment === dimension && r.viewport_type === device) key = r.segment_value;
    if (key === null || key === undefined) continue;
    const g = map.get(key) ?? { sessions: 0, revenue: 0 };
    g.sessions += Number(r.sessions) || 0;
    g.revenue += Number(r.revenue) || 0;
    map.set(key, g);
  }
  return map;
}

export function decompose(rows, { week, compareWeeks, dimension = 'traffic_source', device = 'all' }) {
  const cur = cutOf(rows, week, dimension, device);
  const prevMaps = compareWeeks.map((w) => cutOf(rows, w, dimension, device));
  const keys = new Set(cur.keys());
  for (const m of prevMaps) for (const k of m.keys()) keys.add(k);
  const n = prevMaps.length || 1;
  const prev = new Map();
  for (const k of keys) {
    let sessions = 0;
    let revenue = 0;
    for (const m of prevMaps) {
      const g = m.get(k) ?? { sessions: 0, revenue: 0 };
      sessions += g.sessions;
      revenue += g.revenue;
    }
    prev.set(k, { sessions: sessions / n, revenue: revenue / n });
  }
  const S0 = [...prev.values()].reduce((s, g) => s + g.sessions, 0);
  const S1 = [...keys].reduce((s, k) => s + (cur.get(k)?.sessions ?? 0), 0);
  const revenue0 = [...prev.values()].reduce((s, g) => s + g.revenue, 0);
  const revenue1 = [...keys].reduce((s, k) => s + (cur.get(k)?.revenue ?? 0), 0);
  const out = [...keys].map((k) => {
    const a = prev.get(k);
    const b = cur.get(k) ?? { sessions: 0, revenue: 0 };
    const share0 = S0 ? a.sessions / S0 : 0;
    const share1 = S1 ? b.sessions / S1 : 0;
    const rate0 = a.sessions ? a.revenue / a.sessions : 0;
    const rate1 = b.sessions ? b.revenue / b.sessions : 0;
    return {
      key: k,
      sessions0: a.sessions,
      sessions1: b.sessions,
      rps0: rate0,
      rps1: rate1,
      volume: (S1 - S0) * share0 * rate0,
      mix: S1 * (share1 - share0) * rate0,
      rate: S1 * share1 * (rate1 - rate0),
    };
  });
  out.sort((a, b) => Math.abs(b.mix + b.rate) - Math.abs(a.mix + a.rate));
  return {
    revenue0, revenue1, sessions0: S0, sessions1: S1,
    volume: out.reduce((s, r) => s + r.volume, 0),
    mix: out.reduce((s, r) => s + r.mix, 0),
    rate: out.reduce((s, r) => s + r.rate, 0),
    rows: out,
  };
}

function tierOf(label) {
  if (label === 'unusual') return 0;
  if (label === 'slide' || label === 'climb') return 1;
  if (label === 'normal') return 2;
  return 3;
}

function nice(text) {
  const s = String(text ?? '').replace(/_/g, ' ');
  if (!s || s !== s.toLowerCase()) return s;
  return s.replace(/\b\w/g, (ch) => ch.toUpperCase());
}

function compactSigned(n) {
  const sign = n > 0 ? '+' : n < 0 ? '−' : '';
  const a = Math.abs(n);
  const body = a >= 1e6 ? `${(a / 1e6).toFixed(1)}M` : a >= 1e4 ? `${Math.round(a / 1e3)}K` : a >= 1e3 ? `${(a / 1e3).toFixed(1)}K` : String(Math.round(a));
  return `${sign}${body}`;
}

export function compactMoney(n) {
  if (!Number.isFinite(n)) return '–';
  const sign = n > 0 ? '+' : n < 0 ? '−' : '';
  const a = Math.abs(n);
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${sign}$${Math.round(a / 1e3)}K`;
  return `${sign}$${Math.round(a)}`;
}

function percentText(cur, prev) {
  if (!prev) return null;
  const pct = ((cur - prev) / Math.abs(prev)) * 100;
  const abs = Math.abs(pct);
  const num = abs >= 10 ? abs.toFixed(0) : abs.toFixed(1);
  return `${pct > 0 ? '+' : pct < 0 ? '−' : ''}${num}%`;
}

export function buildMovers({
  funnel, journeys, week, compareWeeks, device = 'all', segment = 'all', segmentValue = '',
  weeks, days = () => 7, fieldLabel = (v) => v, limit = 8,
}) {
  if (!compareWeeks?.length) return { ranked: [], all: [], note: 'Pick a comparison to see what moved.' };
  const items = [];
  const i = weeks.indexOf(week);
  const jSeg = segment !== 'all' && segmentValue ? segment : 'all';
  const jVal = jSeg === 'all' ? 'all' : segmentValue;

  const push = (item) => {
    if (item.before === null || item.after === null || !Number.isFinite(item.stake)) return;
    items.push(item);
  };

  const families = ['traffic_source', 'returning', 'rager'];
  const seen = new Set();
  for (const r of funnel) {
    if (!families.includes(r.segment) || r.viewport_type !== device) continue;
    seen.add(`${r.segment}|${r.segment_value}`);
  }
  for (const key of seen) {
    const [family, value] = key.split('|');
    const map = accumulate(funnel, (r) => r.segment === family && String(r.segment_value) === value && r.viewport_type === device);
    const now = at(map, week);
    const beforeT = blend(map, compareWeeks);
    const subject = nice(fieldLabel(value, 'segment_value'));
    const countPoints = weeks.map((w) => ({ week: w, value: at(map, w).sessions, days: days(w) }));
    push({
      source: 'segment', subject, family, value, measure: 'sessions', measureLabel: 'Sessions',
      before: beforeT.sessions, after: now.sessions,
      noise: classify(countPoints, i, { kind: 'count' }),
      stake: beforeT.sessions ? (now.sessions - beforeT.sessions) * (beforeT.revenue / beforeT.sessions) : 0,
      sentence: `${subject} traffic ${percentText(now.sessions, beforeT.sessions)} (${compactSigned(now.sessions - beforeT.sessions)} sessions) at ${format(beforeT.sessions ? beforeT.revenue / beforeT.sessions : null, 'money')} a session`,
      drill: { tab: 'funnels', panel: 'fn-segments', seg: family, segv: value },
    });
    const ratePoints = weeks.map((w) => ({ week: w, num: at(map, w).buyers, den: at(map, w).sessions, days: days(w) }));
    const after = now.sessions ? now.buyers / now.sessions : null;
    const before = beforeT.sessions ? beforeT.buyers / beforeT.sessions : null;
    push({
      source: 'segment', subject, family, value, measure: 'session_conversion', measureLabel: 'Sessions that bought',
      before, after,
      noise: classify(ratePoints, i, { kind: 'rate' }),
      stake: now.buyers ? (after - before) * now.sessions * (now.revenue / now.buyers) : 0,
      sentence: `${subject} sessions that bought ${format(before, 'pct')} → ${format(after, 'pct')}`,
      drill: { tab: 'funnels', panel: 'fn-segments', seg: family, segv: value },
    });
  }

  const entries = new Set();
  for (const r of funnel) if (r.segment === 'all' && r.segment_value === 'all' && r.viewport_type === device) entries.add(r.entry);
  for (const entry of entries) {
    const map = accumulate(funnel, (r) => r.segment === 'all' && r.segment_value === 'all' && r.viewport_type === device && r.entry === entry);
    const now = at(map, week);
    const beforeT = blend(map, compareWeeks);
    const subject = nice(fieldLabel(entry, 'entry'));
    const countPoints = weeks.map((w) => ({ week: w, value: at(map, w).sessions, days: days(w) }));
    push({
      source: 'entry', subject, value: entry, measure: 'sessions', measureLabel: 'Sessions',
      before: beforeT.sessions, after: now.sessions,
      noise: classify(countPoints, i, { kind: 'count' }),
      stake: beforeT.sessions ? (now.sessions - beforeT.sessions) * (beforeT.revenue / beforeT.sessions) : 0,
      sentence: `${subject} traffic ${percentText(now.sessions, beforeT.sessions)} (${compactSigned(now.sessions - beforeT.sessions)} sessions) at ${format(beforeT.sessions ? beforeT.revenue / beforeT.sessions : null, 'money')} a session`,
      drill: { tab: 'funnels', panel: 'fn-entry' },
    });
    const ratePoints = weeks.map((w) => ({ week: w, num: at(map, w).buyers, den: at(map, w).sessions, days: days(w) }));
    const after = now.sessions ? now.buyers / now.sessions : null;
    const before = beforeT.sessions ? beforeT.buyers / beforeT.sessions : null;
    push({
      source: 'entry', subject, value: entry, measure: 'session_conversion', measureLabel: 'Sessions that bought',
      before, after,
      noise: classify(ratePoints, i, { kind: 'rate' }),
      stake: now.buyers ? (after - before) * now.sessions * (now.revenue / now.buyers) : 0,
      sentence: `${subject} sessions that bought ${format(before, 'pct')} → ${format(after, 'pct')}`,
      drill: { tab: 'funnels', panel: 'fn-entry' },
    });
  }

  const site = accumulate(funnel, (r) => r.segment === 'all' && r.segment_value === 'all' && r.viewport_type === device);
  for (const step of STEPS) {
    const now = at(site, week);
    const beforeT = blend(site, compareWeeks);
    const points = weeks.map((w) => ({ week: w, num: at(site, w)[step.num], den: at(site, w)[step.den], days: days(w) }));
    const after = now[step.den] ? now[step.num] / now[step.den] : null;
    const before = beforeT[step.den] ? beforeT[step.num] / beforeT[step.den] : null;
    push({
      source: 'step', subject: step.label, measure: step.id, measureLabel: step.label,
      before, after,
      noise: classify(points, i, { kind: 'rate' }),
      stake: now[step.num] ? (after - before) * now[step.den] * now.revenue / now[step.num] : 0,
      sentence: `${step.label} ${format(before, 'pct')} → ${format(after, 'pct')} of sessions`,
      drill: { tab: 'funnels', panel: 'fn-funnel' },
    });
  }

  const paths = new Set();
  for (const r of journeys ?? []) {
    if (r.kind === 'general' && r.viewport_type === device && r.segment === jSeg && String(r.segment_value) === String(jVal)) paths.add(r.path);
  }
  for (const path of paths) {
    const map = new Map();
    for (const r of journeys) {
      if (r.kind === 'general' && r.path === path && r.viewport_type === device && r.segment === jSeg && String(r.segment_value) === String(jVal)) map.set(r.week, r);
    }
    const row = (w) => map.get(w);
    const points = weeks.map((w) => ({ week: w, num: row(w)?.end_sessions ?? 0, den: row(w)?.start_sessions ?? 0, days: days(w) }));
    const now = row(week) ?? {};
    let start0 = 0; let end0 = 0; let n = 0;
    for (const w of compareWeeks) {
      const p = row(w); if (!p) continue;
      start0 += p.start_sessions; end0 += p.end_sessions; n += 1;
    }
    if (n) { start0 /= n; end0 /= n; }
    const after = now.start_sessions ? now.end_sessions / now.start_sessions : null;
    const before = start0 ? end0 / start0 : null;
    const subject = fieldLabel(path, 'path');
    push({
      source: 'journey', subject, value: path, measure: 'completion', measureLabel: 'Completion',
      before, after,
      noise: classify(points, i, { kind: 'rate' }),
      stake: now.end_sessions ? (after - before) * now.start_sessions * (now.end_revenue / now.end_sessions) : 0,
      sentence: `${subject} journey completion ${format(before, 'pct')} → ${format(after, 'pct')}`,
      drill: { tab: 'journeys', panel: 'jr-flow', ...(jSeg !== 'all' ? { seg: jSeg, segv: jVal } : {}) },
    });
  }

  items.sort((a, b) => tierOf(a.noise.label) - tierOf(b.noise.label) || Math.abs(b.stake) - Math.abs(a.stake));
  return { ranked: items.filter((item) => tierOf(item.noise.label) < 3).slice(0, limit), all: items };
}

function deltaText(cur, prev, fmt) {
  const c = change(cur, prev, fmt === 'pct' ? 'pct' : 'num');
  if (!c || !Number.isFinite(c.value)) return null;
  const abs = Math.abs(c.value);
  const digits = c.unit === 'pp' && abs < 1 ? 2 : 1;
  let num = abs.toFixed(digits);
  if (c.unit !== 'pp' && num.endsWith('.0')) num = num.slice(0, -2);
  const sign = c.value > 0 ? '+' : c.value < 0 ? '−' : '';
  return { text: `${sign}${num}${c.unit === 'pp' ? ' points' : '%'}`, cls: c.dir > 0 ? 'up' : c.dir < 0 ? 'down' : '' };
}

function spark(values, selected) {
  const pts = values.map((v, i) => [i, v]).filter(([, v]) => v !== null && Number.isFinite(v));
  if (pts.length < 2) return h('span', {});
  const w = 80; const ht = 24;
  const lo = Math.min(...pts.map((p) => p[1])); const hi = Math.max(...pts.map((p) => p[1]));
  const sx = (i) => 3 + (i / (values.length - 1)) * (w - 6);
  const sy = (v) => (hi === lo ? ht / 2 : ht - 4 - ((v - lo) / (hi - lo)) * (ht - 8));
  const d = pts.map(([i, v], n) => `${n ? 'L' : 'M'}${sx(i).toFixed(1)},${sy(v).toFixed(1)}`).join(' ');
  return s('svg', { width: w, height: ht, class: 'spark' },
    s('path', { d, fill: 'none', stroke: '#2c5f8a', 'stroke-width': 1.5 }),
    ...values.map((v, i) => (v === null || !Number.isFinite(v) ? null : s('circle', {
      cx: sx(i), cy: sy(v), r: i === selected ? 2.6 : 1.6, fill: i === selected ? '#2c5f8a' : '#fff', stroke: '#2c5f8a', 'stroke-width': 1,
    }))));
}

function noiseNote(cmp) {
  return cmp && cmp !== 'prev' ? 'Label is against the previous week.' : '';
}

function headlinePoints(series, spec, days) {
  return series.map((row) => (spec.num
    ? { week: row.week, num: row[spec.num], den: row[spec.den], days: days(row.week) }
    : { week: row.week, value: row[spec.id], days: days(row.week) }));
}

export function headline(panel, rows, ctx) {
  const weeks = distinct(rows, 'week');
  const week = weeks.includes(ctx.context?.wk) ? ctx.context.wk : weeks[weeks.length - 1];
  const compareWeeks = ctx.context?.cmp === 'none' ? [] : priorWeeks(weeks, week, ctx.context?.cmp ?? 'prev');
  const data = headlineNumbers(rows, { week, compareWeeks, weeks });
  const days = (w) => ctx.coverage?.get(w) ?? 7;
  const idx = data.series.findIndex((row) => row.week === week);
  const partial = days(week) !== 7 || compareWeeks.some((w) => days(w) !== 7);
  const cards = HEADLINE.map((spec) => {
    const cur = data.current[spec.id];
    const prev = data.previous?.[spec.id] ?? null;
    const sumLike = spec.id === 'revenue' || spec.id === 'sessions';
    const showDelta = data.previous && !(partial && sumLike);
    const delta = showDelta ? deltaText(cur, prev, spec.format) : null;
    const judged = classify(headlinePoints(data.series, spec, days), idx, { kind: spec.kind });
    return h('div', { class: 'hl-card' },
      h('div', { class: 'hl-label' }, spec.label),
      h('div', { class: 'hl-value' }, format(cur, spec.format, ctx.currency)),
      h('div', { class: 'hl-change' },
        delta ? h('span', { class: `delta ${delta.cls}` }, delta.text) : h('span', { class: 'muted', title: partial && sumLike ? 'One of these weeks is partial. Compare rates, not totals.' : '' }, '–'),
        noiseBadge(judged, { note: noiseNote(ctx.context?.cmp) })),
      spark(data.series.map((row) => row[spec.id]), idx));
  });
  return [
    h('div', { class: 'hl-grid' }, cards),
    h('p', { class: 'foot' }, h('a', { href: '#panel-br-decompose', onclick: (e) => { e.preventDefault(); document.getElementById('panel-br-decompose')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); } }, 'Why did it change? ↓')),
  ];
}

function moverRow(item, ctx) {
  return h('li', { class: 'mover' },
    noiseBadge(item.noise, { note: noiseNote(ctx.context?.cmp) }),
    h('a', { href: '#', onclick: (e) => { e.preventDefault(); ctx.open(item.drill); } }, item.sentence),
    h('span', { class: `stake ${item.stake < 0 ? 'down' : 'up'}` }, compactMoney(item.stake)));
}

export function movers(panel, rows, ctx) {
  const host = h('div', {}, h('p', { class: 'muted' }, 'Loading…'));
  fillMovers(host, panel, rows, ctx);
  return host;
}

async function fillMovers(host, panel, rows, ctx) {
  const [funnel, journeys] = await Promise.all([ctx.load('funnel'), ctx.load('journey_summary')]);
  const device = ctx.context?.dev ?? 'all';
  rows = (funnel?.rows ?? rows).filter((r) => r.viewport_type === device);
  const weeks = distinct(rows, 'week');
  const week = weeks.includes(ctx.context?.wk) ? ctx.context.wk : weeks[weeks.length - 1];
  const compareWeeks = ctx.context?.cmp === 'none' ? [] : priorWeeks(weeks, week, ctx.context?.cmp ?? 'prev');
  const built = buildMovers({
    funnel: rows,
    journeys: journeys?.rows ?? [],
    week,
    compareWeeks,
    device,
    segment: ctx.context?.seg ?? 'all',
    segmentValue: ctx.context?.segv ?? '',
    weeks,
    days: (w) => ctx.coverage?.get(w) ?? 7,
    fieldLabel: ctx.fieldLabel,
    limit: panel.limit ?? 8,
  });
  if (built.note) { host.replaceChildren(h('p', { class: 'muted' }, built.note)); return; }
  const showAll = ctx.state.showAll;
  const list = showAll ? built.all : built.ranked;
  const allTable = h('div', { class: 'scroll' }, h('table', { class: 'grid' },
    h('thead', {}, h('tr', {}, ['Subject', 'Measure', 'Before', 'After', 'Label', 'Stake'].map((c, i) => h('th', { class: i > 1 && i < 4 ? 'num' : '' }, c)))),
    h('tbody', {}, built.all.map((item) => h('tr', {},
      h('td', { class: 'label' }, item.subject),
      h('td', {}, item.measureLabel),
      h('td', { class: 'num' }, format(item.before, item.measure === 'sessions' ? 'int' : 'pct', ctx.currency)),
      h('td', { class: 'num' }, format(item.after, item.measure === 'sessions' ? 'int' : 'pct', ctx.currency)),
      h('td', {}, noiseBadge(item.noise)),
      h('td', { class: 'num' }, compactMoney(item.stake)))))));
  host.replaceChildren(
    h('ol', { class: 'movers' }, list.map((item) => moverRow(item, ctx))),
    h('button', { type: 'button', class: 'text-btn', onclick: () => ctx.set({ showAll: !showAll }) }, showAll ? 'Show the top movements' : `Show all ${built.all.length} movements`),
    ...(showAll ? [allTable] : []));
}

function signedMoney(n, currency) {
  const sign = n > 0 ? '+' : n < 0 ? '−' : '';
  return `${sign}${format(Math.abs(n), 'money', currency)}`;
}

export function decomposeView(panel, rows, ctx) {
  const host = h('div', {}, h('p', { class: 'muted' }, 'Loading…'));
  fillDecompose(host, ctx);
  return host;
}

async function fillDecompose(host, ctx) {
  const dim = DIMENSIONS.some(([id]) => id === ctx.state.dimension) ? ctx.state.dimension : 'traffic_source';
  const picker = h('label', { class: 'picker' }, h('span', {}, 'Split by'),
    h('select', { onchange: (e) => ctx.set({ dimension: e.target.value }) },
      DIMENSIONS.map(([id, text]) => h('option', { value: id, selected: id === dim ? 'selected' : null }, text))));
  if (ctx.context?.cmp === 'none') {
    host.replaceChildren(picker, h('p', { class: 'muted' }, 'Pick a comparison to see why revenue changed.'));
    return;
  }
  const funnel = await ctx.load('funnel');
  const weeks = distinct(funnel.rows, 'week');
  const week = weeks.includes(ctx.context?.wk) ? ctx.context.wk : weeks[weeks.length - 1];
  const compareWeeks = priorWeeks(weeks, week, ctx.context?.cmp ?? 'prev');
  const result = decompose(funnel.rows, { week, compareWeeks, dimension: dim, device: ctx.context?.dev ?? 'all' });
  const max = Math.max(...[result.volume, result.mix, result.rate].map((v) => Math.abs(v)), 1);
  const bar = (name, value) => h('div', { class: 'wf-row' },
    h('span', { class: 'wf-name' }, name),
    h('div', { class: 'wf-track', title: 'Split in this order: traffic, then mix, then rates.' },
      h('i', { class: 'wf-zero' }),
      h('i', { class: `wf-bar ${value < 0 ? 'down' : 'up'}`, style: `width:${((Math.abs(value) / max) * 50).toFixed(1)}%` })),
    h('span', { class: `wf-val ${value < 0 ? 'down' : 'up'}` }, signedMoney(value, ctx.currency)));
  host.replaceChildren(
    picker,
    h('p', { class: 'wf-total' },
      `${format(result.revenue0, 'money', ctx.currency)} → ${format(result.revenue1, 'money', ctx.currency)}, ${signedMoney(result.revenue1 - result.revenue0, ctx.currency)}`),
    h('div', { class: 'waterfall', title: 'Split in this order: traffic, then mix, then rates.' },
      bar('Traffic', result.volume), bar('Mix', result.mix), bar('Rates', result.rate)),
    h('div', { class: 'scroll' }, h('table', { class: 'grid' },
      h('thead', {}, h('tr', {}, ['', 'Sessions', 'Revenue per session', 'Traffic', 'Mix', 'Rates'].map((c, i) => h('th', { class: i ? 'num' : 'label' }, c)))),
      h('tbody', {}, result.rows.map((row) => h('tr', {},
        h('td', { class: 'label' }, ctx.fieldLabel(row.key, dim === 'entry' ? 'entry' : 'segment_value')),
        h('td', { class: 'num' }, percentText(row.sessions1, row.sessions0) ?? '–'),
        h('td', { class: 'num' }, `${format(row.rps0, 'money', ctx.currency)} → ${format(row.rps1, 'money', ctx.currency)}`),
        h('td', { class: 'num' }, signedMoney(row.volume, ctx.currency)),
        h('td', { class: 'num' }, signedMoney(row.mix, ctx.currency)),
        h('td', { class: 'num' }, signedMoney(row.rate, ctx.currency))))))),
    h('p', { class: 'foot' }, 'Split in this order: traffic, then mix, then rates.'));
}

function dateLabel(ctx, iso) {
  return ctx.fieldLabel(iso, 'week');
}

export function health(panel, rows, ctx) {
  const host = h('p', { class: 'health-line' }, 'Loading…');
  fillHealth(host, ctx);
  return host;
}

async function fillHealth(host, ctx) {
  const manifest = ctx.manifest;
  const flow = weekCoverage(manifest, 'funnel');
  const bundle = weekCoverage(manifest, 'tag_trend');
  const label = (iso) => dateLabel(ctx, iso);
  const span = (window) => `${label(window.start)}–${label(window.end)}`;
  const flowWhole = [...(flow?.values() ?? [])].every((d) => d === 7);
  const partials = [...(bundle ?? [])].filter(([, d]) => d < 7);
  const flowText = flowWhole
    ? `Journeys and Funnels cover whole weeks (${span(manifest.flows.window)}).`
    : `Journeys and Funnels cover ${span(manifest.flows.window)}.`;
  const other = partials.length
    ? `Other tables cover ${span(manifest.bundle.window)}, so ${partials.map(([w, d]) => `their ${label(w)} week is ${d}/7 days`).join(' and ')}.`
    : `Other tables cover ${span(manifest.bundle.window)}, and every listed week is whole.`;
  const [tags, funnel, selectors] = await Promise.all([ctx.load('tag_trend'), ctx.load('funnel'), ctx.load('selector-weekly')]);
  const report = coverageCheck(manifest, (name) => (name === 'tag_trend' ? tags.rows : funnel.rows));
  const named = new Map();
  for (const r of selectors?.rows ?? []) {
    const key = String(r.selector ?? '');
    if (!named.has(key)) named.set(key, false);
    if (r.name) named.set(key, true);
  }
  const namedCount = [...named.values()].filter(Boolean).length;
  const misses = Object.values(manifest.checks ?? {}).reduce((s, c) => s + (c.misses ?? 0), 0);
  const bits = [
    flowText,
    other,
    `${namedCount} of ${named.size.toLocaleString()} clicked elements are named.`,
    misses ? `${misses} partition misses.` : 'Partition check passed.',
  ];
  if (!report.ok) bits.push('Week coverage check failed: stored trend weeks do not match the funnel.');
  host.textContent = bits.join(' ');
  host.title = report.weeks.map((w) => `${w.week}: ${w.days}/7 days, tag trend ÷ funnel ${w.ratio === null ? '–' : w.ratio.toFixed(3)}`).join('\n');
}
