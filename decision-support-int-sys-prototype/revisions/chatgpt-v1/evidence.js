// Evidence drawer: comparison, history, breakdown, definition, provenance.
import { coverage, formatDay } from './contracts.js';
import { labelOf, scopeWeekly, fmtPct, fmtPoints, wilson } from './derive.js';
import { h, s } from './views.js';

const HELP = {
  product_viewed: 'Sessions recording a product view at any point, divided by sessions in this scope. Not an ordered step.',
  added_to_cart: 'Sessions recording an add-to-cart at any point, divided by sessions in this scope.',
  checkout_started: 'Sessions recording checkout_started at any point, divided by sessions in this scope.',
  buyers: 'Sessions with at least one order, divided by sessions in this scope.',
  session_conversion: 'Sessions with at least one order, divided by sessions in this scope. Last touch, on-site value only.',
  completion: 'Sessions that reached the path\'s last page, divided by sessions that started it. The path list is frozen for the whole site.',
  revenue: 'Revenue in this scope. Uncertainty is not estimated.',
  session_share: 'This row\'s sessions divided by sessions in the breakdown.',
};

function historySeries(ref, ctx) {
  const weeks = ctx.manifest.warehouse?.trendWeeks ?? [];
  const cov = coverage(ctx.manifest, ref.dataset === 'journey_summary' ? 'journey_summary' : 'funnel');
  if (ref.path) {
    const rows = ctx.journeyRows.filter((r) => r.kind === (ref.kind || 'general') && r.path === ref.path
      && r.segment === ref.filter.segment && r.segment_value === ref.filter.segment_value && r.viewport_type === ref.filter.viewport_type && r.row_key === 'step');
    return weeks.map((week) => {
      const steps = rows.filter((r) => r.week === week).sort((a, b) => a.step_index - b.step_index);
      if (!steps.length) return { week, value: null, state: cov.get(week)?.state };
      const first = steps[0]; const last = steps[steps.length - 1];
      return { week, value: first.sessions ? last.sessions / first.sessions : null, state: cov.get(week)?.state };
    });
  }
  const scoped = scopeWeekly(ctx.funnelRows, {
    segment: ref.filter.segment, segmentValue: ref.filter.segment_value, device: ref.filter.viewport_type, entry: ref.filter.entry,
  });
  const metric = ['product_viewed', 'added_to_cart', 'checkout_started', 'buyers', 'revenue', 'sessions'].includes(ref.measure) ? ref.measure : 'buyers';
  return weeks.map((week) => {
    const row = scoped.find((r) => r.week === week);
    if (!row) return { week, value: null, state: cov.get(week)?.state };
    if (metric === 'revenue' || metric === 'sessions') return { week, value: row[metric], state: cov.get(week)?.state };
    return { week, value: row.sessions ? row[metric] / row.sessions : null, state: cov.get(week)?.state };
  });
}

function spark(series) {
  const W = 280; const H = 64; const pts = series.map((p, i) => ({ ...p, i })).filter((p) => p.value !== null);
  if (pts.length < 2) return h('p', { class: 'muted small' }, 'Not enough weeks to draw.');
  const vals = pts.map((p) => p.value);
  const lo = Math.min(...vals); const hi = Math.max(...vals);
  const sx = (i) => 8 + (i / (series.length - 1)) * (W - 16);
  const sy = (v) => (hi === lo ? H / 2 : H - 10 - ((v - lo) / (hi - lo)) * (H - 20));
  const svg = s('svg', { width: W, height: H, class: 'ev-spark' });
  let d = '';
  series.forEach((p, i) => {
    if (p.value === null) { d = ''; return; }
    const cmd = d ? 'L' : 'M';
    d += `${cmd}${sx(i).toFixed(1)},${sy(p.value).toFixed(1)} `;
    if (series[i + 1]?.value === null || i === series.length - 1) {
      if (d.trim()) svg.append(s('path', { d, fill: 'none', stroke: '#2c5f8a', 'stroke-width': 1.6 }));
      d = '';
    }
  });
  series.forEach((p, i) => {
    if (p.value === null) return;
    const hollow = p.state && p.state !== 'verified';
    svg.append(s('circle', { cx: sx(i), cy: sy(p.value), r: 3, fill: hollow ? '#fff' : '#2c5f8a', stroke: '#2c5f8a' }));
  });
  return svg;
}

