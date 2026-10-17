// "This week" and "What moved?": answer line, movers, revenue split, verdict summary.
import { format } from './query.js';
import { h, s } from './views.js';
import { HOME_MEASURES, MOVER_MEASURES, wobbleCheck, moverCandidates, mergeMovers, mixDecomp, weeksOf, weeklyTotals } from './derive.js';
import { badgeText, fmtBand, fmtDelta, tooltip } from './wobble.js';

const shortDate = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
const money = (v, ctx, digits) => {
  const abs = Math.abs(v);
  const text = abs >= 1e6 ? `$${(abs / 1e6).toFixed(2)}M` : abs >= 1e4 ? `$${Math.round(abs / 1e3).toLocaleString()}K` : format(abs, 'money', ctx.currency);
  return digits === 'exact' ? format(v, 'money', ctx.currency) : `${v < 0 ? '−' : ''}${text}`;
};
const signedMoney = (v, ctx) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${format(Math.abs(Math.round(v)), 'money', ctx.currency)}`;

const FAMILY = { traffic_source: 'Traffic source', returning: 'New or returning', device: 'Device', journey: 'Journeys', buyer: 'Buyer', rager: 'Rager' };
const SCOPE = (ctx) => ctx.wobble?.bandScope ?? 'self';

export function wobbleBadge(j, title) {
  return h('span', { class: `wb ${j.badge}${j.thin ? ' thin' : ''}`, title }, badgeText(j), j.thin ? ' · thin' : '');
}

function subjectLabel(c, ctx) {
  if (c.family === 'journey') return String(c.value).split(' > ').map((p) => ctx.fieldLabel(p, 'step')).join(' → ');
  return ctx.fieldLabel(c.value, c.family === 'device' ? 'viewport_type' : 'segment_value');
}

function moverName(c, ctx) {
  return c.family === 'journey' ? `${subjectLabel(c, ctx)} completion` : `${subjectLabel(c, ctx)} ${c.measureLabel.toLowerCase()}`;
}

function spark(values, idx) {
  const pts = values.map((v, i) => [i, v]).filter(([, v]) => v !== null && v !== undefined);
  if (pts.length < 2) return h('span', {});
  const w = 90; const ht = 24;
  const lo = Math.min(...pts.map((p) => p[1])); const hi = Math.max(...pts.map((p) => p[1]));
  const sx = (i) => 3 + (i / (values.length - 1)) * (w - 6);
  const sy = (v) => (hi === lo ? ht / 2 : ht - 4 - ((v - lo) / (hi - lo)) * (ht - 8));
  const d = pts.map(([i, v], n) => `${n ? 'L' : 'M'}${sx(i).toFixed(1)},${sy(v).toFixed(1)}`).join(' ');
  const svg = s('svg', { width: w, height: ht, class: 'spark' }, s('path', { d, fill: 'none', stroke: '#2c5f8a', 'stroke-width': 1.5 }));
  const cur = pts.find(([i]) => i === idx);
  if (cur) svg.append(s('circle', { cx: sx(cur[0]), cy: sy(cur[1]), r: 2.6, fill: '#2c5f8a' }));
  return svg;
}

function drillFor(c, ctx) {
  const label = moverName(c, ctx);
  if (c.family === 'traffic_source' || c.family === 'returning' || c.family === 'buyer' || c.family === 'rager') {
    return () => ctx.drill({ tab: 'journeys', panel: 'jr-flow', pickers: { kind: 'general', segment: c.family, segment_value: c.value }, label });
  }
  if (c.family === 'device') return () => ctx.drill({ tab: 'funnels', panel: 'fn-funnel', pickers: { viewport_type: c.value }, label });
  return () => ctx.drill({ tab: 'funnels', panel: 'fn-funnel', label });
}

function valueText(c, ctx) {
  return format(c.cur, c.fmt, ctx.currency);
}

const opts = (ctx, extra = {}) => ({ week: ctx.global.week, compare: ctx.global.compare, device: ctx.global.device, full: ctx.full, scope: SCOPE(ctx), ...extra });

// ---------- answer line ----------

export function answerline(panel, rows, ctx) {
  const w = wobbleCheck(rows, opts(ctx));
  const cmpText = w.compare ? `the week of ${shortDate(w.compare)}` : 'nothing';
  const link = (m, text) => h('a', { href: '#', class: 'num-link', title: tooltip({ label: m.label, unit: m.unit, band: m.band, median: m.median, n: m.n, delta: m.delta, j: m, scope: 'site' }),
    onclick: (e) => { e.preventDefault(); ctx.log('answer_click', { measure: m.id }); ctx.drill({ tab: 'funnels', panel: 'fn-weekly', state: { measure: m.id === 'order_rate' ? 'cvr' : m.id }, label: `${m.label}, by week` }); } }, text);
  const clause = (m) => [h('strong', {}, m.label.toLowerCase()), ' ', link(m, fmtDelta(m.delta, m.unit)), ` (${fmtBand(m.band, m.unit)})`];
  let sentence;
  let tone;
  const cantsay = w.measures.filter((m) => m.badge === 'cantsay');
  const moved = w.measures.filter((m) => m.badge === 'moved').sort((a, b) => Math.abs(b.delta) / b.band - Math.abs(a.delta) / a.band);
  const within = w.measures.filter((m) => m.badge === 'within');
  if (!w.compare) {
    tone = 'cantsay';
    sentence = ['Can\'t say yet: no comparison week is chosen. Pick one in "Compare with".'];
  } else if (cantsay.length === w.measures.length) {
    tone = 'cantsay';
    sentence = [`Can't say yet: ${cantsay[0].reason}.`];
  } else if (moved.length) {
    tone = 'moved';
    sentence = [`Worth a look: ${moved.length} of ${w.measures.length} measures moved beyond their usual weekly wobble — `,
      moved.map((m, i) => [i ? ', ' : '', clause(m)]), '.',
      within.length ? [' ', within.map((m, i) => [i ? ' and ' : '', h('strong', {}, m.label), ' ', link(m, fmtDelta(m.delta, m.unit))]), ` ${within.length > 1 ? 'are' : 'is'} within ${within.length > 1 ? 'their' : 'its'} wobble (${within.map((m) => fmtBand(m.band, m.unit)).join(', ')}).`] : ''];
  } else {
    tone = 'ok';
    const rev = w.measures.find((m) => m.id === 'revenue');
    sentence = ['The site is OK. Revenue ', link(rev, fmtDelta(rev.delta, rev.unit)), ` is inside its normal weekly wobble (${fmtBand(rev.band, rev.unit)}), and so are sessions, orders and order rate.`];
  }
  ctx.log('answer_rendered', { tone, moved: moved.map((m) => m.id) });
  const cards = w.measures.map((m) => h('div', { class: `kpi ${m.badge}` },
    h('div', { class: 'kpi-label' }, m.label),
    h('div', { class: 'kpi-value' }, format(m.cur, m.fmt, ctx.currency)),
    h('div', { class: 'kpi-delta' }, fmtDelta(m.delta, m.unit), ' ', wobbleBadge(m, tooltip({ label: m.label, unit: m.unit, band: m.band, median: m.median, n: m.n, delta: m.delta, j: m, scope: 'site' }))),
    h('div', { class: 'kpi-band muted small' }, `usual wobble ${fmtBand(m.band, m.unit)}`)));
  return [
    h('p', { class: `answer ${tone}` }, sentence),
    h('div', { class: 'kpis' }, cards),
    h('p', { class: 'foot' }, `Checked sessions, orders, revenue and order rate for the week of ${shortDate(w.week)} against ${cmpText}, using whole weeks from the funnel data. A measure "moved" when its change is bigger than twice its median week-to-week change over the whole weeks before.`),
  ];
}

