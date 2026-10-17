// Context bar, hash keys and the unsupported-filter choice.
import { coverage, coverageLabel, formatDay } from './contracts.js';
import { h } from './views.js';

export function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  let state = {};
  let ev = null;
  try { state = p.get('s') ? JSON.parse(p.get('s')) : {}; } catch { state = {}; }
  try { ev = p.get('ev') ? JSON.parse(p.get('ev')) : null; } catch { ev = null; }
  return {
    site: p.get('site'),
    tab: p.get('tab'),
    state,
    focus: p.get('focus'),
    ev,
    snap: p.get('snap'),
    context: {
      week: p.get('wk'),
      cmp: p.get('cmp') || 'prev',
      seg: p.get('seg') || 'all',
      segv: p.get('segv') || 'all',
      dev: p.get('dev') || 'all',
    },
  };
}

export function hashFrom(app) {
  const p = new URLSearchParams();
  p.set('site', app.site);
  p.set('tab', app.tab);
  const c = app.context;
  if (c.week) p.set('wk', c.week);
  if (c.cmp && c.cmp !== 'prev') p.set('cmp', c.cmp);
  if (c.seg && c.seg !== 'all') {
    p.set('seg', c.seg);
    p.set('segv', c.segv || 'all');
  }
  if (c.dev && c.dev !== 'all') p.set('dev', c.dev);
  if (app.manifest?.generatedAt) p.set('snap', app.manifest.generatedAt);
  if (app.focus) p.set('focus', app.focus);
  if (app.ev) p.set('ev', JSON.stringify(app.ev));
  const tab = app.views.tabs.find((t) => t.id === app.tab);
  const ids = new Set((tab?.panels ?? []).map((pn) => pn.id));
  const tabState = Object.fromEntries(Object.entries(app.panelState).filter(([k, v]) => ids.has(k) && Object.keys(v).length));
  if (Object.keys(tabState).length) p.set('s', JSON.stringify(tabState));
  return `#${p}`;
}

export function writeHash(app, mode) {
  const hash = hashFrom(app);
  if (location.hash === hash) return;
  if (mode === 'push') history.pushState({ qt: 1 }, '', hash);
  else history.replaceState({ qt: 1 }, '', hash);
}

export function defaultWeek(manifest) {
  const weeks = manifest?.warehouse?.trendWeeks ?? [];
  const cov = coverage(manifest, 'funnel');
  const verified = weeks.filter((w) => cov.get(w)?.state === 'verified');
  return (verified.length ? verified : weeks).at(-1) ?? null;
}

export function compareWeek(weeks, week, cmp) {
  if (cmp === 'none') return null;
  const idx = weeks.indexOf(week);
  if (idx <= 0) return null;
  return weeks[idx - 1];
}

function picker(label, options, value, onchange) {
  return h('label', { class: 'picker' }, h('span', {}, label),
    h('select', { onchange: (e) => onchange(e.target.value) },
      options.map(([v, text]) => h('option', { value: v, selected: String(v) === String(value) ? 'selected' : null }, text))));
}

export function renderContextBar(host, { manifest, context, weeks, families, values, labels, onChange }) {
  const cov = coverage(manifest, 'funnel');
  const when = new Date(manifest.generatedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const weekOptions = weeks.map((w) => {
    const info = cov.get(w);
    const extra = coverageLabel(info);
    return [w, `Week of ${formatDay(w)}${extra ? ` · ${extra}` : ''}`];
  });
  const idx = weeks.indexOf(context.week);
  const compareOptions = [['prev', idx <= 0 ? 'Comparison unavailable' : 'Previous week'], ['none', 'No comparison']];
  const familyOptions = families.map((f) => [f, f === 'all' ? 'All visitors' : (labels[f] ?? f)]);
  const valueList = context.seg === 'all' ? [] : (values[context.seg] ?? []);
  host.replaceChildren(
    h('div', { class: 'snap-readout' }, h('span', {}, 'Snapshot'), h('strong', {}, when)),
    picker('Week', weekOptions, context.week, (week) => onChange({ week })),
    picker('Compare with', compareOptions, context.cmp, (cmp) => onChange({ cmp })),
    picker('Segment', familyOptions, context.seg, (seg) => onChange({ seg, segv: seg === 'all' ? 'all' : (values[seg]?.[0] ?? 'all') })),
    valueList.length ? picker('Value', valueList.map((v) => [v, labels[v] ?? v]), context.segv, (segv) => onChange({ segv })) : null,
    picker('Device', [['all', 'All devices'], ['mobile', 'Mobile'], ['desktop', 'Desktop'], ['tablet', 'Tablet']], context.dev, (dev) => onChange({ dev })),
  );
}

export function unsupportedScope(panel, context) {
  if (!panel.inherit || panel.segmentRole !== 'breakdown') return null;
  if (context.seg === 'all' || context.seg === panel.breakdown) return null;
  return {
    field: context.seg,
    reason: 'two segment families can\'t be crossed. Device crosses with one family.',
    alternative: { tab: 'ref-acquisition', panel: 'acq-cube', note: 'Bundle visits, a different population.' },
  };
}

export function contextPhrase(context, labels) {
  const seg = context.seg === 'all' ? 'all visitors' : `${labels[context.seg] ?? context.seg}: ${labels[context.segv] ?? context.segv}`;
  const dev = context.dev === 'all' ? 'all devices' : (labels[context.dev] ?? context.dev);
  return `${seg}, ${dev}`;
}
