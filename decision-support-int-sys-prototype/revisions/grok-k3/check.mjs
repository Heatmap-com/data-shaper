#!/usr/bin/env node
// Checks views.json against every snapshot: datasets present, columns present, measures defined.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const views = JSON.parse(readFileSync(join(here, 'views.json'), 'utf8'));
const data = join(here, '..', '..', 'data');
const sitesFile = join(data, 'sites.json');
const sites = existsSync(sitesFile) ? JSON.parse(readFileSync(sitesFile, 'utf8')) : [];
const VIEWS = new Set(['homework', 'weekly', 'table', 'series', 'cards', 'journey', 'funnel', 'minifunnels', 'trendlines',
  'answerline', 'movers', 'decompose', 'verdictsummary', 'moverlists', 'annotations', 'actions', 'unblock', 'contraststrip', 'contrastgrid', 'campaignchanges']);
const CONTRAST_COLUMNS = ['entry', 'week', 'segment', 'segment_value', 'viewport_type', 'sessions', 'product_viewed', 'added_to_cart', 'checkout_started', 'buyers', 'orders', 'revenue'];
// Views that read whole datasets in code rather than through pickers and measures.
const CODE_VIEWS = { homework: ['week', 'segment', 'segment_value', 'viewport_type', 'sessions', 'product_viewed', 'added_to_cart', 'checkout_started', 'buyers', 'orders', 'revenue'], answerline: ['week', 'segment', 'segment_value', 'viewport_type', 'sessions', 'orders', 'revenue'],
  movers: ['week', 'segment', 'segment_value', 'viewport_type', 'sessions', 'orders', 'revenue'],
  moverlists: ['week', 'segment', 'segment_value', 'viewport_type', 'sessions', 'orders', 'revenue'],
  decompose: ['week', 'segment', 'segment_value', 'viewport_type', 'sessions', 'orders', 'revenue'],
  annotations: ['week', 'segment', 'viewport_type', 'revenue'],
  verdictsummary: ['m_state'], actions: ['x_strategy_id', 'm_state', 'm_metric', 'm_value', 'm_threshold', 'm_detail'],
  unblock: ['requirement_key', 'title', 'domain', 'detail'],
  contraststrip: CONTRAST_COLUMNS, contrastgrid: CONTRAST_COLUMNS, campaignchanges: ['week'] };
const NAME_KEYS = ['campaign', 'creative', 'selector', 'experiment_arm', 'page', 'changes'];
const ENTITY_TYPES = new Set(['campaign', 'creative', 'selector', 'experiment', 'experiment_arm']);
const CTX_KEYS = new Set(['week', 'device', 'split']);
// Built in the browser (app.js DERIVED): the source dataset and the columns it yields.
const DERIVED = {
  journey_summary: {
    from: 'journeys',
    columns: ['kind', 'path', 'rank', 'viewport_type', 'segment', 'segment_value', 'week', 'steps', 'start_sessions', 'end_sessions',
      'checkout', 'bought', 'end_orders', 'end_revenue', 'exact_sessions', 'exact_revenue'],
  },
};
const JOURNEY_COLUMNS = ['path', 'row_key', 'step_index', 'step', 'rank', 'week', 'sessions', 'progressed', 'buyers', 'orders', 'revenue'];

const measureCols = (id) => {
  const m = views.measures[id];
  if (!m) return null;
  return m.sum ? [m.sum] : m.share ? [m.share] : m.ratio ?? [];
};

let problems = 0;
const report = (where, msg) => { problems += 1; console.log(`  ${where}: ${msg}`); };

