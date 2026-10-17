// The weekly ideas deck: this week's findings as cards, each with a type, an urgency, a potential impact,
// a plain headline and a drilldown. Built from the same engines as the tabs, so a card never says more than
// the panel it opens. No DOM here.
import { aggregate, format, measureValue } from './query.js';
import { compareWeek, wobbleCheck, moverCandidates, mergeMovers, weeksOf, weeklyTotals } from './derive.js';
import { bandFor, changeOf, judge, fmtBand, fmtDelta } from './wobble.js';
import { contrasts, headline } from './contrast.js';
import { findOutliers } from './outliers.js';
import { findChanges } from './changes.js';
import { laneOf, laneFindings, nodeLabel, prettyPath } from './flows-views.js';

export const TYPES = {
  moved: { label: 'What moved', ask: 'changed' },
  segment: { label: 'Segment', ask: 'changed' },
  journey: { label: 'Journey', ask: 'changed' },
  campaign: { label: 'Campaign', ask: 'changed' },
  opportunity: { label: 'Opportunity', ask: 'opportunity' },
  check: { label: 'Hypothesis check', ask: 'check' },
  experiment: { label: 'Experiment', ask: 'check' },
};
export const URGENCY = {
  now: { label: 'Act now', rank: 0 },
  week: { label: 'This week', rank: 1 },
  good: { label: 'Good news', rank: 2 },
  fyi: { label: 'Worth knowing', rank: 3 },
};

const pct = (v) => format(v, 'pct');
const int = (v) => format(v ?? 0, 'int');
export function money(v, currency = 'USD') {
  const a = Math.abs(v);
  const sym = currency === 'USD' ? '$' : '';
  const t = a >= 1e6 ? `${sym}${(a / 1e6).toFixed(1)}M` : a >= 1e3 ? `${sym}${(a / 1e3).toFixed(a >= 1e4 ? 0 : 1)}K` : `${sym}${Math.round(a)}`;
  return sym ? t : `${t} ${currency}`;
}
const shortDate = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });

// Impact tier from money at stake against a week of site revenue.
function tier(m, weekRevenue) {
  if (!m || !weekRevenue) return 'Low';
  const s = Math.abs(m) / weekRevenue;
  return s >= 0.02 ? 'High' : s >= 0.005 ? 'Medium' : 'Low';
}
const impactOf = (m, weekRevenue, currency, verb = 'a week') => (m === null || m === undefined || !Number.isFinite(m) ? null
  : { money: Math.abs(m), tier: tier(m, weekRevenue), text: `≈ ${money(m, currency)} ${verb}` });

const shareText = (s) => (s < 0.01 ? 'under 1%' : `${Math.round(s * 100)}%`);
const ratioText = (x) => (x >= 10 ? `${Math.round(x)}×` : `${x.toFixed(1)}×`);
// Two values side by side on the cover. The first is the thing the card is about.
const versus = (a, b, note) => ({ items: [{ ...a, mine: true }, b], note });
const MONTH = 52 / 12;
const timesText = (t) => (!t ? 'beyond' : t < 1.1 ? 'just beyond' : `${t.toFixed(1)}×`);
const segLabel = (ctx, family, v) => (family === 'device' ? ctx.fieldLabel(v, 'viewport_type') : ctx.fieldLabel(v, 'segment_value'));

// ---------- What moved (site and segment measures) ----------

function movedCards(funnel, journeys, env) {
  const { ctx, week, compare, full, siteRev, cur } = env;
  const mc = moverCandidates(funnel, journeys, { week, compare, device: 'all', full, families: ['traffic_source', 'returning'] });
  if (!mc.compare) return [];
  const kept = mergeMovers(mc.candidates).filter((c) => c.family !== 'journey' && c.family !== 'returning');
  const idx = mc.weeks.indexOf(week); const cIdx = mc.weeks.indexOf(mc.compare);
  return kept.slice(0, 6).map((c) => {
    const name = segLabel(ctx, c.family, c.value);
    const pick = c.family === 'device' ? (r) => r.segment === 'all' && r.viewport_type === c.value : (r) => r.segment === c.family && r.segment_value === c.value && r.viewport_type === 'all';
    const t = weeklyTotals(funnel, pick);
    const a = t.get(mc.compare) ?? {}; const b = t.get(week) ?? {};
    let m = null;
    if (c.measure === 'revenue') m = (b.revenue ?? 0) - (a.revenue ?? 0);
    else if (c.measure === 'order_rate') m = c.delta / 100 * (b.sessions ?? 0) * (b.orders ? b.revenue / b.orders : 0);
    else if (c.measure === 'rps') m = ((b.sessions ? b.revenue / b.sessions : 0) - (a.sessions ? a.revenue / a.sessions : 0)) * (b.sessions ?? 0);
    else if (c.measure === 'sessions') m = ((b.sessions ?? 0) - (a.sessions ?? 0)) * (a.sessions ? a.revenue / a.sessions : 0);
    const up = c.delta > 0;
    const times = c.band ? Math.abs(c.delta) / c.band : null;
    const big = times >= 2 && c.share >= 0.1;
    const word = c.measure === 'sessions' ? (up ? 'brought more visitors' : 'brought fewer visitors')
      : c.measure === 'revenue' ? (up ? 'earned more' : 'earned less')
        : `${c.measureLabel.toLowerCase()} ${up ? 'rose' : 'fell'}`;
    return {
      key: `moved|${c.family}|${c.value}|${c.measure}|${week}|${mc.compare}`,
      muteKey: `moved|${c.family}|${c.value}|${c.measure}`,
      type: 'moved', tone: up ? 'good' : 'bad',
      urgency: up ? 'good' : big ? 'now' : 'week',
      impact: impactOf(m, siteRev, cur, up ? 'more this week' : 'less this week'),
      eyebrow: `${c.family === 'device' ? 'Device' : 'Traffic source'} · ${name}`,
      title: `${name} ${word}`,
      alarm: !up && big ? { level: 'stop', text: `${fmtDelta(c.delta, c.unit)} in one week, ${timesText(times)} its usual move` } : up && big ? { level: 'star', text: `Big week: ${fmtDelta(c.delta, c.unit)}` } : null,
      compare: versus(
        { label: `${c.measureLabel}, week of ${shortDate(week)}`, value: c.cur, text: format(c.cur, c.fmt, cur) },
        { label: `Week of ${shortDate(mc.compare)}`, value: c.prev, text: format(c.prev, c.fmt, cur) },
        `${fmtDelta(c.delta, c.unit)}; it usually moves about ${fmtBand(c.median, c.unit)} a week`),
      big: [{ value: shareText(c.share), label: 'of all sessions' }],
      why: `It usually moves about ${fmtBand(c.median, c.unit)} a week; this was ${timesText(times)} its wobble band.${c.also?.length ? ` The same move shows in ${c.also.map((x) => segLabel(ctx, x.family, x.value)).join(', ')}.` : ''}`,
      detail: {
        explain: `${name}'s ${c.measureLabel.toLowerCase()} went from ${format(c.prev, c.fmt, cur)} the week of ${shortDate(mc.compare)} to ${format(c.cur, c.fmt, cur)}. A change counts as meaningful when it is bigger than twice the median of the line's own whole-week changes (${fmtBand(c.band, c.unit)} here, from ${c.n} changes).`,
        chart: { weeks: mc.weeks, values: c.values, idx, cIdx, unit: c.unit, band: c.band, fmt: c.fmt, name },
        table: [[`Week of ${shortDate(week)}`, format(c.cur, c.fmt, cur)], [`Week of ${shortDate(mc.compare)}`, format(c.prev, c.fmt, cur)], ['Change', fmtDelta(c.delta, c.unit)], ['Wobble band', fmtBand(c.band, c.unit)]],
        method: m !== null ? 'Money: the change in this slice\'s revenue that the move accounts for, at this week\'s volume.' : null,
        drill: c.family === 'device'
          ? { tab: 'funnels', panel: 'fn-funnel', pickers: { viewport_type: c.value }, label: `${name} funnel` }
          : { tab: 'journeys', panel: 'jr-flow', pickers: { kind: 'general', segment: c.family, segment_value: c.value }, label: `${name} journeys` },
      },
    };
  });
}