// ---------- movers ----------

function moverRow(c, ctx, idx) {
  const tip = tooltip({ label: moverName(c, ctx), unit: c.unit, band: c.band, median: c.median, n: c.n, delta: c.delta, j: c, scope: SCOPE(ctx) });
  return h('tr', { class: 'mover', onclick: drillFor(c, ctx), title: 'Open the evidence' },
    h('td', { class: 'label' }, h('div', { class: 'mv-name' }, moverName(c, ctx)),
      c.also?.length ? h('div', { class: 'also' }, 'Also seen in: ', c.also.map((a, i) => [i ? ', ' : '', h('a', { href: '#', onclick: (e) => { e.preventDefault(); e.stopPropagation(); ctx.log('movers_click', { also: a.value }); drillFor(a, ctx)(); } }, `${subjectLabel(a, ctx)} ${fmtDelta(a.delta, a.unit)}`)])) : null),
    h('td', { class: 'muted small' }, FAMILY[c.family] ?? c.family),
    h('td', { class: 'num now' }, valueText(c, ctx)),
    h('td', { class: `num change ${c.delta > 0 ? 'up' : c.delta < 0 ? 'down' : ''}` }, fmtDelta(c.delta, c.unit)),
    h('td', {}, wobbleBadge(c, tip)),
    h('td', { class: 'num muted small' }, fmtBand(c.band, c.unit)),
    h('td', { class: 'num muted small' }, `n ${format(c.sessions, 'int')}`),
    h('td', {}, spark(c.values, idx)));
}