for (const tab of views.tabs) {
  for (const p of tab.panels) {
    const where = `${tab.id}/${p.id}`;
    if (!VIEWS.has(p.view)) report(where, `unknown view ${p.view}`);
    for (const id of [...(p.measures ?? []), ...(p.facetMeasures ?? [])]) if (!measureCols(id)) report(where, `measure ${id} not defined`);
    for (const id of [p.floor?.measure, p.mix, p.highlight?.measure, p.highlight?.whenAtLeast?.measure].filter(Boolean)) {
      if (!measureCols(id)) report(where, `measure ${id} not defined`);
    }
    if (p.next) report(where, 'uses next; Grok - K3 panels drill instead');
    for (const d of [p.drill, p.drillHint, ...Object.values(p.modes?.options ?? {}).map((o) => o.drill)].filter(Boolean)) {
      const t = views.tabs.find((x) => x.id === d.tab);
      if (!t) report(where, `drill tab ${d.tab} not found`);
      else if (d.panel && !t.panels.some((x) => x.id === d.panel)) report(where, `drill panel ${d.tab}/${d.panel} not found`);
    }
    for (const k of p.inherit ?? []) if (!CTX_KEYS.has(k)) report(where, `inherit key ${k} unknown`);
    for (const [f, t] of Object.entries(p.entities ?? {})) if (!ENTITY_TYPES.has(t)) report(where, `entity type ${t} for ${f} unknown`);
    for (const pk of p.pickers ?? []) if (['week', 'dim_week'].includes(pk.field) && pk.default !== 'latestFull') report(where, `week picker ${pk.field} must default to latestFull`);
    if (p.hidden && p.demoted) report(where, 'both hidden and demoted');
    if (p.modes) {
      if (!p.modes.options?.[p.modes.default]) report(where, `modes default ${p.modes.default} not an option`);
      for (const [id, o] of Object.entries(p.modes.options ?? {})) {
        if (!o.modeLabel) report(where, `mode ${id} has no modeLabel`);
        for (const mid of o.measures ?? []) if (!measureCols(mid)) report(where, `mode ${id} measure ${mid} not defined`);
      }
    }
  }
}
if (views.wobble?.bandScope !== 'self' && views.wobble?.bandScope !== 'site') report('views', 'wobble.bandScope must be self or site');
if (!(views.wobble?.bandMult > 0) || !(views.wobble?.minChanges >= 1)) report('views', 'wobble needs bandMult and minChanges');
if (!views.measureFloors || typeof views.measureFloors.order_rate !== 'number') report('views', 'measureFloors.order_rate missing');
const lead = views.tabs[0]?.id === 'homework' ? 1 : 0;
if (views.tabs[lead]?.id !== 'home' || views.tabs[lead + 1]?.id !== 'change') report('views', 'home and change must be the first two tabs, after an optional homework tab');
const ids = views.tabs.flatMap((t) => t.panels.map((p) => p.id));
for (const id of new Set(ids)) if (ids.filter((x) => x === id).length > 1) report('views', `panel id ${id} repeats`);

for (const site of sites) {
  const manifest = JSON.parse(readFileSync(join(data, 'sites', site.slug, 'manifest.json'), 'utf8'));
  console.log(`${site.slug}:`);
  for (const tab of views.tabs) {
    for (const p of tab.panels) {
      const where = `${tab.id}/${p.id}`;
      const variants = [p, ...Object.values(p.modes?.options ?? {}).map((o) => ({ ...p, ...o }))];
      for (const pv of variants) checkPanel(manifest, where, pv);
      for (const extra of p.also ?? []) {
        if (!DERIVED[extra] && !manifest.datasets[extra]) report(where, `also dataset ${extra} missing`);
      }
    }
  }
  const namesFile = join(here, 'names', `${site.slug}.json`);
  if (!existsSync(namesFile)) report(site.slug, 'names file missing');
  else {
    try {
      const names = JSON.parse(readFileSync(namesFile, 'utf8'));
      for (const k of NAME_KEYS) if (!(k in names)) report(site.slug, `names file lacks ${k}`);
    } catch (e) { report(site.slug, `names file does not parse: ${e.message}`); }
  }
}