// ---------- Segments that pulled away, and standing gaps worth closing ----------

function segmentCards(funnel, env, taken) {
  const { ctx, week, compare, full, siteRev, cur } = env;
  if (!compare) return [];
  const r = contrasts(funnel, { group: 'traffic_source', week, compare, full });
  const clear = r.list.filter((c) => ['order_rate', 'rps'].includes(c.measure));
  const { findings, structural } = headline(clear, { n: 3, k: 4 });
  const gapSeen = new Set();
  const out = [];
  for (const c of findings) {
    if (!['order_rate', 'rps'].includes(c.measure)) continue;
    if (c.kind !== 'pulled' || taken.has(`${c.value}|${Math.sign(c.segDelta)}`)) continue;
    const name = ctx.fieldLabel(c.value, 'segment_value');
    const ahead = c.direction === 'ahead';
    out.push({
      key: `segment|${c.value}|${c.measure}|${week}|${compare}`, muteKey: `segment|${c.value}|${c.measure}`,
      type: 'segment', tone: ahead ? 'good' : 'bad', urgency: ahead ? 'good' : 'week',
      impact: impactOf(c.money, siteRev, cur, ahead ? 'more than if it moved like the rest' : 'less than if it moved like the rest'),
      eyebrow: `Traffic source · ${name}`,
      title: `${name} ${ahead ? 'pulled ahead of' : 'fell behind'} everyone else`,
      big: [
        { value: format(c.seg[c.idx], c.fmt, cur), label: `${c.label.toLowerCase()}`, delta: fmtDelta(c.segDelta, c.unit), tone: c.segDelta > 0 ? 'up' : 'down' },
        { value: format(c.rest[c.idx], c.fmt, cur), label: 'everyone else', delta: fmtDelta(c.restDelta, c.unit), tone: c.restDelta > 0 ? 'up' : 'down' },
      ],
      why: `The rest of the site didn't move the same way, so this is about ${name}, not the whole site.`,
      detail: {
        explain: `${name}'s ${c.label.toLowerCase()} moved ${fmtDelta(c.segDelta, c.unit)} while everyone else moved ${fmtDelta(c.restDelta, c.unit)}. The gap between them changed beyond its own usual weekly wobble (${fmtBand(c.gapBand.band, c.unit === 'pp' ? 'pp' : 'abs')}).`,
        chart: { weeks: c.weeks, values: c.seg, idx: c.idx, cIdx: c.cIdx, unit: c.unit, band: c.segBand.band, fmt: c.fmt, name },
        table: [[`${name} this week`, format(c.seg[c.idx], c.fmt, cur)], ['Everyone else', format(c.rest[c.idx], c.fmt, cur)], [`${name} usual weekly change`, fmtBand(c.segBand.band, c.unit)]],
        method: 'Money: the extra change beyond what the rest did, times this segment\'s volume and revenue per unit.',
        drill: { tab: 'home', panel: 'hm-contrast', label: 'Segments that stand out' },
      },
    });
  }
  for (const c of structural) {
    if (c.always !== 'lower' || !c.gapMoney || c.share < 0.05 || gapSeen.has(c.value)) continue;
    gapSeen.add(c.value);
    const name = ctx.fieldLabel(c.value, 'segment_value');
    out.push({
      key: `gap|${c.value}|${c.measure}|${week}`, muteKey: `gap|${c.value}|${c.measure}`,
      type: 'opportunity', tone: 'neutral', urgency: 'fyi',
      impact: impactOf(c.gapMoney, siteRev, cur, 'a week at most'),
      eyebrow: `Standing gap · ${name}`,
      title: `${name}'s ${c.label.toLowerCase()} is always below the rest`,
      compare: versus(
        { label: name, value: c.seg[c.idx], text: format(c.seg[c.idx], c.fmt, cur) },
        { label: 'Everyone else', value: c.rest[c.idx], text: format(c.rest[c.idx], c.fmt, cur) },
        c.seg[c.idx] ? `${ratioText(c.rest[c.idx] / c.seg[c.idx])} lower, every whole week` : 'lower every whole week'),
      big: [{ value: shareText(c.share), label: 'of sessions' }],
      why: `It's been lower every whole week, so it isn't news, but it's the biggest gap to work on.`,
      detail: {
        explain: `${name} has had a lower ${c.label.toLowerCase()} than everyone else in every whole week of this data, by at least 25%. Closing the gap would be worth up to ${money(c.gapMoney, cur)} a week. That's an upper bound: these visitors may differ for reasons a page change can't fix.`,
        chart: { weeks: c.weeks, values: c.seg, idx: c.idx, cIdx: c.cIdx >= 0 ? c.cIdx : c.idx - 1, unit: c.unit, band: c.segBand.band, fmt: c.fmt, name },
        table: [[name, format(c.seg[c.idx], c.fmt, cur)], ['Everyone else', format(c.rest[c.idx], c.fmt, cur)], ['Usual gap', c.gapUsual === null ? '–' : fmtDelta(c.gapUsual, c.unit === 'pp' ? 'pp' : 'abs')]],
        method: 'Money: (rest\'s rate − this segment\'s rate) × this segment\'s volume × revenue per unit.',
        drill: { tab: 'funnels', panel: 'fn-segments', label: 'Funnel by segment' },
      },
    });
  }
  return out;
}

