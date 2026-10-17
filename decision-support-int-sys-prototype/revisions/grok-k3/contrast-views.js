// Segment contrast chips, the shared hover card, the pin tray, the strip and the playground grid.
// Everything is computed once per scope and cached, so hovering only builds a card from numbers already in memory.
import { h, s } from './views.js';
import { hoverCard, hideCard, pinCard } from './hovercard.js';
import { ALL, format } from './query.js';
import { BAND, fmtBand, fmtDelta } from './wobble.js';
import { compareWeek } from './derive.js';
import { contrasts, headline, KIND_TEXT, CONTRAST_GROUPS, CONTRAST_MEASURES, CONTRAST_FLOOR, ALWAYS_REL, ERA_BREAK } from './contrast.js';

export const GROUP_LABEL = { traffic_source: 'traffic source', returning: 'new vs returning', device: 'device' };
const SHORT = { order_rate: 'order rate', rps: 'revenue/session', step_pv: 'viewed a product', step_cart: 'view → cart', step_checkout: 'cart → checkout', step_buy: 'checkout → bought' };
const KIND_SHORT = { pulled: 'pulled away', own: 'changed alone', with: 'moved with all', inline: 'in line', cantsay: "can't say" };
const STEP_MEASURE = ['order_rate', 'step_pv', 'step_cart', 'step_checkout', 'step_buy'];
const WEEKLY_MEASURE = { cvr: 'order_rate', rps: 'rps', step_pv: 'step_pv', step_cart: 'step_cart', step_checkout: 'step_checkout', step_buy: 'step_buy' };

// ---------- Settings (shared by every strip, tuned in the playground) ----------

const SETTINGS_KEY = 'qt:grok-k3:contrast';
export const DEFAULT_SETTINGS = { mult: BAND.mult, floor: CONTRAST_FLOOR, alwaysPct: ALWAYS_REL * 100 };
export function contrastSettings() {
  try { return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') }; } catch { return { ...DEFAULT_SETTINGS }; }
}
function saveSettings(patch) {
  const next = { ...contrastSettings(), ...patch };
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(next)); } catch { /* private mode: settings last for the page only */ }
  memo = new WeakMap();
  return next;
}

// ---------- Compute, cached per rows array and scope ----------

let memo = new WeakMap();
const weeksMemo = new WeakMap();
function weeksOf(rows) {
  if (!weeksMemo.has(rows)) weeksMemo.set(rows, [...new Set(rows.map((r) => r.week))].filter(Boolean).sort());
  return weeksMemo.get(rows);
}

// scope: { group, device, entry, week, compare } — week and compare default to the context bar.
export function runContrasts(rows, scope, ctx) {
  if (!rows?.length || !CONTRAST_GROUPS.includes(scope.group)) return null;
  const weeks = weeksOf(rows);
  const full = ctx.full;
  const fullWeeks = weeks.filter(full);
  const week = weeks.includes(scope.week) ? scope.week : weeks.includes(ctx.global?.week) ? ctx.global.week : fullWeeks[fullWeeks.length - 1] ?? weeks[weeks.length - 1];
  const compare = scope.compare !== undefined ? scope.compare : compareWeek(weeks, week, ctx.global?.compare ?? 'prev', full);
  const device = scope.group === 'device' ? 'all' : scope.device && scope.device !== ALL ? scope.device : 'all';
  const entry = scope.entry && scope.entry !== ALL ? scope.entry : undefined;
  const st = contrastSettings();
  const key = JSON.stringify([scope.group, device, entry, week, compare, st]);
  if (!memo.has(rows)) memo.set(rows, new Map());
  const cache = memo.get(rows);
  if (!cache.has(key)) {
    const r = contrasts(rows, {
      group: scope.group, device, entry, week, compare, full,
      floor: st.floor, band: { mult: st.mult, minChanges: BAND.minChanges }, alwaysRel: st.alwaysPct / 100,
    });
    cache.set(key, { ...r, week, compare, device, entry, settings: st });
  }
  return cache.get(key);
}