function moverTable(list, ctx, idx) {
  return h('div', { class: 'scroll' }, h('table', { class: 'grid movers' },
    h('thead', {}, h('tr', {}, h('th', { class: 'label' }, 'What moved'), h('th', {}, 'Breakdown'), h('th', { class: 'num' }, 'This week'), h('th', { class: 'num' }, 'Change'), h('th', {}, 'Wobble'), h('th', { class: 'num' }, 'Band'), h('th', { class: 'num' }, 'Volume'), h('th', {}, 'Trend'))),
    h('tbody', {}, list.map((c) => moverRow(c, ctx, idx)))));
}

export function movers(panel, rows, ctx) {
  const mc = moverCandidates(rows, ctx.also.journey_summary, opts(ctx));
  const idx = mc.weeks.indexOf(mc.week);
  const kept = mergeMovers(mc.candidates);
  const moved = mc.candidates.filter((c) => c.badge === 'moved').length;
  const limit = panel.limit ?? 5;
  ctx.log('badge_counts', { panel: panel.id, moved, total: mc.candidates.length, cantsay: mc.candidates.filter((c) => c.badge === 'cantsay').length });
  const out = [];
  if (!mc.compare) return [h('p', { class: 'blocked' }, 'Pick a week to compare with to see what moved.')];
  out.push(kept.length ? moverTable(kept.slice(0, limit), ctx, idx) : h('p', { class: 'answer ok' }, `Nothing moved beyond its usual wobble this week (${mc.candidates.length} things checked).`));
  const showAll = ctx.state.all;
  out.push(h('p', { class: 'foot' },
    `${moved} of ${mc.candidates.length} things checked moved beyond their own usual weekly wobble. Same change in different breakdowns is shown once, with the others under "Also seen in". Ranked by size of move against its band, times its share of sessions. Click a row for the evidence. `,
    h('a', { href: '#', onclick: (e) => { e.preventDefault(); ctx.set({ all: !showAll }); } }, showAll ? 'Hide the full list' : `Show all ${mc.candidates.length}`)));
  if (showAll) {
    const all = [...mc.candidates].sort((a, b) => (b.badge === 'moved') - (a.badge === 'moved') || b.score - a.score || Math.abs(b.delta ?? 0) / (b.band || 1) - Math.abs(a.delta ?? 0) / (a.band || 1));
    out.push(moverTable(all, ctx, idx));
  }
  return out;
}

const BY_MEASURE = [...HOME_MEASURES];

