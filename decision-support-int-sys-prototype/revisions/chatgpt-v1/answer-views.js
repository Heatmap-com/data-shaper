// Weekly brief, channels, event reach, one journey, the revenue bridge and the mix split.
import { formatDay, rankWindow } from './contracts.js';
import { fixedVolume, fmtPct, fmtPoints, fmtShare, labelOf, outcomeFacts, partitionEffects, pathLabel, scopeWeekly, PARTITIONS } from './derive.js';
import { evidenceRef } from './evidence.js';
import { oneLane } from './flows-views.js';
import { h } from './views.js';

function money(v, currency, digits) {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  return new Intl.NumberFormat(undefined, { style: 'currency', currency, minimumFractionDigits: digits, maximumFractionDigits: digits }).format(v);
}

function rel(cur, prev) {
  if (cur === null || prev === null || !prev) return '—';
  const v = ((cur - prev) / Math.abs(prev)) * 100;
  const sign = v > 0 ? '+' : '';
  return `${sign}${v.toFixed(1)}%`;
}

function badge(screen) {
  if (!screen?.review) return null;
  const tip = (screen.checks ?? []).map((c) => `${c.pass ? 'Pass' : 'Fail'}: ${c.detail}`).join('\n');
  return h('span', { class: 'badge review', title: tip }, 'Large enough to review');
}

function link(text, ref, ctx, attr) {
  return h('button', { type: 'button', class: 'ev-link', 'data-evidence': attr || '', onclick: () => ctx.openEvidence(ref) }, text);
}

function scopeFilter(ctx, entry) {
  return {
    segment: ctx.context.segment,
    segment_value: ctx.context.segmentValue,
    viewport_type: ctx.context.device,
    entry: entry && entry !== 'all' ? entry : null,
  };
}

export function outcomes(panel, ctx) {
  const facts = outcomeFacts(ctx.analysis.outcomes);
  const cur = ctx.currency;
  const cells = [
    ['Sessions', facts.sessions.current?.toLocaleString() ?? '—', rel(facts.sessions.current, facts.sessions.prior), 'Count', null],
    ['Sessions that bought', fmtPct(facts.rate.current), facts.rate.prior === null ? '—' : `${fmtPoints(facts.rate.current - facts.rate.prior)} points`, 'Rate', facts.rate.screen],
    ['Orders per buying session', facts.ops.current === null ? '—' : facts.ops.current.toFixed(3), facts.ops.prior === null ? '—' : `prior ${facts.ops.prior.toFixed(3)}`, 'Rate', null],
    ['Average order', money(facts.aov.current, cur, 2), facts.aov.prior === null ? '—' : `prior ${money(facts.aov.prior, cur, 2)}`, 'Money', null],
    ['Revenue', money(facts.revenue.current, cur, 0), rel(facts.revenue.current, facts.revenue.prior), 'Money', null],
  ];
  const strip = h('div', { class: 'outcome-strip' }, cells.map(([label, value, delta, kind, screen]) => h('div', { class: 'outcome' },
    h('div', { class: 'muted small' }, label),
    h('div', { class: 'big' }, value),
    h('div', { class: 'small' }, delta, ' ', badge(screen)),
    kind === 'Money' ? h('div', { class: 'muted small', title: 'Uncertainty not estimated' }, 'Uncertainty not estimated') : null)));
  const links = h('p', { class: 'outcome-links' },
    h('a', { href: '#', class: 'next', onclick: (e) => { e.preventDefault(); ctx.go({ tab: 'explain' }); } }, 'Explain revenue change →'),
    ' ',
    h('a', { href: '#', class: 'next', onclick: (e) => { e.preventDefault(); ctx.go({ tab: 'client-brief' }); } }, 'Prepare client brief →'));
  return [strip, links];
}

