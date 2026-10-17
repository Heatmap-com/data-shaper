#!/usr/bin/env node
// One-off extractor: data-capture-plan.md (the source of truth) →
// src/catalog/*.json. Run from the repo root:
//   node scripts/build-catalog.mjs ~/Work/research2/output/data-capture-plan.md
// The emitted files are committed; this script exists so the catalog data
// is traceable to the plan's tables instead of hand-transcribed.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const planPath = process.argv[2];
if (!planPath) throw new Error('usage: build-catalog.mjs <path to data-capture-plan.md>');
const md = readFileSync(planPath, 'utf8');
const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, '..', 'src', 'catalog');
mkdirSync(path.join(outDir, 'strategies'), { recursive: true });

/** Parse one markdown table starting at line index; returns {header, rows}. */
function parseTable(lines, start) {
  const header = lines[start].split('|').slice(1, -1).map((c) => c.trim());
  const rows = [];
  for (let i = start + 2; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line.startsWith('|')) break;
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    rows.push(cells);
  }
  return { header, rows };
}

const lines = md.split('\n');
function findSection(heading) {
  const idx = lines.findIndex((l) => l.trim().startsWith(heading));
  if (idx === -1) throw new Error(`heading not found: ${heading}`);
  return idx;
}
function findTableAfter(idx) {
  for (let i = idx; i < lines.length; i += 1) {
    if (lines[i].trim().startsWith('|')) return parseTable(lines, i);
  }
  throw new Error(`no table after line ${idx}`);
}

const DOMAIN_LAYER = { H: 'L1', T: 'L2', M: 'L3', S: 'L4', V: 'L5', A: 'L6', O: 'L8' };
const DOMAIN_NAME = {
  H: 'heatmap', T: 'tracker', M: 'render', S: 'commerce', V: 'vendor', A: 'ads_external', O: 'operator',
};
const TODAY_MECHANISM = {
  Live: 'query', Probe: 'query', Tracker: 'tracker', Render: 'render',
  API: 'api', Operator: 'operator',
};

// ── §4 requirement registry ──────────────────────────────────────────────
const requirements = [];
const registryVersion = '2026-10-04.1';