function deviceRows(ctx, ref) {
  if (ref.filter.viewport_type !== 'all') return [];
  return ['mobile', 'desktop', 'tablet'].map((dev) => {
    const rows = scopeWeekly(ctx.funnelRows, {
      segment: ref.filter.segment, segmentValue: ref.filter.segment_value, device: dev, entry: ref.filter.entry,
    });
    const cur = rows.find((r) => r.week === ref.weeks[0]);
    const metric = ['product_viewed', 'added_to_cart', 'checkout_started', 'buyers'].includes(ref.measure) ? ref.measure : 'buyers';
    return { label: labelOf(dev), n: cur?.sessions ?? null, value: cur?.sessions ? cur[metric] / cur.sessions : null };
  }).filter((r) => r.n);
}

function entryRows(ctx, ref) {
  if (ref.filter.entry && ref.filter.entry !== 'all') return [];
  const entries = [...new Set(ctx.funnelRows.map((r) => r.entry))];
  return entries.map((entry) => {
    const rows = scopeWeekly(ctx.funnelRows, {
      segment: ref.filter.segment, segmentValue: ref.filter.segment_value, device: ref.filter.viewport_type, entry,
    });
    const cur = rows.find((r) => r.week === ref.weeks[0]);
    const metric = ['product_viewed', 'added_to_cart', 'checkout_started', 'buyers'].includes(ref.measure) ? ref.measure : 'buyers';
    return { label: labelOf(entry), n: cur?.sessions ?? null, value: cur?.sessions ? cur[metric] / cur.sessions : null };
  }).filter((r) => r.n).sort((a, b) => b.n - a.n);
}