function concentration(ctx, finding) {
  if (ctx.context.device !== 'all' || finding.theme === 'channel') return null;
  const week = ctx.context.week;
  const seg = { segment: ctx.context.segment, segmentValue: ctx.context.segmentValue };
  let best = null;
  for (const dev of ['mobile', 'desktop', 'tablet']) {
    const rows = scopeWeekly(ctx.funnelRows, { ...seg, device: dev });
    const row = rows.find((r) => r.week === week);
    if (!row?.sessions) continue;
    if (!best || row.sessions > best.sessions) best = { dev, sessions: row.sessions, row };
  }
  if (!best) return null;
  if (finding.theme === 'event_reach') {
    const metric = finding.evidence.metric;
    const rate = best.row[metric] / best.sessions;
    return `${labelOf(best.dev)} is the largest device: ${fmtPct(rate)} of its ${best.sessions.toLocaleString()} sessions.`;
  }
  if (finding.theme === 'journey' && finding.evidence.path) {
    const steps = ctx.journeyRows.filter((r) => r.kind === 'general' && r.path === finding.evidence.path && r.week === week
      && r.segment === ctx.context.segment && r.segment_value === ctx.context.segmentValue && r.viewport_type === best.dev && r.row_key === 'step')
      .sort((a, b) => a.step_index - b.step_index);
    if (steps.length < 2) return null;
    const rate = steps[0].sessions ? steps[steps.length - 1].sessions / steps[0].sessions : null;
    return `${labelOf(best.dev)} is the largest device on this path: ${fmtPct(rate)} completed, across ${steps[0].sessions.toLocaleString()} starts.`;
  }
  return null;
}

export function answers(panel, ctx) {
  const { findings, improvements, limits, emptyState } = ctx.analysis;
  ctx.log('answer_rendered', { ev: findings.map((f) => f.ruleId).join(',') });
  const card = (f) => {
    const filter = f.theme === 'channel'
      ? { segment: 'traffic_source', segment_value: f.evidence.key, viewport_type: ctx.context.device }
      : { segment: ctx.context.segment, segment_value: ctx.context.segmentValue, viewport_type: ctx.context.device };
    const ref = evidenceRef(ctx, {
      ...f.evidence,
      dataset: f.evidence.dataset,
      title: f.claim,
      subject: f.evidence.subject,
      path: f.evidence.path,
      filter,
      measure: f.evidence.metric === 'completion' ? 'completion' : (f.evidence.metric === 'session_conversion' ? 'session_conversion' : f.evidence.metric),
    });
    const line = concentration(ctx, f);
    return h('article', { class: 'finding' },
      h('p', { class: 'claim' }, f.claim),
      line ? h('p', { class: 'small' }, line) : null,
      f.caveats.length ? h('ul', { class: 'caveats' }, f.caveats.map((c) => h('li', {}, c))) : null,
      h('div', { class: 'finding-actions' },
        h('button', { type: 'button', onclick: () => ctx.openEvidence(ref) }, 'See evidence'),
        h('button', { type: 'button', onclick: () => ctx.go(f.go) }, 'Go to view'),
        h('button', { type: 'button', onclick: () => ctx.pin(f) }, 'Pin')));
  };
  const blocks = [
    h('div', { class: 'findings' }, findings.map(card)),
    emptyState ? h('p', { class: 'empty-state' }, emptyState) : null,
  ];
  if (improvements.length) {
    blocks.push(h('h4', {}, 'Improvements worth preserving'), h('ul', { class: 'improvements' }, improvements.map((f) => h('li', {}, f.claim, ' ', badge(f.evidence.screen)))));
  }
  blocks.push(h('h4', {}, 'What this can\'t assess'), h('ul', { class: 'limits' }, limits.map((line) => h('li', {}, line))));
  return blocks;
}

