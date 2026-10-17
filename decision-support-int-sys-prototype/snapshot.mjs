#!/usr/bin/env node
// One site's local snapshot for the query-tool prototype: stored rows from the
// read-only `_current` views, plus tables from the site's analyst bundle.
// Writes data/sites/<slug>/manifest.json and one JSON file per dataset.
// Nothing is written to the warehouse.
//
//   node prototype/query-tool/snapshot.mjs --site mellow
//   node prototype/query-tool/snapshot.mjs --site loop-earplugs --bundle ~/work/analysis/loop-earplugs
//   --skip-flows leaves out the journeys and funnel queries (flows.mjs), which take minutes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clickHouseConfig, createClickHouseClient } from '../../src/composition/clickhouse.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..', '..');
const ROW_CAP = 6000;
const CAP_ORDER = ['visits', 'm_sessions', 'm_clicks', 'sessions', 'm_entry_sessions', 'm_exposed_sessions', 'chains', 'orders', 'm_orders', 'visitors'];
const SKIP_BUNDLE = new Set(['line-items', 'selectors', 'element-binding', 'experiment-analysis']);

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) out[argv[i].slice(2)] = argv[i + 1]?.startsWith('--') ? true : argv[++i];
  }
  return out;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (ch !== '\r') field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  const [columns, ...body] = rows.filter((r) => r.length > 1 || r[0] !== '');
  const num = /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/;
  return { columns, rows: body.map((r) => r.map((v) => (v === '' ? null : num.test(v) ? Number(v) : v))) };
}

function readBundle(dir) {
  const tables = {};
  for (const file of fs.readdirSync(dir).filter((f) => /^\d\d_.*\.txt$/.test(f)).sort()) {
    const text = fs.readFileSync(path.join(dir, file), 'utf8');
    const re = /^=== TABLE: (\S+) ===$[\s\S]*?^--- BEGIN CSV ---\n([\s\S]*?)^--- END CSV ---$/gm;
    for (const m of text.matchAll(re)) {
      const body = m[2].split('\n').filter((l) => !l.startsWith('@@')).join('\n');
      tables[m[1]] = { ...parseCsv(body), file };
    }
  }
  return tables;
}

const col = (t, name) => t.columns.indexOf(name);