export function moverlists(panel, rows, ctx) {
  const idx = weeksOf(rows).indexOf(ctx.global.week);
  if (panel.mode === 'measure') {
    const mc = moverCandidates(rows, ctx.also.journey_summary, opts(ctx, { measures: BY_MEASURE }));
    const kept = mergeMovers(mc.candidates);
    const groups = [...BY_MEASURE.map((m) => ({ title: m.label, list: kept.filter((c) => c.measure === m.id) })), { title: 'Journey completion', list: kept.filter((c) => c.family === 'journey') }];
    return [h('div', { class: 'mv-cols' }, groups.map((g) => h('div', { class: 'mv-col' }, h('h4', {}, g.title),
      g.list.length ? h('ol', {}, g.list.slice(0, 5).map((c) => h('li', { onclick: drillFor(c, ctx) },
        h('span', {}, subjectLabel(c, ctx)), ' ', h('span', { class: `change ${c.delta > 0 ? 'up' : 'down'}` }, fmtDelta(c.delta, c.unit)), ' ',
        wobbleBadge(c, tooltip({ label: moverName(c, ctx), unit: c.unit, band: c.band, median: c.median, n: c.n, delta: c.delta, j: c, scope: SCOPE(ctx) })),
        c.also?.length ? h('div', { class: 'also' }, `also ${c.also.map((a) => subjectLabel(a, ctx)).join(', ')}`) : null)))
        : h('p', { class: 'muted small' }, 'Nothing moved beyond its wobble.')))),
    h('p', { class: 'foot' }, 'Top five per measure that moved beyond their own wobble. Merged across breakdowns as on the home tab.')];
  }
  const families = ['traffic_source', 'returning', 'buyer'];
  const mc = moverCandidates(rows, ctx.also.journey_summary, opts(ctx, { families }));
  const groups = [...families, 'device', 'journey'].map((f) => ({ f, list: mc.candidates.filter((c) => c.family === f) }));
  const rank = (a, b) => (b.badge === 'moved') - (a.badge === 'moved') || Math.abs(b.delta ?? 0) / (b.band || 1) * b.share - Math.abs(a.delta ?? 0) / (a.band || 1) * a.share;
  return [h('div', { class: 'mv-cols' }, groups.filter((g) => g.list.length).map((g) => h('div', { class: 'mv-col' },
    h('h4', {}, FAMILY[g.f]),
    g.f === 'buyer' ? h('p', { class: 'chip trap' }, 'Buyer: the buying rate is 100% by construction. Read volumes, not rates.') : null,
    h('ol', {}, [...g.list].sort(rank).slice(0, 6).map((c) => h('li', { onclick: drillFor(c, ctx) },
      h('span', {}, g.f === 'journey' ? subjectLabel(c, ctx) : `${subjectLabel(c, ctx)} · ${c.measureLabel.toLowerCase()}`), ' ',
      h('span', { class: `change ${c.delta > 0 ? 'up' : 'down'}` }, fmtDelta(c.delta, c.unit)), ' ',
      wobbleBadge(c, tooltip({ label: moverName(c, ctx), unit: c.unit, band: c.band, median: c.median, n: c.n, delta: c.delta, j: c, scope: SCOPE(ctx) })))))))),
  h('p', { class: 'foot' }, 'Each list ranks one breakdown on its own, so nothing is merged here. Moved items come first.')];
}

// ---------- decomposition ----------