function checkPanel(manifest, where, p) {
  const derived = DERIVED[p.dataset];
  const ds = derived ? (manifest.datasets[derived.from] && { columns: derived.columns }) : manifest.datasets[p.dataset];
  if (!ds) { report(where, `dataset ${p.dataset} missing (panel shows as blocked)`); return; }
  if (p.join && !manifest.datasets[p.join.dataset]) report(where, `join dataset ${p.join.dataset} missing`);
  if (p.changes) {
    const o = p.changes;
    if (p.view !== 'campaignchanges') report(where, 'changes only work on the campaignchanges view');
    if (!Array.isArray(p.groupBy) || !p.groupBy.length) report(where, 'changes needs groupBy');
    for (const id of [o.volume, o.money, ...(o.metrics ?? [])]) if (!views.measures[id]) report(where, `changes names an unknown measure ${id}`);
    for (const id of [o.volume, o.money]) if (views.measures[id] && !views.measures[id].sum) report(where, `changes.${id === o.volume ? 'volume' : 'money'} must be a sum measure`);
    if (!(o.metrics ?? []).includes(o.volume)) report(where, 'changes.metrics must include the volume measure');
    if (!(p.pickers ?? []).some((x) => x.field === (o.week ?? 'week'))) report(where, 'changes needs a week picker');
  }
  if (p.outliers) {
    const o = p.outliers;
    if (p.view !== 'table') report(where, 'outliers only work on table views');
    for (const k of ['volume', 'rate', 'value']) if (!views.measures[o[k]]) report(where, `outliers.${k} names an unknown measure ${o[k]}`);
    if (views.measures[o.volume] && !views.measures[o.volume].sum) report(where, 'outliers.volume must be a sum measure');
    if (o.count && !views.measures[o.count]?.sum) report(where, 'outliers.count must be a sum measure');
    for (const k of ['rate', 'value']) if (views.measures[o[k]] && !views.measures[o[k]].ratio) report(where, `outliers.${k} must be a ratio measure`);
    if (o.default && !['outliers', 'all'].includes(o.default)) report(where, `outliers.default must be outliers or all, not ${o.default}`);
    if (o.history !== false && !(p.pickers ?? []).some((x) => x.field === (o.week ?? 'week'))) report(where, 'outliers history needs a week picker (or history: false)');
  }
  if (p.contrast === true && p.dataset !== 'funnel') report(where, 'contrast: true needs the funnel dataset; use "funnel" with also: ["funnel"]');
  if (p.contrast === 'funnel' && !(p.also ?? []).includes('funnel')) report(where, 'contrast: "funnel" needs also: ["funnel"]');
  if (p.contrast && ![true, false, 'funnel'].includes(p.contrast)) report(where, `contrast must be true, false or "funnel", not ${JSON.stringify(p.contrast)}`);
  if (p.contrast && manifest.datasets.funnel) {
    const fc = new Set(manifest.datasets.funnel.columns.map((c) => c.name ?? c));
    const lack = CONTRAST_COLUMNS.filter((c) => !fc.has(c));
    if (lack.length) report(where, `funnel lacks columns for contrasts: ${lack.join(', ')}`);
  }
  const cols = new Set([
    ...Object.keys(p.filter ?? {}), ...(p.pickers ?? []).map((x) => x.field),
    ...[p.groupBy ?? []].flat(), ...(p.groupByOptions ?? []).filter((o) => o !== '(none)'),
    ...(p.show ?? []), p.rows, p.rowLabel, p.columns, p.x, p.cardTitle, p.cardSubtitle, ...(p.cardFields ?? []),
    p.series, p.facet, ...(p.steps ?? []).map((st) => st.col), ...(p.view === 'journey' ? JOURNEY_COLUMNS : []), ...(CODE_VIEWS[p.view] ?? []),
    ...[...(p.measures ?? []), ...(p.facetMeasures ?? [])].flatMap((id) => measureCols(id) ?? []),
    ...[p.floor?.measure, p.mix, p.highlight?.measure, p.highlight?.whenAtLeast?.measure, p.outliers?.volume, p.outliers?.rate, p.outliers?.value, p.outliers?.count, p.changes?.volume, p.changes?.money, ...(p.changes?.metrics ?? [])].filter(Boolean).flatMap((id) => measureCols(id) ?? []),
  ].filter(Boolean));
  const missing = [...cols].filter((c) => !ds.columns.includes(c));
  if (missing.length) report(where, `${p.dataset} lacks ${missing.join(', ')}`);
}

console.log(problems ? `${problems} problem(s)` : 'views.json matches every snapshot');
process.exitCode = problems ? 1 : 0;
