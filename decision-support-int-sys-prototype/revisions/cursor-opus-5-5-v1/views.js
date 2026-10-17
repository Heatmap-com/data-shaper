import { partialTip } from './coverage.js';
import { classify } from './noise.js';
import { NONE, aggregate, change, distinct, format, measureColumns, measureValue, naturalCompare, priorWeeks, totals } from './query.js';

const NOISE_TEXT = { unusual: 'unusual', slide: 'sliding', climb: 'climbing', normal: 'normal', thin: '–', partial: 'partial' };

export function noiseBadge(result, { note = '' } = {}) {
  if (!result) return null;
  const title = [result.reason, note].filter(Boolean).join(' ');
  return h('span', { class: `noise ${result.label}`, title }, NOISE_TEXT[result.label] ?? result.label);
}

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

function changeCell(c, extra) {
  if (!c) return h('td', { class: 'num muted' }, '–', extra ?? null);
  const sign = c.value > 0 ? '+' : '';
  const cls = c.dir > 0 ? 'up' : c.dir < 0 ? 'down' : '';
  return h('td', { class: `num change ${cls}` }, `${sign}${c.value.toFixed(1)}${c.unit === 'pp' ? ' pp' : '%'}`, extra ?? null);
}

function armLabels(rows) {
  const control = new Map();
  for (const r of rows) {
    if (r.arm == null) continue;
    const key = String(r.arm);
    if (!control.has(key)) control.set(key, r.is_control === 1 || r.is_control === true);
  }
  if (!control.size) return null;
  const variants = [...control.entries()].filter(([, isControl]) => !isControl).map(([key]) => key).sort(naturalCompare);
  const labels = new Map();
  for (const [arm, isControl] of control) labels.set(arm, isControl ? 'Control' : `Variant ${variants.indexOf(arm) + 1}`);
  return labels;
}

function measureSelect(panel, ctx, current) {
  if (panel.measures.length < 2) return null;
  return h('label', { class: 'picker' }, h('span', {}, 'Measure'),
    h('select', { onchange: (e) => ctx.set({ measure: e.target.value }) },
      panel.measures.map((id) => h('option', { value: id, selected: id === current ? 'selected' : null }, ctx.measure(id).label))));
}