export function comparison(panel, ctx) {
  const rows = ctx.analysis.channels;
  const sortKey = ctx.state.sortKey || 'session_conversion';
  const sortBy = ctx.state.sortBy || 'delta';
  const valueOf = (m) => {
    if (sortKey === 'session_share') return sortBy === 'volume' ? m.n1 : (m.share1 ?? 0) - (m.share0 ?? 0);
    if (sortKey === 'revenue') return sortBy === 'volume' ? m.rev1 : (m.rev1 || 0) - (m.rev0 || 0);
    if (sortKey === 'rps') {
      const a = m.n1 ? m.rev1 / m.n1 : 0; const b = m.n0 ? m.rev0 / m.n0 : 0;
      return sortBy === 'volume' ? a : a - b;
    }
    return sortBy === 'volume' ? m.n1 : (m.rate.delta ?? -Infinity);
  };
  const ordered = [...rows].sort((a, b) => valueOf(b) - valueOf(a));
  const cur = ctx.currency;
  const head = h('tr', {}, ['Source', 'Session share', 'Sessions that bought', 'Revenue per session', 'Revenue', ''].map((t, i) => h('th', { class: i ? 'num' : '' }, t)));
  const body = ordered.map((m) => {
    const on = ctx.context.segment === 'traffic_source' && ctx.context.segmentValue === m.key;
    const rateRef = evidenceRef(ctx, {
      dataset: 'funnel', title: `${m.subject} sessions that bought`, measure: 'session_conversion', subject: m.subject,
      filter: { segment: 'traffic_source', segment_value: m.key, viewport_type: ctx.context.device },
      x1: m.x1, n1: m.n1, x0: m.x0, n0: m.n0, current: m.rate.current, prior: m.rate.prior, delta: m.rate.delta, screen: m.rate.screen,
      calc: 'ratio-of-sums',
    });
    const cell = (text, ref, attr) => h('td', { class: 'num' }, link(text, ref || rateRef, ctx, attr));
    return h('tr', { class: on ? 'highlight' : '' },
      h('td', {}, m.subject, on ? h('span', { class: 'badge' }, 'Selected') : null),
      cell(`${fmtShare(m.share0)} → ${fmtShare(m.share1)}`),
      h('td', { class: 'num' }, link(`${fmtPct(m.rate.prior)} → ${fmtPct(m.rate.current)}`, rateRef, ctx, m.key === 'meta' ? 'meta-rate' : ''), ' ', badge(sortKey === 'session_conversion' ? m.rate.screen : null),
        h('div', { class: 'muted small' }, `n ${m.n1.toLocaleString()}`)),
      cell(`${money(m.n0 ? m.rev0 / m.n0 : null, cur, 2)} → ${money(m.n1 ? m.rev1 / m.n1 : null, cur, 2)}`),
      cell(`${money(m.rev0, cur, 0)} → ${money(m.rev1, cur, 0)}`),
      h('td', {}, h('button', { type: 'button', class: 'texty', onclick: () => ctx.go({ tab: 'paths', seg: 'traffic_source', segv: m.key }) }, 'Inspect journeys →')));
  });
  const controls = h('div', { class: 'view-controls' },
    h('label', { class: 'picker' }, h('span', {}, 'Sort by'),
      h('select', { onchange: (e) => ctx.set({ sortKey: e.target.value }) },
        [['session_conversion', 'Sessions that bought'], ['session_share', 'Session share'], ['rps', 'Revenue per session'], ['revenue', 'Revenue']]
          .map(([v, t]) => h('option', { value: v, selected: v === sortKey ? 'selected' : null }, t)))),
    h('label', { class: 'picker' }, h('span', {}, 'Order'),
      h('select', { onchange: (e) => ctx.set({ sortBy: e.target.value }) },
        [['delta', `Change in ${sortKey.replaceAll('_', ' ')}`], ['volume', 'Volume']]
          .map(([v, t]) => h('option', { value: v, selected: v === sortBy ? 'selected' : null }, t)))));
  return [controls, h('div', { class: 'scroll' }, h('table', { class: 'grid' }, h('thead', {}, head), h('tbody', {}, body)))];
}