// The panel's own pickers say which group, device and landing page to compare within.
export function scopeFromPickers(ctx, fallbackGroup) {
  const pick = (f) => ctx.pickers?.find((p) => p.field === f)?.value;
  const seg = pick('segment');
  const vp = pick('viewport_type');
  const entry = pick('entry');
  if (CONTRAST_GROUPS.includes(seg)) return { group: seg, device: vp, entry, focus: pick('segment_value') !== 'all' ? pick('segment_value') : undefined };
  if (seg === 'all' && vp && vp !== 'all' && vp !== ALL) return { group: 'device', entry, focus: vp };
  return { group: fallbackGroup ?? contextGroup(ctx), device: vp, entry };
}
export const contextGroup = (ctx) => (CONTRAST_GROUPS.includes(ctx.global?.split) ? ctx.global.split : 'traffic_source');

// ---------- Words and numbers ----------

const valueLabel = (c, ctx) => ctx.fieldLabel(c.value, c.group === 'device' ? 'viewport_type' : 'segment_value');
const level = (v, c, ctx) => format(v, c.fmt, ctx.currency);
const money = (v, ctx) => (v === null || v === undefined || !Number.isFinite(v) ? '–'
  : new Intl.NumberFormat(undefined, { style: 'currency', currency: ctx.currency ?? 'USD', notation: 'compact', maximumFractionDigits: 1 }).format(v));
const relGap = (c, i = c.idx) => (c.seg[i] !== null && c.rest[i] ? c.seg[i] / c.rest[i] - 1 : null);
function gapWords(c, i = c.idx) {
  if (c.unit === 'pp') {
    const g = c.gap[i];
    if (g === null || g === undefined) return 'no gap to read';
    return `${Math.abs(g * 100).toFixed(2)} pts ${g >= 0 ? 'above' : 'below'} the rest`;
  }
  const r = relGap(c, i);
  if (r === null) return 'no gap to read';
  return `${Math.abs(r * 100).toFixed(Math.abs(r) < 0.1 ? 1 : 0)}% ${r >= 0 ? 'above' : 'below'} the rest`;
}
const usualGapWords = (c) => {
  const g = c.gapUsual;
  if (g === null || g === undefined) return null;
  return c.unit === 'pp' ? `${Math.abs(g * 100).toFixed(2)} pts ${g >= 0 ? 'above' : 'below'}` : `${Math.abs(g).toFixed(0)}% ${g >= 0 ? 'above' : 'below'}`;
};
const times = (d, b) => (b ? `${(Math.abs(d) / b).toFixed(1)}× ` : '');
const gapDeltaText = (c) => (c.unit === 'pp' ? fmtDelta(c.gapDelta, 'pp') : `${c.gapDelta > 0 ? '+' : '−'}${Math.abs(c.gapDelta).toFixed(0)} points of relative gap`);
const gapBandText = (c) => (c.unit === 'pp' ? fmtBand(c.gapBand.band, 'pp') : `±${c.gapBand.band?.toFixed(0)} points`);

function chipText(c, ctx, { withValue = true, focus = false, structural = false } = {}) {
  const who = withValue ? h('strong', {}, valueLabel(c, ctx), ' ') : null;
  if (focus) {
    const d = c.unit === 'pp' && c.gapNow !== null ? fmtDelta(c.gapNow * 100, 'pp') : gapWords(c);
    return [who, `vs rest ${d}`];
  }
  if (structural && c.always) return [who, `${SHORT[c.measure]} `, h('span', { class: 'ctr-k' }, gapWords(c))];
  if ((c.kind === 'pulled' || c.kind === 'own' || c.kind === 'with') && c.segDelta !== null) {
    return [who, `${SHORT[c.measure]} ${fmtDelta(c.segDelta, c.unit)}`, h('span', { class: 'ctr-k' }, ` · ${c.kind === 'pulled' ? (c.direction === 'ahead' ? 'pulled ahead' : 'fell behind') : KIND_SHORT[c.kind]}`)];
  }
  if (c.always) return [who, `${SHORT[c.measure]} `, h('span', { class: 'ctr-k' }, gapWords(c))];
  return [who, `${SHORT[c.measure]} `, h('span', { class: 'ctr-k' }, KIND_SHORT[c.kind])];
}

