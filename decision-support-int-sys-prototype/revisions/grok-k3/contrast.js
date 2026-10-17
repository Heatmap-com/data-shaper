// Segment contrasts: does one value of a split behave differently from the rest of its group?
// Three kinds, each judged against history rather than a p-value (weekly totals, huge n):
//   pulled  — the gap to the rest moved beyond the gap's own usual wobble
//   own     — the segment moved beyond its own wobble while the rest did not
//   with    — the segment moved, but so did the rest (site-wide, not segment-specific)
//   always  — a steady gap every whole week (structural; context, not news)
// No DOM here.
import { BAND, bandFor, changeOf } from './wobble.js';

const SUMS = ['sessions', 'product_viewed', 'added_to_cart', 'checkout_started', 'buyers', 'orders', 'revenue'];

// num/den ratios. `unit` is how a change reads: points for rates, percent for money.
// `per` is the revenue one extra unit of `num` is roughly worth, for the money-at-stake line.
export const CONTRAST_MEASURES = [
  { id: 'order_rate', label: 'Order rate', num: 'orders', den: 'sessions', unit: 'pp', fmt: 'pct', per: (t) => (t.orders ? t.revenue / t.orders : 0) },
  { id: 'rps', label: 'Revenue per session', num: 'revenue', den: 'sessions', unit: '%', fmt: 'money', per: () => 1 },
  { id: 'step_pv', label: 'Viewed a product', num: 'product_viewed', den: 'sessions', unit: 'pp', fmt: 'pct', step: 1, per: (t) => (t.product_viewed ? t.revenue / t.product_viewed : 0) },
  { id: 'step_cart', label: 'Viewed → cart count ratio', num: 'added_to_cart', den: 'product_viewed', unit: 'pp', fmt: 'pct', step: 2, per: (t) => (t.added_to_cart ? t.revenue / t.added_to_cart : 0) },
  { id: 'step_checkout', label: 'Cart → checkout count ratio', num: 'checkout_started', den: 'added_to_cart', unit: 'pp', fmt: 'pct', step: 3, per: (t) => (t.checkout_started ? t.revenue / t.checkout_started : 0) },
  { id: 'step_buy', label: 'Checkout → bought count ratio', num: 'buyers', den: 'checkout_started', unit: 'pp', fmt: 'pct', step: 4, per: (t) => (t.buyers ? t.revenue / t.buyers : 0) },
];
export const CONTRAST_GROUPS = ['traffic_source', 'returning', 'device'];
export const ERA_BREAK = { returning: '2026-09-07' };
export const CONTRAST_FLOOR = 300;
// A gap counts as structural when the segment sits at least this far from the rest, in the same direction, every whole week.
export const ALWAYS_REL = 0.25;

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : null;
};
const empty = () => Object.fromEntries(SUMS.map((k) => [k, 0]));
const add = (t, r) => { for (const k of SUMS) t[k] += Number(r[k]) || 0; return t; };
const ratio = (t, m) => (t && t[m.den] ? t[m.num] / t[m.den] : null);

// Weekly totals per value of one group, plus the group total. Funnel rows are summed over entry pages unless `entry` is set.
export function groupTotals(funnel, { group, device = 'all', entry }) {
  const isDevice = group === 'device';
  const rows = funnel.filter((r) => (isDevice
    ? r.segment === 'all' && r.viewport_type !== 'all'
    : r.segment === group && r.viewport_type === device)
    && (!entry || r.entry === entry));
  const valueOf = (r) => (isDevice ? r.viewport_type : r.segment_value);
  const weeks = [...new Set(rows.map((r) => r.week))].sort();
  const by = new Map();
  const total = new Map(weeks.map((w) => [w, empty()]));
  for (const r of rows) {
    const v = valueOf(r);
    if (!by.has(v)) by.set(v, new Map(weeks.map((w) => [w, empty()])));
    add(by.get(v).get(r.week), r);
    add(total.get(r.week), r);
  }
  return { weeks, by, total };
}