export function decompose(panel, rows, ctx) {
  const split = panel.ownSplit ? (ctx.state.split ?? ctx.global.split) : ctx.global.split;
  const outcome = panel.ownSplit ? (ctx.state.outcome ?? 'revenue') : 'revenue';
  const d = mixDecomp(rows, { ...opts(ctx), split, outcome });
  const controls = panel.ownSplit ? h('div', { class: 'view-controls' },
    h('label', { class: 'picker' }, h('span', {}, 'Split by'), h('select', { onchange: (e) => ctx.set({ split: e.target.value }) },
      [['traffic_source', 'Traffic source'], ['returning', 'New or returning'], ['rager', 'Rager'], ['device', 'Device']].map(([v, l]) => h('option', { value: v, selected: v === split ? 'selected' : null }, l)))),
    h('label', { class: 'picker' }, h('span', {}, 'Outcome'), h('select', { onchange: (e) => ctx.set({ outcome: e.target.value }) },
      [['revenue', 'Revenue'], ['orders', 'Orders']].map(([v, l]) => h('option', { value: v, selected: v === outcome ? 'selected' : null }, l))))) : null;
  if (!d) return [controls, h('p', { class: 'blocked' }, ctx.global.device !== 'all' && (split === 'none' || split === 'device') ? 'With one device chosen there is nothing to split by device. Pick a split in the context bar.' : 'Pick a week to compare with to split the change.')];
  const isMoney = d.outcome === 'revenue';
  const fmtV = (v) => (isMoney ? signedMoney(v, ctx) : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(Math.round(v)).toLocaleString()}`);
  const perLabel = isMoney ? 'revenue per session' : 'orders per session';
  const max = Math.max(...d.rows.map((r) => Math.max(Math.abs(r.volume), Math.abs(r.rate))), 1);
  const bar = (v) => h('span', { class: `dbar ${v >= 0 ? 'pos' : 'neg'}`, style: `width:${(Math.abs(v) / max * 100).toFixed(1)}%` });
  const label = (v) => ctx.fieldLabel(v, split === 'device' || split === 'none' ? 'viewport_type' : 'segment_value');
  const highlight = ctx.state.highlight;
  const body = d.rows.map((r) => h('tr', { class: `mover${highlight === r.value ? ' hl' : ''}`, title: 'Open this segment on Health', onclick: () => ctx.drill({ tab: 'health', panel: 'health-weekly', ctx: { split: split === 'device' ? 'none' : split }, highlight: r.value, label: `${label(r.value)} revenue` }) },
    h('td', { class: 'label' }, label(r.value)),
    h('td', { class: 'num' }, `${format(r.s0, 'int')} → ${format(r.s1, 'int')}`),
    h('td', { class: 'num' }, isMoney ? `${format(r.rps0, 'money', ctx.currency)} → ${format(r.rps1, 'money', ctx.currency)}` : `${format(r.rps0, 'pct')} → ${format(r.rps1, 'pct')}`),
    h('td', { class: 'num' }, fmtV(r.volume)), h('td', { class: 'dcell' }, bar(r.volume)),
    h('td', { class: 'num' }, fmtV(r.rate)), h('td', { class: 'dcell' }, bar(r.rate)),
    h('td', { class: 'num strong' }, fmtV(r.total))));
  const ties = Math.abs(d.total - d.siteDelta) < (isMoney ? 1 : 0.5);
  body.push(h('tr', { class: 'total' }, h('td', { class: 'label' }, 'Total'), h('td', {}), h('td', {}),
    h('td', { class: 'num' }, fmtV(d.volume)), h('td', {}), h('td', { class: 'num' }, fmtV(d.rate)), h('td', {}),
    h('td', { class: 'num' }, fmtV(d.total), ties ? h('span', { class: 'tick', title: 'Sums exactly to the site change' }, ' ✓') : null)));
  const summary = h('p', { class: 'decomp-summary' },
    h('span', {}, 'Traffic growth ', h('strong', {}, fmtV(d.growth))), ' · ',
    h('span', {}, 'mix ', h('strong', {}, fmtV(d.mix))), ' · ',
    h('span', {}, 'rates ', h('strong', {}, fmtV(d.rate))), ' = ',
    h('strong', {}, fmtV(d.total)),
    h('span', { class: 'muted small' }, ` ${isMoney ? 'revenue' : 'orders'}, week of ${shortDate(d.week)} against ${shortDate(d.compare)}`));
  const notes = [
    `Volume = change in sessions × average ${perLabel} over the two weeks. Rate = average sessions × change in ${perLabel}. They add up exactly.`,
    `Traffic growth is the site's change in sessions at the site's average ${perLabel}; mix is the rest of the volume column, from traffic moving between segments.`,
  ];
  if (Math.sign(d.mix) !== Math.sign(d.rate) && d.mix && d.rate) notes.push(d.rate > 0 ? 'Most segments converted better, but traffic shifted toward lower-value segments.' : 'Traffic shifted toward higher-value segments, but segments converted worse.');
  if (d.partial) notes.push('One of these weeks is partial: read this as directional.');
  return [controls, summary,
    h('div', { class: 'scroll' }, h('table', { class: 'grid decomp' },
      h('thead', {}, h('tr', {}, h('th', { class: 'label' }, FAMILY[split] ?? 'Segment'), h('th', { class: 'num' }, 'Sessions'), h('th', { class: 'num' }, isMoney ? 'Revenue per session' : 'Orders per session'),
        h('th', { class: 'num' }, 'Volume'), h('th', {}), h('th', { class: 'num' }, 'Rate'), h('th', {}), h('th', { class: 'num' }, 'Total'))),
      h('tbody', {}, body))),
    h('ul', { class: 'caveats' }, notes.map((n) => h('li', {}, n)))];
}

// ---------- verdict summary ----------

export function verdictsummary(panel, rows, ctx) {
  const n = (st) => rows.filter((r) => r.m_state === st).length;
  const page = ctx.manifest.bundle?.analysedPage?.path ?? 'the analysed page';
  const fired = n('triggered');
  return [h('p', { class: 'answer' }, fired ? `On the analysed page (${page}): ${fired} rules triggered, ${n('blocked')} blocked, ${n('silent')} silent${n('below_floor') ? `, ${n('below_floor')} below the volume floor` : ''}. ` : `Nothing fired this week — ${rows.length} rules watched. `,
    h('a', { class: 'next', href: '#', onclick: (e) => { e.preventDefault(); ctx.drill({ tab: 'verdicts', panel: 'vd-actions', label: 'Verdicts' }); } }, 'Open Verdicts →'))];
}

// ---------- change log ----------

export function annotations(panel, rows, ctx) {
  const weeks = weeksOf(rows);
  const site = weeklyTotals(rows, (r) => r.segment === 'all' && r.viewport_type === ctx.global.device);
  const changes = ctx.names.map?.changes ?? [];
  const W = Math.round(Math.max(300, Math.min(900, ctx.width ?? 900))); const H = 140; const L = 60; const R = 10; const T = 10; const B = 24;
  const vals = weeks.map((w) => site.get(w)?.revenue ?? 0);
  const hi = Math.max(...vals, 1);
  const sx = (i) => L + (weeks.length === 1 ? 0 : (i / (weeks.length - 1)) * (W - L - R));
  const sy = (v) => T + (1 - v / hi) * (H - T - B);
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'tl-svg' });
  svg.append(s('path', { d: vals.map((v, i) => `${i ? 'L' : 'M'}${sx(i)},${sy(v)}`).join(' '), fill: 'none', stroke: '#2c5f8a', 'stroke-width': 2 }));
  weeks.forEach((w, i) => {
    svg.append(s('text', { x: sx(i), y: H - 6, 'text-anchor': 'middle', class: 'tl-axis' }, shortDate(w)));
    const c = s('circle', { cx: sx(i), cy: sy(vals[i]), r: 3, fill: ctx.full(w) ? '#2c5f8a' : '#fff', stroke: '#2c5f8a' });
    c.append(s('title', {}, `Week of ${shortDate(w)}: ${format(vals[i], 'money', ctx.currency)}`));
    svg.append(c);
  });
  svg.append(s('text', { x: L - 6, y: sy(hi) + 4, 'text-anchor': 'end', class: 'tl-axis' }, money(hi, ctx)));
  for (const ch of changes) {
    const i = weeks.findIndex((w) => ch.date >= w && ch.date < weeks[weeks.indexOf(w) + 1] || (w === weeks[weeks.length - 1] && ch.date >= w));
    if (i < 0) continue;
    svg.append(s('line', { x1: sx(i), x2: sx(i), y1: T, y2: H - B, stroke: '#d97230', 'stroke-dasharray': '3 3' }));
    const t = s('text', { x: sx(i) + 4, y: T + 10, class: 'tl-axis' }, ch.label);
    svg.append(t);
  }
  return [h('div', { class: 'chart' }, svg),
    h('p', { class: 'foot' }, changes.length ? `${changes.length} changes marked.` : `No change log yet. Add releases, sales and campaigns to names/${ctx.manifest.site.slug}.json "changes" as { "date": "2026-10-01", "label": "Sale starts" } to mark them here.`)];
}