// ---------- Hypothesis check: "Is the website broken?" ----------

function brokenCheck(funnel, env) {
  const { ctx, week, compare, full } = env;
  if (!compare) return null;
  const weeks = weeksOf(funnel);
  const idx = weeks.indexOf(week);
  const site = weeklyTotals(funnel, (r) => r.segment === 'all' && r.viewport_type === 'all');
  const siteS = site.get(week)?.sessions || 1;
  const values = [...new Set(funnel.filter((r) => r.segment === 'traffic_source').map((r) => r.segment_value))];
  const rate = (t) => (t?.sessions ? t.orders / t.sessions : null);
  const chans = values.map((v) => {
    const t = weeklyTotals(funnel, (r) => r.segment === 'traffic_source' && r.segment_value === v && r.viewport_type === 'all');
    const series = weeks.map((w) => rate(t.get(w)));
    const b = bandFor(series, weeks.map(full), idx, 'pp');
    const d = changeOf(series[idx], series[weeks.indexOf(compare)], 'pp');
    const j = judge({ delta: d, band: b.band, partial: false, thin: (t.get(week)?.sessions ?? 0) < 500 });
    return { v, name: ctx.fieldLabel(v, 'segment_value'), share: (t.get(week)?.sessions ?? 0) / siteS, d, b, j, series, cur: series[idx] };
  }).filter((c) => c.share >= 0.03 && c.j.badge !== 'cantsay' && !c.j.thin).sort((a, b) => b.share - a.share);
  const fell = chans.filter((c) => c.j.badge === 'moved' && c.d < 0);
  const steady = chans.filter((c) => !(c.j.badge === 'moved' && c.d < 0));
  if (!fell.length || chans.length < 3) return null;
  const supported = fell.length * 3 >= chans.length * 2;
  const list = (xs) => xs.map((c) => c.name).join(xs.length === 2 ? ' and ' : ', ');
  return {
    key: `check|broken|${week}|${compare}`, muteKey: 'check|broken',
    type: 'check', tone: supported ? 'bad' : 'neutral', urgency: supported ? 'now' : 'week', impact: null, priority: true,
    eyebrow: 'Hypothesis check',
    title: '"The website is broken"',
    verdict: supported ? 'The data supports it' : "The data doesn't support it",
    verdictTone: supported ? 'bad' : 'good',
    big: [
      { value: `${fell.length} of ${chans.length}`, label: 'channels converted worse', tone: 'down' },
      { value: `${steady.length}`, label: 'converted as usual', tone: 'up' },
    ],
    why: supported
      ? `Almost every channel's order rate fell beyond its wobble at the same time. That points at the site, not the traffic.`
      : `${list(fell)} converted worse, but ${list(steady.slice(0, 3))} converted as usual on the same site. A broken site would hurt every channel.`,
    detail: {
      explain: `Each channel's order rate this week, against its own usual weekly wobble. If the site were broken, every channel would fall together. ${supported ? 'Most did.' : 'Only some did, so look at what those visitors are being sent to, or who they are.'}`,
      rows: chans.map((c) => [c.name, pct(c.cur), c.d === null ? '–' : fmtDelta(c.d, 'pp'), c.j.badge === 'moved' ? (c.d < 0 ? 'fell' : 'rose') : 'as usual']),
      rowHead: ['Channel', 'Order rate', 'Change', ''],
      method: `Channels with at least 3% of sessions and 500 sessions a week. "Fell" means beyond twice the median of its own whole-week changes.`,
      drill: { tab: 'funnels', panel: 'fn-segments', label: 'Funnel by segment' },
    },
  };
}

// ---------- Journeys: a step that moved on its own, and a shift across journeys ----------