export function eventReach(panel, ctx) {
  const entry = ctx.state.entry || 'all';
  const entries = ['all', ...new Set(ctx.funnelRows.filter((r) => r.segment === 'all').map((r) => r.entry))];
  const scoped = scopeWeekly(ctx.funnelRows, {
    segment: ctx.context.segment, segmentValue: ctx.context.segmentValue, device: ctx.context.device, entry,
  });
  const cur = scoped.find((r) => r.week === ctx.context.week);
  const prev = ctx.context.compareWeek ? scoped.find((r) => r.week === ctx.context.compareWeek) : null;
  const events = [
    ['product_viewed', 'Product viewed'],
    ['added_to_cart', 'Added to cart'],
    ['checkout_started', 'Checkout started'],
    ['buyers', 'Bought'],
  ];
  const fromAnalysis = entry === 'all' ? Object.fromEntries(ctx.analysis.eventReach.map((r) => [r.metric, r])) : {};
  const rows = events.map(([metric, label]) => {
    const known = fromAnalysis[metric];
    const x1 = cur?.[metric] ?? null; const n1 = cur?.sessions ?? null;
    const x0 = prev?.[metric] ?? null; const n0 = prev?.sessions ?? null;
    const current = n1 ? x1 / n1 : null; const prior = n0 ? x0 / n0 : null;
    const rec = known ?? { metric, subject: label, x1, n1, x0, n0, current, prior, delta: current !== null && prior !== null ? current - prior : null, screen: null };
    return rec;
  });
  const controls = h('div', { class: 'view-controls' },
    h('label', { class: 'picker' }, h('span', {}, 'Entry type'),
      h('select', { onchange: (e) => ctx.set({ entry: e.target.value }) },
        entries.map((v) => h('option', { value: v, selected: v === entry ? 'selected' : null }, v === 'all' ? 'All entries' : labelOf(v))))));
  const list = h('div', { class: 'reach' }, rows.map((r) => {
    const ref = evidenceRef(ctx, {
      dataset: 'funnel', title: r.subject, subject: r.subject, measure: r.metric, filter: scopeFilter(ctx, entry),
      x1: r.x1, n1: r.n1, x0: r.x0, n0: r.n0, current: r.current, prior: r.prior, delta: r.delta, screen: r.screen,
    });
    return h('div', { class: 'reach-row' },
      h('div', { class: 'reach-name' }, r.subject),
      h('div', { class: 'reach-bar' }, h('span', { style: `width:${Math.max(0, Math.min(100, (r.current ?? 0) * 100))}%` })),
      h('div', { class: 'reach-fig' }, link(fmtPct(r.current), ref, ctx, r.metric === 'product_viewed' ? 'reach-product' : ''),
        h('span', { class: 'muted small' }, ` ${r.x1?.toLocaleString() ?? '—'} sessions`),
        ' ', r.delta === null ? '—' : `${fmtPoints(r.delta)} points`, ' ', badge(r.screen)));
  }));
  const population = cur?.sessions == null ? '—' : `${cur.sessions.toLocaleString()} sessions`;
  return [controls, h('p', { class: 'foot' }, population), list, h('p', { class: 'foot' }, 'Actions recorded anywhere in the session, out of the same sessions. Not an ordered sequence, and not step-to-step rates.')];
}

export function journeyFocus(panel, ctx) {
  const kind = ctx.state.kind || 'general';
  const rows = ctx.analysis.journeys;
  const shown = kind === 'general' ? rows : pageJourneys(ctx);
  const focus = ctx.focus && shown.some((r) => r.path === ctx.focus) ? ctx.focus : shown[0]?.path;
  const window = rankWindow(ctx.manifest);
  const basis = window
    ? `The ${shown.length} paths with the most revenue site-wide over ${formatDay(window.start)}–${formatDay(window.end)}, ranked once for all segments. Not the top paths for the selected segment.`
    : 'Ranked once for the whole site.';
  const head = h('tr', {}, ['Path', 'Starts', 'Completion', 'Prior', 'Change', 'Bought at the end', ''].map((t, i) => h('th', { class: i ? 'num' : '' }, t)));
  const body = [];
  for (const j of shown) {
    const open = j.path === focus;
    const ref = evidenceRef(ctx, {
      dataset: 'journey_summary', title: j.subject, subject: j.subject, path: j.path, kind, measure: 'completion',
      filter: { segment: ctx.context.segment, segment_value: ctx.context.segmentValue, viewport_type: ctx.context.device },
      x1: j.x1, n1: j.n1, x0: j.x0, n0: j.n0, current: j.current, prior: j.prior, delta: j.delta, screen: j.screen,
    });
    body.push(h('tr', { class: open ? 'highlight' : '' },
      h('td', {}, j.subject || pathLabel(j.path)),
      h('td', { class: 'num' }, (j.n1 ?? 0).toLocaleString()),
      h('td', { class: 'num' }, link(fmtPct(j.current), ref, ctx)),
      h('td', { class: 'num' }, fmtPct(j.prior)),
      h('td', { class: 'num' }, j.delta === null ? '—' : `${fmtPoints(j.delta)} points`, ' ', badge(j.screen)),
      h('td', { class: 'num' }, j.end1 ? fmtPct((j.bought1 ?? 0) / j.end1) : '—'),
      h('td', {}, h('button', { type: 'button', class: 'texty', onclick: () => ctx.go({ tab: 'paths', focus: j.path }) }, open ? 'Shown' : 'Expand'))));
    if (open) {
      const raw = ctx.journeyRows.filter((r) => r.kind === kind && r.path === j.path && r.segment === ctx.context.segment
        && r.segment_value === ctx.context.segmentValue && r.viewport_type === ctx.context.device);
      const extra = j.delta !== null && j.delta < 0 ? fixedVolume(j.n1, j.current, j.prior) : null;
      body.push(h('tr', { class: 'lane-row' }, h('td', { colspan: '7' },
        oneLane(raw, j.path, ctx.context.week, ctx.context.compareWeek, ctx),
        extra !== null ? h('p', { class: 'scenario' }, `At this week's ${j.n1.toLocaleString()} starts, the prior completion rate would mean about ${Math.round(extra / 100) * 100 === 0 ? '0' : (Math.round(extra / 100) * 100).toLocaleString()} more completions. This is a comparison at fixed volume, not lost or recoverable shoppers.`) : null)));
    }
  }
  const controls = h('div', { class: 'view-controls' },
    h('label', { class: 'picker' }, h('span', {}, 'Journeys'),
      h('select', { onchange: (e) => ctx.set({ kind: e.target.value }) },
        [['general', 'General'], ['page', 'Page-specific']].map(([v, t]) => h('option', { value: v, selected: v === kind ? 'selected' : null }, t)))));
  return [h('p', { class: 'basis' }, basis), controls, h('div', { class: 'scroll' }, h('table', { class: 'grid' }, h('thead', {}, head), h('tbody', {}, body)))];
}

