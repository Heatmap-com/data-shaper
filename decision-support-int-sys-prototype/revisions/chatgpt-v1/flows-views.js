// Journey and funnel views, drawn after the portal's journey-analysis sankey and funnel chart.
import { aggregate, change, distinct, format, measureValue, naturalCompare } from './query.js';
import { h, s, PALETTE } from './views.js';

const STEP_COLORS = ['#085D3A', '#079455', '#4CA30D', '#85E13A', '#A6EF67', '#D0F8AB'];
const CHECKOUT = '#279CCA';
const BOUGHT = '#175CD3';
const ORANGE = '#EF6820';

const sum = (rows, col) => {
  let total = null;
  for (const r of rows) {
    const v = r[col];
    if (v === null || v === undefined || v === '') continue;
    const n = Number(v);
    if (!Number.isFinite(n)) continue;
    total = (total ?? 0) + n;
  }
  return total;
};
const ratio = (a, b) => (b ? a / b : null);

export function compact(n) {
  if (n === null || n === undefined) return '—';
  const a = Math.abs(n);
  if (a >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (a >= 1e4) return `${Math.round(n / 1e3)}K`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
}

function darken(hex) {
  const c = hex.replace('#', '');
  const part = (i) => Math.max(0, parseInt(c.slice(i, i + 2), 16) - 15).toString(16).padStart(2, '0');
  return `#${part(0)}${part(2)}${part(4)}`;
}

function weekText(ctx, week) {
  const base = ctx.fieldLabel(week, 'week');
  const info = ctx.coverageOf?.(week);
  if (!info || info.state === 'verified') return base;
  if (info.state === 'unverified-complete') return `${base} · Coverage unverified`;
  const inferred = info.state === 'partial-inferred' ? ', inferred' : '';
  return `${base} · ${info.days}/7 days${inferred}`;
}

function select(label, options, value, onchange) {
  return h('label', { class: 'picker' }, h('span', {}, label),
    h('select', { onchange: (e) => onchange(e.target.value) },
      options.map(([v, l]) => h('option', { value: v, selected: String(v) === String(value) ? 'selected' : null }, l))));
}

function weekControls(weeks, ctx) {
  const week = weeks.includes(ctx.state.week) ? ctx.state.week : weeks[weeks.length - 1];
  const idx = weeks.indexOf(week);
  const mode = ['prev', 'first', 'none'].includes(ctx.state.compare) ? ctx.state.compare : 'prev';
  const compare = mode === 'none' || idx === 0 ? null : mode === 'first' ? weeks[0] : weeks[idx - 1];
  const label = (w) => weekText(ctx, w);
  const controls = [
    select('Week', weeks.map((w) => [w, `Week of ${label(w)}`]), week, (v) => ctx.set({ week: v })),
    select('Compare with', [['prev', 'Previous week'], ['first', `First week (${label(weeks[0])})`], ['none', 'Nothing']], mode, (v) => ctx.set({ compare: v })),
  ];
  return { week, compare, controls, label };
}

// Rates change in points, counts in percent.
function delta(cur, prev, fmt, { invert = false } = {}) {
  const c = change(cur, prev, fmt === 'pct' ? 'pct' : 'num');
  if (!c || !Number.isFinite(c.value)) return null;
  const good = invert ? c.dir < 0 : c.dir > 0;
  const cls = c.dir === 0 ? 'flat' : good ? 'up' : 'down';
  const arrow = c.dir > 0 ? '▲' : c.dir < 0 ? '▼' : '■';
  return h('span', { class: `delta ${cls}` }, `${arrow} ${Math.abs(c.value).toFixed(1)}${c.unit === 'pp' ? ' pp' : '%'}`);
}

function prettyPath(path, kind, ctx) {
  const parts = String(path).split(' > ');
  return kind === 'general' ? parts.map((p) => ctx.fieldLabel(p, 'step')).join(' → ') : parts.join(' → ');
}

function tooltip(host) {
  const tip = h('div', { class: 'flow-tip', hidden: true });
  host.append(tip);
  return {
    show(evt, title, rows) {
      tip.replaceChildren(h('div', { class: 'tip-title' }, title),
        h('div', { class: 'tip-rows' }, rows.filter(Boolean).map(([k, v]) => h('div', { class: 'tip-row' }, h('span', {}, k), h('strong', {}, v)))));
      tip.hidden = false;
      const box = host.getBoundingClientRect();
      const x = evt.clientX - box.left + 14;
      tip.style.left = `${Math.min(x, box.width - 300)}px`;
      tip.style.top = `${evt.clientY - box.top + 12}px`;
    },
    hide() { tip.hidden = true; },
  };
}

// ---------- Journeys ----------

// One path in one week: page steps, then checkout started and bought. A node's height is the
// sessions that reached it; the ribbon to the next node is the sessions that went on.
function laneOf(rows, pathName, week) {
  const here = rows.filter((r) => r.path === pathName && r.week === week);
  const steps = here.filter((r) => r.row_key === 'step').sort((a, b) => a.step_index - b.step_index);
  if (!steps.length) return null;
  const last = steps[steps.length - 1];
  const nodes = steps.map((st, i) => ({
    name: st.step, kind: 'page', index: i,
    reached: i === 0 ? st.sessions : steps[i - 1].progressed,
    continued: st.progressed,
    row: st,
  }));
  nodes.push({ name: 'Checkout started', kind: 'checkout', index: nodes.length, reached: last.progressed, continued: last.buyers, row: last });
  nodes.push({ name: 'Bought', kind: 'bought', index: nodes.length, reached: last.buyers, continued: null, row: last });
  return {
    path: pathName, nodes, last,
    exact: here.find((r) => r.row_key === 'path'),
    start: nodes[0].reached,
    end: last.sessions,
    rank: steps[0].rank,
  };
}

const LANE_METRICS = {
  completion: { label: 'Completion (end ÷ start)', fmt: 'pct', of: (l) => ratio(l.end, l.start) },
  end: { label: 'Sessions that reached the end', fmt: 'int', of: (l) => l.end },
  buy: { label: 'Bought, of those at the end', fmt: 'pct', of: (l) => ratio(l.last.buyers, l.end) },
  rps: { label: 'Revenue per session at the end', fmt: 'money', of: (l) => ratio(l.last.revenue, l.end) },
};

function spark(values, highlight, fmt, ctx) {
  const pts = values.map((v, i) => [i, v]).filter(([, v]) => v !== null && v !== undefined);
  const w = 150; const ht = 34;
  if (pts.length < 2) return h('span', {});
  const lo = Math.min(...pts.map((p) => p[1])); const hi = Math.max(...pts.map((p) => p[1]));
  const sx = (i) => 4 + (i / (values.length - 1)) * (w - 8);
  const sy = (v) => (hi === lo ? ht / 2 : ht - 5 - ((v - lo) / (hi - lo)) * (ht - 10));
  const d = pts.map(([i, v], n) => `${n ? 'L' : 'M'}${sx(i).toFixed(1)},${sy(v).toFixed(1)}`).join(' ');
  const svg = s('svg', { width: w, height: ht, class: 'lane-spark' }, s('path', { d, fill: 'none', stroke: '#079455', 'stroke-width': 1.6 }));
  for (const [i, v] of pts) {
    const dot = s('circle', { cx: sx(i), cy: sy(v), r: i === highlight ? 3.6 : 2, fill: i === highlight ? '#085D3A' : '#fff', stroke: '#079455', 'stroke-width': 1.2 });
    dot.append(s('title', {}, `${ctx.weekLabel(i)}: ${format(v, fmt, ctx.currency)}`));
    svg.append(dot);
  }
  return svg;
}

function laneSvg(lane, prev, ctx, tip, kind) {
  const CW = 156; const BAR = 40; const TOP = 26; const NODE_H = 110; const H = TOP + NODE_H + 70;
  const n = lane.nodes.length;
  const W = 8 + (n - 1) * CW + BAR + 120;
  const mid = TOP + NODE_H / 2;
  const scale = (v) => (lane.start ? (Math.max(0, v) / lane.start) * NODE_H : 0);
  const geo = lane.nodes.map((node, i) => {
    const hgt = Math.max(3, scale(node.reached));
    return { x: 8 + i * CW, y: mid - hgt / 2, h: hgt };
  });
  const colorOf = (node) => (node.kind === 'checkout' ? CHECKOUT : node.kind === 'bought' ? BOUGHT : STEP_COLORS[Math.min(node.index, STEP_COLORS.length - 1)]);
  const svg = s('svg', { width: W, height: H, class: 'lane-svg' });
  const ribbon = (sx, sy1, sy2, tx, ty1, ty2) => {
    const cx = sx + (tx - sx) / 2;
    return `M ${sx} ${sy1} C ${cx} ${sy1}, ${cx} ${ty1}, ${tx} ${ty1} L ${tx} ${ty2} C ${cx} ${ty2}, ${cx} ${sy2}, ${sx} ${sy2} Z`;
  };

  lane.nodes.forEach((node, i) => {
    if (i === n - 1) return;
    const g = geo[i]; const next = geo[i + 1];
    const cont = Math.min(node.continued ?? 0, node.reached);
    const hc = Math.min(g.h, Math.max(cont > 0 ? 1.5 : 0, scale(cont)));
    svg.append(s('path', { d: ribbon(g.x + BAR, g.y, g.y + hc, next.x, next.y, next.y + next.h), fill: `${colorOf(lane.nodes[i + 1])}35` }));
    const dropped = node.reached - cont;
    if (dropped > 0 && node.kind !== 'bought') {
      const hd = g.h - hc;
      const tx = g.x + BAR + 46; const ty = H - 14;
      svg.append(s('path', { d: ribbon(g.x + BAR, g.y + hc, g.y + hc + hd, tx, ty, ty + Math.max(2, Math.min(hd, 8))), fill: `${ORANGE}26` }));
      const t = s('text', { x: tx + 4, y: ty + 8, class: 'lane-drop' }, `−${compact(dropped)} (${format(dropped / node.reached, 'pct')})`);
      t.append(s('title', {}, node.kind === 'page' ? 'Ended the visit here, or went to a page off this path' : 'Started checkout but did not buy in this session'));
      svg.append(t);
    }
  });

  lane.nodes.forEach((node, i) => {
    const g = geo[i]; const color = colorOf(node);
    const was = prev?.nodes[i];
    const fromPrev = i === 0 ? null : ratio(node.reached, lane.nodes[i - 1].reached);
    const wasFromPrev = i === 0 || !was ? null : ratio(was.reached, prev.nodes[i - 1].reached);
    const rect = s('rect', { x: g.x, y: g.y, width: BAR, height: g.h, rx: Math.min(8, g.h / 2), fill: color, stroke: darken(color), class: 'lane-node' });
    rect.addEventListener('mousemove', (evt) => tip.show(evt, node.kind === 'page' ? prettyPath(node.name, kind, ctx) : node.name, [
      ['Sessions that reached it', format(node.reached, 'int')],
      was ? ['Compared week', format(was.reached, 'int')] : null,
      i > 0 ? ['Of the step before', format(fromPrev, 'pct')] : null,
      wasFromPrev !== null ? ['Compared week, of the step before', format(wasFromPrev, 'pct')] : null,
      node.continued !== null ? ['Went on to the next node', format(node.continued, 'int')] : null,
      node.kind !== 'page' || i === lane.nodes.length - 3 ? ['Revenue (sessions at the end)', format(lane.last.revenue, 'money', ctx.currency)] : null,
      node.kind !== 'page' || i === lane.nodes.length - 3 ? ['Revenue per session at the end', format(ratio(lane.last.revenue, lane.end), 'money', ctx.currency)] : null,
      node.kind === 'bought' ? ['Average order', format(ratio(lane.last.revenue, lane.last.orders), 'money', ctx.currency)] : null,
    ]));
    rect.addEventListener('mouseleave', () => tip.hide());
    svg.append(rect);
    const name = node.kind === 'page' ? (kind === 'general' ? ctx.fieldLabel(node.name, 'step') : node.name) : node.name;
    const fit = name.length <= 21 ? name : node.kind === 'page' && kind === 'page' ? `…${name.slice(-20)}` : `${name.slice(0, 20)}…`;
    const label = s('text', { x: g.x, y: 15, class: `lane-name ${node.kind}` }, fit);
    label.append(s('title', {}, name));
    svg.append(label);
    svg.append(s('text', { x: g.x, y: TOP + NODE_H + 18, class: 'lane-count' }, compact(node.reached)));
    if (fromPrev !== null) {
      svg.append(s('text', { x: g.x + 44, y: TOP + NODE_H + 18, class: 'lane-rate' }, format(fromPrev, 'pct')));
    }
    const d = i === 0 ? (was ? change(node.reached, was.reached, 'num') : null) : (wasFromPrev !== null ? change(fromPrev, wasFromPrev, 'pct') : null);
    if (d && Number.isFinite(d.value)) {
      svg.append(s('text', { x: g.x, y: TOP + NODE_H + 33, class: `lane-delta ${d.dir > 0 ? 'up' : d.dir < 0 ? 'down' : ''}` },
        `${d.dir > 0 ? '▲' : d.dir < 0 ? '▼' : '■'} ${Math.abs(d.value).toFixed(1)}${d.unit === 'pp' ? ' pp' : '%'}`));
    }
  });
  return svg;
}

export function journey(panel, rows, ctx) {
  const weeks = distinct(rows, 'week');
  const totalsBy = (w) => (ctx.join ? sum(ctx.join.filter((r) => r.week === w), 'sessions') : null);
  const wc = weekControls(weeks, ctx);
  const metricId = LANE_METRICS[ctx.state.laneMetric] ? ctx.state.laneMetric : 'completion';
  const metric = LANE_METRICS[metricId];
  const kind = rows[0]?.kind ?? 'general';
  const ranks = new Map();
  for (const r of rows) ranks.set(r.path, Math.min(ranks.get(r.path) ?? Infinity, r.rank));
  const paths = [...ranks.keys()].sort((a, b) => ranks.get(a) - ranks.get(b));
  const wrap = h('div', { class: 'flow-wrap' });
  const tip = tooltip(wrap);
  const all = totalsBy(wc.week); const allPrev = wc.compare ? totalsBy(wc.compare) : null;
  const sctx = { ...ctx, weekLabel: (i) => wc.label(weeks[i]) };

  const head = h('div', { class: 'flow-head' },
    h('div', { class: 'all-sessions' },
      h('div', { class: 'all-bar' }),
      h('div', {}, h('div', { class: 'muted small' }, 'All sessions'),
        h('div', { class: 'big' }, all === null ? '–' : compact(all), ' ', allPrev ? delta(all, allPrev, 'int') : null),
        h('div', { class: 'muted small' }, `week of ${wc.label(wc.week)}${wc.compare ? `, against ${wc.label(wc.compare)}` : ''}`))),
    h('div', { class: 'flow-legend' },
      h('span', {}, h('i', { style: `background:${STEP_COLORS[0]}` }), 'Page step'),
      h('span', {}, h('i', { style: `background:${CHECKOUT}` }), 'Checkout started'),
      h('span', {}, h('i', { style: `background:${BOUGHT}` }), 'Bought'),
      h('span', {}, h('i', { style: `background:${ORANGE}55` }), 'Dropped or left the path'),
      h('span', { class: 'muted' }, 'Green figure: share of the node before. Arrow: change against the compared week.')));
  wrap.append(head);

  for (const p of paths) {
    const lane = laneOf(rows, p, wc.week);
    if (!lane) continue;
    const prev = wc.compare ? laneOf(rows, p, wc.compare) : null;
    const series = weeks.map((w) => { const l = laneOf(rows, p, w); return l ? metric.of(l) : null; });
    const cur = metric.of(lane); const was = prev ? metric.of(prev) : null;
    const lowVolume = lane.start < (panel.floor?.min ?? 0);
    wrap.append(h('div', { class: `lane${lowVolume ? ' floor' : ''}` },
      h('div', { class: 'lane-head' },
        h('div', { class: 'lane-rank' }, `#${lane.rank}`),
        h('div', { class: 'lane-path', title: p }, prettyPath(p, kind, ctx)),
        h('div', { class: 'lane-stats' },
          h('span', {}, h('strong', {}, compact(lane.start)), ' started', all ? ` (${format(lane.start / all, 'pct')} of all)` : ''),
          h('span', {}, h('strong', {}, compact(lane.end)), ' reached the end'),
          h('span', {}, h('strong', {}, format(ratio(lane.last.buyers, lane.end), 'pct')), ' of them bought')),
        h('div', { class: 'lane-metric' },
          h('span', { class: 'muted small' }, metric.label),
          h('div', {}, h('strong', {}, format(cur, metric.fmt, ctx.currency)), ' ', delta(cur, was, metric.fmt))),
        spark(series, weeks.indexOf(wc.week), metric.fmt, sctx)),
      h('div', { class: 'lane-body' }, laneSvg(lane, prev, ctx, tip, kind))));
  }

  const controls = h('div', { class: 'view-controls' }, wc.controls,
    select('Lane trend shows', Object.entries(LANE_METRICS).map(([id, m]) => [id, m.label]), metricId, (v) => ctx.set({ laneMetric: v })));
  return [controls, wrap];
}

export function oneLane(rows, pathName, week, compareWeek, ctx) {
  const kind = rows.find((r) => r.path === pathName)?.kind ?? rows[0]?.kind ?? 'general';
  const lane = laneOf(rows, pathName, week);
  if (!lane) return h('p', { class: 'muted' }, 'No rows for this path in the selected week.');
  const prev = compareWeek ? laneOf(rows, pathName, compareWeek) : null;
  const wrap = h('div', { class: 'flow-wrap single-lane' });
  const tip = tooltip(wrap);
  wrap.append(h('div', { class: 'lane' }, h('div', { class: 'lane-body' }, laneSvg(lane, prev, ctx, tip, kind))));
  return wrap;
}

// Journey rows to one row per path, cut and week, so the generic views can trend them.
export function journeySummary(rows) {
  const groups = new Map();
  for (const r of rows) {
    const key = [r.kind, r.path, r.viewport_type, r.segment, r.segment_value, r.week].join('|');
    const g = groups.get(key) ?? { kind: r.kind, path: r.path, rank: r.rank, viewport_type: r.viewport_type, segment: r.segment, segment_value: r.segment_value, week: r.week, steps: [], exact: null };
    if (r.row_key === 'step') g.steps.push(r); else g.exact = r;
    groups.set(key, g);
  }
  const out = [];
  for (const g of groups.values()) {
    if (!g.steps.length) continue;
    g.steps.sort((a, b) => a.step_index - b.step_index);
    const first = g.steps[0]; const last = g.steps[g.steps.length - 1];
    out.push({
      kind: g.kind, path: g.path, rank: g.rank, viewport_type: g.viewport_type, segment: g.segment, segment_value: g.segment_value, week: g.week,
      steps: g.steps.length,
      start_sessions: first.sessions,
      end_sessions: last.sessions,
      checkout: last.progressed,
      bought: last.buyers,
      end_orders: last.orders,
      end_revenue: last.revenue,
      exact_sessions: g.exact?.sessions ?? 0,
      exact_revenue: g.exact?.revenue ?? 0,
    });
  }
  return out;
}

// ---------- Funnels ----------

function funnelCounts(rows, steps, week) {
  const here = rows.filter((r) => r.week === week);
  return steps.map((st) => sum(here, st.col));
}

function yAxisLabels(max) {
  return [max, (max * 2) / 3, max / 3, 0].map((v) => compact(v));
}

const band = (rate) => (rate >= 99.95 ? 'band-100' : rate >= 75 ? 'band-75' : rate >= 50 ? 'band-50' : 'band-low');

export function funnel(panel, rows, ctx) {
  const steps = panel.steps;
  const weeks = distinct(rows, 'week');
  const wc = weekControls(weeks, ctx);
  const cur = funnelCounts(rows, steps, wc.week);
  const prev = wc.compare ? funnelCounts(rows, steps, wc.compare) : null;
  const rateOf = (counts, k) => (counts[0] ? (counts[k] / counts[0]) * 100 : 0);
  const stepRate = (counts, k) => (k === 0 ? 1 : ratio(counts[k], counts[k - 1]));

  const cols = steps.map((st, k) => {
    const rate = rateOf(cur, k);
    const prevRate = prev ? rateOf(prev, k) : null;
    const abandoned = k < steps.length - 1 ? cur[k] - cur[k + 1] : null;
    const completedRate = stepRate(cur, k);
    return h('div', { class: 'pf-step' },
      h('div', { class: 'pf-head' }, h('span', { class: 'pf-num' }, k + 1), st.label),
      h('div', { class: `pf-well ${band(rate)}` },
        prevRate !== null && k > 0 ? h('div', { class: 'pf-ghost', style: `height:calc(${Math.min(prevRate, 94)}% - 8px)`, title: `${wc.label(wc.compare)}: ${prevRate.toFixed(1)}% of all sessions` }) : null,
        h('div', { class: 'pf-bar', style: `height:calc(${Math.min(rate, 94)}% - 8px)` },
          h('span', { class: 'pf-pill' }, `${rate >= 10 ? rate.toFixed(1) : rate.toFixed(2)}%`))),
      h('div', { class: 'pf-stats' },
        h('div', { class: 'pf-label', title: 'Ratio of the two session counts. The numerator is not established to be a subset of the denominator.' }, 'Count ratio'),
        h('div', { class: 'pf-row' }, h('span', { class: 'pf-count good' }, compact(cur[k])),
          h('span', { class: 'pf-badge good' }, format(completedRate, 'pct'))),
        h('div', { class: 'pf-delta' }, k > 0 && prev ? [delta(completedRate, stepRate(prev, k), 'pct'), h('span', { class: 'muted' }, ` vs ${wc.label(wc.compare)}`)] : '\u00a0'),
        h('div', { class: 'pf-label', title: 'Sessions that recorded this action but not the next count. Not visitors who left between steps.' }, 'Fewer sessions recorded this'),
        h('div', { class: 'pf-row' }, h('span', { class: 'pf-count bad' }, abandoned === null ? '–' : compact(Math.max(0, abandoned))),
          abandoned === null ? null : h('span', { class: 'pf-badge bad' }, format(Math.max(0, abandoned) / (cur[k] || 1), 'pct')))));
  });
  const max = Math.max(...cur);
  const chart = h('div', { class: 'pf' },
    h('div', { class: 'pf-axis' }, yAxisLabels(max).map((l) => h('span', {}, l))),
    h('div', { class: 'pf-steps' }, cols));
  const summary = h('p', { class: 'foot' },
    `Week of ${wc.label(wc.week)}: ${format(cur[0], 'int')} sessions, ${format(ratio(cur[cur.length - 1], cur[0]), 'pct')} bought`,
    prev ? [' (', delta(ratio(cur[cur.length - 1], cur[0]), ratio(prev[prev.length - 1], prev[0]), 'pct'), ` against ${wc.label(wc.compare)}). The dashed outline is the compared week.`] : '.');
  const warning = panel.legacyFunnel ? h('p', { class: 'legacy-note' }, 'This drawing shows counts of sessions that recorded each action anywhere in the visit. The narrowing shape and the labels below don\'t mean visitors left between steps. Use Paths and actions → Event reach.') : null;
  return [warning, h('div', { class: 'view-controls' }, wc.controls), chart, summary];
}

export function minifunnels(panel, rows, ctx) {
  const steps = panel.steps;
  const field = panel.series;
  const weeks = distinct(rows, 'week');
  const wc = weekControls(weeks, ctx);
  const values = distinct(rows, field)
    .map((v) => ({ v, rows: rows.filter((r) => String(r[field]) === String(v)) }))
    .map((x) => ({ ...x, cur: funnelCounts(x.rows, steps, wc.week), prev: wc.compare ? funnelCounts(x.rows, steps, wc.compare) : null }))
    .filter((x) => x.cur[0] > 0)
    .sort((a, b) => b.cur[0] - a.cur[0]);
  const floor = panel.floor?.min ?? 0;
  const cards = values.map((x) => {
    const conv = ratio(x.cur[steps.length - 1], x.cur[0]);
    const was = x.prev ? ratio(x.prev[steps.length - 1], x.prev[0]) : null;
    return h('div', { class: `mf-card${x.cur[0] < floor ? ' floor' : ''}` },
      h('div', { class: 'mf-head' },
        h('div', { class: 'mf-title' }, ctx.fieldLabel(x.v, field)),
        h('div', { class: 'muted small' }, `${compact(x.cur[0])} sessions`, x.prev ? [' ', delta(x.cur[0], x.prev[0], 'int')] : null)),
      h('div', { class: 'mf-conv' }, h('strong', {}, format(conv, 'pct')), ' bought ', delta(conv, was, 'pct')),
      h('div', { class: 'mf-bars' }, steps.map((st, k) => {
        const rate = x.cur[0] ? (x.cur[k] / x.cur[0]) * 100 : 0;
        const prevRate = x.prev && x.prev[0] ? (x.prev[k] / x.prev[0]) * 100 : null;
        return h('div', { class: 'mf-step', title: `${st.label}: ${format(x.cur[k], 'int')} (${rate.toFixed(1)}% of sessions)${prevRate !== null ? `; compared week ${prevRate.toFixed(1)}%` : ''}` },
          h('div', { class: `mf-well ${band(rate)}` },
            prevRate !== null && k > 0 ? h('div', { class: 'mf-ghost', style: `height:${Math.min(prevRate, 100)}%` }) : null,
            h('div', { class: 'mf-bar', style: `height:${Math.max(1.5, Math.min(rate, 100))}%` })),
          h('div', { class: 'mf-rate' }, `${rate >= 10 ? rate.toFixed(0) : rate.toFixed(1)}%`),
          h('div', { class: 'mf-name' }, st.short ?? st.label));
      })));
  });
  return [
    h('div', { class: 'view-controls' }, wc.controls),
    h('div', { class: 'mf-grid' }, cards),
    h('p', { class: 'foot' }, `Each bar is a share of that segment's sessions. The dashed outline is ${wc.compare ? wc.label(wc.compare) : 'not shown'}.${floor ? ` Greyed cards have fewer than ${floor} sessions.` : ''}`),
  ];
}

// ---------- Trend small multiples ----------

export function trendlines(panel, rows, ctx) {
  const x = panel.x ?? 'week';
  const xs = distinct(rows, x);
  const seriesField = panel.series;
  const volumeCol = panel.volume ?? 'sessions';
  const totalsBySeries = new Map();
  for (const r of rows) totalsBySeries.set(r[seriesField], (totalsBySeries.get(r[seriesField]) ?? 0) + (Number(r[volumeCol]) || 0));
  const seriesVals = [...totalsBySeries.keys()].sort((a, b) => totalsBySeries.get(b) - totalsBySeries.get(a)).slice(0, panel.maxSeries ?? 8);
  const colorOf = new Map(seriesVals.map((v, i) => [v, PALETTE[i % PALETTE.length]]));
  const hidden = new Set(ctx.state.hidden ?? []);
  const visible = seriesVals.filter((v) => !hidden.has(String(v)));
  const partial = new Set(xs.filter((w) => {
    const info = ctx.coverageOf?.(w);
    return info && info.state !== 'verified';
  }));
  const floorDef = panel.floor ? ctx.measure(panel.floor.measure) : null;

  let facets;
  let measurePicker = null;
  if (panel.facetMeasures) {
    facets = panel.facetMeasures.map((id) => ({ key: id, title: ctx.measure(id).label, def: ctx.measure(id), rows }));
  } else {
    const measureId = panel.measures.includes(ctx.state.measure) ? ctx.state.measure : panel.measures[0];
    const def = ctx.measure(measureId);
    const ranks = new Map();
    for (const r of rows) ranks.set(r[panel.facet], Math.min(ranks.get(r[panel.facet]) ?? Infinity, Number(r.rank ?? 0)));
    const keys = [...ranks.keys()].sort((a, b) => ranks.get(a) - ranks.get(b) || naturalCompare(a, b));
    const kind = rows[0]?.kind;
    facets = keys.map((k) => ({ key: k, title: panel.facet === 'path' ? `#${ranks.get(k)} ${prettyPath(k, kind, ctx)}` : ctx.fieldLabel(k, panel.facet), def, rows: rows.filter((r) => r[panel.facet] === k) }));
    measurePicker = select('Measure', panel.measures.map((id) => [id, ctx.measure(id).label]), measureId, (v) => ctx.set({ measure: v }));
  }

  const legend = h('div', { class: 'tl-legend' }, seriesVals.map((v) => h('button', {
    type: 'button',
    class: `tl-chip${hidden.has(String(v)) ? ' off' : ''}`,
    onclick: () => {
      const next = new Set(hidden);
      if (next.has(String(v))) next.delete(String(v)); else next.add(String(v));
      ctx.set({ hidden: [...next] });
    },
  }, h('i', { style: `background:${colorOf.get(v)}` }), ctx.fieldLabel(v, seriesField))));

  const W = 340; const H = 170; const L = 54; const R = 12; const T = 12; const B = 24;
  const sx = (i) => L + (xs.length === 1 ? (W - L - R) / 2 : (i / (xs.length - 1)) * (W - L - R));
  const cards = facets.map((f) => {
    const defs = [f.def, floorDef].filter(Boolean);
    const cells = aggregate(f.rows, [seriesField, x], defs);
    const at = new Map(cells.map((g) => [`${g.key[seriesField]}|${g.key[x]}`, g]));
    const lines = visible.map((v) => ({ v, pts: xs.map((w) => { const g = at.get(`${v}|${w}`); return g ? { w, val: measureValue(f.def, g), floorVal: floorDef ? measureValue(floorDef, g) : null } : null; }) }));
    const vals = lines.flatMap((l) => l.pts.filter((p) => p && p.val !== null).map((p) => p.val));
    let lo = Math.min(...vals); let hi = Math.max(...vals);
    if (!vals.length) { lo = 0; hi = 1; }
    if (lo === hi) { lo -= Math.abs(lo) * 0.1 || 1; hi += Math.abs(hi) * 0.1 || 1; }
    const pad = (hi - lo) * 0.08; lo -= pad; hi += pad;
    if (f.def.format === 'int') lo = Math.min(0, lo);
    if (vals.every((v) => v >= 0)) lo = Math.max(0, lo);
    const sy = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
    const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'tl-svg' });
    xs.forEach((w, i) => {
      if (partial.has(w)) {
        const half = xs.length > 1 ? (W - L - R) / (xs.length - 1) / 2 : 20;
        svg.append(s('rect', { x: sx(i) - half, y: T, width: half * 2, height: H - T - B, fill: '#f5f5f5' }));
        const info = ctx.coverageOf?.(w);
        const tag = info?.days ? `${info.days}/7` : 'unverified';
        svg.append(s('text', { x: sx(i), y: T + 10, 'text-anchor': 'middle', class: 'tl-axis' }, tag));
      }
    });
    for (const fr of [0, 0.5, 1]) {
      const v = lo + fr * (hi - lo); const y = sy(v);
      svg.append(s('line', { x1: L, x2: W - R, y1: y, y2: y, stroke: '#eceef1' }));
      svg.append(s('text', { x: L - 6, y: y + 4, 'text-anchor': 'end', class: 'tl-axis' }, format(v, f.def.format, ctx.currency)));
    }
    xs.forEach((w, i) => svg.append(s('text', { x: sx(i), y: H - 6, 'text-anchor': 'middle', class: 'tl-axis' }, ctx.fieldLabel(w, x))));
    for (const line of lines) {
      const color = colorOf.get(line.v);
      const pts = line.pts.map((p, i) => (p && p.val !== null ? [sx(i), sy(p.val), p] : null)).filter(Boolean);
      if (pts.length > 1) svg.append(s('path', { d: pts.map(([px, py], n) => `${n ? 'L' : 'M'}${px.toFixed(1)},${py.toFixed(1)}`).join(' '), fill: 'none', stroke: color, 'stroke-width': 2, 'stroke-linejoin': 'round' }));
      for (const [px, py, p] of pts) {
        const thin = floorDef && p.floorVal !== null && p.floorVal < panel.floor.min;
        const dot = s('circle', { cx: px, cy: py, r: 3, fill: thin ? '#fff' : color, stroke: color, 'stroke-width': 1.5 });
        dot.append(s('title', {}, `${ctx.fieldLabel(line.v, seriesField)}, week of ${ctx.fieldLabel(p.w, x)}: ${format(p.val, f.def.format, ctx.currency)}${floorDef ? ` (${format(p.floorVal, floorDef.format)} ${floorDef.label.toLowerCase()})` : ''}${thin ? ', below the floor' : ''}`));
        svg.append(dot);
      }
    }
    const lastIdx = xs.length - 1;
    const movers = lines.map((l) => ({ v: l.v, c: change(l.pts[lastIdx]?.val ?? null, l.pts[lastIdx - 1]?.val ?? null, f.def.format === 'pct' ? 'pct' : 'num') }))
      .filter((m) => m.c && Number.isFinite(m.c.value)).sort((a, b) => Math.abs(b.c.value) - Math.abs(a.c.value)).slice(0, 2);
    return h('div', { class: 'tl-card' },
      h('div', { class: 'tl-title', title: String(f.key) }, f.title),
      svg,
      movers.length ? h('div', { class: 'tl-movers' }, 'Last week moved most: ', movers.map((m, i) => [i ? ', ' : '', h('strong', { style: `color:${colorOf.get(m.v)}` }, ctx.fieldLabel(m.v, seriesField)), ' ',
        h('span', { class: `delta ${m.c.dir > 0 ? 'up' : 'down'}` }, `${m.c.dir > 0 ? '▲' : '▼'} ${Math.abs(m.c.value).toFixed(1)}${m.c.unit === 'pp' ? ' pp' : '%'}`)])) : null);
  });
  return [
    h('div', { class: 'view-controls' }, measurePicker),
    legend,
    h('div', { class: 'tl-grid' }, cards),
    h('p', { class: 'foot' }, `One line per ${ctx.fieldLabel(seriesField).toLowerCase()}. Click a name to hide or show it. Each chart has its own scale.${floorDef ? ` Hollow points have fewer than ${panel.floor.min} ${floorDef.label.toLowerCase()}.` : ''}`),
  ];
}