function journeyCards(journeyRows, env) {
  const { ctx, week, compare, full, siteRev, cur } = env;
  if (!compare || !journeyRows?.length) return [];
  const rows = journeyRows.filter((r) => r.kind === 'general' && r.segment === 'all' && r.segment_value === 'all' && r.viewport_type === 'all');
  const weeks = [...new Set(rows.map((r) => r.week))].sort();
  if (!weeks.includes(week)) return [];
  const wc = { week, compare, full, label: shortDate };
  const ranks = new Map();
  for (const r of rows) ranks.set(r.path, Math.min(ranks.get(r.path) ?? Infinity, r.rank));
  const paths = [...ranks.keys()].sort((a, b) => ranks.get(a) - ranks.get(b));
  const sets = paths.map((p) => { const byWeek = weeks.map((w) => laneOf(rows, p, w)); return { p, byWeek, lane: byWeek[weeks.indexOf(week)] }; }).filter((x) => x.lane);
  const peers = sets.map((x) => x.lane);
  for (const x of sets) x.fd = laneFindings({ lane: x.lane, byWeek: x.byWeek, weeks, wc: { ...wc, full }, floor: 300, peers });
  const count = new Map();
  for (const x of sets) for (const m of x.fd.moves) { const k = `${m.key}|${Math.sign(m.d)}`; count.set(k, [...(count.get(k) ?? []), { x, m }]); }
  const minWide = Math.max(2, Math.ceil(sets.length / 2));
  const out = [];
  const lbl = (x, i) => nodeLabel(x.lane.nodes[i], 'general', ctx);
  const valueAt = (x, m) => {
    const next = x.lane.nodes[m.i];
    const perSession = next.reached ? (x.lane.last.revenue ?? 0) / next.reached : 0;
    return (m.d / 100) * x.lane.nodes[m.i - 1].reached * perSession;
  };
  for (const [k, v] of count) {
    if (v.length < minWide) continue;
    const { x, m } = v[0];
    const from = lbl(x, m.i - 1); const to = lbl(x, m.i);
    const total = v.reduce((s, e) => s + valueAt(e.x, e.m), 0);
    const big = v.reduce((a, e) => (Math.abs(e.m.d) > Math.abs(a.m.d) ? e : a));
    const bst = big.x.fd.steps.find((st) => st.key === big.m.key);
    out.push({
      key: `jwide|${k}|${week}|${compare}`, muteKey: `jwide|${k}`,
      type: 'journey', tone: m.d > 0 ? 'good' : 'bad', urgency: m.d > 0 ? 'good' : 'now',
      impact: impactOf(total, siteRev, cur, m.d > 0 ? 'more this week' : 'less this week'),
      eyebrow: 'Across journeys',
      title: `${from} → ${to} ${m.d > 0 ? 'improved' : 'got worse'} in ${v.length} of ${sets.length} top journeys`,
      alarm: m.d < 0 ? { level: 'stop', text: `A site-wide drop, not one journey: fewer get from ${from} to ${to}` } : null,
      compare: versus(
        { label: `${from} → ${to}, journey #${big.x.lane.rank} this week`, value: big.m.cur, text: pct(big.m.cur) },
        { label: `Week of ${shortDate(compare)}`, value: big.m.prev, text: pct(big.m.prev) },
        `${fmtDelta(big.m.d, 'pp')} in the journey that moved most`),
      big: [{ value: `${v.length} of ${sets.length}`, label: 'top journeys moved the same way' }],
      why: 'When the same step moves in most journeys at once, the cause is that step itself, wherever visitors come from.',
      detail: {
        explain: `The share of visitors who went from ${from} to ${to} moved beyond its usual weekly range in ${v.length} of the top ${sets.length} journeys, all in the same direction.`,
        rows: v.map((e) => [`#${e.x.lane.rank} ${prettyPath(e.x.p, 'general', ctx)}`, pct(e.m.cur), fmtDelta(e.m.d, 'pp'), fmtBand(e.m.band, 'pp')]),
        rowHead: ['Journey', 'Step rate', 'Change', 'Band'],
        chart: bst?.series ? { weeks, values: bst.series, idx: weeks.indexOf(week), cIdx: weeks.indexOf(compare), unit: 'pp', band: bst.band, fmt: 'pct', name: `${from} → ${to}, journey #${big.x.lane.rank}` } : null,
        method: 'Money: change in the step rate × sessions that reached the step before × revenue per session that reached the next step, summed over the journeys.',
        drill: { tab: 'journeys', panel: 'jr-flow', state: { laneView: 'changed' }, label: 'Top journeys' },
      },
    });
  }
  for (const x of sets) {
    const own = x.fd.moves.filter((m) => (count.get(`${m.key}|${Math.sign(m.d)}`)?.length ?? 0) < minWide);
    const m = own[0];
    if (!m) continue;
    const from = lbl(x, m.i - 1); const to = lbl(x, m.i);
    const st = x.fd.steps.find((s) => s.i === m.i);
    out.push({
      key: `journey|${x.p}|${m.key}|${week}|${compare}`, muteKey: `journey|${x.p}|${m.key}`,
      type: 'journey', tone: m.d > 0 ? 'good' : 'bad', urgency: m.d > 0 ? 'good' : 'week',
      impact: impactOf(valueAt(x, m), siteRev, cur, m.d > 0 ? 'more this week' : 'less this week'),
      eyebrow: `Journey #${x.lane.rank} · ${prettyPath(x.p, 'general', ctx)}`,
      title: `${m.d > 0 ? 'More' : 'Fewer'} visitors go from ${from} to ${to}`,
      compare: versus(
        { label: `Went on to ${to}, this week`, value: m.cur, text: pct(m.cur) },
        { label: `Week of ${shortDate(compare)}`, value: m.prev, text: pct(m.prev) },
        `${fmtDelta(m.d, 'pp')}; it usually moves about ${fmtBand(m.band / 2, 'pp')} a week`),
      big: [{ value: int(x.lane.nodes[m.i - 1].reached), label: `visitors reached ${from}` }],
      why: `It usually moves about ${fmtBand(m.band / 2, 'pp')} a week, and only this journey moved, so it's about this path.`,
      detail: {
        explain: `Of the visitors on this journey who reached ${from}, ${pct(m.cur)} went on to ${to}, ${m.d > 0 ? 'up' : 'down'} from ${pct(m.prev)}. That's ${(Math.abs(m.d) / m.band).toFixed(1)}× its wobble band of ${fmtBand(m.band, 'pp')}.`,
        chart: st ? { weeks, values: st.series, idx: weeks.indexOf(week), cIdx: weeks.indexOf(compare), unit: 'pp', band: st.band, fmt: 'pct', name: `${from} → ${to}` } : null,
        method: 'Money: change in the step rate × sessions that reached the step before × revenue per session that reached the next step.',
        drill: { tab: 'journeys', panel: 'jr-flow', state: { openLanes: { [x.p]: true } }, label: `Journey #${x.lane.rank}` },
      },
    });
  }
  return out;
}

