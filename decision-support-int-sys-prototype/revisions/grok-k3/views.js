import { bandFor, changeOf, judge, fmtDelta, fmtBand, tooltip, badgeText } from './wobble.js';
import { wobbleHover } from './wobble-card.js';
import { coverageLabel, coverageTitle } from './coverage.js';
import { compareWeek } from './derive.js';
import { ALL, NONE, aggregate, change, distinct, format, measureColumns, measureValue, naturalCompare, totals } from './query.js';
import { findOutliers } from './outliers.js';

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else el.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const SVG = 'http://www.w3.org/2000/svg';
export function s(tag, attrs = {}, ...children) {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  for (const c of children) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

export const PALETTE = ['#2c5f8a', '#c08a3e', '#10b068', '#8a5fb0', '#d97230', '#4a9fb5', '#b05f7a', '#7a8a3e', '#8a8a8a', '#5f6fb0'];

function sparkline(values) {
  const pts = values.map((v, i) => [i, v]).filter(([, v]) => v !== null && v !== undefined);
  if (pts.length < 2) return h('span', { class: 'muted' }, '');
  const w = 84; const ht = 22;
  const lo = Math.min(...pts.map((p) => p[1])); const hi = Math.max(...pts.map((p) => p[1]));
  const sx = (i) => 2 + (i / (values.length - 1)) * (w - 4);
  const sy = (v) => (hi === lo ? ht / 2 : ht - 3 - ((v - lo) / (hi - lo)) * (ht - 6));
  const d = pts.map(([i, v], n) => `${n ? 'L' : 'M'}${sx(i).toFixed(1)},${sy(v).toFixed(1)}`).join(' ');
  const [li, lv] = pts[pts.length - 1];
  return s('svg', { width: w, height: ht, class: 'spark' },
    s('path', { d, fill: 'none', stroke: '#2c5f8a', 'stroke-width': 1.5 }),
    s('circle', { cx: sx(li), cy: sy(lv), r: 2.2, fill: '#2c5f8a' }));
}

function changeCell(c) {
  if (!c) return h('td', { class: 'num muted' }, '–');
  const sign = c.value > 0 ? '+' : '';
  const cls = c.dir > 0 ? 'up' : c.dir < 0 ? 'down' : '';
  return h('td', { class: `num change ${cls}` }, `${sign}${c.value.toFixed(1)}${c.unit === 'pp' ? ' pp' : '%'}`);
}

function measureSelect(panel, ctx, current) {
  if (panel.measures.length < 2) return null;
  return h('label', { class: 'picker' }, h('span', {}, 'Measure'),
    h('select', { onchange: (e) => ctx.set({ measure: e.target.value }) },
      panel.measures.map((id) => h('option', { value: id, selected: id === current ? 'selected' : null }, ctx.measure(id).label))));
}

const RATE_FORMATS = new Set(['pct']);
const median = (xs) => {
  const v = [...xs].sort((a, b) => a - b);
  const n = v.length;
  return n ? (n % 2 ? v[(n - 1) / 2] : (v[n / 2 - 1] + v[n / 2]) / 2) : null;
};

export function weekBadge(j, title) {
  return h('span', { class: `wb ${j.badge}${j.thin ? ' thin' : ''}`, title }, badgeText(j), j.thin ? ' · thin' : '');
}

export function weekly(panel, rows, ctx) {
  const measureId = panel.measures.includes(ctx.state.measure) ? ctx.state.measure : panel.measures[0];
  const def = ctx.measure(measureId);
  const rowField = panel.rows; const colField = panel.columns ?? 'week';
  const isWeek = colField === 'week' || colField === 'dim_week';
  const floorDef = panel.floor ? ctx.measure(panel.floor.measure) : null;
  const mixDef = panel.mix ? ctx.measure(panel.mix) : null;
  const orderDef = ctx.measure(panel.measures[0]);
  const defs = [def, floorDef, mixDef, orderDef].filter(Boolean);
  const minField = panel.rowSort?.field && !panel.rowSort.natural ? panel.rowSort.field : null;

  const cols = distinct(rows, colField).sort((a, b) => naturalCompare(a, b));
  const cells = aggregate(rows, [rowField, colField], defs, minField);
  const colTotals = Object.fromEntries(cols.map((c) => [c, totals(rows.filter((r) => String(r[colField]) === String(c)), defs)]));
  const byRow = new Map();
  for (const g of cells) {
    const rk = g.key[rowField];
    const ent = ctx.entity?.(rowField, rk, g.first);
    if (!byRow.has(rk)) byRow.set(rk, { key: rk, label: ent?.label ?? (panel.rowLabel ? g.first[panel.rowLabel] ?? rk : rk === null || rk === undefined ? '(blank)' : ctx.fieldLabel(rk, rowField)), title: ent?.title ?? String(rk), cells: {}, min: Infinity });
    const entry = byRow.get(rk);
    entry.cells[g.key[colField]] = g;
    entry.min = Math.min(entry.min, g.min);
  }
  const rowTotals = new Map(aggregate(rows, [rowField], [orderDef]).map((g) => [g.key[rowField], measureValue(orderDef, g)]));
  let list = [...byRow.values()];
  if (panel.rowSort?.natural) list.sort((a, b) => naturalCompare(a.label, b.label));
  else if (minField) list.sort((a, b) => a.min - b.min || (rowTotals.get(b.key) ?? 0) - (rowTotals.get(a.key) ?? 0));
  else list.sort((a, b) => (rowTotals.get(b.key) ?? 0) - (rowTotals.get(a.key) ?? 0));
  const hidden = Math.max(0, list.length - (panel.limit ?? 50));
  list = list.slice(0, panel.limit ?? 50);

  const val = (g, c) => measureValue(def, g, colTotals[c]);
  const below = (g) => floorDef && g && (measureValue(floorDef, g) ?? 0) < panel.floor.min;

  // Whole weeks come from the dataset's window, not from volume.
  const cov = isWeek ? ctx.cov(cols.map(String)) : new Map();
  const partial = new Set(cols.filter((c) => isWeek && cov.get(String(c)) && !cov.get(String(c)).full));
  const full = (w) => !partial.has(w);
  const isRate = RATE_FORMATS.has(def.format) || def.format === 'num';
  const unit = isRate && def.format === 'pct' ? 'pp' : '%';
  const fullCols = cols.filter(full);
  const wantWeek = ctx.inheritWeek ? ctx.global?.week : null;
  const judged = isWeek && cols.length > 1 ? (cols.includes(wantWeek) ? wantWeek : fullCols[fullCols.length - 1] ?? cols[cols.length - 1]) : cols[cols.length - 1];
  const jIdx = cols.indexOf(judged);
  const cmp = isWeek ? compareWeek(cols, judged, ctx.global?.compare ?? 'prev', full) : cols[cols.length - 2] ?? null;
  const cIdx = cmp ? cols.indexOf(cmp) : -1;
  const scope = ctx.wobble?.bandScope ?? 'self';
  const blankPartial = (c) => partial.has(c) && !isRate;

  // Site-scope band: pooled median of every row's changes before the judged week.
  let siteBand = null;
  if (scope === 'site' && isWeek) {
    const all = [];
    for (const r of list) {
      const vs = cols.map((c) => val(r.cells[c], c));
      for (let i = 1; i < jIdx; i += 1) {
        if (!full(cols[i]) || !full(cols[i - 1])) continue;
        const ch = changeOf(vs[i], vs[i - 1], unit);
        if (ch !== null && Number.isFinite(ch)) all.push(Math.abs(ch));
      }
    }
    const m = all.length >= 3 ? median(all) : null;
    siteBand = { band: m === null ? null : 2 * m, median: m, n: all.length };
  }

  const judgeRow = (values, cellsOf, label) => {
    if (!isWeek || cIdx < 0) return null;
    const delta = changeOf(values[jIdx], values[cIdx], unit);
    const b = siteBand ?? bandFor(values, cols.map(full), jIdx, unit);
    const partialHit = !isRate && (partial.has(judged) || partial.has(cmp));
    const thin = floorDef ? below(cellsOf(judged)) || below(cellsOf(cmp)) : false;
    const j = judge({ delta, band: b.band, partial: partialHit, thin });
    return { delta, ...b, j, scope: siteBand ? 'site' : 'self', tip: tooltip({ label, unit, band: b.band, median: b.median, n: b.n, delta, j, scope: siteBand ? 'site' : 'self' }) };
  };

  const vsRest = isWeek && ctx.contrast && rowField === 'segment_value' ? ctx.contrast.valueChips({ week: judged, compare: cmp, n: 1, measure: measureId }) : null;
  const head = h('tr', {}, h('th', { class: 'label' }, ctx.fieldLabel(rowField)),
    cols.map((c) => {
      const cv = cov.get(String(c));
      const cls = ['num', partial.has(c) ? 'partial' : '', c === judged && isWeek ? 'judged' : '', c === cmp && isWeek ? 'compare' : ''].filter(Boolean).join(' ');
      return h('th', { class: cls, title: partial.has(c) ? coverageTitle(cv, panel.dataset) : c === judged ? 'The week being judged' : c === cmp ? 'The week it is compared with' : null },
        ctx.fieldLabel(c, colField), partial.has(c) ? h('span', { class: 'cov' }, coverageLabel(cv)) : null);
    }),
    h('th', { class: 'num', title: isWeek && cmp ? `Week of ${cmp} → ${judged}` : 'Last column against the one before it' }, 'Change'),
    isWeek ? h('th', {}, 'Wobble') : null,
    vsRest ? h('th', { title: 'This row against everyone else in the same split, judged against the gap\'s own history. Hover a chip to compare.' }, 'Vs rest of split') : null,
    h('th', {}, 'Trend'));

  // The hover card behind each wobble pill. Other rows are filled in once every row is judged.
  const judgedRows = [];
  const pillCard = (name, values, jr, cellsOf, key) => {
    const m = {
      id: `${panel.id}|${measureId}|${key}|${judged}|${cmp}`,
      name, chart: null, measure: def.label, fmt: def.format, unit, color: '#2c5f8a',
      weeks: cols, values, idx: jIdx, cIdx, full: cols.map(full),
      status: jr.j.badge, reason: jr.j.reason, thin: jr.j.thin, delta: jr.delta, band: jr.band, median: jr.median, n: jr.n, scope: jr.scope,
      volume: floorDef ? { label: floorDef.label, values: cols.map((c) => { const g = cellsOf(c); return g ? measureValue(floorDef, g) : null; }) } : null,
      floorText: floorDef ? `under ${panel.floor.min} ${floorDef.label.toLowerCase()}` : null,
      othersNoun: 'rows', wholeLabel: 'the whole table', others: [],
      weekLabel: (w) => ctx.fieldLabel(w, colField), currency: ctx.currency, log: ctx.log,
    };
    if (key !== '__total') judgedRows.push({ key, m });
    return m;
  };
  const pill = (m, jr) => wobbleHover(weekBadge(jr.j, null), m);

  const drill = panel.drill;
  const bodyRows = list.map((r) => {
    const values = cols.map((c) => val(r.cells[c], c));
    const jr = judgeRow(values, (c) => r.cells[c], `${r.label} ${def.label.toLowerCase()}`);
    const last = values.length - 1;
    const fallback = !isWeek && last > 0 ? change(values[last], values[last - 1], def.format) : null;
    const labelCell = drill
      ? h('td', { class: 'label drillable', title: `${r.title} — open ${drill.text ?? 'details'}` }, h('a', { href: '#', onclick: (e) => { e.preventDefault(); const carried = Object.fromEntries((drill.carry ?? []).map((f) => [f, ctx.pickers?.find((p) => p.field === f)?.value]).filter(([, x]) => x !== undefined)); ctx.drill({ ...drill, pickers: { ...(drill.pickers ?? {}), ...carried, [drill.picker]: r.key }, label: `${r.label}` }); } }, narrowUrl(String(r.label), ctx)))
      : h('td', { class: 'label', title: r.title }, narrowUrl(String(r.label), ctx));
    return h('tr', { class: ctx.state.highlight !== undefined && String(ctx.state.highlight) === String(r.key) ? 'hl' : null },
      labelCell,
      cols.map((c, i) => h('td', { class: `num${below(r.cells[c]) ? ' floor' : ''}${c === judged && isWeek ? ' judged' : ''}${partial.has(c) ? ' partial' : ''}`, title: blankPartial(c) ? 'Part week: not comparable with whole weeks' : below(r.cells[c]) ? `Below the floor of ${panel.floor.min} ${floorDef.label.toLowerCase()}` : null },
        blankPartial(c) && cols.length > 1 ? '—' : format(values[i], def.format, ctx.currency))),
      jr ? h('td', { class: `num change ${jr.delta > 0 ? 'up' : jr.delta < 0 ? 'down' : ''}` }, fmtDelta(jr.delta, unit)) : changeCell(fallback),
      isWeek ? h('td', {}, jr ? pill(pillCard(String(r.label), values, jr, (c) => r.cells[c], r.key), jr) : '') : null,
      vsRest ? h('td', { class: 'ctr-td' }, vsRest(r.key)) : null,
      h('td', {}, sparkline(values.map((v, i) => (blankPartial(cols[i]) ? null : v)))));
  });

  if (panel.total && byRow.size > 1) {
    const tg = Object.fromEntries(cols.map((c) => [c, { sums: colTotals[c], count: 0 }]));
    const values = cols.map((c) => (def.share ? 1 : measureValue(def, tg[c], colTotals[c])));
    const jr = def.share ? null : judgeRow(values, () => null, `Total ${def.label.toLowerCase()}`);
    const last = values.length - 1;
    bodyRows.push(h('tr', { class: 'total' }, h('td', { class: 'label' }, 'Total'),
      values.map((v, i) => h('td', { class: `num${cols[i] === judged && isWeek ? ' judged' : ''}` }, blankPartial(cols[i]) && cols.length > 1 ? '—' : format(v, def.format, ctx.currency))),
      jr ? h('td', { class: `num change ${jr.delta > 0 ? 'up' : jr.delta < 0 ? 'down' : ''}` }, fmtDelta(jr.delta, unit)) : changeCell(!isWeek && last > 0 ? change(values[last], values[last - 1], def.format) : null),
      isWeek ? h('td', {}, jr ? pill(pillCard('Total', values, jr, () => null, '__total'), jr) : '') : null,
      vsRest ? h('td', {}) : null,
      h('td', {}, sparkline(values.map((v, i) => (blankPartial(cols[i]) ? null : v))))));
  }

  const rowSummaries = judgedRows.map(({ key, m }) => ({ key, name: m.name, delta: m.delta, badge: m.status }));
  for (const { key, m } of judgedRows) m.others = rowSummaries.filter((o) => o.key !== key);
  const out = [
    h('div', { class: 'view-controls' }, measureSelect(panel, ctx, measureId)),
    vsRest ? ctx.contrast.strip({ week: judged, compare: cmp }) : null,
    h('div', { class: 'scroll' }, h('table', { class: 'grid' }, h('thead', {}, head), h('tbody', {}, bodyRows))),
  ];
  const notes = [];
  if (isWeek && cmp) notes.push(`Change is the week of ${ctx.fieldLabel(judged, colField)} against ${ctx.fieldLabel(cmp, colField)}; the badge compares it with ${siteBand ? 'the pooled weekly wobble of all rows' : 'each row\'s own weekly wobble'} (${unit === 'pp' ? 'points' : 'percent'})`);
  if (isWeek && !cmp) notes.push('No comparison week, so no wobble badges');
  if (hidden) notes.push(`${hidden} more rows not shown`);
  if (partial.size) notes.push(isRate ? 'part weeks are marked with the days they cover; their rates still read fine' : 'part weeks show —, because their totals are not comparable with whole weeks; switch to a rate to read them');
  if (floorDef) notes.push(`grey cells have fewer than ${panel.floor.min} ${floorDef.label.toLowerCase()}; their badges say thin`);
  if (notes.length) out.push(h('p', { class: 'foot' }, `${notes.join('. ')}.`));
  if (mixDef && byRow.size > 1) out.push(mixStrip(list, cols.filter(full), mixDef, colTotals, ctx));
  return out;
}


function mixStrip(list, cols, def, colTotals, ctx) {
  const share = (r, c) => {
    const g = r.cells[c];
    const tot = colTotals[c][def.sum];
    return g && tot ? g.sums[def.sum] / tot : 0;
  };
  const bars = cols.map((c) => h('div', { class: 'mix-col' },
    h('div', { class: 'mix-bar' }, list.map((r, i) => {
      const v = share(r, c);
      return v > 0 ? h('span', { style: `width:${(v * 100).toFixed(2)}%;background:${PALETTE[i % PALETTE.length]}`, title: `${r.label}: ${format(v, 'pct')}` }) : null;
    })),
    h('div', { class: 'mix-label' }, ctx.fieldLabel(c, 'week'))));
  const legend = h('div', { class: 'legend' }, list.slice(0, PALETTE.length).map((r, i) => h('span', {},
    h('i', { style: `background:${PALETTE[i]}` }), String(r.label))));
  return h('div', { class: 'mix' }, h('h4', {}, `Mix: ${def.label.toLowerCase()} by week`), bars, legend);
}

function rowOrderIndex(panel) {
  if (!panel.rowOrder) return null;
  const idx = new Map(panel.rowOrder.order.map((v, i) => [String(v), i]));
  return (g) => idx.get(String(g.key[panel.rowOrder.field] ?? g[panel.rowOrder.field])) ?? 999;
}

export function table(panel, rows, ctx) {
  if (panel.show && !panel.measures) return rawTable(panel, rows, ctx);
  const opts = panel.groupByOptions ?? [];
  const groupOpt = opts.includes(ctx.state.groupBy) ? ctx.state.groupBy : opts[0];
  const keys = [...(panel.groupBy ?? [])];
  if (groupOpt && groupOpt !== NONE && !keys.includes(groupOpt)) keys.push(groupOpt);
  const defs = panel.measures.map((id) => ctx.measure(id));
  const floorDef = panel.floor ? ctx.measure(panel.floor.measure) : null;
  const hl = panel.highlight;
  const hlDefs = hl ? [ctx.measure(hl.measure), hl.whenAtLeast && ctx.measure(hl.whenAtLeast.measure)] : [];
  const ocfg = panel.outliers;
  const oDefs = ocfg ? [ocfg.volume, ocfg.rate, ocfg.value, ocfg.count].filter(Boolean).map((id) => ctx.measure(id)) : [];
  const allDefs = [...defs, floorDef, ...hlDefs, ...oDefs].filter(Boolean);
  const groups = aggregate(rows, keys, allDefs);
  const shareTotals = totals(rows, allDefs);

  const sort = ctx.state.sort ?? (panel.sort ? { key: panel.sort.measure ?? panel.sort.field, dir: panel.sort.dir } : null);
  const ordered = rowOrderIndex(panel);
  const keyOf = (g, k) => (panel.measures.includes(k) ? measureValue(ctx.measure(k), g, shareTotals) : g.key[k]);
  if (sort) {
    groups.sort((a, b) => {
      const va = keyOf(a, sort.key); const vb = keyOf(b, sort.key);
      const cmp = typeof va === 'number' && typeof vb === 'number' ? va - vb : naturalCompare(va, vb);
      return sort.dir === 'asc' ? cmp : -cmp;
    });
  } else if (ordered) groups.sort((a, b) => ordered(a) - ordered(b));
  else groups.sort((a, b) => naturalCompare(keys.map((k) => a.key[k]).join(' '), keys.map((k) => b.key[k]).join(' ')));

  const isFlagged = (g) => hl && measureValue(hlDefs[0], g) === hl.equals
    && (!hl.whenAtLeast || (measureValue(hlDefs[1], g) ?? 0) >= hl.whenAtLeast.min);
  const flags = ocfg ? outlierFlags(panel, groups, keys, ctx) : null;
  const showAll = !flags || (ctx.state.outlierView ?? ocfg.default ?? 'outliers') === 'all';
  const visible = showAll ? groups : groups.filter((g) => flags.has(g));
  const limit = panel.limit ?? 200;
  const shown = visible.slice(0, limit);
  const sortHeader = (k, label, num) => {
    const active = sort?.key === k;
    const arrow = active ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : '';
    return h('th', {
      class: `${num ? 'num' : 'label'} sortable${active ? ' active' : ''}`,
      onclick: () => ctx.set({ sort: { key: k, dir: active && sort.dir === 'desc' ? 'asc' : 'desc' } }),
    }, label + arrow);
  };
  const below = (g) => floorDef && (measureValue(floorDef, g) ?? 0) < panel.floor.min;

  const head = h('tr', {}, keys.map((k) => sortHeader(k, ctx.fieldLabel(k), false)),
    flags ? h('th', { class: 'label' }, 'Why it stands out') : null,
    defs.map((d, i) => sortHeader(panel.measures[i], d.label, true)));
  const body = shown.map((g) => h('tr', { class: `${below(g) ? 'floor' : ''}${isFlagged(g) ? ' flagged' : ''}` },
    keys.map((k, i) => { const ent = ctx.entity?.(k, g.key[k], g.first); return h('td', { class: 'label', title: ent?.title ?? String(g.key[k] ?? '') },
      g.key[k] === null || g.key[k] === undefined || g.key[k] === '' ? h('span', { class: 'muted' }, '(blank)') : narrowUrl(ent?.label ?? ctx.fieldLabel(g.key[k], k), ctx),
      !flags && i === keys.length - 1 && isFlagged(g) ? h('span', { class: 'badge warn' }, hl.label) : null); }),
    flags ? h('td', { class: 'why' }, (flags.get(g) ?? []).map((r) => outlierBadge(r, panel, ctx, flags.history))) : null,
    defs.map((d) => h('td', { class: 'num' }, format(measureValue(d, g, shareTotals), d.format, ctx.currency)))));
  if (flags && !showAll && !shown.length) {
    body.push(h('tr', {}, h('td', { class: 'empty-note', colspan: keys.length + defs.length + 1 }, 'Nothing stands out in this selection. ',
      h('a', { href: '#', onclick: (e) => { e.preventDefault(); ctx.set({ outlierView: 'all' }); } }, `Show all ${groups.length}`))));
  }

  const controls = opts.length ? h('label', { class: 'picker' }, h('span', {}, 'Group by'),
    h('select', { onchange: (e) => ctx.set({ groupBy: e.target.value, sort: undefined }) },
      opts.map((o) => h('option', { value: o, selected: o === groupOpt ? 'selected' : null }, o === NONE ? 'Nothing more' : ctx.fieldLabel(o))))) : null;
  const notes = flags
    ? [showAll ? `${groups.length.toLocaleString()} groups, ${flags.size} stand out` : `${flags.size} of ${groups.length.toLocaleString()} groups stand out`]
    : [`${groups.length.toLocaleString()} groups`];
  if (visible.length > limit) notes.push(`showing the first ${limit}`);
  if (floorDef) notes.push(`greyed rows have fewer than ${panel.floor.min} ${floorDef.label.toLowerCase()}`);
  const toggle = flags ? h('div', { class: 'seg-toggle', role: 'group', 'aria-label': 'Rows to show' },
    [['outliers', `Outliers (${flags.size})`], ['all', `All (${groups.length})`]].map(([id, label]) => h('button', {
      type: 'button', class: (showAll ? 'all' : 'outliers') === id ? 'on' : null, 'aria-pressed': String((showAll ? 'all' : 'outliers') === id),
      onclick: () => ctx.set({ outlierView: id }),
    }, label))) : null;
  return [
    h('div', { class: 'view-controls' }, toggle, controls),
    h('div', { class: 'scroll' }, h('table', { class: 'grid' }, h('thead', {}, head), h('tbody', {}, body))),
    h('p', { class: 'foot' }, `${notes.join(', ')}.`),
    flags ? h('p', { class: 'foot' }, outlierRuleText(panel, ctx, flags.history)) : null,
  ];
}

// Rows that stand out, judged in the current selection. A single picked week also checks each row against its own past weeks.
function outlierFlags(panel, groups, keys, ctx) {
  const cfg = panel.outliers;
  const weekP = ctx.pickers?.find((p) => p.field === (cfg.week ?? 'week'));
  let history = null;
  if (cfg.history !== false && weekP && weekP.value !== ALL && ctx.baseRows) {
    const others = (ctx.pickers ?? []).filter((p) => p !== weekP && p.value !== undefined && p.value !== ALL);
    const histRows = ctx.baseRows.filter((r) => others.every((p) => String(r[p.field]) === String(p.value)));
    const weeks = [...new Set(histRows.map((r) => r[weekP.field]))].filter(Boolean).sort();
    const cov = ctx.cov(weeks.map(String));
    const full = (w) => cov.get(String(w))?.full ?? false;
    history = { rows: histRows, weekField: weekP.field, week: weekP.value, compare: compareWeek(weeks, weekP.value, ctx.global?.compare ?? 'prev', full), full };
  }
  const flags = findOutliers({ groups, keys, cfg, measure: ctx.measure, floorMin: panel.floor?.min ?? 0, history });
  flags.history = history;
  return flags;
}

function outlierBadge(r, panel, ctx, history) {
  const cfg = panel.outliers;
  const vol = ctx.measure(cfg.volume); const rate = ctx.measure(cfg.rate); const val = ctx.measure(cfg.value);
  const f = (v, d) => format(v, d.format, ctx.currency);
  const wk = (w) => ctx.fieldLabel(w, 'week');
  const cmp = history?.compare ? wk(history.compare) : null;
  switch (r.kind) {
    case 'high':
    case 'low':
      return h('span', { class: `ob ${r.kind === 'high' ? 'good' : 'bad'}`, title: `${val.label} ${f(r.value, val)}; a typical row in this table earns ${f(r.typical, val)}, and most sit within ×${r.spread.toFixed(1)} of that. This one is ${Math.abs(r.away).toFixed(1)} of those spreads ${r.away > 0 ? 'above' : 'below'}. ${rate.label} ${f(r.rate, rate)} against ${f(r.restRate, rate)} for the rest (z = ${r.z.toFixed(1)}).` },
        `${val.label} ${r.times >= 10 ? Math.round(r.times) : r.times.toFixed(1)}× typical`);
    case 'none':
      return h('span', { class: 'ob bad', title: `At the rest of the table's rate it would have had about ${Math.round(r.expected)} ${r.label.toLowerCase()}. Zero is very unlikely to be chance.` }, `No ${r.label.toLowerCase()} (≈${Math.round(r.expected)} expected)`);
    case 'new':
      return h('span', { class: 'ob new', title: `No ${vol.label.toLowerCase()} in the ${r.earlierWeeks} earlier week${r.earlierWeeks === 1 ? '' : 's'} of this data.` }, 'New this week');
    case 'jump':
    case 'drop':
      return h('span', { class: `ob ${r.kind === 'jump' ? 'good' : 'bad'}`, title: `${f(r.prev, vol)} → ${f(r.cur, vol)}. Its usual weekly change is ${fmtBand(r.band, '%')} (twice the median of ${r.n} whole-week changes).` },
        `${vol.label} ${fmtDelta(r.delta, '%', 0)}${cmp ? ` vs ${cmp}` : ''}`);
    default:
      return h('span', { class: `ob ${r.kind === 'valueup' ? 'good' : 'bad'}`, title: `${f(r.prev, val)} → ${f(r.cur, val)}. Its usual weekly change is ${fmtBand(r.band, '%')} (twice the median of ${r.n} whole-week changes).` },
        `${val.label} ${fmtDelta(r.delta, '%', 0)}`);
  }
}

function outlierRuleText(panel, ctx, history) {
  const cfg = panel.outliers;
  const val = ctx.measure(cfg.value).label.toLowerCase();
  const parts = [`A row stands out when its ${val} is far from a typical row's (more than ${cfg.spread ?? 2} times the usual spread, on a log scale) and its ${ctx.measure(cfg.rate).label.toLowerCase()} clearly differs from the rest (z ≥ ${cfg.z ?? 3})`];
  if (cfg.count) parts.push(`it has no ${ctx.measure(cfg.count).label.toLowerCase()} where the rest's rate predicts at least ${cfg.expectZero ?? 7}`);
  const mat = `${((cfg.material ?? 0.005) * 100).toLocaleString()}%`;
  if (history) parts.push(history.compare ? `its ${ctx.measure(cfg.volume).label.toLowerCase()} or ${val} moved against ${ctx.fieldLabel(history.compare, 'week')} by more than its own usual weekly wobble, and by at least ${mat} of the table's ${ctx.measure(cfg.volume).label.toLowerCase()} or revenue` : 'there is no comparison week, so moves are not checked');
  if (history) parts.push(`it is new this week with at least ${mat} of the table's ${ctx.measure(cfg.volume).label.toLowerCase()}`);
  const tail = panel.floor ? ` Rows under ${panel.floor.min} ${ctx.measure(panel.floor.measure).label.toLowerCase()} never stand out.` : '';
  return `${parts.slice(0, -1).join(', ')}${parts.length > 1 ? ', or ' : ''}${parts[parts.length - 1]}.${tail}`;
}

function rawTable(panel, rows, ctx) {
  const cols = panel.show;
  const sort = ctx.state.sort ?? (panel.sort ? { key: panel.sort.field, dir: panel.sort.dir } : null);
  const list = [...rows];
  if (sort) {
    list.sort((a, b) => {
      const va = a[sort.key]; const vb = b[sort.key];
      const cmp = typeof va === 'number' && typeof vb === 'number' ? va - vb : naturalCompare(va, vb);
      return sort.dir === 'asc' ? cmp : -cmp;
    });
  }
  const limit = panel.limit ?? 200;
  const fmt = panel.formats ?? {};
  const head = h('tr', {}, cols.map((c) => {
    const active = sort?.key === c;
    return h('th', {
      class: `${fmt[c] ? 'num' : 'label'} sortable${active ? ' active' : ''}`,
      onclick: () => ctx.set({ sort: { key: c, dir: active && sort.dir === 'desc' ? 'asc' : 'desc' } }),
    }, ctx.fieldLabel(c) + (active ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''));
  }));
  const body = list.slice(0, limit).map((r) => h('tr', {}, cols.map((c) => { const ent = fmt[c] ? null : ctx.entity?.(c, r[c], r); return h('td', { class: fmt[c] ? 'num' : 'label wrap', title: fmt[c] ? null : ent?.title ?? String(r[c] ?? '') },
    ent ? ent.label : fmt[c] ? format(r[c], fmt[c], ctx.currency) : narrowUrl(format(r[c], 'text', ctx.currency), ctx)); })));
  return [
    h('div', { class: 'scroll' }, h('table', { class: 'grid' }, h('thead', {}, head), h('tbody', {}, body))),
    h('p', { class: 'foot' }, `${list.length.toLocaleString()} rows${list.length > limit ? `, showing the first ${limit}` : ''}.`),
  ];
}

// Some sources store URLs with JSON-escaped slashes. On a phone the host eats the cell; the full URL stays in the cell's title.
function narrowUrl(text, ctx) {
  if (typeof text !== 'string' || !/^https?:/.test(text)) return text;
  const url = text.replace(/\\\//g, '/');
  return ctx.width < 560 ? url.replace(/^https?:\/\/[^/]+/, '') || '/' : url;
}

export function series(panel, rows, ctx) {
  const measureId = panel.measures.includes(ctx.state.measure) ? ctx.state.measure : panel.measures[0];
  const def = ctx.measure(measureId);
  const groups = aggregate(rows, [panel.x], [def]).sort((a, b) => naturalCompare(a.key[panel.x], b.key[panel.x]));
  const shareTotals = totals(rows, [def]);
  const pts = groups.map((g) => ({ x: g.key[panel.x], v: measureValue(def, g, shareTotals) }));
  const W = Math.round(Math.max(300, Math.min(960, ctx.width ?? 960))); const H = 240; const L = W < 560 ? 52 : 70; const B = 40; const T = 12;
  const max = Math.max(0, ...pts.map((p) => p.v ?? 0)) || 1;
  const bw = (W - L - 8) / Math.max(1, pts.length);
  const step = Math.ceil(pts.length / Math.max(4, Math.min(16, Math.floor((W - L) / 48))));
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'series', preserveAspectRatio: 'none' });
  for (const f of [0, 0.5, 1]) {
    const y = T + (1 - f) * (H - T - B);
    svg.append(s('line', { x1: L, x2: W, y1: y, y2: y, stroke: '#e6e6e6' }));
    svg.append(s('text', { x: L - 6, y: y + 4, 'text-anchor': 'end', class: 'axis' }, format(max * f, def.format, ctx.currency)));
  }
  pts.forEach((p, i) => {
    const hgt = ((p.v ?? 0) / max) * (H - T - B);
    const x = L + i * bw;
    const bar = s('rect', { x: x + bw * 0.12, y: H - B - hgt, width: bw * 0.76, height: Math.max(0, hgt), fill: '#2c5f8a', class: 'bar' });
    bar.append(s('title', {}, `${p.x}: ${format(p.v, def.format, ctx.currency)}`));
    svg.append(bar);
    if (i % step === 0) svg.append(s('text', { x: x + bw / 2, y: H - B + 16, 'text-anchor': 'middle', class: 'axis' }, String(p.x).replace(/^\d{4}-/, '')));
  });
  const vals = pts.map((p) => p.v).filter((v) => v !== null);
  const hi = pts.reduce((a, p) => ((p.v ?? -Infinity) > (a?.v ?? -Infinity) ? p : a), null);
  const lo = pts.reduce((a, p) => ((p.v ?? Infinity) < (a?.v ?? Infinity) ? p : a), null);
  return [
    h('div', { class: 'view-controls' }, measureSelect(panel, ctx, measureId)),
    h('div', { class: 'chart' }, svg),
    vals.length ? h('p', { class: 'foot' }, `${pts.length} points. Highest ${hi.x} at ${format(hi.v, def.format, ctx.currency)}; lowest ${lo.x} at ${format(lo.v, def.format, ctx.currency)}.`) : null,
  ];
}