export function weekly(panel, rows, ctx) {
  const measureId = panel.measures.includes(ctx.state.measure) ? ctx.state.measure : panel.measures[0];
  const def = ctx.measure(measureId);
  const rowField = panel.rows; const colField = panel.columns ?? 'week';
  const floorDef = panel.floor ? ctx.measure(panel.floor.measure) : null;
  const mixDef = panel.mix ? ctx.measure(panel.mix) : null;
  const orderDef = ctx.measure(panel.measures[0]);
  const defs = [def, floorDef, mixDef, orderDef].filter(Boolean);
  const minField = panel.rowSort?.field && !panel.rowSort.natural ? panel.rowSort.field : null;

  const cols = distinct(rows, colField);
  const cells = aggregate(rows, [rowField, colField], defs, minField);
  const colTotals = Object.fromEntries(cols.map((c) => [c, totals(rows.filter((r) => String(r[colField]) === String(c)), defs)]));
  const byRow = new Map();
  for (const g of cells) {
    const rk = g.key[rowField];
    if (!byRow.has(rk)) byRow.set(rk, { key: rk, label: panel.rowLabel ? g.first[panel.rowLabel] ?? rk : rk === null || rk === undefined ? '(blank)' : ctx.fieldLabel(rk, rowField), cells: {}, min: Infinity });
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

  const daysOf = (week) => ctx.coverage?.get(String(week));
  const isPartial = (week) => { const days = daysOf(week); return days != null && days < 7; };
  const selected = ctx.weekInherited && cols.includes(ctx.state.week) ? ctx.state.week : cols[cols.length - 1];
  const mode = ctx.weekInherited && ['prev', 'avg4', 'first', 'none'].includes(ctx.state.compare) ? ctx.state.compare : 'prev';
  const cmpWeeks = mode === 'none' ? [] : (ctx.weekInherited ? priorWeeks(cols, selected, mode) : (cols.indexOf(selected) > 0 ? [cols[cols.indexOf(selected) - 1]] : []));
  const sumLike = Boolean(def.sum) && !def.ratio && !def.share;
  const noiseKind = def.ratio && def.format === 'pct' ? 'rate' : def.format === 'money' ? 'money' : 'count';
  const arms = panel.id === 'xp-weekly' ? armLabels(rows) : null;

  const comparedValue = (rowCells) => {
    if (!cmpWeeks.length) return null;
    if (def.ratio) {
      const num = cmpWeeks.reduce((s, w) => s + (rowCells[w]?.sums[def.ratio[0]] ?? 0), 0);
      const den = cmpWeeks.reduce((s, w) => s + (rowCells[w]?.sums[def.ratio[1]] ?? 0), 0);
      return den ? num / den : null;
    }
    if (def.share) {
      const part = cmpWeeks.reduce((s, w) => s + (rowCells[w]?.sums[def.share] ?? 0), 0);
      const whole = cmpWeeks.reduce((s, w) => s + (colTotals[w]?.[def.share] ?? 0), 0);
      return whole ? part / whole : null;
    }
    if (!def.sum) return null;
    return cmpWeeks.reduce((s, w) => s + (rowCells[w]?.sums[def.sum] ?? 0), 0) / cmpWeeks.length;
  };
  const noiseFor = (rowCells) => {
    const i = cols.indexOf(selected);
    if (i < 1 || def.share) return null;
    const points = cols.map((c) => {
      const g = rowCells[c];
      const days = daysOf(c) ?? 7;
      if (def.ratio) return { week: c, num: g?.sums[def.ratio[0]] ?? 0, den: g?.sums[def.ratio[1]] ?? 0, days };
      return { week: c, value: g ? measureValue(def, g, colTotals[c]) : null, days };
    });
    return classify(points, i, { kind: noiseKind });
  };
  const changeTd = (rowCells, current) => {
    const partialChange = isPartial(selected) || cmpWeeks.some(isPartial);
    const badge = noiseBadge(noiseFor(rowCells), { note: mode !== 'prev' ? 'Label is against the previous week.' : '' });
    if (!cmpWeeks.length) return h('td', { class: 'num muted' }, '–');
    if (sumLike && partialChange) {
      const days = [selected, ...cmpWeeks].map(daysOf).find((d) => d != null && d < 7);
      return h('td', { class: 'num muted', title: partialTip(days ?? 6) }, '–');
    }
    return changeCell(change(current, comparedValue(rowCells), def.format), badge);
  };

  const head = h('tr', {}, h('th', { class: 'label' }, ctx.fieldLabel(rowField)),
    cols.map((c) => {
      const days = daysOf(c);
      const partial = isPartial(c);
      return h('th', {
        class: `num${partial ? ' partial' : ''}${c === selected ? ' ctx-week' : ''}`,
        title: partial ? partialTip(days) : null,
      }, partial ? `${ctx.fieldLabel(c, colField)} · ${days}/7 days` : ctx.fieldLabel(c, colField));
    }),
    h('th', { class: 'num', title: cmpWeeks.length ? 'Against the selected comparison. A sum is left blank when either week is partial.' : 'No comparison' }, 'Change'),
    h('th', {}, 'Trend'));

  const bodyRows = list.map((r) => {
    const values = cols.map((c) => val(r.cells[c], c));
    const shown = arms?.get(String(r.key)) ?? (/^https?:\/\//i.test(String(r.label)) ? ctx.fieldLabel(r.label, rowField) : r.label);
    return h('tr', { class: ctx.highlight != null && String(r.key) === String(ctx.highlight) ? 'ctx-highlight' : '' },
      h('td', { class: 'label', title: String(arms ? r.key : r.label) }, String(shown)),
      cols.map((c, i) => h('td', { class: `num${below(r.cells[c]) ? ' floor' : ''}${c === selected ? ' ctx-week' : ''}`, title: below(r.cells[c]) ? `Below the floor of ${panel.floor.min} ${floorDef.label.toLowerCase()}` : null },
        format(values[i], def.format, ctx.currency))),
      changeTd(r.cells, val(r.cells[selected], selected)),
      h('td', {}, sparkline(values)));
  });

  if (panel.total && byRow.size > 1) {
    const tg = Object.fromEntries(cols.map((c) => [c, { sums: colTotals[c], count: 0 }]));
    const values = cols.map((c) => (def.share ? 1 : measureValue(def, tg[c], colTotals[c])));
    bodyRows.push(h('tr', { class: 'total' }, h('td', { class: 'label' }, 'Total'),
      values.map((v, i) => h('td', { class: `num${cols[i] === selected ? ' ctx-week' : ''}` }, format(v, def.format, ctx.currency))),
      changeTd(tg, def.share ? 1 : measureValue(def, tg[selected], colTotals[selected])),
      h('td', {}, sparkline(values))));
  }

  const out = [
    h('div', { class: 'view-controls' }, measureSelect(panel, ctx, measureId)),
    h('div', { class: 'scroll' }, h('table', { class: 'grid' }, h('thead', {}, head), h('tbody', {}, bodyRows))),
  ];
  const notes = [];
  if (hidden) notes.push(`${hidden} more rows not shown`);
  if (cols.some(isPartial)) notes.push('Weeks marked n/7 days are partial: compare their rates, not their totals');
  if (floorDef) notes.push(`grey cells have fewer than ${panel.floor.min} ${floorDef.label.toLowerCase()}`);
  if (notes.length) out.push(h('p', { class: 'foot' }, `${notes.join('. ')}.`));
  if (mixDef && byRow.size > 1) out.push(mixStrip(list, cols, mixDef, colTotals, ctx));
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
  const allDefs = [...defs, floorDef, ...hlDefs].filter(Boolean);
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

  const limit = panel.limit ?? 200;
  const shown = groups.slice(0, limit);
  const arms = panel.id === 'xp-arms' ? armLabels(rows) : null;
  const sortHeader = (k, label, num) => {
    const active = sort?.key === k;
    const arrow = active ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : '';
    return h('th', {
      class: `${num ? 'num' : 'label'} sortable${active ? ' active' : ''}`,
      onclick: () => ctx.set({ sort: { key: k, dir: active && sort.dir === 'desc' ? 'asc' : 'desc' } }),
    }, label + arrow);
  };
  const isFlagged = (g) => hl && measureValue(hlDefs[0], g) === hl.equals
    && (!hl.whenAtLeast || (measureValue(hlDefs[1], g) ?? 0) >= hl.whenAtLeast.min);
  const below = (g) => floorDef && (measureValue(floorDef, g) ?? 0) < panel.floor.min;

  const head = h('tr', {}, keys.map((k) => sortHeader(k, ctx.fieldLabel(k), false)),
    defs.map((d, i) => sortHeader(panel.measures[i], d.label, true)));
  const body = shown.map((g) => h('tr', { class: `${below(g) ? 'floor' : ''}${isFlagged(g) ? ' flagged' : ''}` },
    keys.map((k, i) => {
      const raw = g.key[k];
      const arm = k === 'arm' ? arms?.get(String(raw)) : null;
      const text = raw === null || raw === undefined || raw === '' ? null : arm ?? (/^https?:\/\//i.test(String(raw)) ? ctx.fieldLabel(raw, k) : String(raw));
      return h('td', { class: 'label', title: String(raw ?? '') },
        text === null ? h('span', { class: 'muted' }, '(blank)') : text,
        i === keys.length - 1 && isFlagged(g) ? h('span', { class: 'badge warn' }, hl.label) : null);
    }),
    defs.map((d) => h('td', { class: 'num' }, format(measureValue(d, g, shareTotals), d.format, ctx.currency)))));

  const controls = opts.length ? h('label', { class: 'picker' }, h('span', {}, 'Group by'),
    h('select', { onchange: (e) => ctx.set({ groupBy: e.target.value, sort: undefined }) },
      opts.map((o) => h('option', { value: o, selected: o === groupOpt ? 'selected' : null }, o === NONE ? 'Nothing more' : ctx.fieldLabel(o))))) : null;
  const notes = [`${groups.length.toLocaleString()} groups`];
  if (groups.length > limit) notes.push(`showing the first ${limit}`);
  if (floorDef) notes.push(`greyed rows have fewer than ${panel.floor.min} ${floorDef.label.toLowerCase()}`);
  return [
    h('div', { class: 'view-controls' }, controls),
    h('div', { class: 'scroll' }, h('table', { class: 'grid' }, h('thead', {}, head), h('tbody', {}, body))),
    h('p', { class: 'foot' }, `${notes.join(', ')}.`),
  ];
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
  const body = list.slice(0, limit).map((r) => h('tr', {}, cols.map((c) => h('td', { class: fmt[c] ? 'num' : 'label wrap', title: fmt[c] ? null : String(r[c] ?? '') },
    format(r[c], fmt[c] ?? 'text', ctx.currency)))));
  return [
    h('div', { class: 'scroll' }, h('table', { class: 'grid' }, h('thead', {}, head), h('tbody', {}, body))),
    h('p', { class: 'foot' }, `${list.length.toLocaleString()} rows${list.length > limit ? `, showing the first ${limit}` : ''}.`),
  ];
}

export function series(panel, rows, ctx) {
  const measureId = panel.measures.includes(ctx.state.measure) ? ctx.state.measure : panel.measures[0];
  const def = ctx.measure(measureId);
  const groups = aggregate(rows, [panel.x], [def]).sort((a, b) => naturalCompare(a.key[panel.x], b.key[panel.x]));
  const shareTotals = totals(rows, [def]);
  const pts = groups.map((g) => ({ x: g.key[panel.x], v: measureValue(def, g, shareTotals) }));
  const W = 960; const H = 240; const L = 70; const B = 40; const T = 12;
  const max = Math.max(0, ...pts.map((p) => p.v ?? 0)) || 1;
  const bw = (W - L - 8) / Math.max(1, pts.length);
  const step = Math.ceil(pts.length / 16);
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