function addRequirements(heading, domain) {
  const { header, rows } = findTableAfter(findSection(heading));
  const col = Object.fromEntries(header.map((h, i) => [h, i]));
  for (const cells of rows) {
    const key = cells[col.Code];
    if (!/^([HTMSVAO]\d{2})$/.test(key)) continue;
    const datasetsRaw = cells[col['Dataset(s)'] ?? col.Dataset] ?? '';
    const todayRaw = cells[col.Today] ?? '';
    const today = todayRaw.split('(')[0].trim().split(' ')[0];
    requirements.push({
      key,
      domain: DOMAIN_NAME[domain],
      title: cells[col.Requirement],
      source_layer: DOMAIN_LAYER[domain],
      mechanism: TODAY_MECHANISM[today] ?? 'query',
      source_tables: col['Source tables'] !== undefined ? cells[col['Source tables']] : '',
      datasets: datasetsRaw.split(',').map((s) => s.trim().replace(/`/g, '').replace(/ v\d$/, '')).filter(Boolean),
      today: todayRaw,
      grain: '',
      human_required: domain === 'O' ? 1 : 0,
    });
  }
}

addRequirements('### 4.1', 'H');
addRequirements('### 4.2', 'T');
addRequirements('### 4.3', 'M');
addRequirements('### 4.4', 'S');
addRequirements('### 4.5', 'V');
addRequirements('### 4.6', 'A');
addRequirements('### 4.7', 'O');

if (requirements.length !== 98) {
  throw new Error(`expected 98 requirements, parsed ${requirements.length}`);
}
writeFileSync(
  path.join(outDir, 'requirements.json'),
  JSON.stringify({ registry_version: registryVersion, requirements }, null, 2) + '\n',
);

// ── §4.8 base sets ────────────────────────────────────────────────────────
{
  const { rows } = findTableAfter(findSection('### 4.8'));
  const sets = {};
  for (const cells of rows) {
    sets[cells[0].replace(/`/g, '')] = {
      requirements: cells[1].split(',').map((s) => s.trim()).filter(Boolean),
      applies_to: cells[2],
    };
  }
  writeFileSync(path.join(outDir, 'base-sets.json'), JSON.stringify(sets, null, 2) + '\n');
}

// ── §5 strategy tables ────────────────────────────────────────────────────
const SOURCE_DOC = {
  PO: 'Page-Optimization-Strategy-Decision-Methodology.md',
  PI: 'Strategy Inclusion Methodology Revenue-Joined Behavioral Screening for Page Optimization.md',
  PG: 'gpt.md',
  TI: 'Tool-Strategy Inclusion Methodology Structural and Behavioral Triggers for Third-Party Tools in Ecommerce.md',
  TD: 'Third-Party-Tool-Strategy-Decision-Methodology.md',
  TG: 'gpt-tools-research.md',
  LP: 'lp-strategies.md',
};
const CATALOG_VERSION = '2026-10-04.1';

function parseStrategyTable(heading, catalog) {
  const { header, rows } = findTableAfter(findSection(heading));
  const col = Object.fromEntries(header.map((h, i) => [h, i]));
  const strategies = [];
  for (const cells of rows) {
    const id = cells[col.Id].replace(/`/g, '');
    if (!id || id.startsWith('---')) continue;
    const raw = cells[col.Requires] ?? '';
    const codes = [...raw.matchAll(/\b([HTMSVAO]\d{2})\b/g)].map((m) => m[1]);
    const descriptorRefs = [...raw.matchAll(/\b(F\d{2}|p\d{2}\.\w+|s\d{2}\.\w+)\b/g)].map((m) => m[1]);
    const family = id.split(':')[1].match(/^[A-Z]+/)?.[0] ?? '';
    strategies.push({
      id,
      family,
      title: cells[col.Strategy],
      requirement_keys: [...new Set(codes)],
      descriptor_refs: [...new Set(descriptorRefs)],
      requires_raw: raw,
      source_ref: SOURCE_DOC[catalog],
    });
  }
  return strategies;
}

const catalogs = {
  PO: parseStrategyTable('### 5.1', 'PO'),
  PI: parseStrategyTable('### 5.2', 'PI'),
  PG: parseStrategyTable('### 5.3', 'PG'),
  TI: parseStrategyTable('### 5.4', 'TI'),
  TD: parseStrategyTable('### 5.5', 'TD'),
  TG: parseStrategyTable('### 5.6', 'TG'),
};

// TD:FIX and TD:F-ROUTE cards (§5.5 note).
catalogs.TD.push(
  {
    id: 'TD:FIX', family: 'FIX', title: 'Fix instance cards (unnamed FIX-n items)',
    requirement_keys: ['H17', 'V01', 'S06'], descriptor_refs: [], requires_raw: 'H17, V01 returns by product family, S06',
    source_ref: SOURCE_DOC.TD,
  },
  {
    id: 'TD:F-ROUTE', family: 'F', title: 'Flow-routing fix cards',
    requirement_keys: ['V05', 'H03'], descriptor_refs: [], requires_raw: 'V05 flow destination URL, H03',
    source_ref: SOURCE_DOC.TD,
  },
);

// PG:S12 alias row.
catalogs.PG.push({
  id: 'PG:S12', family: 'S', title: 'Attention-gap swap (alias of PG:A4)',
  requirement_keys: [], descriptor_refs: [], requires_raw: '', alias_of: 'PG:A4',
  source_ref: SOURCE_DOC.PG,
});

// Count check: 41 / 52 / 80(+1) / 38 / 23(+2) / 35.
const expected = { PO: 41, PI: 52, PG: 81, TI: 38, TD: 25, TG: 35 };
for (const [catalog, count] of Object.entries(expected)) {
  if (catalogs[catalog].length !== count) {
    throw new Error(`${catalog}: expected ${count} rows, parsed ${catalogs[catalog].length}`);
  }
}

for (const [catalog, strategies] of Object.entries(catalogs)) {
  writeFileSync(
    path.join(outDir, 'strategies', `${catalog.toLowerCase()}.json`),
    JSON.stringify(
      {
        catalog_version: CATALOG_VERSION,
        catalog_id: catalog,
        source: SOURCE_DOC[catalog],
        strategies: strategies.map((s) => ({
          ...s,
          scope: ['TI', 'TD', 'TG'].includes(catalog) ? 'site' : 'page',
          surface: '',
          tools: [],
          prerequisites: [],
          exclusions: [],
          confounds: [],
          kill_metric: null,
          guardrails: [],
          test_design: null,
          trigger: null,
          spec: {},
        })),
      },
      null,
      2,
    ) + '\n',
  );
}

// ── Appendix A crosswalk ─────────────────────────────────────────────────
{
  const idx = findSection('## Appendix A');
  const { rows } = findTableAfter(idx);
  const entries = [];
  for (const cells of rows) {
    const members = cells[1].split(',').map((s) => s.trim()).filter(Boolean);
    entries.push({ intent_id: cells[0], members, relation: cells[2] });
  }
  writeFileSync(
    path.join(outDir, 'crosswalk.json'),
    JSON.stringify({ catalog_version: CATALOG_VERSION, entries }, null, 2) + '\n',
  );
}

// ── §6.1 event registry ──────────────────────────────────────────────────
{
  const { header, rows } = findTableAfter(findSection('### 6.1'));
  const col = Object.fromEntries(header.map((h, i) => [h, i]));
  const families = [];
  for (const cells of rows) {
    const names = cells[col['Event names']].split(',').map((s) => s.trim().replace(/`/g, '')).filter(Boolean);
    families.push({
      code: cells[col.Family].split(' ')[0],
      family: cells[col.Family],
      events: names,
      required_properties: cells[col['Required properties beyond common']].split(',').map((s) => s.trim().replace(/`/g, '')).filter(Boolean),
      volume_rule: cells[col['Volume rule']],
      feeds: cells[col.Feeds].split(',').map((s) => s.trim()).filter(Boolean),
    });
  }
  writeFileSync(
    path.join(outDir, 'events.json'),
    JSON.stringify({ contract_version: '2026-10-04.1', common_properties: ['ts_ms', 'selector', 'element_class', 'item_id', 'item_index', 'is_default', 'value', 'viewport_h', 'scroll_y_rel'], families }, null, 2) + '\n',
  );
}

console.log('catalog files written:', requirements.length, 'requirements;',
  Object.entries(catalogs).map(([k, v]) => `${k}=${v.length}`).join(' '));