function monday(dateText) {
  const d = new Date(`${dateText}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

function addColumn(t, name, fn) {
  t.columns.push(name);
  for (const r of t.rows) r.push(fn(r));
}

function cap(t) {
  if (t.rows.length <= ROW_CAP) return { ...t, capped: false };
  const by = CAP_ORDER.map((c) => col(t, c)).find((i) => i >= 0);
  const rows = by === undefined ? t.rows.slice(0, ROW_CAP) : [...t.rows].sort((a, b) => (b[by] ?? 0) - (a[by] ?? 0)).slice(0, ROW_CAP);
  return { ...t, rows, capped: true, cappedFrom: t.rows.length, cappedBy: by === undefined ? 'file order' : t.columns[by] };
}

function shapeBundle(tables) {
  const out = {};
  const daily = tables.daily_site;
  if (daily && col(daily, 'index') >= 0) daily.columns[col(daily, 'index')] = 'd';
  for (const name of ['daily_site', 'daily_channel_device', 'campaign_daily', 'product_daily']) {
    const t = tables[name];
    if (t && col(t, 'd') >= 0) addColumn(t, 'week', (r) => (r[col(t, 'd')] ? monday(String(r[col(t, 'd')])) : null));
  }
  const sel = tables['selector-weekly'];
  if (sel) {
    const lookup = new Map((tables.selectors?.rows ?? []).map((r) => [r[0], r[1]]));
    const names = new Map((tables['element-binding']?.rows ?? []).map((r) => [r[col(tables['element-binding'], 'selector_id')], r[col(tables['element-binding'], 'm_name')]]));
    const id = col(sel, 'selector_id');
    addColumn(sel, 'selector', (r) => lookup.get(r[id]) ?? r[id]);
    addColumn(sel, 'name', (r) => names.get(r[id]) ?? r[col(sel, 'x_am_label')] ?? null);
  }
  const cards = Object.keys(tables).filter((n) => n.startsWith('cards-'));
  for (const [name, t] of Object.entries(tables)) {
    if (SKIP_BUNDLE.has(name) || cards.includes(name)) continue;
    out[name] = cap(t);
  }
  return out;
}

function catalogNames() {
  const names = new Map();
  const dir = path.join(repo, 'src/catalog/strategies');
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const cat = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    for (const s of cat.strategies ?? []) {
      const short = String(s.id).replace(/^[A-Z]+:/, '');
      names.set(`${cat.catalog_id}|${s.id}`, s.title);
      names.set(`${cat.catalog_id}|${short}`, s.title);
    }
  }
  return names;
}

function requirementTitles() {
  const raw = JSON.parse(fs.readFileSync(path.join(repo, 'src/catalog/requirements.json'), 'utf8'));
  const list = Array.isArray(raw) ? raw : raw.requirements ?? Object.values(raw);
  return new Map(list.map((r) => [r.key, { title: r.title, domain: r.domain }]));
}

function latest(view) {
  return `batch_id = (SELECT argMax(batch_id, generated_at) FROM {db}.${view} WHERE idsite = {idsite:UInt32})`;
}

const QUERIES = {
  trend: `SELECT row_type, row_key, row_key_1, row_key_2, toString(idsitehsr) AS idsitehsr, viewport_type, segment, segment_value,
      toString(week) AS week, sessions, buyers, orders, round(revenue, 2) AS revenue, clicks, progressed,
      JSONExtractInt(metrics, 'rank') AS rank
    FROM {db}.ae_trend_row_current WHERE idsite = {idsite:UInt32}`,
  tag_trend: `SELECT tag_key, tag_value, viewport_type, segment, segment_value, toString(week) AS week,
      sessions, buyers, orders, round(revenue, 2) AS revenue, progressed
    FROM {db}.ae_session_tag_trend_current WHERE idsite = {idsite:UInt32}`,
  tag_selection: `SELECT tag_key, family, status, reason, tagged_sessions, distinct_values,
      round(rps_z, 2) AS rps_z, round(rps_spread, 3) AS rps_spread, round(aov_z, 2) AS aov_z, round(aov_spread, 3) AS aov_spread,
      arrayStringConcat(trend_values, ' | ') AS trend_values, toString(window_start) AS window_start, toString(window_end) AS window_end
    FROM {db}.ae_session_tag_selection_current WHERE idsite = {idsite:UInt32}`,
  cards: `SELECT toString(idsitehsr) AS idsitehsr, catalog_id, strategy_id, segment_key, scope, surface, verdict, trigger_state,
      structural_state, gate_failed, blocking_rule, arrayStringConcat(missing_requirements, ', ') AS missing,
      arrayStringConcat(triggered_rules, ', ') AS triggered_rules, metric, value, threshold, confidence, attribution_label,
      test_code, impact_proxy, score, effort_class, toString(batch_id) AS batch
    FROM {db}.ae_strategy_card_current WHERE idsite = {idsite:UInt32} AND ${latest('ae_strategy_card_current')}`,
  requirements: `SELECT toString(idsitehsr) AS idsitehsr, requirement_key, status, dataset_id, source, row_count, detail, toString(batch_id) AS batch
    FROM {db}.ae_requirement_status_current WHERE idsite = {idsite:UInt32} AND ${latest('ae_requirement_status_current')}`,
  page_analysis: `SELECT toString(idsitehsr) AS idsitehsr, url, page_type, role, toString(window_start) AS window_start, toString(window_end) AS window_end,
      entry_sessions, orders, round(revenue, 2) AS revenue, single_pageview_share, scroll_reach_25, scroll_reach_70, desktop_rps, mobile_rps,
      cards_triggered, cards_silent, cards_below_floor, cards_blocked, status
    FROM {db}.ae_page_analysis_current WHERE idsite = {idsite:UInt32} AND ${latest('ae_page_analysis_current')}`,
  experiment_rows: `SELECT experiment_key, arm, is_control, basis, viewport_type, toString(toMonday(day)) AS week,
      sum(sessions) AS sessions, sum(buyers) AS buyers, sum(orders) AS orders, round(sum(revenue), 2) AS revenue
    FROM {db}.ae_experiment_row_current
    WHERE idsite = {idsite:UInt32} AND idsitehsr = 0 AND section = '' AND selector = ''
      AND basis IN ('assigned', 'exposed') AND segment = 'all'
    GROUP BY experiment_key, arm, is_control, basis, viewport_type, week`,
  experiments: `SELECT experiment_key, provenance, partner, name, hypothesis, kind, scope, status,
      toString(declared_start) AS declared_start, toString(declared_end) AS declared_end,
      toString(observed_start) AS observed_start, toString(observed_end) AS observed_end,
      assigned_visits, peak_daily_visits
    FROM {db}.ae_experiment_descriptor_current WHERE idsite = {idsite:UInt32}`,
};

async function pullWarehouse(idsite) {
  if (!process.env.CLICKHOUSE_HOST && fs.existsSync(path.join(repo, '.env'))) process.loadEnvFile(path.join(repo, '.env'));
  const config = clickHouseConfig(process.env);
  const client = createClickHouseClient(config, { requestTimeoutMs: 300_000 });
  const out = {};
  try {
    for (const [name, sql] of Object.entries(QUERIES)) {
      const result = await client.query({
        query: sql.replaceAll('{db}', config.database),
        query_params: { idsite },
        format: 'JSONCompactEachRowWithNames',
      });
      const [columns = [], ...rows] = await result.json();
      out[name] = { columns, rows, capped: false };
      console.log(`warehouse ${name}: ${rows.length} rows`);
    }
  } finally {
    await client.close();
  }
  return { tables: out, database: config.database };
}

function enrichWarehouse(t) {
  const names = catalogNames();
  if (t.cards) addColumn(t.cards, 'name', (r) => names.get(`${r[col(t.cards, 'catalog_id')]}|${r[col(t.cards, 'strategy_id')]}`) ?? null);
  const titles = requirementTitles();
  if (t.requirements) {
    const key = col(t.requirements, 'requirement_key');
    addColumn(t.requirements, 'title', (r) => titles.get(r[key])?.title ?? null);
    addColumn(t.requirements, 'domain', (r) => titles.get(r[key])?.domain ?? null);
  }
  if (t.experiments && t.experiment_rows) {
    const byKey = new Map();
    for (const r of t.experiments.rows) {
      const key = r[col(t.experiments, 'experiment_key')];
      const prior = byKey.get(key);
      if (!prior || r[col(t.experiments, 'provenance')] === 'operator') byKey.set(key, r);
    }
    t.experiments.rows = [...byKey.values()];
    const label = (key) => byKey.get(key)?.[col(t.experiments, 'name')] || key;
    addColumn(t.experiment_rows, 'experiment', (r) => label(r[col(t.experiment_rows, 'experiment_key')]));
  }
  if (t.trend) {
    const tr = t.trend;
    const pageUrl = new Map(tr.rows.filter((r) => r[col(tr, 'row_type')] === 'page').map((r) => [r[col(tr, 'row_key_1')], r[col(tr, 'row_key_2')]]));
    addColumn(tr, 'page_url', (r) => pageUrl.get(r[col(tr, 'idsitehsr')]) ?? null);
  }
}

// Within one segmentation the values sum to `all`, for every subject, device and week.
function checkPartition(t, identity, label) {
  if (!t?.rows.length) return { table: label, cells: 0, misses: 0, examples: [] };
  const idx = identity.map((c) => col(t, c));
  const [seg, val] = [col(t, 'segment'), col(t, 'segment_value')];
  const measures = ['sessions', 'orders', 'revenue'].map((c) => col(t, c));
  const cells = new Map();
  for (const r of t.rows) {
    const key = idx.map((i) => r[i]).join('|');
    if (!cells.has(key)) cells.set(key, { all: null, parts: new Map() });
    const cell = cells.get(key);
    const values = measures.map((i) => Number(r[i]) || 0);
    if (r[seg] === 'all') cell.all = values;
    else {
      const sum = cell.parts.get(r[seg]) ?? [0, 0, 0];
      cell.parts.set(r[seg], sum.map((s, i) => s + values[i]));
    }
  }
  let misses = 0;
  const examples = [];
  for (const [key, cell] of cells) {
    if (!cell.all) continue;
    for (const [segment, sum] of cell.parts) {
      const off = sum.some((s, i) => Math.abs(s - cell.all[i]) > (i === 2 ? 1 : 0));
      if (off) {
        misses += 1;
        if (examples.length < 5) examples.push({ key, segment, all: cell.all, sum });
      }
    }
  }
  return { table: label, cells: cells.size, misses, examples };
}

function writeDataset(dir, name, t, source, note) {
  const file = `${name.replace(/[^a-z0-9_-]/gi, '__')}.json`;
  fs.writeFileSync(path.join(dir, file), JSON.stringify({ columns: t.columns, rows: t.rows }));
  return {
    source, file, rows: t.rows.length, columns: t.columns,
    ...(t.capped ? { capped: true, cappedFrom: t.cappedFrom, cappedBy: t.cappedBy } : {}),
    ...(note ? { note } : {}),
  };
}

async function main() {
  const opts = args(process.argv.slice(2));
  if (!opts.site) throw new Error('--site <slug> is required');
  const siteFile = path.join(repo, 'orchestration/sites', opts.site, 'site.json');
  const site = JSON.parse(fs.readFileSync(siteFile, 'utf8'));
  const bundleDir = opts.bundle ?? path.join(os.homedir(), 'work/analysis', opts.site);
  const outDir = path.join(here, 'data/sites', opts.site);
  fs.mkdirSync(outDir, { recursive: true });

  const { tables: wh, database } = await pullWarehouse(Number(site.idsite));
  enrichWarehouse(wh);
  const checks = [
    checkPartition(wh.trend, ['row_type', 'row_key', 'row_key_1', 'row_key_2', 'idsitehsr', 'viewport_type', 'week'], 'trend'),
    checkPartition(wh.tag_trend, ['tag_key', 'tag_value', 'viewport_type', 'week'], 'tag_trend'),
  ];
  for (const c of checks) console.log(`partition ${c.table}: ${c.cells} cells, ${c.misses} misses`);
  if (checks.some((c) => c.misses) && !opts['allow-partition-miss']) {
    console.error(JSON.stringify(checks.map((c) => c.examples), null, 2));
    throw new Error('partition check failed; rerun with --allow-partition-miss to keep the snapshot anyway');
  }

  const datasets = {};
  for (const [name, t] of Object.entries(wh)) datasets[name] = writeDataset(outDir, name, t, 'warehouse');

  let bundle = null;
  if (fs.existsSync(bundleDir)) {
    const profile = fs.existsSync(path.join(bundleDir, '00_site_profile.json'))
      ? JSON.parse(fs.readFileSync(path.join(bundleDir, '00_site_profile.json'), 'utf8'))
      : {};
    const tables = shapeBundle(readBundle(bundleDir));
    for (const [name, t] of Object.entries(tables)) datasets[name] = writeDataset(outDir, name, t, 'bundle', `bundle file ${t.file}`);
    bundle = { dir: bundleDir, window: profile.report_window ?? null, periods: profile.periods ?? null, analysedPage: profile.analysed_page ?? null, tables: Object.keys(tables).length };
    console.log(`bundle: ${Object.keys(tables).length} tables from ${bundleDir}`);
  } else {
    console.log(`bundle: none at ${bundleDir}`);
  }

  const weeks = [...new Set((wh.trend?.rows ?? []).map((r) => r[col(wh.trend, 'week')]))].sort();
  const manifest = {
    site: { slug: opts.site, name: site.name, idsite: site.idsite, domain: site.domain, currency: site.currency ?? 'USD', platform: site.platform },
    generatedAt: new Date().toISOString(),
    warehouse: {
      database,
      trendWeeks: weeks,
      cardsBatch: wh.cards?.rows[0]?.[col(wh.cards, 'batch')] ?? null,
      requirementsBatch: wh.requirements?.rows[0]?.[col(wh.requirements, 'batch')] ?? null,
    },
    bundle,
    checks,
    datasets,
  };
  if (!opts['skip-flows'] && weeks.length) {
    const { pullFlows } = await import('./flows.mjs');
    writeFlows(outDir, manifest, await pullFlows({ idsite: Number(site.idsite), weeks }));
  }
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  const indexFile = path.join(here, 'data/sites.json');
  const index = fs.existsSync(indexFile) ? JSON.parse(fs.readFileSync(indexFile, 'utf8')) : [];
  const entry = { slug: opts.site, name: site.name, idsite: site.idsite, generatedAt: manifest.generatedAt };
  fs.writeFileSync(indexFile, JSON.stringify([...index.filter((s) => s.slug !== opts.site), entry].sort((a, b) => a.name.localeCompare(b.name)), null, 2));
  console.log(`wrote ${outDir} (${Object.keys(datasets).length} datasets)`);
}

export function writeFlows(dir, manifest, flows) {
  const checks = [
    checkPartition(flows.journeys, ['kind', 'row_key', 'path', 'step_index', 'viewport_type', 'week'], 'journeys'),
    checkPartition(flows.funnel, ['entry', 'viewport_type', 'week'], 'funnel'),
  ];
  for (const c of checks) console.log(`partition ${c.table}: ${c.cells} cells, ${c.misses} misses`);
  manifest.datasets.journeys = writeDataset(dir, 'journeys', flows.journeys, 'warehouse', `trend run, top ${flows.summary.pathLimit} paths of each kind, not stored`);
  manifest.datasets.funnel = writeDataset(dir, 'funnel', flows.funnel, 'warehouse', 'computed for the snapshot from journey_events_map');
  manifest.checks = [...(manifest.checks ?? []).filter((c) => !['journeys', 'funnel'].includes(c.table)), ...checks];
  manifest.flows = flows.summary;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