// ---------- Campaigns: outliers worth acting on, and important week-over-week changes ----------

const CAMPAIGN_OUTLIERS = { volume: 'visits', rate: 'visit_cvr', value: 'rpv', count: 'orders', spread: 2, z: 3, expectZero: 7, material: 0.005 };
const CAMPAIGN_CHANGES = { volume: 'visits', money: 'revenue', metrics: ['visits', 'orders', 'revenue', 'visit_cvr', 'rpv'], material: 0.005, stopShare: 0.1 };

function campaignCards(rows, env) {
  const { ctx, week, siteRev, cur } = env;
  if (!rows?.length) return [];
  const weeks = [...new Set(rows.map((r) => r.week))].filter(Boolean).sort();
  const cov = ctx.cov(weeks, 'weekly_source_campaign');
  const full = (w) => cov.get(String(w))?.full ?? false;
  const cWeek = weeks.includes(week) ? week : weeks[weeks.length - 1];
  const cCompare = compareWeek(weeks, cWeek, ctx.global?.compare ?? 'prev', full);
  const keys = ['src', 'camp'];
  const untagged = (k) => k.camp === null || k.camp === undefined || k.camp === '';
  const name = (g) => (untagged(g.key) ? `${ctx.fieldLabel(g.key.src, 'src')} traffic with no campaign tag` : ctx.entity('camp', g.key.camp, g.first)?.label ?? g.key.camp);
  const defs = ['visits', 'orders', 'revenue', 'visit_cvr', 'rpv'].map((id) => ctx.measure(id));
  const weekRows = rows.filter((r) => r.week === cWeek);
  const groups = aggregate(weekRows, keys, defs);
  const flags = findOutliers({ groups, keys, cfg: CAMPAIGN_OUTLIERS, measure: ctx.measure, floorMin: 100, history: null });
  const total = groups.reduce((a, g) => ({ visits: a.visits + (g.sums.visits ?? 0), revenue: a.revenue + (g.sums.revenue ?? 0), orders: a.orders + (g.sums.orders ?? 0) }), { visits: 0, revenue: 0, orders: 0 });
  const aov = total.orders ? total.revenue / total.orders : 0;
  const out = [];
  const keyOf = (g) => keys.map((k) => g.key[k]).join('\u0001');

  // Funnel steps per campaign, to say where a weak campaign loses its visitors.
  const blank = () => ({ visits: 0, atc: 0, chk: 0, orders: 0, mobile: 0 });
  const add = (t, r) => { t.visits += +r.visits || 0; t.atc += +r.atc_visits || 0; t.chk += +r.checkout_visits || 0; t.orders += +r.orders || 0; if (r.dev_s === 'mobile') t.mobile += +r.visits || 0; return t; };
  const steps = new Map(); const all = blank();
  for (const r of weekRows) {
    const k = [r.src, r.camp].join('\u0001');
    if (!steps.has(k)) steps.set(k, { ...blank(), key: { src: r.src, camp: r.camp }, first: r });
    add(steps.get(k), r); add(all, r);
  }
  const div = (a, b) => (b ? a / b : null);
  const leadOf = (g, nm) => {
    const me = steps.get(keyOf(g));
    if (!me || !all.atc) return null;
    const rest = { visits: all.visits - me.visits, atc: all.atc - me.atc, chk: all.chk - me.chk, orders: all.orders - me.orders, mobile: all.mobile - me.mobile };
    const stages = [
      { id: 'cart', label: 'Added to cart', mine: div(me.atc, me.visits), rest: div(rest.atc, rest.visits), base: me.visits },
      { id: 'checkout', label: 'Cart → checkout', mine: div(me.chk, me.atc), rest: div(rest.chk, rest.atc), base: me.atc },
      { id: 'buy', label: 'Checkout → order', mine: div(me.orders, me.chk), rest: div(rest.orders, rest.chk), base: me.chk },
    ];
    const usable = stages.filter((x) => x.base >= 30 && x.rest > 0 && x.mine !== null);
    if (!usable.length) return null;
    const worst = usable.reduce((a, x) => (x.mine / x.rest < a.mine / a.rest ? x : a));
    if (worst.mine / worst.rest > 0.7) return null;
    const vs = `against ${pct(worst.rest)} for your other campaigns`;
    const text = worst.id === 'cart' ? `It breaks before the cart: only ${pct(worst.mine)} add to cart, ${vs}. Look at the landing page and whether it matches what the ad promises.`
      : worst.id === 'checkout' ? `Visitors add to cart, but only ${pct(worst.mine)} go on to checkout, ${vs}. Look at the cart: shipping cost, fees, anything unexpected.`
        : `Visitors reach checkout, but only ${pct(worst.mine)} finish, ${vs}. Look at payment and the checkout itself.`;
    const short = worst.id === 'cart' ? 'before the cart' : worst.id === 'checkout' ? 'between cart and checkout' : 'inside checkout';
    const extra = [];
    const product = !untagged(g.key) && nm.split(' · ').length >= 3 ? nm.split(' · ')[2] : null;
    if (product && worst.id === 'cart') {
      const sib = [...steps.values()].filter((t) => t !== me && !untagged(t.key) && t.visits >= 1000 && div(t.atc, t.visits) >= Math.max(3 * worst.mine, 0.6 * worst.rest))
        .map((t) => ({ t, nm: name(t) })).filter((x) => x.nm.split(' · ')[2] === product)
        .sort((a, b) => b.t.visits - a.t.visits)[0];
      if (sib) extra.push({ text: `Another ${product} campaign adds to cart at ${pct(div(sib.t.atc, sib.t.visits))}, so it isn't the product. Compare the two landing pages.`, name: sib.nm });
    }
    const mob = div(me.mobile, me.visits); const rmob = div(rest.mobile, rest.visits);
    if (mob !== null && rmob !== null && Math.abs(mob - rmob) >= 0.15) extra.push({ text: `It's ${Math.round(mob * 100)}% mobile, against ${Math.round(rmob * 100)}% for your other campaigns.` });
    return { short: `Where it breaks: ${short}`, text, extra, rows: stages.filter((x) => x.mine !== null && x.rest !== null).map((x) => [x.label, pct(x.mine), pct(x.rest)]), rowHead: ['Step', 'This campaign', 'Other campaigns'] };
  };
  const namesOf = (g, nm) => (untagged(g.key) ? [] : [{ text: nm, kind: 'campaign', source: [
    ['Where it comes from', 'The campaign tags on each visit'], ['utm_source', String(g.key.src ?? '–')], ['utm_medium', String(g.first?.med ?? '–')], ['utm_campaign', String(g.key.camp)],
    ['Readable name', 'Made from the tag by our naming step. Rename it if it reads wrong.']] }]);

  for (const g of groups) {
    const reasons = flags.get(g) ?? [];
    for (const r of reasons) {
      const nm = name(g);
      const visits = g.sums.visits ?? 0; const orders = g.sums.orders ?? 0; const revenue = g.sums.revenue ?? 0;
      const src = ctx.fieldLabel(g.key.src, 'src');
      const drill = { tab: 'acquisition', panel: 'acq-campaigns', pickers: { week: cWeek }, state: { outlierView: 'outliers' }, label: 'Campaigns' };
      if (r.kind === 'none') {
        const impact = impactOf(r.expected * aov, siteRev, cur, 'a week if it sold like the rest');
        if (impact && r.expected >= 15) impact.tier = 'High';
        out.push({
          key: `camp|none|${keyOf(g)}|${cWeek}`, muteKey: `camp|none|${keyOf(g)}`, type: 'campaign', tone: 'bad',
          urgency: r.expected >= 15 ? 'now' : 'week', impact,
          eyebrow: `Campaign · ${src}`, title: `${nm} is dead traffic`, names: namesOf(g, nm),
          alarm: { level: 'stop', text: `0 orders from ${int(visits)} visits` },
          compare: versus({ label: 'Orders this week', value: 0, text: '0' }, { label: "At your other campaigns' rate", value: r.expected, text: `≈${Math.round(r.expected)}` }, `from ${int(visits)} visits`),
          big: [],
          lead: leadOf(g, nm),
          why: "At the rest of your campaigns' rate it would have sold. Zero is very unlikely to be chance.",
          detail: { explain: `${nm} sent ${int(visits)} visits the week of ${shortDate(cWeek)} and none bought. At the order rate of your other campaigns it would have had about ${Math.round(r.expected)} orders.`, table: [['Visits', int(visits)], ['Orders', '0'], ['Expected orders', `≈${Math.round(r.expected)}`]], method: 'Money: expected orders × your average order value this week.', drill },
        });
      } else if (r.kind === 'low' || r.kind === 'high') {
        const hi = r.kind === 'high';
        const m = hi ? revenue : Math.max(0, (r.restRate * visits - orders) * aov);
        const ratio = hi ? r.times : r.value ? r.typical / r.value : null;
        const extreme = ratio === null || ratio >= 10;
        const impact = impactOf(m, siteRev, cur, hi ? 'a week now' : 'a week if it converted like the rest');
        if (impact && extreme && !hi) impact.tier = 'High';
        out.push({
          key: `camp|${r.kind}|${keyOf(g)}|${cWeek}`, muteKey: `camp|${r.kind}|${keyOf(g)}`, type: hi ? 'opportunity' : 'campaign', tone: hi ? 'good' : 'bad',
          urgency: hi ? 'good' : extreme ? 'now' : 'week', impact,
          eyebrow: `Campaign · ${src}`, names: namesOf(g, nm),
          title: hi ? `${nm} earns ${ratioText(r.times)} a typical campaign` : `${nm} converts far below your other campaigns`,
          alarm: extreme ? (hi ? (visits >= 300 ? { level: 'star', text: `${ratioText(r.times)} the revenue per visit of a typical campaign` } : null) : { level: 'stop', text: ratio === null ? 'Almost no revenue from real traffic' : `${ratioText(ratio)} below a typical campaign` }) : null,
          compare: versus(
            { label: 'Revenue per visit, this campaign', value: r.value, text: format(r.value, 'money', cur) },
            { label: 'Typical campaign', value: r.typical, text: format(r.typical, 'money', cur) },
            ratio ? `${ratioText(ratio)} ${hi ? 'higher' : 'lower'}, from ${int(visits)} visits` : `from ${int(visits)} visits`),
          big: [],
          lead: hi ? null : leadOf(g, nm),
          why: hi ? 'A candidate to scale: it earns well above the rest, and the difference is far beyond chance.' : 'It takes real traffic and converts well below the rest, beyond chance.',
          detail: { explain: `Revenue per visit ${format(r.value, 'money', cur)} against ${format(r.typical, 'money', cur)} for a typical campaign. Order rate ${pct(r.rate)} against ${pct(r.restRate)} for the rest (z = ${r.z.toFixed(1)}).`, table: [['Visits', int(visits)], ['Orders', int(orders)], ['Revenue', format(revenue, 'money', cur)]], method: hi ? 'Money: what it earned this week.' : "Money: orders it would have had at the rest's rate, minus its orders, × average order value.", drill },
        });
      }
    }
  }
  if (cCompare) {
    const res = findChanges({ rows, keys, weekField: 'week', week: cWeek, compare: cCompare, full, cfg: CAMPAIGN_CHANGES, measure: ctx.measure, floorMin: 100 });
    const tiles = [...res.sections.started, ...res.sections.stopped, ...res.sections.traffic].sort((a, b) => Math.abs(b.moneyDelta ?? 0) - Math.abs(a.moneyDelta ?? 0)).slice(0, 3);
    for (const t of tiles) {
      const g = { key: t.key, first: t.first };
      const nm = name(g);
      const kind = t.kind;
      const up = kind === 'started' || (kind === 'traffic' && t.cur > t.prev);
      out.push({
        key: `chg|${kind}|${keyOf(g)}|${cWeek}`, muteKey: `chg|${kind}|${keyOf(g)}`, type: 'campaign', tone: up ? 'good' : 'bad',
        urgency: kind === 'stopped' ? 'now' : up ? 'good' : 'week',
        impact: res.partial ? null : impactOf(t.moneyDelta, siteRev, cur, up ? 'more than last week' : 'less than last week'),
        eyebrow: `Campaign · ${ctx.fieldLabel(t.key.src, 'src')}`, names: namesOf(g, nm),
        title: kind === 'started' ? `New campaign: ${nm}` : kind === 'stopped' ? `${nm} stopped sending traffic` : `${nm} traffic ${up ? 'jumped' : 'dropped'}`,
        alarm: kind === 'stopped' ? { level: 'stop', text: 'A campaign went quiet' } : null,
        compare: versus({ label: 'Visits this week', value: t.cur, text: int(t.cur) }, { label: `Week of ${shortDate(cCompare)}`, value: t.prev ?? 0, text: int(t.prev) }, t.prev ? fmtDelta((t.cur / t.prev - 1) * 100, '%', 0) : 'new this week'),
        big: [],
        why: kind === 'stopped' ? "If that wasn't planned, a link, budget or tracking tag may have broken." : kind === 'started' ? 'Check it lands on the right page and that it converts.' : 'A move this big is outside its usual weekly range.',
        detail: { explain: `Visits went from ${int(t.prev)} to ${int(t.cur)}${res.partial ? '. This week is a part week, so money is left out' : ''}.`, method: 'From the Important changes section of the Acquisition tab.', drill: { tab: 'acquisition', panel: 'acq-changes', label: 'Important changes' } },
      });
    }
  }
  return out.sort((a, b) => (b.impact?.money ?? 0) - (a.impact?.money ?? 0)).slice(0, 5);
}

