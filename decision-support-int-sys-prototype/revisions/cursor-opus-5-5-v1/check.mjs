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
const VIEWS = new Set(['weekly', 'table', 'series', 'cards', 'journey', 'funnel', 'minifunnels', 'trendlines', 'headline', 'movers', 'decompose', 'health']);
// Built in the browser (app.js DERIVED): the source dataset and the columns it yields.
const DERIVED = {
  journey_summary: {
    from: 'journeys',
    columns: ['kind', 'path', 'rank', 'viewport_type', 'segment', 'segment_value', 'week', 'steps', 'start_sessions', 'end_sessions',
      'checkout', 'bought', 'end_orders', 'end_revenue', 'exact_sessions', 'exact_revenue'],
  },
  site_week: {
    from: 'funnel',
    columns: ['segment', 'segment_value', 'viewport_type', 'week', 'sessions', 'product_viewed', 'added_to_cart', 'checkout_started', 'buyers', 'orders', 'revenue'],
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
const fieldMap = views.context?.fieldMap;
if (!fieldMap?.device || !fieldMap?.week || !fieldMap?.segment) report('context', 'missing context.fieldMap');

for (const tab of views.tabs) {
  for (const p of tab.panels) {
    const where = `${tab.id}/${p.id}`;
    if (!VIEWS.has(p.view)) report(where, `unknown view ${p.view}`);
    for (const id of [...(p.measures ?? []), ...(p.facetMeasures ?? [])]) if (!measureCols(id)) report(where, `measure ${id} not defined`);
    for (const id of [p.floor?.measure, p.mix, p.highlight?.measure, p.highlight?.whenAtLeast?.measure].filter(Boolean)) {
      if (!measureCols(id)) report(where, `measure ${id} not defined`);
    }
    if (p.next && !views.tabs.some((t) => t.id === p.next.tab)) report(where, `next tab ${p.next.tab} not found`);
    for (const src of p.sources ?? []) if (!DERIVED[src.dataset] && src.dataset !== p.dataset) {
      /* existence is checked per snapshot below */
    }
  }
}

for (const site of sites) {
  const manifest = JSON.parse(readFileSync(join(data, 'sites', site.slug, 'manifest.json'), 'utf8'));
  console.log(`${site.slug}:`);
  for (const tab of views.tabs) {
    for (const p of tab.panels) {
      const where = `${tab.id}/${p.id}`;
      const derived = DERIVED[p.dataset];
      const ds = derived ? (manifest.datasets[derived.from] && { columns: derived.columns }) : manifest.datasets[p.dataset];
      if (!ds) { report(where, `dataset ${p.dataset} missing (panel shows as blocked)`); continue; }
      if (p.join && !manifest.datasets[p.join.dataset]) report(where, `join dataset ${p.join.dataset} missing`);
      for (const src of p.sources ?? []) {
        if (!DERIVED[src.dataset] && !manifest.datasets[src.dataset]) report(where, `movers source ${src.dataset} missing`);
      }
      if (p.inherit && fieldMap) {
        const inherited = Object.entries(p.inherit).filter(([, mode]) => mode);
        for (const [field] of inherited) {
          const names = field === 'segment' ? [...fieldMap.segment, ...(fieldMap.segment_value ?? [])] : (fieldMap[field] ?? []);
          if (!names.some((col) => ds.columns.includes(col))) report(where, `inherits ${field} but ${p.dataset} has none of ${names.join(', ')}`);
        }
      }
      const cols = new Set([
        ...Object.keys(p.filter ?? {}), ...(p.pickers ?? []).map((x) => x.field),
        ...[p.groupBy ?? []].flat(), ...(p.groupByOptions ?? []).filter((o) => o !== '(none)'),
        ...(p.show ?? []), p.rows, p.rowLabel, p.columns, p.x, p.cardTitle, p.cardSubtitle, ...(p.cardFields ?? []),
        p.series, p.facet, ...(p.steps ?? []).map((st) => st.col), ...(p.view === 'journey' ? JOURNEY_COLUMNS : []),
        ...[...(p.measures ?? []), ...(p.facetMeasures ?? [])].flatMap((id) => measureCols(id) ?? []),
        ...[p.floor?.measure, p.mix, p.highlight?.measure, p.highlight?.whenAtLeast?.measure].filter(Boolean).flatMap((id) => measureCols(id) ?? []),
      ].filter(Boolean));
      const missing = [...cols].filter((c) => !ds.columns.includes(c));
      if (missing.length) report(where, `${p.dataset} lacks ${missing.join(', ')}`);
    }
  }
}

console.log(problems ? `${problems} problem(s)` : 'views.json matches every snapshot');
process.exitCode = problems ? 1 : 0;