export function drawEvidence(host, ref, ctx) {
  if (!ref) { host.hidden = true; host.replaceChildren(); return; }
  host.hidden = false;
  const series = historySeries(ref, ctx);
  const pct = ref.measure === 'revenue' || ref.measure === 'sessions' ? null : true;
  const fmt = (v) => (v === null || v === undefined ? '—' : pct ? fmtPct(v) : Math.round(v).toLocaleString());
  const w1 = wilson(ref.x1, ref.n1);
  const w0 = wilson(ref.x0, ref.n0);
  const interval = (w) => (w ? `${fmtPct(w[0])} to ${fmtPct(w[1])}` : '—');
  const checks = ref.screen?.checks ?? [];
  const devices = ref.dataset === 'journey_summary' ? [] : deviceRows(ctx, ref);
  const entries = ref.dataset === 'journey_summary' ? [] : entryRows(ctx, ref);
  const unsupported = [];
  if (ref.filter.segment && ref.filter.segment !== 'all' && ref.filter.segment !== 'traffic_source') {
    unsupported.push('New or returning × traffic source is not in this dataset. Device crosses with one segment family; two families can\'t be crossed. Crossed in weekly_entry_cube (bundle visits, different population).');
  }
  const meta = ctx.manifest.datasets?.[ref.dataset] ?? ctx.manifest.datasets?.funnel;
  const file = ref.dataset === 'journey_summary' ? ctx.manifest.datasets.journeys?.file : meta?.file;
  const rows = ref.dataset === 'journey_summary' ? ctx.manifest.datasets.journeys?.rows : meta?.rows;
  const wh = ctx.manifest.warehouse ?? {};
  const cov = coverage(ctx.manifest, ref.dataset === 'journey_summary' ? 'journeys' : 'funnel').get(ref.weeks[0]);

  const tableOf = (title, list) => (list.length ? h('div', {}, h('h5', {}, title),
    h('table', { class: 'grid' }, h('tbody', {}, list.slice(0, 8).map((r) => h('tr', {},
      h('td', {}, r.label), h('td', { class: 'num' }, fmt(r.value)), h('td', { class: 'num muted' }, r.n === null ? '—' : r.n.toLocaleString())))))) : null);

  host.replaceChildren(h('div', { class: 'evidence-inner' },
    h('header', {}, h('h3', {}, ref.title || ref.subject || 'Evidence'), h('button', { type: 'button', id: 'evidence-close' }, 'Close')),
    h('section', {}, h('h4', {}, 'Comparison'),
      h('p', {}, `${fmt(ref.current)} this week`, ref.n1 !== null && ref.n1 !== undefined ? ` (${(ref.x1 ?? 0).toLocaleString()} / ${ref.n1.toLocaleString()})` : ''),
      h('p', {}, ref.prior === null || ref.prior === undefined ? 'Comparison unavailable' : `${fmt(ref.prior)} in the week of ${formatDay(ref.weeks[1])}`, ref.n0 ? ` (${(ref.x0 ?? 0).toLocaleString()} / ${ref.n0.toLocaleString()})` : ''),
      h('p', {}, ref.delta === null || ref.delta === undefined ? 'No delta' : `${fmtPoints(ref.delta)} points`),
      pct ? h('p', { class: 'small' }, `Wilson 95% this week ${interval(w1)}. Prior week ${interval(w0)}.`) : h('p', { class: 'small' }, 'Uncertainty not estimated.'),
      ref.screen?.review ? h('p', {}, h('span', { class: 'badge review' }, 'Large enough to review')) : null,
      checks.length ? h('ul', { class: 'small' }, checks.map((c) => h('li', {}, `${c.pass ? 'Pass' : 'Fail'} — ${c.detail}`))) : null),
    h('section', {}, h('h4', {}, 'History'), spark(series),
      h('p', { class: 'small muted' }, 'Hollow dots are weeks whose coverage is not verified. Gaps stay gaps.')),
    h('section', {}, h('h4', {}, 'Breakdown'), tableOf('Device', devices), tableOf('Entry type', entries),
      unsupported.map((text) => h('p', { class: 'unsupported' }, text, ' ',
        h('a', { href: '#', class: 'next', onclick: (e) => { e.preventDefault(); ctx.go({ tab: 'ref-acquisition', focus: 'acq-cube' }); } }, 'Open the cube →')))),
    h('section', {}, h('h4', {}, 'Definition'), h('p', {}, HELP[ref.measure] || ref.help || 'See Definitions.')),
    h('section', {}, h('h4', {}, 'Provenance'),
      h('ul', { class: 'small' }, [
        `Dataset ${ref.dataset}`,
        `Source ${meta?.source === 'warehouse' || ref.dataset === 'journey_summary' ? 'warehouse' : (meta?.source ?? 'snapshot')}`,
        `File ${file ?? '—'}`,
        `Rows ${rows?.toLocaleString?.() ?? '—'}`,
        meta?.capped ? `Capped ${meta.rows.toLocaleString()} of ${meta.cappedFrom.toLocaleString()}` : 'Not capped',
        `Coverage ${cov ? `${cov.days}/7 ${cov.state}` : '—'}`,
        `Snapshot ${ctx.manifest.generatedAt}`,
        wh.cardsBatch ? `Batch ${wh.cardsBatch}` : null,
        `Calculation ${ref.calc || 'ratio-of-sums'}`,
      ].filter(Boolean).map((line) => h('li', {}, line))),
      h('button', { type: 'button', id: 'evidence-copy' }, 'Copy link'))));
  host.querySelector('#evidence-close').onclick = () => ctx.closeEvidence();
  host.querySelector('#evidence-copy').onclick = async (e) => {
    const btn = e.currentTarget;
    try { await navigator.clipboard.writeText(location.href); btn.textContent = 'Copied'; }
    catch { btn.textContent = location.href; }
  };
}

export function evidenceRef(ctx, extra) {
  const f = extra.filter ?? {};
  return {
    snap: ctx.manifest.generatedAt,
    site: ctx.manifest.site.slug,
    dataset: extra.dataset,
    file: ctx.manifest.datasets[extra.dataset]?.file ?? ctx.manifest.datasets.journeys?.file ?? null,
    filter: {
      segment: f.segment ?? 'all',
      segment_value: f.segment_value ?? 'all',
      viewport_type: f.viewport_type ?? 'all',
      entry: f.entry ?? null,
      path: extra.path ?? null,
    },
    weeks: [ctx.context.week, ctx.context.compareWeek],
    measure: extra.measure,
    calc: extra.calc || 'ratio-of-sums',
    coverage: extra.coverage ?? 'verified',
    capped: false,
    title: extra.title,
    subject: extra.subject,
    path: extra.path ?? null,
    kind: extra.kind ?? null,
    x1: extra.x1 ?? null, n1: extra.n1 ?? null, x0: extra.x0 ?? null, n0: extra.n0 ?? null,
    current: extra.current ?? null, prior: extra.prior ?? null, delta: extra.delta ?? null,
    screen: extra.screen ? { review: extra.screen.review, fails: extra.screen.fails, checks: extra.screen.checks } : null,
    help: extra.help ?? null,
  };
}