function pageJourneys(ctx) {
  const summaries = new Map();
  for (const r of ctx.journeyRows) {
    if (r.kind !== 'page' || r.row_key !== 'step') continue;
    if (r.segment !== ctx.context.segment || r.segment_value !== ctx.context.segmentValue || r.viewport_type !== ctx.context.device) continue;
    const key = `${r.path}|${r.week}`;
    const g = summaries.get(key) ?? { path: r.path, week: r.week, rank: r.rank, steps: [] };
    g.steps.push(r);
    summaries.set(key, g);
  }
  const paths = [...new Set([...summaries.values()].map((g) => g.path))];
  return paths.map((path) => {
    const take = (week) => {
      const g = summaries.get(`${path}|${week}`);
      if (!g) return null;
      g.steps.sort((a, b) => a.step_index - b.step_index);
      return g;
    };
    const a = take(ctx.context.week);
    const b = ctx.context.compareWeek ? take(ctx.context.compareWeek) : null;
    const end = a?.steps.at(-1);
    const start = a?.steps[0];
    const pend = b?.steps.at(-1);
    const pstart = b?.steps[0];
    return {
      path, subject: path, rank: a?.rank ?? 99,
      x1: end?.sessions ?? null, n1: start?.sessions ?? null,
      x0: pend?.sessions ?? null, n0: pstart?.sessions ?? null,
      current: start?.sessions ? end.sessions / start.sessions : null,
      prior: pstart?.sessions ? pend.sessions / pstart.sessions : null,
      delta: null, screen: null, bought1: end?.buyers ?? null, end1: end?.sessions ?? null,
    };
  }).map((j) => ({ ...j, delta: j.current !== null && j.prior !== null ? j.current - j.prior : null }))
    .sort((a, b) => a.rank - b.rank);
}

export function changeBridge(panel, ctx) {
  const bridge = ctx.analysis.bridge;
  const cur = ctx.currency;
  const max = Math.max(...bridge.contributions.map((c) => Math.abs(c.value)), 1);
  const bars = h('div', { class: 'bridge' }, bridge.contributions.map((c) => h('div', { class: 'bridge-row' },
    h('span', { class: 'bridge-label' }, c.label),
    h('span', { class: 'bridge-track' }, h('span', { class: c.value < 0 ? 'neg' : 'pos', style: `width:${(Math.abs(c.value) / max) * 100}%` })),
    h('span', { class: 'bridge-num' }, `${c.value < 0 ? '−' : '+'}${money(Math.abs(c.value), cur, 0).replace(/^[−-]/, '')}`))));
  const sign = bridge.observed < 0 ? '−' : '+';
  return [
    bridge.note ? h('p', { class: 'foot' }, bridge.note) : null,
    bars,
    h('p', { class: 'reconcile' }, `Contributions sum to the observed change: ${sign}${money(Math.abs(bridge.observed), cur, 0).replace(/^[−-]/, '')}. Residual ${money(bridge.residual, cur, 0)}.`),
    h('p', { class: 'foot' }, 'An accounting split of the observed change, not its causes.'),
  ];
}