function restOf(total, seg) {
  const out = empty();
  for (const k of SUMS) out[k] = (total?.[k] ?? 0) - (seg?.[k] ?? 0);
  return out;
}

// One contrast for one segment value and one measure, in the judged week against the compare week.
export function contrastOne({ weeks, segWeeks, total, measure: m, week, compare, full, group, floor = CONTRAST_FLOOR, band = BAND, alwaysRel = ALWAYS_REL }) {
  const era = ERA_BREAK[group];
  const usable = (w) => full(w) && w !== era;
  const segs = weeks.map((w) => segWeeks.get(w));
  const rests = weeks.map((w, i) => restOf(total.get(w), segs[i]));
  const seg = segs.map((t) => ratio(t, m));
  const rest = rests.map((t) => ratio(t, m));
  const gap = seg.map((s, i) => (s === null || rest[i] === null ? null : m.unit === 'pp' ? s - rest[i] : rest[i] ? (s / rest[i] - 1) * 100 : null));
  const fullFlags = weeks.map(usable);
  const idx = weeks.indexOf(week);
  const cIdx = compare ? weeks.indexOf(compare) : -1;
  const gapUnit = m.unit === 'pp' ? 'pp' : 'abs';
  const out = {
    measure: m.id, label: m.label, unit: m.unit, fmt: m.fmt, weeks, seg, rest, gap,
    segDen: segs.map((t) => t?.[m.den] ?? 0), restDen: rests.map((t) => t?.[m.den] ?? 0),
    week, compare, idx, cIdx, kind: 'inline', reasons: [], tags: [],
  };
  const segBand = bandFor(seg, fullFlags, idx, m.unit, band);
  const restBand = bandFor(rest, fullFlags, idx, m.unit, band);
  const gapBand = bandFor(gap, fullFlags, idx, gapUnit, band);
  Object.assign(out, { segBand, restBand, gapBand });

  // Structural gap: same direction and at least ALWAYS_REL apart, every usable week up to the judged one.
  const rel = seg.map((s, i) => (s !== null && rest[i] ? s / rest[i] - 1 : null));
  const usableRel = rel.filter((r, i) => i <= idx && fullFlags[i] && r !== null);
  if (usableRel.length >= 3 && (usableRel.every((r) => r <= -alwaysRel) || usableRel.every((r) => r >= alwaysRel))) {
    out.always = usableRel[0] < 0 ? 'lower' : 'higher';
    out.tags.push(out.always === 'lower' ? 'always lower' : 'always higher');
  }
  out.gapNow = gap[idx];
  out.gapUsual = median(gap.filter((g, i) => i < idx && fullFlags[i] && g !== null));
  const t = segs[idx];
  const per = t ? m.per(t) : 0;
  if (out.always && seg[idx] !== null && rest[idx] !== null) out.gapMoney = (rest[idx] - seg[idx]) * (t?.[m.den] ?? 0) * per;

  if (cIdx < 0) { out.kind = 'cantsay'; out.reasons.push('no comparison week'); return out; }
  if (compare === era || week === era) { out.kind = 'cantsay'; out.reasons.push(`the ${group} definition changed in the week of ${era}`); return out; }
  if (!full(week) || !full(compare)) { out.kind = 'cantsay'; out.reasons.push('partial week'); return out; }
  const thin = out.segDen[idx] < floor || out.segDen[cIdx] < floor;
  if (thin) { out.thin = true; out.reasons.push(`fewer than ${floor} ${m.den.replace(/_/g, ' ')} in a compared week`); }

  out.segDelta = changeOf(seg[idx], seg[cIdx], m.unit);
  out.restDelta = changeOf(rest[idx], rest[cIdx], m.unit);
  out.gapDelta = changeOf(gap[idx], gap[cIdx], gapUnit);
  const did = seg[idx] !== null && seg[cIdx] !== null && rest[idx] !== null && rest[cIdx] !== null ? (seg[idx] - seg[cIdx]) - (rest[idx] - rest[cIdx]) : null;
  out.didMoney = did === null ? null : did * (t?.[m.den] ?? 0) * per;
  out.ownMoney = seg[idx] !== null && seg[cIdx] !== null ? (seg[idx] - seg[cIdx]) * (t?.[m.den] ?? 0) * per : null;

  if ([segBand, gapBand].some((b) => b.band === null)) {
    out.kind = 'cantsay';
    out.reasons.push(`fewer than ${band.minChanges + 1} usable whole weeks to learn the usual wobble (${gapBand.n} week-to-week change${gapBand.n === 1 ? '' : 's'})`);
    return out;
  }
  const segMoved = Math.abs(out.segDelta) > segBand.band;
  const restMoved = restBand.band !== null && Math.abs(out.restDelta) > restBand.band && Math.sign(out.restDelta) === Math.sign(out.segDelta);
  const gapMoved = Math.abs(out.gapDelta) > gapBand.band;
  // Pulled needs the segment itself to move unusually; a gap that moved only because the rest moved is not about this segment.
  if (gapMoved && segMoved) { out.kind = 'pulled'; out.direction = out.gapDelta > 0 ? 'ahead' : 'behind'; }
  else if (segMoved && restMoved) out.kind = 'with';
  else if (segMoved) out.kind = 'own';
  else if (gapMoved) out.tags.push('the rest moved, not this segment');
  out.size = out.kind === 'pulled' ? Math.abs(out.gapDelta) / gapBand.band : out.kind === 'own' || out.kind === 'with' ? Math.abs(out.segDelta) / segBand.band : 0;
  out.money = out.kind === 'pulled' ? out.didMoney : out.kind === 'own' || out.kind === 'with' ? out.ownMoney : null;
  return out;
}

