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
const VIEWS = new Set(['weekly', 'table', 'series', 'cards', 'journey', 'funnel', 'minifunnels', 'trendlines',
  'comparison', 'eventReach', 'journeyFocus', 'answers', 'outcomes', 'changeBridge', 'mixRate', 'brief']);
const DERIVED = {
  journey_summary: {
    from: 'journeys',
    columns: ['kind', 'path', 'rank', 'viewport_type', 'segment', 'segment_value', 'week', 'steps', 'start_sessions', 'end_sessions',
      'checkout', 'bought', 'end_orders', 'end_revenue', 'exact_sessions', 'exact_revenue'],
  },
  scope_weekly: { from: 'funnel', columns: ['week', 'entry', 'viewport_type', 'segment', 'segment_value', 'sessions', 'product_viewed', 'added_to_cart', 'checkout_started', 'buyers', 'orders', 'revenue'] },
  metric_comparisons: { from: 'funnel', columns: ['week', 'segment', 'segment_value', 'viewport_type', 'sessions', 'buyers', 'revenue'] },
  journey_comparisons: { from: 'journeys', columns: ['kind', 'path', 'week', 'viewport_type', 'segment', 'segment_value', 'sessions', 'buyers'] },
  revenue_bridge: { from: 'funnel', columns: ['week', 'sessions', 'buyers', 'orders', 'revenue'] },
  mix_rate_effects: { from: 'funnel', columns: ['week', 'segment', 'segment_value', 'viewport_type', 'entry', 'sessions', 'buyers', 'revenue'] },
  answer_candidates: { from: 'funnel', columns: ['week', 'sessions'] },
  brief_items: { from: null, columns: [] },
};
const CONDITIONS = new Set(['decline_reviewable', 'largest_share_below_rest', 'reach_reviewable', 'rate_change_reviewable']);
const RULE_FIELDS = {
  journey_completion_decline: ['path', 'completion', 'completion_pct', 'delta_pp', 'compare_week', 'starts'],
  channel_on_site_value: ['source', 'segment_label', 'share', 'rate', 'current_pct', 'others_rate', 'comparison_pct', 'comparison_label', 'top2_label', 'top2_rate'],
  event_reach_movement: ['action', 'current', 'delta_pp', 'compare_week'],
  channel_rate_change: ['source', 'prior', 'current'],
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
    if (p.next && !views.tabs.some((t) => t.id === p.next.tab)) report(where, `next tab ${p.next.tab} not found`);
  }
}

for (const site of sites) {
  const manifest = JSON.parse(readFileSync(join(data, 'sites', site.slug, 'manifest.json'), 'utf8'));
  console.log(`${site.slug}:`);
  for (const tab of views.tabs) {
    for (const p of tab.panels) {
      const where = `${tab.id}/${p.id}`;
      const derived = DERIVED[p.dataset];
      const ds = derived
        ? (derived.from === null || manifest.datasets[derived.from] ? { columns: derived.columns } : null)
        : manifest.datasets[p.dataset];
      if (!ds) { report(where, `dataset ${p.dataset} missing (panel shows as blocked)`); continue; }
      if (p.join && !manifest.datasets[p.join.dataset]) report(where, `join dataset ${p.join.dataset} missing`);
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

const ids = new Set();
for (const tab of views.tabs) {
  for (const p of tab.panels) {
    if (ids.has(p.id)) report('ids', `panel ${p.id} is used twice`);
    ids.add(p.id);
  }
}
for (const [name, contract] of Object.entries(views.datasetContracts ?? {})) {
  const keys = [...(contract.keys ?? []), ...(contract.dimensions ?? []), ...(contract.nonAdditiveAcross ?? [])];
  const sample = sites[0] ? JSON.parse(readFileSync(join(data, 'sites', sites[0].slug, 'manifest.json'), 'utf8')) : null;
  const derived = DERIVED[name];
  const ds = derived ? { columns: derived.columns } : sample?.datasets?.[name];
  if (!ds) { report('contracts', `${name} is not in the snapshot`); continue; }
  const missing = keys.filter((k) => !ds.columns.includes(k));
  if (missing.length) report('contracts', `${name} lacks ${missing.join(', ')}`);
}
for (const rule of views.answerRules ?? []) {
  if (!rule.dataset) report(rule.id, 'missing dataset');
  if (!CONDITIONS.has(rule.condition)) report(rule.id, `unknown condition ${rule.condition}`);
  const fields = [...rule.claimTemplate.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
  const allowed = RULE_FIELDS[rule.id] ?? [];
  const unknown = fields.filter((f) => !allowed.includes(f));
  if (unknown.length) report(rule.id, `template fields ${unknown.join(', ')} are not resolved`);
}

if (problems) console.log(`${problems} problem(s)`);
else console.log('views.json matches every snapshot');
process.exitCode = problems ? 1 : 0;