// ---------- Experiments: is it running cleanly, and is anything winning? ----------

function experimentCards(rows, env) {
  const { ctx, week, siteRev, cur } = env;
  if (!rows?.length) return [];
  const base = rows.filter((r) => r.basis === 'assigned' && (r.viewport_type === 'all' || !r.viewport_type));
  const by = new Map();
  for (const r of base) {
    const e = by.get(r.experiment) ?? { key: r.experiment_key, arms: new Map(), weeks: new Set() };
    const a = e.arms.get(r.arm) ?? { arm: r.arm, control: Number(r.is_control) === 1, sessions: 0, orders: 0, revenue: 0, week: 0 };
    a.sessions += Number(r.sessions) || 0; a.orders += Number(r.orders) || 0; a.revenue += Number(r.revenue) || 0;
    if (r.week === week) a.week += Number(r.sessions) || 0;
    e.arms.set(r.arm, a); e.weeks.add(r.week); by.set(r.experiment, e);
  }
  const out = [];
  for (const [exp, e] of by) {
    const arms = [...e.arms.values()];
    const live = arms.reduce((s, a) => s + a.week, 0);
    if (arms.length < 2 || live < 500 || /control vs control|a\/a/i.test(exp)) continue;
    const control = arms.find((a) => a.control) ?? arms[0];
    const variants = arms.filter((a) => a !== control);
    const best = variants.sort((a, b) => b.revenue / (b.sessions || 1) - a.revenue / (a.sessions || 1))[0];
    const total = arms.reduce((s, a) => s + a.sessions, 0);
    const expected = total / arms.length;
    const chi = arms.reduce((s, a) => s + (a.sessions - expected) ** 2 / expected, 0);
    const srm = arms.length === 2 && chi > 10.83;
    const rps = (a) => (a.sessions ? a.revenue / a.sessions : 0);
    const lift = rps(control) ? (rps(best) / rps(control) - 1) * 100 : null;
    const p1 = best.orders / (best.sessions || 1); const p0 = control.orders / (control.sessions || 1);
    const pool = (best.orders + control.orders) / ((best.sessions + control.sessions) || 1);
    const se = Math.sqrt(pool * (1 - pool) * (1 / (best.sessions || 1) + 1 / (control.sessions || 1)));
    const z = se ? (p1 - p0) / se : 0;
    const real = Math.abs(z) >= 2.58;
    const leaning = !real && Math.abs(z) >= 1.96;
    const nm = ctx.names?.resolve('experiment', exp)?.label ?? exp;
    const armName = (a) => ctx.names?.resolve('experiment_arm', `${e.key}|${a.arm}`)?.label ?? (a.control ? 'Control' : 'Variant');
    const vName = armName(best);
    const stake = lift !== null ? (rps(best) - rps(control)) * live : null;
    const up = lift > 0;
    const verdict = srm ? 'Check the setup before reading results' : real ? (up ? 'Real win' : 'Real loss') : leaning ? `Leaning ${up ? 'ahead' : 'behind'}, not settled` : 'Noise so far';
    const title = srm ? 'The traffic split in this test looks broken'
      : real ? (up ? `${vName} beats the current site` : `${vName} is losing to the current site`)
        : leaning ? `${vName} is leaning ${up ? 'ahead of' : 'behind'} the current site`
          : `No real difference yet between ${vName} and the current site`;
    const names = [
      { text: nm, kind: 'experiment', source: [['Where it comes from', 'The test name in your testing tool'], ['Test id', String(e.key)]] },
      ...(armName(best) !== 'Variant' ? [{ text: vName, kind: 'arm', source: [['Where it comes from', 'The variant name in your testing tool'], ['Variant id', String(best.arm)]] }] : []),
    ];
    const impact = srm || (!real && !leaning) ? null : impactOf(stake, siteRev, cur, up ? 'a week more if you ship it' : 'a week lost if you ship it');
    out.push({
      key: `xp|${exp}|${week}`, muteKey: `xp|${exp}`,
      type: 'experiment', tone: srm ? 'bad' : (real || leaning) ? (up ? 'good' : 'bad') : 'neutral',
      urgency: srm ? 'now' : real ? 'week' : leaning ? 'week' : 'fyi',
      impact, names,
      eyebrow: `Test · ${nm}`,
      title, verdict, verdictTone: srm ? 'bad' : real || leaning ? (up ? 'good' : 'bad') : 'neutral',
      alarm: srm ? { level: 'stop', text: 'Results from this test are unreliable until the split is fixed' } : real && up && impact?.tier !== 'Low' ? { level: 'star', text: `Winner: ${fmtDelta(lift, '%', 1)} revenue per visitor` } : null,
      compare: srm ? null : versus(
        { label: `Revenue per visitor, ${vName}`, value: rps(best), text: format(rps(best), 'money', cur) },
        { label: 'Current site (the control)', value: rps(control), text: format(rps(control), 'money', cur) },
        `${lift === null ? '' : `${fmtDelta(lift, '%', 1)}, `}${int(total)} visitors so far`),
      big: srm ? arms.map((a) => ({ value: `${Math.round(a.sessions / total * 100)}%`, label: armName(a) })) : [],
      forecast: impact ? (up ? `≈ ${money(impact.money * MONTH, cur)} a month more if you ship it` : `≈ ${money(impact.money * MONTH, cur)} a month lost if you ship it`) : null,
      why: srm ? `Arms should get about equal traffic, but they're ${arms.map((a) => `${Math.round(a.sessions / total * 100)}%`).join(' / ')}. Uneven splits usually mean a setup bug.`
        : real ? `The control is your site as it is today. A gap this size is very unlikely to be chance.`
          : leaning ? `The control is your site as it is today. ${up ? 'The variant' : 'The current site'} is ahead so far, but the gap could still be chance. Let it run.`
            : `The control is your site as it is today. The gap is small enough to be chance. Keep it running, or call it a tie.`,
      detail: {
        explain: `${arms.length} arms, ${int(total)} assigned visitors over ${e.weeks.size} weeks. The control is the site as it is today; the other arms change one thing. This prototype doesn't run a full significance or sample-ratio test; the z-score (${z.toFixed(1)}) and split check are rough guides.`,
        rows: arms.map((a) => [armName(a), int(a.sessions), pct(a.orders / (a.sessions || 1)), format(rps(a), 'money', cur)]),
        rowHead: ['Arm', 'Visitors', 'Order rate', 'Revenue / visitor'],
        method: 'Split check: chi-square against an even split (flag above 10.83). Signal: two-proportion z on order rate, leader vs control. Real: |z| ≥ 2.58. Leaning: |z| ≥ 1.96.',
        drill: { tab: 'experiments', panel: 'xp-arms', pickers: { experiment: exp }, label: 'the test' },
      },
    });
  }
  return out.sort((a, b) => URGENCY[a.urgency].rank - URGENCY[b.urgency].rank).slice(0, 3);
}