// Every value × measure for one group. Sorted: segment-specific findings first, by money at stake, then structural gaps.
export function contrasts(funnel, { group, device = 'all', entry, week, compare, full, measures = CONTRAST_MEASURES, floor, band, alwaysRel }) {
  const g = groupTotals(funnel, { group, device, entry });
  const list = [];
  for (const [value, segWeeks] of g.by) {
    const share = (segWeeks.get(week)?.sessions ?? 0) / (g.total.get(week)?.sessions || 1);
    for (const m of measures) {
      const c = contrastOne({ weeks: g.weeks, segWeeks, total: g.total, measure: m, week, compare, full, group, floor, band, alwaysRel });
      list.push({ ...c, group, value, share });
    }
  }
  return { group, weeks: g.weeks, list: list.sort(rankContrast) };
}

const KIND_ORDER = { pulled: 0, own: 1, with: 2, inline: 3, cantsay: 4 };
export function rankContrast(a, b) {
  return (KIND_ORDER[a.kind] - KIND_ORDER[b.kind])
    || (Boolean(a.thin) - Boolean(b.thin))
    || Math.abs(b.money ?? 0) - Math.abs(a.money ?? 0)
    || (b.size ?? 0) - (a.size ?? 0)
    || Math.abs(b.gapMoney ?? 0) - Math.abs(a.gapMoney ?? 0);
}

// What a strip should lead with: up to n segment-specific findings, then up to k structural gaps not already shown.
export function headline(list, { n = 3, k = 2 } = {}) {
  const findings = list.filter((c) => (c.kind === 'pulled' || c.kind === 'own') && !c.thin).slice(0, n);
  const shownKeys = new Set(findings.map((c) => `${c.value}|${c.measure}`));
  const structural = list.filter((c) => c.always && !shownKeys.has(`${c.value}|${c.measure}`))
    .sort((a, b) => Math.abs(b.gapMoney ?? 0) - Math.abs(a.gapMoney ?? 0)).slice(0, k);
  return { findings, structural };
}

export const KIND_TEXT = {
  pulled: (c) => (c.direction === 'ahead' ? 'Pulled ahead of the rest' : 'Fell behind the rest'),
  own: () => 'Changed on its own',
  with: () => 'Moved with everyone',
  inline: () => 'In line with its usual gap',
  cantsay: () => "Can't say",
};