export function cards(panel, rows, ctx) {
  const field = panel.groupBy;
  const present = distinct(rows, field).map(String);
  const order = [...(panel.groupOrder ?? []).filter((g) => present.includes(g)), ...present.filter((g) => !(panel.groupOrder ?? []).includes(g))];
  const perCol = panel.perColumn ?? 40;
  const cols = order.map((g) => {
    const items = rows.filter((r) => String(r[field]) === g);
    return h('div', { class: `card-col state-${g}` },
      h('h4', {}, g.replace(/_/g, ' '), h('span', { class: 'count' }, items.length)),
      items.slice(0, perCol).map((r) => h('div', { class: 'card' },
        h('div', { class: 'card-title' }, String(r[panel.cardTitle] ?? '')),
        r[panel.cardSubtitle] ? h('div', { class: 'card-sub' }, String(r[panel.cardSubtitle])) : null,
        h('dl', {}, (panel.cardFields ?? []).filter((f) => r[f] !== null && r[f] !== undefined && r[f] !== '').map((f) => [
          h('dt', {}, ctx.fieldLabel(f)), h('dd', {}, format(r[f], typeof r[f] === 'number' ? 'num' : 'text', ctx.currency)),
        ])))),
      items.length > perCol ? h('p', { class: 'foot' }, `${items.length - perCol} more`) : null);
  });
  return [h('div', { class: 'board' }, cols)];
}
