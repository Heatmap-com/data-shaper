// Journey and funnel views, drawn after the portal's journey-analysis sankey and funnel chart.
import { aggregate, change, distinct, format, measureValue, naturalCompare } from './query.js';
import { h, s, PALETTE } from './views.js';
import { bandFor, changeOf, judge, fmtBand, fmtDelta, badgeText } from './wobble.js';
import { coverageLabel } from './coverage.js';
import { compareWeek } from './derive.js';
import { wobbleButton, wobbleHover } from './wobble-card.js';
import { journeyHover } from './journey-cards.js';

const STEP_COLORS = ['#085D3A', '#079455', '#4CA30D', '#85E13A', '#A6EF67', '#D0F8AB'];
const CHECKOUT = '#279CCA';
const BOUGHT = '#175CD3';
const ORANGE = '#EF6820';

const sum = (rows, col) => rows.reduce((t, r) => t + (Number(r[col]) || 0), 0);
const ratio = (a, b) => (b ? a / b : null);

export function compact(n) {
  if (n === null || n === undefined) return '–';
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

// Whole weeks come from the dataset's window in the manifest.
export function partialWeeks(weeks, ctx) {
  const cov = ctx.cov(weeks.map(String));
  return new Set(weeks.filter((w) => cov.get(String(w)) && !cov.get(String(w)).full));
}

function select(label, options, value, onchange) {
  return h('label', { class: 'picker' }, h('span', {}, label),
    h('select', { onchange: (e) => onchange(e.target.value) },
      options.map(([v, l]) => h('option', { value: v, selected: String(v) === String(value) ? 'selected' : null }, l))));
}

function weekControls(weeks, ctx, partial) {
  const full = (w) => !partial.has(w);
  const fullWeeks = weeks.filter(full);
  const own = weeks.includes(ctx.state.week);
  const week = own ? ctx.state.week : weeks.includes(ctx.global?.week) ? ctx.global.week : fullWeeks[fullWeeks.length - 1] ?? weeks[weeks.length - 1];
  const mode = ctx.state.compare ?? ctx.global?.compare ?? 'prev';
  const compare = compareWeek(weeks, week, mode, full);
  const cov = ctx.cov(weeks.map(String));
  const label = (w) => `${ctx.fieldLabel(w, 'week')}${partial.has(w) ? ` (${coverageLabel(cov.get(String(w)))})` : ''}`;
  const first = fullWeeks[0];
  const controls = [
    select('Week', weeks.map((w) => [w, `Week of ${label(w)}`]), week, (v) => ctx.set({ week: v })),
    select('Compare with', [['prev', 'Previous week'], ['firstFull', `First whole week${first ? ` (${label(first)})` : ''}`], ['none', 'Nothing']], ['prev', 'firstFull', 'none'].includes(mode) ? mode : 'prev', (v) => ctx.set({ compare: v })),
    own || ctx.state.compare ? h('button', { type: 'button', class: 'linklike', onclick: () => ctx.set({ week: undefined, compare: undefined }) }, 'follow the context bar') : null,
  ];
  return { week, compare, controls, label, full };
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

export function prettyPath(path, kind, ctx) {
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
export function laneOf(rows, pathName, week) {
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

// "Changed (N) / All (M)": by default a panel shows only what moved beyond its own wobble.
function changedToggle({ changed, total, showAll, title, onPick }) {
  return h('div', { class: 'seg-toggle', role: 'group', 'aria-label': 'What to show', title },
    [['changed', `Changed (${changed})`], ['all', `All (${total})`]].map(([id, label]) => h('button', {
      type: 'button', class: (showAll ? 'all' : 'changed') === id ? 'on' : null, 'aria-pressed': String((showAll ? 'all' : 'changed') === id),
      onclick: () => onPick(id),
    }, label)));
}
function hiddenNote({ changed, total, noun, empty, judged = true, onShowAll }) {
  const hidden = total - changed;
  if (!hidden) return null;
  const link = h('button', { type: 'button', class: 'linklike', onclick: onShowAll }, `Show all ${total} ${noun}s`);
  return changed
    ? h('p', { class: 'changed-note muted' }, `${hidden} ${noun}${hidden === 1 ? '' : 's'} with no meaningful change ${hidden === 1 ? 'is' : 'are'} hidden. `, link)
    : h('div', { class: 'changed-empty' }, h('strong', {}, empty), h('p', { class: 'muted' }, judged ? `None of the ${total} ${noun}s moved beyond ${total === 1 ? 'its' : 'their'} usual weekly range, so there is nothing to call out. ` : 'There are too few whole weeks before this one to learn each usual weekly range, so no change can be called out yet. ', link));
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

export function nodeLabel(node, kind, ctx) {
  if (node.kind !== 'page') return node.name;
  const n = kind === 'general' ? ctx.fieldLabel(node.name, 'step') : node.name;
  return n.length > 40 ? `…${n.slice(-39)}` : n;
}
const stepRateOf = (l, i) => (l?.nodes[i] && l.nodes[i - 1] ? ratio(l.nodes[i].reached, l.nodes[i - 1].reached) : null);
const median = (xs) => {
  const v = [...xs].sort((a, b) => a - b);
  const n = v.length;
  return n ? (n % 2 ? v[(n - 1) / 2] : (v[n / 2 - 1] + v[n / 2]) / 2) : null;
};
// Compared with the other top journeys in the same week. Completion is left out: it falls with every extra step.
const PEER_METRICS = [
  { id: 'buy', of: (l) => ratio(l.last.buyers, l.end), text: (v) => `${format(v, 'pct')} of those at the end buy` },
];
const PEER_RATIO = 1.5;

// What stands out in one lane: steps that moved beyond their own weekly range, how the lane compares with
// the other top journeys, and where most sessions leave.
export function laneFindings({ lane, byWeek, weeks, wc, floor, peers }) {
  const jIdx = weeks.indexOf(wc.week);
  const cIdx = wc.compare ? weeks.indexOf(wc.compare) : -1;
  const fullFlags = weeks.map(wc.full);
  const steps = [];
  let judged = 0;
  if (cIdx >= 0) {
    for (let i = 1; i < lane.nodes.length; i += 1) {
      const before = byWeek[cIdx]?.nodes[i - 1]?.reached ?? 0;
      const thin = lane.nodes[i - 1].reached < floor || before < floor;
      const series = byWeek.map((l) => stepRateOf(l, i));
      const b = bandFor(series, fullFlags, jIdx, 'pp');
      const d = changeOf(series[jIdx], series[cIdx], 'pp');
      if (!thin && b.band !== null) judged += 1;
      const status = thin ? 'thin' : b.band === null || d === null ? 'cantsay' : Math.abs(d) > b.band ? 'moved' : 'within';
      steps.push({ i, key: `${lane.nodes[i - 1].name}>${lane.nodes[i].name}`, series, d, band: b.band, median: b.median, n: b.n, cur: series[jIdx], prev: series[cIdx], size: b.band && d !== null ? Math.abs(d) / b.band : 0, status });
    }
  }
  const moves = steps.filter((st) => st.status === 'moved').sort((a, b) => b.size - a.size);
  const contrasts = [];
  if (lane.start >= floor) {
    for (const m of PEER_METRICS) {
      const mine = m.of(lane);
      const others = peers.filter((x) => x !== lane && x.start >= floor).map(m.of).filter((v) => v !== null);
      const med = median(others);
      if (others.length < 2 || mine === null || !med) continue;
      const r = mine / med;
      if (r >= PEER_RATIO || r <= 1 / PEER_RATIO) contrasts.push({ m, mine, med, r });
    }
  }
  let leak = null;
  for (const node of lane.nodes) {
    if (node.kind === 'bought' || node.continued === null || !node.reached) continue;
    const share = 1 - Math.min(node.continued, node.reached) / node.reached;
    if (!leak || share > leak.share) leak = { node, share };
  }
  return { steps, moves, contrasts, leak, judged, canJudge: cIdx >= 0 };
}

function laneSentences(fd, lane, kind, ctx, wc, floor, siteWide) {
  const out = [];
  const pct = (v) => format(v, 'pct');
  const own = fd.moves.filter((m) => !siteWide.has(`${m.key}|${Math.sign(m.d)}`));
  const shared = fd.moves.filter((m) => siteWide.has(`${m.key}|${Math.sign(m.d)}`));
  for (const m of own.slice(0, 2)) {
    const from = nodeLabel(lane.nodes[m.i - 1], kind, ctx); const to = nodeLabel(lane.nodes[m.i], kind, ctx);
    out.push({ tone: m.d > 0 ? 'up' : 'down', parts: [{ text: `${from} → ${to} ${m.d > 0 ? 'rose' : 'fell'} to ${pct(m.cur)} from ${pct(m.prev)}; it usually moves ${fmtBand(m.band, 'pp')} a week`, card: { type: 'step', data: m } }] });
  }
  const overview = { type: 'overview' };
  if (own.length > 2) out.push({ tone: 'note', parts: [{ text: `${own.length - 2} more step${own.length - 2 === 1 ? '' : 's'} moved beyond ${own.length - 2 === 1 ? 'its' : 'their'} usual range`, card: overview }] });
  if (shared.length) {
    out.push({ tone: 'note', parts: ['Also part of the site-wide shift: ', ...shared.flatMap((m, k) => [k ? '; ' : '',
      { text: `${nodeLabel(lane.nodes[m.i - 1], kind, ctx)} → ${nodeLabel(lane.nodes[m.i], kind, ctx)} ${m.d > 0 ? 'rose' : 'fell'} to ${pct(m.cur)}`, card: { type: 'step', data: m } }]).filter(Boolean)] });
  }
  for (const c of fd.contrasts) {
    out.push({ tone: c.r > 1 ? 'up' : 'down', parts: [{ text: `${c.m.text(c.mine)}, ${c.r.toFixed(1)}× the typical top journey (${pct(c.med)})`, card: { type: 'peer', data: c } }] });
  }
  if (!own.length && !shared.length) {
    if (!fd.canJudge) out.push({ tone: 'note', parts: ['No comparison week, so step changes are not judged'] });
    else if (!fd.judged) out.push({ tone: 'note', parts: [{ text: `Too few whole weeks${lane.start < floor ? ` or under ${floor} sessions` : ''} to judge step changes`, card: overview }] });
    else out.push({ tone: 'calm', parts: [{ text: `Every step within its usual weekly range against ${wc.label(wc.compare)}`, card: overview }] });
  }
  if (fd.leak) {
    const n = fd.leak.node;
    out.push({ tone: 'note', parts: [{ text: n.kind === 'checkout'
      ? `Biggest leak: ${pct(fd.leak.share)} of checkouts don't end in a purchase`
      : `Biggest leak: ${pct(fd.leak.share)} leave at ${nodeLabel(n, kind, ctx)} or go off the journey`, card: { type: 'leak' } }] });
  }
  return out;
}

export function journey(panel, rows, ctx) {
  const weeks = distinct(rows, 'week');
  const totalsBy = (w) => (ctx.join ? sum(ctx.join.filter((r) => r.week === w), 'sessions') : null);
  const partial = partialWeeks(weeks, ctx);
  const wc = weekControls(weeks, ctx, partial);
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

  const floor = panel.floor?.min ?? 0;
  const laneSets = paths.map((p) => {
    const byWeek = weeks.map((w) => laneOf(rows, p, w));
    return { p, byWeek, lane: byWeek[weeks.indexOf(wc.week)] };
  }).filter((x) => x.lane);
  const peers = laneSets.map((x) => x.lane);
  const openLanes = ctx.state.openLanes ?? {};
  const toggle = (p, open) => {
    ctx.log?.('lane_toggle', { panel: panel.id, path: p, open });
    ctx.set({ openLanes: { ...(ctx.state.openLanes ?? {}), [p]: open } }, { log: false });
  };
  // Opening from a card (possibly a pinned one far from the lane) also brings the lane into view.
  const reveal = (p) => {
    toggle(p, true);
    let tries = 0;
    const find = () => {
      const el = [...document.querySelectorAll('.lane[data-lane]')].find((e) => e.dataset.lane === p && e.classList.contains('open'));
      if (!el) { if ((tries += 1) < 20) setTimeout(find, 50); return; }
      const top = el.getBoundingClientRect().top;
      if (top < 80 || top > window.innerHeight - 160) el.scrollIntoView({ block: 'start', behavior: 'smooth' });
    };
    setTimeout(find, 30);
  };

  // A step that moved the same way in several journeys is a site-wide shift, not a journey story.
  for (const x of laneSets) x.fd = laneFindings({ lane: x.lane, byWeek: x.byWeek, weeks, wc, floor, peers });
  const moveCount = new Map();
  for (const x of laneSets) for (const m of x.fd.moves) {
    const k = `${m.key}|${Math.sign(m.d)}`;
    moveCount.set(k, [...(moveCount.get(k) ?? []), { x, m }]);
  }
  const siteWideMin = Math.max(2, Math.ceil(laneSets.length / 2));
  const siteWide = new Map([...moveCount].filter(([, v]) => v.length >= siteWideMin));
  const across = siteWide.size ? h('p', { class: 'lane-across' }, h('strong', {}, 'Across journeys: '),
    [...siteWide.values()].map((v, i) => {
      const { x, m } = v[0];
      return [i ? '; ' : '', `${nodeLabel(x.lane.nodes[m.i - 1], kind, ctx)} → ${nodeLabel(x.lane.nodes[m.i], kind, ctx)} ${m.d > 0 ? 'rose' : 'fell'} in ${v.length} of ${laneSets.length} journeys`];
    }),
    '. That looks site-wide rather than about one journey, so it isn\'t counted as standing out in each lane below.') : null;
  if (across) wrap.append(across);

  const canFilter = Boolean(wc.compare);
  const changedLanes = laneSets.filter((x) => x.fd.moves.some((m) => !siteWide.has(`${m.key}|${Math.sign(m.d)}`)));
  const lanesJudged = laneSets.some((x) => x.fd.judged);
  const showAllLanes = !canFilter || (ctx.state.laneView ?? 'changed') === 'all';
  const shownLanes = showAllLanes ? laneSets : changedLanes;
  if (!showAllLanes && !changedLanes.length && laneSets.length) {
    wrap.append(hiddenNote({ changed: 0, total: laneSets.length, noun: 'journey', empty: lanesJudged ? `No journey changed meaningfully against ${wc.label(wc.compare)}.` : 'Too early to judge changes.', judged: lanesJudged, onShowAll: () => ctx.set({ laneView: 'all' }) }));
  }
  const jc = { panelId: panel.id, weeks, wc, label: (node) => nodeLabel(node, kind, ctx), pretty: (path) => prettyPath(path, kind, ctx), laneSets, siteWide, floor, ctx };
  for (const x of shownLanes) {
    const { p, byWeek, lane, fd } = x;
    const prev = wc.compare ? byWeek[weeks.indexOf(wc.compare)] : null;
    const series = byWeek.map((l) => (l ? metric.of(l) : null));
    const cur = metric.of(lane); const was = prev ? metric.of(prev) : null;
    const lowVolume = lane.start < floor;
    const flags = fd.moves.filter((m) => !siteWide.has(`${m.key}|${Math.sign(m.d)}`)).length + fd.contrasts.length;
    const open = Boolean(openLanes[p]);
    const sentences = laneSentences(fd, lane, kind, ctx, wc, floor, siteWide);
    const xc = { ...x, prev, open, toggle: (o) => toggle(p, o), reveal: () => reveal(p) };
    const part = (pt, tone) => (typeof pt === 'string' ? pt : journeyHover(h('span', { class: `ls-hov ${tone}` }, pt.text), pt.card, xc, jc));
    wrap.append(h('div', { class: `lane collapsible${open ? ' open' : ''}${lowVolume ? ' floor' : ''}${flags ? ' flagged' : ''}`, 'data-lane': p },
      h('div', { class: 'lane-head', role: 'button', tabindex: '0', 'aria-expanded': String(open), title: open ? 'Close this journey' : 'Open the journey diagram',
        onclick: () => toggle(p, !open),
        onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(p, !open); } } },
        h('span', { class: 'lane-chev' }, open ? '▾' : '▸'),
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
      h('div', { class: 'lane-summary' },
        journeyHover(flags ? h('span', { class: 'ob bad lane-flag' }, `${flags} thing${flags === 1 ? '' : 's'} stand${flags === 1 ? 's' : ''} out`) : h('span', { class: 'ob soft lane-flag' }, 'nothing unusual'), { type: 'overview' }, xc, jc),
        lowVolume ? h('span', { class: 'muted' }, `Under ${floor} starters, so read it as directional. `) : null,
        sentences.map((s0, i) => h('span', { class: `ls ${s0.tone}` }, s0.parts.map((pt) => part(pt, s0.tone)), i < sentences.length - 1 ? '. ' : '.'))),
      open ? h('div', { class: 'lane-body' }, laneSvg(lane, prev, ctx, tip, kind)) : null));
  }

  if (!showAllLanes && changedLanes.length && changedLanes.length < laneSets.length) wrap.append(hiddenNote({ changed: changedLanes.length, total: laneSets.length, noun: 'journey', onShowAll: () => ctx.set({ laneView: 'all' }) }));
  const allOpen = shownLanes.length && shownLanes.every((x) => openLanes[x.p]);
  const controls = h('div', { class: 'view-controls' },
    canFilter && laneSets.length ? changedToggle({ changed: changedLanes.length, total: laneSets.length, showAll: showAllLanes,
      title: 'Changed: a step in the journey moved beyond its own usual weekly range. Shifts seen across most journeys are in the note above the lanes instead.', onPick: (id) => ctx.set({ laneView: id }) }) : null,
    wc.controls,
    select('Lane trend shows', Object.entries(LANE_METRICS).map(([id, m]) => [id, m.label]), metricId, (v) => ctx.set({ laneMetric: v })),
    h('button', { type: 'button', class: 'linklike', onclick: () => ctx.set({ openLanes: { ...openLanes, ...Object.fromEntries(shownLanes.map((x) => [x.p, !allOpen])) } }) }, allOpen ? 'close all journeys' : 'open all journeys'));
  return [controls, wrap];
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
  const partial = partialWeeks(weeks, ctx);
  const wc = weekControls(weeks, ctx, partial);
  const cur = funnelCounts(rows, steps, wc.week);
  const prev = wc.compare ? funnelCounts(rows, steps, wc.compare) : null;
  const rateOf = (counts, k) => (counts[0] ? (counts[k] / counts[0]) * 100 : 0);
  const stepRate = (counts, k) => (k === 0 ? 1 : ratio(counts[k], counts[k - 1]));

  const root = (r) => Math.sqrt(Math.max(0, r) / 100) * 100;
  const cx = ctx.contrast?.funnel({ week: wc.week, compare: wc.compare });
  const cols = steps.map((st, k) => {
    const rate = rateOf(cur, k);
    const prevRate = prev ? rateOf(prev, k) : null;
    const abandoned = k < steps.length - 1 ? cur[k] - cur[k + 1] : null;
    const completedRate = stepRate(cur, k);
    return h('div', { class: 'pf-step' },
      h('div', { class: 'pf-head' }, h('span', { class: 'pf-num' }, k + 1), st.label),
      h('div', { class: `pf-well ${band(rate)}` },
        prevRate !== null && k > 0 ? h('div', { class: 'pf-ghost', style: `height:calc(${Math.min(root(prevRate), 94)}% - 8px)`, title: `${wc.label(wc.compare)}: ${prevRate.toFixed(1)}% of all sessions` }) : null,
        h('div', { class: 'pf-bar', style: `height:calc(${Math.min(root(rate), 94)}% - 8px)` },
          h('span', { class: 'pf-pill' }, `${rate >= 10 ? rate.toFixed(1) : rate.toFixed(2)}%`))),
      h('div', { class: 'pf-stats' },
        h('div', { class: 'pf-label', title: 'Sessions recorded at this step ÷ sessions recorded at the step before. Steps are counted separately, so this is a ratio of counts, not people moving on.' }, k === 0 ? 'Sessions' : 'Count ratio'),
        h('div', { class: 'pf-row' }, h('span', { class: 'pf-count good' }, compact(cur[k])),
          h('span', { class: 'pf-badge good' }, format(completedRate, 'pct'))),
        h('div', { class: 'pf-delta' }, k > 0 && prev ? [delta(completedRate, stepRate(prev, k), 'pct'), h('span', { class: 'muted' }, ` vs ${wc.label(wc.compare)}`)] : '\u00a0'),
        h('div', { class: 'pf-label', title: 'How many fewer sessions were recorded at the next step. Not the same as people who left: a step can be reached without the one before.' }, 'Fewer sessions recorded next'),
        h('div', { class: 'pf-row' }, h('span', { class: 'pf-count bad' }, abandoned === null ? '–' : compact(Math.max(0, abandoned))),
          abandoned === null ? null : h('span', { class: 'pf-badge bad' }, format(Math.max(0, abandoned) / (cur[k] || 1), 'pct'))),
        cx?.focusLabel ? h('div', { class: 'pf-ctr' }, h('div', { class: 'pf-label' }, k === 0 ? 'Order rate vs rest' : 'Step vs rest'), cx.stepChip(k) ?? '–') : null));
  });
  const chart = h('div', { class: 'pf' },
    h('div', { class: 'pf-axis' }, ['100%', '44%', '11%', '0%'].map((l) => h('span', {}, l))),
    h('div', { class: 'pf-steps' }, cols));
  const summary = h('p', { class: 'foot' },
    `Week of ${wc.label(wc.week)}: ${format(cur[0], 'int')} sessions, ${format(ratio(cur[cur.length - 1], cur[0]), 'pct')} bought`,
    prev ? [' (', delta(ratio(cur[cur.length - 1], cur[0]), ratio(prev[prev.length - 1], prev[0]), 'pct'), ` against ${wc.label(wc.compare)}). The dashed outline is the compared week.`] : '.');
  const note = h('p', { class: 'foot scale-note' }, 'Bar heights use a square-root scale so the small later steps stay visible; the percentages are exact. Each step counts sessions that did it at any point in the visit, so a step can be reached without the one before.');
  const focusNote = cx?.focusLabel ? h('p', { class: 'foot' }, `The chips under each step compare ${cx.focusLabel} with everyone else in the same split. Hover to see both side by side; click to pin.`) : null;
  return [h('div', { class: 'view-controls' }, wc.controls), cx?.strip, chart, summary, focusNote, note];
}

export function minifunnels(panel, rows, ctx) {
  const steps = panel.steps;
  const field = panel.series;
  const weeks = distinct(rows, 'week').sort();
  const partial = partialWeeks(weeks, ctx);
  const wc = weekControls(weeks, ctx, partial);
  const floor = panel.floor?.min ?? 0;
  const last = steps.length - 1;
  const jIdx = weeks.indexOf(wc.week);
  const sortBy = ctx.state.mfSort === 'move' ? 'move' : 'sessions';
  const values = distinct(rows, field)
    .map((v) => ({ v, rows: rows.filter((r) => String(r[field]) === String(v)) }))
    .map((x) => ({ ...x, cur: funnelCounts(x.rows, steps, wc.week), prev: wc.compare ? funnelCounts(x.rows, steps, wc.compare) : null }))
    .filter((x) => x.cur[0] > 0)
    .map((x) => {
      const series = weeks.map((w) => { const c = funnelCounts(x.rows, steps, w); return c[0] ? c[last] / c[0] : null; });
      const d = x.prev ? changeOf(series[jIdx], x.prev[0] ? x.prev[last] / x.prev[0] : null, 'pp') : null;
      const b = bandFor(series, weeks.map(wc.full), jIdx, 'pp');
      const thin = x.cur[0] < floor || (x.prev && x.prev[0] < floor);
      const j = judge({ delta: d, band: b.band, partial: false, thin });
      return { ...x, series, d, b, j, size: b.band && d !== null ? Math.abs(d) / b.band : 0 };
    })
    .sort((a, b) => (sortBy === 'move' ? (b.j.badge === 'moved') - (a.j.badge === 'moved') || b.size - a.size : 0) || b.cur[0] - a.cur[0]);
  const vc = ctx.contrast?.valueChips({ week: wc.week, compare: wc.compare, n: 2 });
  const cIdxMf = wc.compare ? weeks.indexOf(wc.compare) : -1;
  const pillOf = (x) => wobbleHover(h('span', { class: `wb ${x.j.badge}${x.j.thin ? ' thin' : ''}` }, badgeText(x.j), x.j.thin ? ' · thin' : ''), {
    id: `${panel.id}|${x.v}|${wc.week}|${wc.compare}`, name: ctx.fieldLabel(x.v, field), chart: null, measure: 'Bought rate (bought ÷ sessions)', fmt: 'pct', unit: 'pp', color: '#2c5f8a',
    weeks, values: x.series, idx: jIdx, cIdx: cIdxMf, full: weeks.map(wc.full),
    status: x.j.badge, reason: x.j.reason, thin: x.j.thin, delta: x.d, band: x.b.band, median: x.b.median, n: x.b.n,
    volume: { label: 'Sessions', values: weeks.map((w) => funnelCounts(x.rows, steps, w)[0]) }, floorText: `under ${floor} sessions`,
    othersNoun: 'segments', wholeLabel: 'the whole split',
    others: values.filter((y) => y !== x).map((y) => ({ name: ctx.fieldLabel(y.v, field), delta: y.d, badge: y.j.badge })),
    weekLabel: wc.label, currency: ctx.currency, log: ctx.log,
  });
  const cards = values.map((x) => {
    const conv = ratio(x.cur[steps.length - 1], x.cur[0]);
    const was = x.prev ? ratio(x.prev[steps.length - 1], x.prev[0]) : null;
    const seg = ctx.pickers?.find((p) => p.field === 'segment')?.value;
    const open = panel.drill ? () => ctx.drill({ ...panel.drill, pickers: { ...(panel.drill.pickers ?? {}), segment: seg, [panel.drill.picker]: x.v }, label: ctx.fieldLabel(x.v, field) }) : null;
    return h('div', { class: `mf-card${x.cur[0] < floor ? ' floor' : ''}${open ? ' drillable' : ''}`, onclick: open, title: open ? 'Open journeys for this segment' : null },
      h('div', { class: 'mf-head' },
        h('div', { class: 'mf-title' }, ctx.fieldLabel(x.v, field)),
        h('div', { class: 'muted small' }, `${compact(x.cur[0])} sessions`, x.prev ? [' ', delta(x.cur[0], x.prev[0], 'int')] : null)),
      h('div', { class: 'mf-conv' }, h('strong', {}, format(conv, 'pct')), ' bought ', x.d !== null ? h('span', { class: `delta ${x.d > 0 ? 'up' : x.d < 0 ? 'down' : 'flat'}` }, fmtDelta(x.d, 'pp')) : null, ' ',
        wc.compare ? pillOf(x) : null),
      vc ? h('div', { class: 'mf-ctr' }, vc(x.v)) : null,
      h('div', { class: 'mf-bars' }, steps.map((st, k) => {
        const rate = x.cur[0] ? (x.cur[k] / x.cur[0]) * 100 : 0;
        const prevRate = x.prev && x.prev[0] ? (x.prev[k] / x.prev[0]) * 100 : null;
        return h('div', { class: 'mf-step', title: `${st.label}: ${format(x.cur[k], 'int')} (${rate.toFixed(1)}% of sessions)${prevRate !== null ? `; compared week ${prevRate.toFixed(1)}%` : ''}` },
          h('div', { class: `mf-well ${band(rate)}` },
            prevRate !== null && k > 0 ? h('div', { class: 'mf-ghost', style: `height:${Math.sqrt(Math.min(prevRate, 100) / 100) * 100}%` }) : null,
            h('div', { class: 'mf-bar', style: `height:${Math.max(1.5, Math.sqrt(Math.min(rate, 100) / 100) * 100)}%` })),
          h('div', { class: 'mf-rate' }, `${rate >= 10 ? rate.toFixed(0) : rate.toFixed(1)}%`),
          h('div', { class: 'mf-name' }, st.short ?? st.label));
      })));
  });
  return [
    h('div', { class: 'view-controls' }, wc.controls, select('Sort', [['sessions', 'Most sessions'], ['move', 'Biggest move']], sortBy, (v) => ctx.set({ mfSort: v }))),
    ctx.contrast?.strip({ week: wc.week, compare: wc.compare }),
    h('div', { class: 'mf-grid' }, cards),
    h('p', { class: 'foot' }, `Each bar is a share of that segment's sessions, on a square-root scale so small steps stay visible. The dashed outline is ${wc.compare ? wc.label(wc.compare) : 'not shown'}. The badge compares the change in bought rate with that segment's own weekly wobble.${floor ? ` Greyed cards have fewer than ${floor} sessions.` : ''}`),
  ];
}

// ---------- Trend small multiples ----------

const OTHER = '__other';
const RETURNING_REDEFINED = '2026-09-07';

export function trendlines(panel, rows, ctx) {
  const x = panel.x ?? 'week';
  const xs = distinct(rows, x).sort();
  const seriesField = panel.series;
  const volumeCol = panel.volume ?? 'sessions';
  const totalsBySeries = new Map();
  for (const r of rows) totalsBySeries.set(r[seriesField], (totalsBySeries.get(r[seriesField]) ?? 0) + (Number(r[volumeCol]) || 0));
  const ranked = [...totalsBySeries.keys()].sort((p, q) => totalsBySeries.get(q) - totalsBySeries.get(p));
  const topN = ctx.state.allSeries ? (panel.maxSeries ?? 8) : (panel.topSeries ?? 3);
  const top = new Set(ranked.slice(0, topN).map(String));
  const folded = ranked.length > topN;
  const data = folded ? rows.map((r) => (top.has(String(r[seriesField])) ? r : { ...r, [seriesField]: OTHER })) : rows;
  const seriesVals = [...ranked.slice(0, topN), ...(folded ? [OTHER] : [])];
  const colorOf = new Map(seriesVals.map((v, i) => [v, v === OTHER ? '#9aa0a6' : PALETTE[i % PALETTE.length]]));
  const nameOf = (v) => (v === OTHER ? `Other (${ranked.length - topN})` : ctx.fieldLabel(v, seriesField));
  const hidden = new Set(ctx.state.hidden ?? []);
  const visible = seriesVals.filter((v) => !hidden.has(String(v)));
  const partial = partialWeeks(xs, ctx);
  const full = (w) => !partial.has(w);
  const floorDef = panel.floor ? ctx.measure(panel.floor.measure) : null;
  const shared = !ctx.state.zoom;
  const indexed = Boolean(ctx.state.index);
  const fullXs = xs.filter(full);
  const judgedW = xs.includes(ctx.global?.week) ? ctx.global.week : fullXs[fullXs.length - 1] ?? xs[xs.length - 1];
  const jIdx = xs.indexOf(judgedW);
  const cmpW = compareWeek(xs, judgedW, ctx.global?.compare ?? 'prev', full);
  const cIdx = cmpW ? xs.indexOf(cmpW) : -1;
  const mode = ['lines', 'slope', 'heat'].includes(ctx.state.tlMode) ? ctx.state.tlMode : 'lines';
  const isReturning = rows.some((r) => r.segment === 'returning');

  let facets;
  let measurePicker = null;
  if (panel.facetMeasures) {
    facets = panel.facetMeasures.map((id) => ({ key: id, title: ctx.measure(id).label, def: ctx.measure(id), rows: data }));
  } else {
    const measureId = panel.measures.includes(ctx.state.measure) ? ctx.state.measure : panel.measures[0];
    const def = ctx.measure(measureId);
    const ranks = new Map();
    for (const r of data) ranks.set(r[panel.facet], Math.min(ranks.get(r[panel.facet]) ?? Infinity, Number(r.rank ?? 0)));
    const keys = [...ranks.keys()].sort((p, q) => ranks.get(p) - ranks.get(q) || naturalCompare(p, q));
    const kind = data[0]?.kind;
    facets = keys.map((k) => ({ key: k, title: panel.facet === 'path' ? `#${ranks.get(k)} ${prettyPath(k, kind, ctx)}` : ctx.fieldLabel(k, panel.facet), def, rows: data.filter((r) => r[panel.facet] === k) }));
    measurePicker = select('Measure', panel.measures.map((id) => [id, ctx.measure(id).label]), measureId, (v) => ctx.set({ measure: v }));
  }

  // Lines and wobble per facet, before drawing, so a shared scale can span them.
  const built = facets.map((f) => {
    const defs = [f.def, floorDef].filter(Boolean);
    const cells = aggregate(f.rows, [seriesField, x], defs);
    const at = new Map(cells.map((g) => [`${g.key[seriesField]}|${g.key[x]}`, g]));
    const unit = f.def.format === 'pct' ? 'pp' : '%';
    const lines = visible.map((v) => {
      const raw = xs.map((w) => { const g = at.get(`${v}|${w}`); return g ? { w, val: measureValue(f.def, g), floorVal: floorDef ? measureValue(floorDef, g) : null } : null; });
      const values = raw.map((p) => p?.val ?? null);
      const fullVals = values.filter((x, i) => x !== null && full(xs[i])).sort((p, q) => p - q);
      const base = fullVals.length ? (fullVals.length % 2 ? fullVals[(fullVals.length - 1) / 2] : (fullVals[fullVals.length / 2 - 1] + fullVals[fullVals.length / 2]) / 2) : null;
      const pts = raw.map((p) => (p && p.val !== null && indexed ? { ...p, shown: base ? (p.val / base) * 100 : null } : p ? { ...p, shown: p.val } : null));
      const delta = cIdx >= 0 ? changeOf(values[jIdx], values[cIdx], unit) : null;
      const b = bandFor(values, xs.map(full), jIdx, unit);
      const thin = floorDef ? [jIdx, cIdx].some((i) => i >= 0 && raw[i] && raw[i].floorVal !== null && raw[i].floorVal < panel.floor.min) : false;
      const partialHit = unit === '%' && (!full(judgedW) || (cmpW && !full(cmpW)));
      const j = judge({ delta, band: b.band, partial: partialHit, thin });
      return { v, pts, values, raw, base, delta, b, j, unit };
    });
    return { f, lines, unit };
  });
  const allShown = built.flatMap((bf) => bf.lines.flatMap((l) => l.pts.filter((p) => p && p.shown !== null).map((p) => p.shown)));
  const scaleOf = (vals, fmt) => {
    let lo = Math.min(...vals); let hi = Math.max(...vals);
    if (!vals.length) { lo = 0; hi = 1; }
    if (lo === hi) { lo -= Math.abs(lo) * 0.1 || 1; hi += Math.abs(hi) * 0.1 || 1; }
    const pad = (hi - lo) * 0.08; lo -= pad; hi += pad;
    if (fmt === 'int' && !indexed) lo = Math.min(0, lo);
    if (vals.every((v) => v >= 0)) lo = Math.max(0, lo);
    return [lo, hi];
  };
  const sameFormat = new Set(facets.map((f) => f.def.format)).size === 1;
  const sharedScale = shared && sameFormat ? scaleOf(allShown, facets[0]?.def.format) : null;

  const legend = h('div', { class: 'tl-legend' }, seriesVals.map((v) => h('button', {
    type: 'button',
    class: `tl-chip${hidden.has(String(v)) ? ' off' : ''}`,
    onclick: () => {
      const next = new Set(hidden);
      if (next.has(String(v))) next.delete(String(v)); else next.add(String(v));
      ctx.set({ hidden: [...next] });
    },
  }, h('i', { style: `background:${colorOf.get(v)}` }), nameOf(v))));

  const W = 340; const H = 170; const L = 54; const R = 12; const T = 12; const B = 24;
  const sx = (i) => L + (xs.length === 1 ? (W - L - R) / 2 : (i / (xs.length - 1)) * (W - L - R));
  const fullFlags = xs.map(full);
  // The hover card for one moved line: its values, band, volume and the other lines in the same chart.
  const wobbleOf = (f, lines, m) => ({
    id: `${panel.id}|${f.key}|${m.v}|${judgedW}|${cmpW}`,
    name: nameOf(m.v), color: colorOf.get(m.v), chart: f.title, measure: f.def.label, fmt: f.def.format, unit: m.unit,
    weeks: xs, values: m.values, idx: jIdx, cIdx, full: fullFlags, delta: m.delta, band: m.b.band, median: m.b.median, n: m.b.n,
    volume: floorDef ? { label: floorDef.label, values: m.raw.map((p) => p?.floorVal ?? null) } : null,
    others: lines.filter((o) => o !== m).map((o) => ({ name: nameOf(o.v), values: o.values, delta: o.delta, badge: o.j.badge })),
    weekLabel: (w) => ctx.fieldLabel(w, x), currency: ctx.currency, log: ctx.log,
  });
  const movedAll = [];
  for (const { f, lines } of built) {
    for (const m of lines.filter((l) => l.j.badge === 'moved' && l.v !== OTHER)) movedAll.push({ facet: f.title, card: wobbleOf(f, lines, m), ...m });
  }
  movedAll.sort((p, q) => Math.abs(q.delta) / q.b.band - Math.abs(p.delta) / p.b.band);
  const firstW = fullXs[0];
  const slopeCard = ({ f, lines }) => {
    const a = xs.indexOf(firstW); const z = jIdx;
    const vals = lines.flatMap((l) => [l.values[a], l.values[z]]).filter((x) => x !== null && x !== undefined);
    const [lo, hi] = scaleOf(vals, f.def.format);
    const SW = 340; const SH = 190; const X0 = 90; const X1 = 250;
    const sy = (val) => 14 + (1 - (val - lo) / (hi - lo)) * (SH - 40);
    const svg = s('svg', { viewBox: `0 0 ${SW} ${SH}`, class: 'tl-svg' });
    svg.append(s('text', { x: X0, y: SH - 6, 'text-anchor': 'middle', class: 'tl-axis' }, ctx.fieldLabel(firstW, x)), s('text', { x: X1, y: SH - 6, 'text-anchor': 'middle', class: 'tl-axis' }, ctx.fieldLabel(judgedW, x)));
    for (const l of lines) {
      const p = l.values[a]; const q = l.values[z];
      if (p === null || q === null || p === undefined || q === undefined) continue;
      const color = colorOf.get(l.v);
      svg.append(s('line', { x1: X0, x2: X1, y1: sy(p), y2: sy(q), stroke: color, 'stroke-width': 2, 'stroke-dasharray': l.v === OTHER ? '4 3' : 'none' }));
      svg.append(s('text', { x: X0 - 6, y: sy(p) + 4, 'text-anchor': 'end', class: 'tl-axis' }, format(p, f.def.format, ctx.currency)));
      const t = s('text', { x: X1 + 6, y: sy(q) + 4, class: 'tl-axis' }, `${nameOf(l.v)} ${format(q, f.def.format, ctx.currency)}`);
      svg.append(t);
    }
    return h('div', { class: 'tl-card' }, h('div', { class: 'tl-title' }, f.title), svg);
  };
  const heatCard = ({ f, lines }) => {
    const unitOf = f.def.format === 'pct' ? 'pp' : '%';
    const body = lines.map((l) => h('tr', {}, h('td', { class: 'label' }, h('i', { class: 'dot', style: `background:${colorOf.get(l.v)}` }), nameOf(l.v)),
      xs.map((w, i) => {
        const val = l.values[i];
        const thin = floorDef && l.raw[i] && l.raw[i].floorVal !== null && l.raw[i].floorVal < panel.floor.min;
        const dist = val === null || l.base === null ? null : changeOf(val, l.base, unitOf);
        const scale = l.b.median ? dist / (2 * l.b.median) : 0;
        const k = Math.max(-1, Math.min(1, scale || 0));
        const bg = dist === null ? 'transparent' : k >= 0 ? `rgba(16,176,104,${(Math.abs(k) * 0.55).toFixed(2)})` : `rgba(217,114,48,${(Math.abs(k) * 0.55).toFixed(2)})`;
        return h('td', { class: `num heat${thin ? ' floor' : ''}${partial.has(w) ? ' partial' : ''}${w === judgedW ? ' judged' : ''}`, style: `background:${bg}`, title: dist === null ? null : `${fmtDelta(dist, unitOf)} from its typical week${thin ? ' · below the floor' : ''}` }, val === null ? '–' : format(val, f.def.format, ctx.currency));
      })));
    return h('div', { class: 'tl-card heat-card' }, h('div', { class: 'tl-title' }, f.title),
      h('table', { class: 'grid heat-grid' }, h('thead', {}, h('tr', {}, h('th', {}), xs.map((w) => h('th', { class: `num${partial.has(w) ? ' partial' : ''}` }, ctx.fieldLabel(w, x))))), h('tbody', {}, body)));
  };
  const lineCard = ({ f, lines }) => {
    const vals = lines.flatMap((l) => l.pts.filter((p) => p && p.shown !== null).map((p) => p.shown));
    const [lo, hi] = sharedScale ?? scaleOf(vals, f.def.format);
    const fmtAxis = (v) => (indexed ? v.toFixed(0) : format(v, f.def.format, ctx.currency));
    const sy = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
    const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'tl-svg' });
    xs.forEach((w, i) => {
      if (partial.has(w)) {
        const half = xs.length > 1 ? (W - L - R) / (xs.length - 1) / 2 : 20;
        svg.append(s('rect', { x: sx(i) - half, y: T, width: half * 2, height: H - T - B, fill: '#f5f5f5' }));
        svg.append(s('text', { x: sx(i), y: T + 10, 'text-anchor': 'middle', class: 'tl-axis' }, 'part week'));
      }
      if (w === judgedW) svg.append(s('rect', { x: sx(i) - 3, y: T, width: 6, height: H - T - B, fill: '#2c5f8a14' }));
    });
    if (isReturning && xs.includes(RETURNING_REDEFINED)) {
      const i = xs.indexOf(RETURNING_REDEFINED);
      const line = s('line', { x1: sx(i), x2: sx(i), y1: T, y2: H - B, stroke: '#d97230', 'stroke-dasharray': '3 3' });
      line.append(s('title', {}, 'Returning means something different from 7 Sep. Do not compare across this week.'));
      svg.append(line, s('text', { x: sx(i) + 3, y: H - B - 4, class: 'tl-axis warn' }, 'returning redefined'));
    }
    for (const fr of [0, 0.5, 1]) {
      const v = lo + fr * (hi - lo); const y = sy(v);
      svg.append(s('line', { x1: L, x2: W - R, y1: y, y2: y, stroke: '#eceef1' }));
      svg.append(s('text', { x: L - 6, y: y + 4, 'text-anchor': 'end', class: 'tl-axis' }, fmtAxis(v)));
    }
    xs.forEach((w, i) => svg.append(s('text', { x: sx(i), y: H - 6, 'text-anchor': 'middle', class: 'tl-axis' }, ctx.fieldLabel(w, x))));
    for (const line of lines) {
      const color = colorOf.get(line.v);
      const pts = line.pts.map((p, i) => (p && p.shown !== null ? [sx(i), sy(p.shown), p] : null)).filter(Boolean);
      if (pts.length > 1) svg.append(s('path', { d: pts.map(([px, py], n) => `${n ? 'L' : 'M'}${px.toFixed(1)},${py.toFixed(1)}`).join(' '), fill: 'none', stroke: color, 'stroke-width': line.v === OTHER ? 1.5 : 2, 'stroke-dasharray': line.v === OTHER ? '4 3' : 'none', 'stroke-linejoin': 'round' }));
      for (const [px, py, p] of pts) {
        const thin = floorDef && p.floorVal !== null && p.floorVal < panel.floor.min;
        const dot = s('circle', { cx: px, cy: py, r: 3, fill: thin ? '#fff' : color, stroke: color, 'stroke-width': 1.5 });
        dot.append(s('title', {}, `${nameOf(line.v)}, week of ${ctx.fieldLabel(p.w, x)}: ${format(p.val, f.def.format, ctx.currency)}${indexed && p.shown !== null ? ` (index ${p.shown.toFixed(0)})` : ''}${floorDef ? ` (${format(p.floorVal, floorDef.format)} ${floorDef.label.toLowerCase()})` : ''}${thin ? ', below the floor' : ''}`));
        svg.append(dot);
      }
    }
    const moved = lines.filter((l) => l.j.badge === 'moved' && l.v !== OTHER).sort((p, q) => Math.abs(q.delta) / q.b.band - Math.abs(p.delta) / p.b.band);
    return h('div', { class: `tl-card${moved.length ? ' has-moved' : ''}` },
      h('div', { class: 'tl-title', title: String(f.key) }, f.title),
      svg,
      h('div', { class: 'tl-movers' }, moved.length ? ['Moved beyond wobble: ', moved.slice(0, 3).map((m, i) => [i ? ' ' : '', wobbleButton(wobbleOf(f, lines, m),
        h('strong', { style: `color:${colorOf.get(m.v)}` }, nameOf(m.v)), ' ', h('span', { class: `delta ${m.delta > 0 ? 'up' : 'down'}` }, fmtDelta(m.delta, m.unit)))])]
        : h('span', { class: 'muted' }, cmpW ? 'Nothing moved beyond its wobble.' : 'No comparison week.')));
  };
  const changedB = built.filter((bf) => bf.lines.some((l) => l.j.badge === 'moved' && l.v !== OTHER));
  const canFilterTl = Boolean(cmpW) && built.length > 1;
  const showAllTl = !canFilterTl || (ctx.state.tlView ?? 'changed') === 'all';
  const shownB = showAllTl ? built : changedB;
  const tlJudged = built.some((bf) => bf.lines.some((l) => l.j.badge === 'moved' || l.j.badge === 'within'));
  const cards = shownB.map(mode === 'heat' ? heatCard : mode === 'slope' ? slopeCard : lineCard);
  const noun = panel.facetMeasures ? 'chart' : panel.facet === 'path' ? 'journey' : 'chart';
  const lead = movedAll.length
    ? h('p', { class: 'lead-block' }, `${movedAll.length} line${movedAll.length === 1 ? '' : 's'} moved beyond ${movedAll.length === 1 ? 'its' : 'their'} own wobble in the week of ${ctx.fieldLabel(judgedW, x)}: `,
      movedAll.slice(0, 4).map((m, i, shown) => {
        const pill = wobbleButton(m.card, h('strong', {}, nameOf(m.v)), ` in ${m.facet} `, h('span', { class: `delta ${m.delta > 0 ? 'up' : 'down'}` }, fmtDelta(m.delta, m.unit)));
        return [i ? ' ' : '', i === shown.length - 1 ? h('span', { class: 'nowrap' }, pill, movedAll.length > 4 ? '' : '.') : pill];
      }), movedAll.length > 4 ? `; and ${movedAll.length - 4} more.` : '')
    : h('p', { class: 'lead-block muted' }, cmpW ? `Nothing here moved beyond its own wobble in the week of ${ctx.fieldLabel(judgedW, x)}.` : 'Pick a comparison week to see what moved.');
  const toggles = h('div', { class: 'toggles' },
    select('Show as', [['lines', 'Lines'], ['slope', 'Slope (first whole week → this week)'], ['heat', 'Heat (distance from typical)']], mode, (val) => ctx.set({ tlMode: val })),
    mode === 'lines' ? h('label', {}, h('input', { type: 'checkbox', checked: shared ? null : 'checked', onchange: (e) => ctx.set({ zoom: e.target.checked }) }), ' Zoom each chart (shapes only — don\'t compare heights)') : null,
    mode === 'lines' ? h('label', {}, h('input', { type: 'checkbox', checked: indexed ? 'checked' : null, onchange: (e) => ctx.set({ index: e.target.checked }) }), ' Index: 100 = the line\'s typical whole week') : null,
    folded || ctx.state.allSeries ? h('label', {}, h('input', { type: 'checkbox', checked: ctx.state.allSeries ? 'checked' : null, onchange: (e) => ctx.set({ allSeries: e.target.checked, hidden: [] }) }), ` Show up to ${panel.maxSeries ?? 8} lines`) : null);
  return [
    h('div', { class: 'view-controls' },
      canFilterTl ? changedToggle({ changed: changedB.length, total: built.length, showAll: showAllTl, title: 'Changed: at least one line in the chart moved beyond its own usual weekly range', onPick: (id) => ctx.set({ tlView: id }) }) : null,
      measurePicker, toggles),
    showAllTl || shownB.length ? lead : null,
    shownB.length ? legend : null,
    shownB.length ? h('div', { class: 'tl-grid' }, cards) : null,
    !showAllTl ? hiddenNote({ changed: changedB.length, total: built.length, noun, empty: tlJudged ? `Nothing moved beyond its wobble in the week of ${ctx.fieldLabel(judgedW, x)}.` : 'Too early to judge changes.', judged: tlJudged, onShowAll: () => ctx.set({ tlView: 'all' }) }) : null,
    h('p', { class: 'foot' }, `One line per ${ctx.fieldLabel(seriesField).toLowerCase()}; the biggest ${topN} by volume, the rest folded into Other. ${sharedScale ? 'All charts share one scale, so heights compare across charts.' : 'Each chart has its own scale.'} ${mode === 'heat' ? 'Cell colour is the distance from that line\'s typical whole week, scaled by its wobble: green above, orange below.' : 'The shaded column is the judged week.'} Click a name to hide or show it.${floorDef ? ` Hollow points have fewer than ${panel.floor.min} ${floorDef.label.toLowerCase()}.` : ''}`),
  ];
}