function explain(c, ctx) {
  const v = valueLabel(c, ctx);
  const seg = fmtDelta(c.segDelta, c.unit); const rest = fmtDelta(c.restDelta, c.unit);
  if (c.kind === 'cantsay') return `Can't judge this one: ${c.reasons.join('; ')}.`;
  if (c.kind === 'pulled') return `${v} moved ${seg} while the rest moved ${rest}. The gap between them changed ${gapDeltaText(c)}, ${times(c.gapDelta, c.gapBand.band)}its usual ${gapBandText(c)}, and ${v}'s own move was ${times(c.segDelta, c.segBand.band)}its usual ${fmtBand(c.segBand.band, c.unit)}.`;
  if (c.kind === 'own') return `${v} moved ${seg}, ${times(c.segDelta, c.segBand.band)}its usual ${fmtBand(c.segBand.band, c.unit)}. The rest moved ${rest}, inside its usual wobble, but the gap stayed within its usual ${gapBandText(c)}.`;
  if (c.kind === 'with') return `${v} moved ${seg}, beyond its usual ${fmtBand(c.segBand.band, c.unit)}, but the rest moved the same way (${rest}), so this looks site-wide rather than about ${v}.`;
  const restMoved = c.tags.includes('the rest moved, not this segment');
  return `${v} moved ${seg}, inside its usual ${fmtBand(c.segBand.band, c.unit)}.${restMoved ? ` The rest moved ${rest}, which shifted the gap, but ${v} itself did nothing unusual.` : ' Nothing unusual against the rest.'}`;
}

function moneyLine(c, ctx) {
  const v = valueLabel(c, ctx);
  const lines = [];
  const more = (x) => `${money(Math.abs(x), ctx)} ${x >= 0 ? 'more' : 'less'}`;
  if (c.kind === 'pulled' && c.money) lines.push(`Roughly ${more(c.money)} revenue this week than if ${v} had moved like the rest (the extra change × ${v}'s volume × revenue per unit).`);
  else if ((c.kind === 'own' || c.kind === 'with') && c.money) lines.push(`Roughly ${more(c.money)} revenue this week from ${v}'s change.`);
  if (c.always && c.gapMoney) {
    lines.push(c.always === 'lower'
      ? `Always lower: matching the rest would be worth up to ${money(c.gapMoney, ctx)} a week. Upper bound — these visitors differ for reasons a page change may not fix.`
      : `Always higher: ${v} brings about ${money(-c.gapMoney, ctx)} a week more than it would at the rest's rate.`);
  }
  return lines;
}

// ---------- Cards ----------

const contrastKey = (c) => `ctr|${c.group}|${c.value}|${c.measure}|${c.week}|${c.compare}`;
function specOf(c, ctx) {
  return {
    id: contrastKey(c),
    build: (o) => cardBody(c, ctx, o),
    onHover: () => ctx.log?.('contrast_hover', { group: c.group, value: c.value, measure: c.measure, kind: c.kind }),
    onPin: () => ctx.log?.('contrast_pin', { group: c.group, value: c.value, measure: c.measure, kind: c.kind }),
  };
}

function evidence(c, ctx) {
  const pickers = c.group === 'device'
    ? { segment: 'all', segment_value: 'all', viewport_type: c.value }
    : { segment: c.group, segment_value: c.value };
  ctx.log?.('contrast_open', { group: c.group, value: c.value, measure: c.measure });
  hideCard();
  ctx.drill({ tab: 'funnels', panel: 'fn-funnel', pickers, label: `${valueLabel(c, ctx)} funnel` });
}