export function mixRate(panel, ctx) {
  const partition = PARTITIONS[ctx.state.partition] ? ctx.state.partition : 'traffic_source';
  const got = partitionEffects(ctx.funnelRows, partition, ctx.context.device, ctx.context.week, ctx.context.compareWeek);
  const controls = h('div', { class: 'view-controls' },
    h('label', { class: 'picker' }, h('span', {}, 'Split by'),
      h('select', { onchange: (e) => ctx.set({ partition: e.target.value }) },
        Object.entries(PARTITIONS).map(([id, p]) => h('option', { value: id, selected: id === partition ? 'selected' : null }, p.label)))));
  const totals = h('p', { class: 'mix-total' },
    `Buying-session rate ${fmtPct(got.p0)} → ${fmtPct(got.p1)} (${fmtPoints(got.observed, 3)} points). `,
    `Mix ${fmtPoints(got.mix, 3)} points. Within-segment rate ${fmtPoints(got.rate, 3)} points.`,
    got.entered || got.exited ? ` Entered or exited ${fmtPoints(got.entered + got.exited, 3)} points.` : '');
  const scale = Math.max(Math.abs(got.mix), Math.abs(got.rate), 0.0001);
  const bar = (label, value) => h('div', { class: 'bridge-row' },
    h('span', { class: 'bridge-label' }, label),
    h('span', { class: 'bridge-track' }, h('span', { class: value < 0 ? 'neg' : 'pos', style: `width:${(Math.abs(value) / scale) * 100}%` })),
    h('span', { class: 'bridge-num' }, `${fmtPoints(value)} points`));
  const head = h('tr', {}, ['Member', 'Weight then', 'Weight now', 'Rate then', 'Rate now', 'Mix', 'Rate', 'Revenue change'].map((t, i) => h('th', { class: i ? 'num' : '' }, t)));
  const body = got.rows.sort((a, b) => b.n1 - a.n1).map((r) => {
    const rev = got.revenue.find((x) => x.key === r.key);
    return h('tr', {},
      h('td', {}, labelOf(r.key)),
      h('td', { class: 'num' }, fmtShare(r.w0)),
      h('td', { class: 'num' }, fmtShare(r.w1)),
      h('td', { class: 'num' }, fmtPct(r.p0)),
      h('td', { class: 'num' }, fmtPct(r.p1)),
      h('td', { class: 'num' }, fmtPoints(r.mix)),
      h('td', { class: 'num' }, fmtPoints(r.rate)),
      h('td', { class: 'num' }, rev ? money(rev.delta, ctx.currency, 0) : '—'));
  });
  const sum = got.revenueSum;
  return [controls, totals, bar('Mix', got.mix), bar('Within-segment rate', got.rate),
    h('div', { class: 'scroll' }, h('table', { class: 'grid' }, h('thead', {}, head), h('tbody', {}, body))),
    h('p', { class: 'foot' }, `Member revenue changes sum to ${money(sum, ctx.currency, 0)}.`),
  ];
}

export function brief(panel, ctx) {
  const pins = ctx.pins();
  const stale = pins.findings.filter((p) => p.evidenceRef?.snap && p.evidenceRef.snap !== ctx.manifest.generatedAt);
  const list = pins.findings.length
    ? h('ol', { class: 'pin-list' }, pins.findings.map((p) => h('li', {},
      h('p', {}, p.claim),
      (p.caveats ?? []).length ? h('ul', { class: 'caveats' }, p.caveats.map((c) => h('li', {}, c))) : null,
      h('button', { type: 'button', class: 'texty', onclick: () => ctx.unpin(p.id) }, 'Remove'))))
    : h('p', { class: 'muted' }, 'No pins yet. Pin a finding from the brief. Three findings at most.');
  const action = h('label', { class: 'action-field' }, h('span', {}, 'Your recommendation'),
    h('textarea', { rows: '3', onchange: (e) => ctx.setAction(e.target.value) }, pins.action));
  const scope = {
    site: ctx.manifest.site.name,
    week: formatDay(ctx.context.week),
    compare: ctx.context.compareWeek ? `against ${formatDay(ctx.context.compareWeek)}` : 'no comparison',
    segment: ctx.context.segment === 'all' ? 'all visitors' : `${ctx.context.segment} ${ctx.context.segmentValue}`,
    device: ctx.context.device,
  };
  return [
    stale.length ? h('p', { class: 'snap-banner' }, 'A pin was made on a different snapshot. Numbers may differ.') : null,
    list,
    action,
    h('div', { class: 'finding-actions' },
      h('button', { type: 'button', onclick: () => ctx.copyBrief(scope) }, 'Copy as Markdown'),
      h('button', { type: 'button', onclick: () => ctx.downloadBrief(scope) }, 'Download JSON')),
  ];
}