// ---------- The deck ----------

// What the weekly money means over a month if nothing changes. A rough line, not a model.
function forecastOf(c, cur) {
  if (!c.impact) return null;
  const m = money(c.impact.money * MONTH, cur);
  if (c.impact.text.includes('at most')) return `Up to ≈ ${m} a month if you close the gap`;
  if (c.type === 'opportunity') return `≈ ${m} a month at this rate, more if you scale it`;
  if (c.tone === 'bad') return `≈ ${m} a month lost if this continues`;
  if (c.tone === 'good') return `≈ ${m} a month more if this holds`;
  return `≈ ${m} a month`;
}

export function buildDeck({ funnel, journeys, journeySummary, campaigns, experiments, ctx }) {
  const t0 = performance.now();
  const weeks = weeksOf(funnel);
  const full = ctx.full;
  const fullWeeks = weeks.filter(full);
  const week = weeks.includes(ctx.global?.week) ? ctx.global.week : fullWeeks[fullWeeks.length - 1] ?? weeks[weeks.length - 1];
  const compare = compareWeek(weeks, week, ctx.global?.compare ?? 'prev', full);
  const kpi = wobbleCheck(funnel, { week, compare: ctx.global?.compare ?? 'prev', device: 'all', full });
  const siteRev = kpi.measures.find((m) => m.id === 'revenue')?.cur ?? 0;
  const env = { ctx, week, compare, full, siteRev, cur: ctx.currency };
  const safe = (fn) => { try { return fn() ?? []; } catch (err) { console.warn('homework:', err); return []; } };
  const moved = safe(() => movedCards(funnel, journeySummary, env));
  const taken = new Set(moved.map((c) => `${c.key.split('|')[2]}|${c.tone === 'good' ? 1 : -1}`));
  const cards = [
    ...moved,
    ...safe(() => [brokenCheck(funnel, env)].filter(Boolean)),
    ...safe(() => segmentCards(funnel, env, taken)),
    ...safe(() => journeyCards(journeys, env)),
    ...safe(() => campaignCards(campaigns, env)),
    ...safe(() => experimentCards(experiments, env)),
  ];
  const seen = new Set();
  const deck = cards.filter((c) => (seen.has(c.key) ? false : seen.add(c.key)));
  for (const c of deck) {
    if (c.forecast === undefined) c.forecast = forecastOf(c, env.cur);
    if (!c.alarm && c.urgency === 'now' && c.tone === 'bad') c.alarm = { level: 'stop', text: 'This one needs a look this week' };
  }
  deck.filter((c) => c.alarm?.level === 'star').sort((a, b) => (b.impact?.money ?? 0) - (a.impact?.money ?? 0)).slice(2).forEach((c) => { c.alarm = null; });
  const score = (c) => URGENCY[c.urgency].rank * 10 - (c.priority ? 5 : 0) - (c.impact ? { High: 3, Medium: 2, Low: 1 }[c.impact.tier] : 0);
  deck.sort((a, b) => score(a) - score(b) || (b.impact?.money ?? 0) - (a.impact?.money ?? 0));
  return { week, compare, weeks, kpi, deck, ms: performance.now() - t0 };
}