function miniChart(c, ctx) {
  const W = 300; const H = 96; const L = 20; const R = 20; const T = 10; const B = 22;
  const n = c.weeks.length;
  const vals = [...c.seg, ...c.rest].filter((v) => v !== null && Number.isFinite(v));
  if (n < 2 || !vals.length) return null;
  let lo = Math.min(...vals); let hi = Math.max(...vals);
  if (hi === lo) { hi += Math.abs(hi) * 0.1 || 1; lo -= Math.abs(lo) * 0.1 || 1; }
  const pad = (hi - lo) * 0.12; lo -= pad; hi += pad;
  const x = (i) => L + (i / (n - 1)) * (W - L - R);
  const y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  const era = ERA_BREAK[c.group];
  const usable = (i) => ctx.full(c.weeks[i]) && c.weeks[i] !== era;
  const svg = s('svg', { width: W, height: H, class: 'ctr-chart', viewBox: `0 0 ${W} ${H}` });
  c.weeks.forEach((w, i) => {
    if (!usable(i)) svg.append(s('rect', { x: x(i) - 9, y: T - 4, width: 18, height: H - T - B + 8, class: 'ctr-unusable' }));
    if (i === c.idx) svg.append(s('rect', { x: x(i) - 9, y: T - 4, width: 18, height: H - T - B + 8, class: 'ctr-judged' }));
    const t = s('text', { x: x(i), y: H - 6, class: `ctr-wk${i === c.idx ? ' on' : ''}`, 'text-anchor': 'middle' }, ctx.fieldLabel(w, 'week'));
    svg.append(t);
  });
  const line = (arr, cls) => {
    const pts = arr.map((v, i) => [i, v]).filter(([, v]) => v !== null && Number.isFinite(v));
    svg.append(s('path', { d: pts.map(([i, v], k) => `${k ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' '), class: `ctr-line ${cls}` }));
    for (const [i, v] of pts) {
      const dot = s('circle', { cx: x(i), cy: y(v), r: i === c.idx || i === c.cIdx ? 3.4 : 2.2, class: `ctr-dot ${cls}${usable(i) ? '' : ' hollow'}` });
      dot.append(s('title', {}, `${ctx.fieldLabel(c.weeks[i], 'week')}: ${level(v, c, ctx)}`));
      svg.append(dot);
    }
  };
  line(c.rest, 'rest');
  line(c.seg, 'seg');
  return svg;
}

function cardBody(c, ctx, { floating = false, pinned = false, onUnpin } = {}) {
  const v = valueLabel(c, ctx);
  const i = c.idx; const j = c.cIdx;
  const wk = (w) => (w ? ctx.fieldLabel(w, 'week') : '–');
  const head = h('div', { class: 'ctr-card-head' },
    h('div', {}, h('div', { class: 'ctr-title' }, `${v} · ${c.label}`),
      h('div', { class: 'ctr-sub' }, `Within ${GROUP_LABEL[c.group]} · week of ${wk(c.week)}${c.compare ? ` vs ${wk(c.compare)}` : ''}`)),
    h('span', { class: `ctr-kind kind-${c.kind}${c.thin ? ' thin' : ''}` }, KIND_TEXT[c.kind](c), c.thin ? ' · thin' : ''),
    pinned ? h('button', { type: 'button', class: 'ctr-x', title: 'Unpin', onclick: onUnpin }, '✕') : null);
  const tbl = h('table', { class: 'ctr-tbl' },
    h('thead', {}, h('tr', {}, h('th', {}), h('th', { class: 'seg' }, v), h('th', { class: 'rest' }, 'Everyone else'))),
    h('tbody', {},
      h('tr', {}, h('td', {}, `Week of ${wk(c.week)}`), h('td', {}, level(c.seg[i], c, ctx)), h('td', {}, level(c.rest[i], c, ctx))),
      j >= 0 ? h('tr', {}, h('td', {}, `Week of ${wk(c.compare)}`), h('td', {}, level(c.seg[j], c, ctx)), h('td', {}, level(c.rest[j], c, ctx))) : null,
      c.segDelta !== undefined ? h('tr', { class: 'chg' }, h('td', {}, 'Change'), h('td', {}, fmtDelta(c.segDelta, c.unit)), h('td', {}, fmtDelta(c.restDelta, c.unit))) : null,
      h('tr', { class: 'usual' }, h('td', {}, 'Usual weekly change'), h('td', {}, fmtBand(c.segBand.band, c.unit)), h('td', {}, fmtBand(c.restBand.band, c.unit))),
      h('tr', { class: 'vol' }, h('td', {}, 'Volume this week'),
        h('td', {}, `${format(c.segDen[i], 'int')}`), h('td', {}, `${format(c.restDen[i], 'int')}`))));
  const gap = h('p', { class: 'ctr-gap' },
    h('strong', {}, 'Gap: '), `${v} is ${gapWords(c)} this week`,
    usualGapWords(c) ? `; usually ${usualGapWords(c)}` : '',
    c.gapDelta !== undefined && c.gapDelta !== null ? `. The gap changed ${gapDeltaText(c)}, ${times(c.gapDelta, c.gapBand.band)}its usual ${gapBandText(c)}.` : '.');
  const actions = h('div', { class: 'ctr-actions' },
    !pinned ? h('button', { type: 'button', class: 'ctr-btn', onclick: () => pinCard(specOf(c, ctx)) }, 'Pin to compare') : null,
    h('button', { type: 'button', class: 'ctr-btn primary', onclick: () => evidence(c, ctx) }, `Open ${v} funnel →`));
  return [
    head,
    pinned ? null : h('p', { class: 'ctr-explain' }, explain(c, ctx)),
    h('div', { class: 'ctr-legend' }, h('span', { class: 'seg' }, v), h('span', { class: 'rest' }, 'Everyone else'), pinned ? null : h('span', { class: 'muted' }, 'shaded: judged week · grey: part or redefined week')),
    miniChart(c, ctx),
    tbl,
    gap,
    ...moneyLine(c, ctx).map((t) => h('p', { class: 'ctr-money' }, t)),
    c.reasons.length && c.kind !== 'cantsay' ? h('p', { class: 'ctr-note' }, `Note: ${c.reasons.join('; ')}.`) : null,
    floating || pinned ? actions : null,
  ].filter(Boolean);
}

// ---------- Chips ----------

export function chip(c, ctx, opts = {}) {
  if (!c) return null;
  const b = h('button', { type: 'button', class: `ctr-chip kind-${opts.structural ? 'inline' : c.kind}${c.always ? ' always' : ''}${c.thin ? ' thin' : ''}${opts.cls ? ` ${opts.cls}` : ''}` },
    h('i', { class: 'ctr-dot-i' }), chipText(c, ctx, opts));
  return hoverCard(b, specOf(c, ctx));
}

// ---------- Strip ----------

function allCantSay(res) { return res.list.length && res.list.every((c) => c.kind === 'cantsay'); }

export function strip(rows, scope, ctx, { title, n = 3, k = 2, seeAll = true, exclude } = {}) {
  const ran = runContrasts(rows, scope, ctx);
  if (!ran) return null;
  const res = exclude === undefined ? ran : { ...ran, list: ran.list.filter((c) => String(c.value) !== String(exclude)) };
  const wk = (w) => ctx.fieldLabel(w, 'week');
  const lead = h('span', { class: 'ctr-strip-lead' }, title ?? `Within ${GROUP_LABEL[res.group]}`, h('span', { class: 'muted' }, ` · week of ${wk(res.week)}${res.compare ? ` vs ${wk(res.compare)}` : ''}`));
  const counts = res.list.reduce((a, c) => ((a[c.kind] = (a[c.kind] ?? 0) + 1), a), {});
  const all = seeAll ? h('a', { href: '#', class: 'ctr-all', onclick: (e) => { e.preventDefault(); ctx.drill({ tab: 'change', panel: 'ch-contrast', state: { group: res.group, cDevice: res.device, cEntry: res.entry }, label: `Contrasts: ${GROUP_LABEL[res.group]}` }); } }, 'all contrasts →') : null;
  if (allCantSay(res)) {
    const why = [...new Set(res.list.flatMap((c) => c.reasons))].slice(0, 2).join('; ');
    return h('div', { class: 'ctr-strip cantsay' }, lead, h('span', { class: 'ctr-none' }, `Can't compare segments this week: ${why}.`), all);
  }
  const hl = headline(res.list, { n, k });
  return h('div', { class: 'ctr-strip' }, lead,
    hl.findings.length ? hl.findings.map((c) => chip(c, ctx)) : h('span', { class: 'ctr-none' }, `No value moved apart from the rest beyond its usual wobble.`),
    hl.structural.length ? [h('span', { class: 'ctr-sep' }, 'Always:'), hl.structural.map((c) => chip(c, ctx, { structural: true }))] : null,
    h('span', { class: 'muted ctr-count', title: 'Every value × measure in this group, judged against its own history' }, `${res.list.length} checked · ${counts.pulled ?? 0} pulled away · ${counts.own ?? 0} changed alone`),
    all);
}

// ---------- Hooks for existing views ----------

// Funnel: the strip above, plus one chip per step comparing the chosen segment with the rest of its group.
export function funnelContrast(rows, ctx, { week, compare }) {
  const scope = { ...scopeFromPickers(ctx), week, compare };
  const res = runContrasts(rows, scope, ctx);
  if (!res) return { strip: null, stepChip: () => null };
  const focus = scope.focus;
  const find = (m) => res.list.find((c) => String(c.value) === String(focus) && c.measure === m);
  return {
    strip: strip(rows, scope, ctx, { title: focus ? `Other ${GROUP_LABEL[res.group]} values that stand out` : undefined, exclude: focus }),
    stepChip: (k) => (focus && STEP_MEASURE[k] ? chip(find(STEP_MEASURE[k]), ctx, { withValue: false, focus: true, cls: 'step' }) : null),
    focusLabel: focus ? ctx.fieldLabel(focus, res.group === 'device' ? 'viewport_type' : 'segment_value') : null,
  };
}

// Cards and tables keyed by segment value: up to `n` chips for that value.
export function valueChips(rows, scope, ctx, { n = 2, measure } = {}) {
  const res = runContrasts(rows, scope, ctx);
  if (!res) return () => null;
  const want = WEEKLY_MEASURE[measure];
  return (value) => {
    const mine = res.list.filter((c) => String(c.value) === String(value));
    let pick = mine.filter((c) => (c.kind === 'pulled' || c.kind === 'own') && !c.thin);
    if (want) {
      const m = mine.find((c) => c.measure === want);
      pick = m ? [m, ...pick.filter((c) => c !== m)] : pick;
    }
    if (!pick.length) pick = mine.filter((c) => c.always).sort((a, b) => Math.abs(b.gapMoney ?? 0) - Math.abs(a.gapMoney ?? 0));
    const chips = pick.slice(0, n).map((c) => chip(c, ctx, { withValue: false }));
    return chips.length ? h('span', { class: 'ctr-chips' }, chips) : null;
  };
}

// ---------- Views ----------

// Home: the context split's strip, plus devices.
export function contraststrip(panel, rows, ctx) {
  const g = contextGroup(ctx);
  const others = CONTRAST_GROUPS.filter((x) => x !== g);
  return [
    strip(rows, { group: g, device: ctx.global?.device }, ctx),
    ...others.map((x) => strip(rows, { group: x, device: ctx.global?.device }, ctx, { n: 2, k: 1 })),
    h('p', { class: 'foot' }, 'Hover a chip to compare that segment with the rest of its group; click to pin it beside others. A segment counts as pulled away only when it moved beyond its own usual wobble and its gap to the rest moved beyond the gap\'s usual wobble.'),
  ];
}

function select(label, options, value, onchange) {
  return h('label', { class: 'picker' }, h('span', {}, label),
    h('select', { onchange: (e) => onchange(e.target.value) },
      options.map(([v, l]) => h('option', { value: v, selected: String(v) === String(value) ? 'selected' : null }, l))));
}

// The playground: every value × measure for one group, with the thresholds exposed.
export function contrastgrid(panel, rows, ctx) {
  const st = ctx.state;
  const group = CONTRAST_GROUPS.includes(st.group) ? st.group : contextGroup(ctx);
  const weeks = weeksOf(rows);
  const entries = [...new Set(rows.map((r) => r.entry))].filter(Boolean).sort();
  const device = group === 'device' ? 'all' : st.cDevice ?? (ctx.global?.device && ctx.global.device !== 'all' ? ctx.global.device : 'all');
  const entry = st.cEntry ?? ALL;
  const fullWeeks = weeks.filter(ctx.full);
  const week = weeks.includes(st.week) ? st.week : weeks.includes(ctx.global?.week) ? ctx.global.week : fullWeeks[fullWeeks.length - 1];
  const cmpMode = st.compare ?? ctx.global?.compare ?? 'prev';
  const compare = compareWeek(weeks, week, cmpMode, ctx.full);
  const res = runContrasts(rows, { group, device, entry, week, compare }, ctx);
  const settings = contrastSettings();
  const show = st.show === 'all' ? 'all' : 'flagged';
  const wk = (w) => ctx.fieldLabel(w, 'week');

  const controls = h('div', { class: 'view-controls' },
    select('Compare within', CONTRAST_GROUPS.map((g) => [g, GROUP_LABEL[g][0].toUpperCase() + GROUP_LABEL[g].slice(1)]), group, (v) => ctx.set({ group: v })),
    group !== 'device' ? select('Device', [['all', 'All devices'], ['mobile', 'Mobile'], ['desktop', 'Desktop'], ['tablet', 'Tablet']], device, (v) => ctx.set({ cDevice: v })) : null,
    select('Landed on', [[ALL, 'Any page'], ...entries.map((e) => [e, ctx.fieldLabel(e, 'entry')])], entry, (v) => ctx.set({ cEntry: v })),
    select('Week', weeks.map((w) => [w, `Week of ${wk(w)}${ctx.full(w) ? '' : ' (part)'}`]), week, (v) => ctx.set({ week: v })),
    select('Compare with', [['prev', 'Previous week'], ['firstFull', 'First whole week'], ['none', 'Nothing']], ['prev', 'firstFull', 'none'].includes(cmpMode) ? cmpMode : 'prev', (v) => ctx.set({ compare: v })));
  const tuning = h('details', { class: 'ctr-tuning', open: st.tuning ? 'open' : null, ontoggle: (e) => { st.tuning = e.target.open; } },
    h('summary', {}, `Sensitivity: band ×${settings.mult}, floor ${settings.floor}, structural ≥ ${settings.alwaysPct}% · applies to every contrast strip`),
    h('div', { class: 'view-controls' },
      select('Unusual means beyond', [[1.5, '1.5 × the median weekly change'], [2, '2 × (default)'], [3, '3 × (strict)']], settings.mult, (v) => { saveSettings({ mult: Number(v) }); ctx.set({}); }),
      select('Thin below', [[100, '100'], [300, '300 (default)'], [1000, '1,000']], settings.floor, (v) => { saveSettings({ floor: Number(v) }); ctx.set({}); }),
      select('Structural gap', [[15, '15% apart every week'], [25, '25% (default)'], [40, '40%']], settings.alwaysPct, (v) => { saveSettings({ alwaysPct: Number(v) }); ctx.set({}); }),
      h('button', { type: 'button', class: 'linklike', onclick: () => { saveSettings(DEFAULT_SETTINGS); ctx.set({}); } }, 'reset')),
    h('p', { class: 'foot' }, `Each segment's band is learned from its own whole weeks before the judged week (needs ${BAND.minChanges} week-to-week changes). The 7 Sep week is left out for new vs returning, because the definition changed.`));
  if (!res) return [controls, tuning, h('div', { class: 'blocked' }, 'No funnel rows for this group.')];

  const values = [...new Set(res.list.map((c) => c.value))]
    .map((v) => ({ v, share: res.list.find((c) => c.value === v).share }))
    .sort((a, b) => b.share - a.share);
  const byKey = new Map(res.list.map((c) => [`${c.value}|${c.measure}`, c]));
  const flagged = (c) => c.kind === 'pulled' || c.kind === 'own' || c.always;
  const cell = (c) => {
    if (!c) return h('td', { class: 'ctr-cell empty' }, '–');
    const dim = show === 'flagged' && !flagged(c);
    const b = chip(c, ctx, { withValue: false, focus: true, cls: `cell${dim ? ' dim' : ''}` });
    return h('td', { class: 'ctr-cell' }, b,
      c.segDelta !== undefined && c.kind !== 'cantsay' ? h('div', { class: `ctr-cell-d ${c.segDelta > 0 ? 'up' : c.segDelta < 0 ? 'down' : ''}` }, fmtDelta(c.segDelta, c.unit)) : null);
  };
  const grid = h('div', { class: 'scroll' }, h('table', { class: 'grid ctr-grid' },
    h('thead', {}, h('tr', {}, h('th', { class: 'label' }, GROUP_LABEL[group][0].toUpperCase() + GROUP_LABEL[group].slice(1)), h('th', { class: 'num' }, 'Share'),
      CONTRAST_MEASURES.map((m) => h('th', {}, m.label)))),
    h('tbody', {}, values.map(({ v, share }) => h('tr', {},
      h('td', { class: 'label' }, ctx.fieldLabel(v, group === 'device' ? 'viewport_type' : 'segment_value')),
      h('td', { class: 'num' }, format(share, 'pct')),
      CONTRAST_MEASURES.map((m) => cell(byKey.get(`${v}|${m.id}`))))))));

  const counts = res.list.reduce((a, c) => ((a[c.kind] = (a[c.kind] ?? 0) + 1), a), {});
  const always = res.list.filter((c) => c.always).length;
  const legend = h('div', { class: 'ctr-legend-row' },
    ['pulled', 'own', 'with', 'inline', 'cantsay'].map((kd) => h('span', { class: `ctr-chip kind-${kd} static` }, h('i', { class: 'ctr-dot-i' }), `${KIND_SHORT[kd]} ${counts[kd] ?? 0}`)),
    h('span', { class: 'ctr-chip always static' }, h('i', { class: 'ctr-dot-i' }), `always apart ${always}`),
    select('Highlight', [['flagged', 'Pulled away, changed alone, always apart'], ['all', 'Everything']], show, (v) => ctx.set({ show: v })));

  const top = res.list.filter((c) => (c.kind === 'pulled' || c.kind === 'own') && !c.thin).slice(0, 6);
  const findings = h('div', { class: 'ctr-findings' }, h('h4', {}, 'Reading order'),
    top.length ? h('ol', {}, top.map((c) => h('li', {}, chip(c, ctx), ' ', h('span', { class: 'muted' }, explain(c, ctx)))))
      : h('p', { class: 'muted' }, allCantSay(res) ? `Can't say for ${GROUP_LABEL[group]} this week: ${[...new Set(res.list.flatMap((c) => c.reasons))].join('; ')}.` : 'No value moved apart from the rest beyond its usual wobble this week.'));
  return [controls, tuning, legend, grid,
    h('p', { class: 'foot' }, `Each cell is the segment against everyone else in ${GROUP_LABEL[group]}, week of ${wk(res.week)}${res.compare ? ` vs ${wk(res.compare)}` : ''}. Rates show the gap in points; revenue per session shows it in percent. The small figure under a cell is the segment's own change. Hover for the comparison, click to pin.`),
    findings];
}
