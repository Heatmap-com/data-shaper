import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { adaptersIn, discoverAdapterRoles } from '../src/discover.js';
import { createAeBatch, runAeBatch } from '../src/runner-ae.js';
import { createMemoryAePersistence } from '../src/adapters/persistence/memory.js';
import {
  captureGate,
  collectDatasets,
  createSiteState,
  draftDescriptors,
  qualify,
  writeAnalysis,
} from '../src/site-analysis/handlers.js';

/**
 * One site through the schema-2 pipeline on the memory store: two pages pass
 * the capture gate, page and site datasets run, requirement status refreshes
 * after the site datasets, the bot drafts descriptors, site and page cards
 * run, and the analysis rows are written. The stored rows are the record.
 */

const adaptersDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'adapters');
const roles = await discoverAdapterRoles(adaptersDir);
const discovered = adaptersIn(roles, 'datasets');
const descriptorSources = adaptersIn(roles, 'descriptor-sources');
const requirementStatus = discovered.find((d) => d.id === 'requirement-status');

const logger = { info() {}, warn() {}, error() {} };
const clock = { todayUtc: () => '2026-10-03' };
const site = { idsite: 1, siteName: 'one' };

const siteSource = { id: 'fixture-one-site', async listSites() { return [site]; } };

const qualification = {
  status: 'qualified',
  idsitehsr: 101,
  url: 'https://one.com/pages/lp',
  pageType: 'content',
  entrySessions: 500,
  orders: 4,
  revenue: 400,
  evidence: { title: 'LP', unfiltered: { sessions: 520, orders: 4, revenue: 400 } },
};
const qualifier = { id: 'fixture-qualifier', async qualify() { return qualification; } };

const targets = [
  { idsitehsr: 101, url: 'https://one.com/pages/lp', pageTitle: 'LP', pageType: 'content', role: 'primary', selectionReason: 'qualifier choice', entrySessions: 500, orders: 4, revenue: 400 },
  { idsitehsr: 102, url: 'https://one.com/products/a', pageTitle: 'A', pageType: 'product', role: 'sister', selectionReason: 'next-highest entry page', entrySessions: 300, orders: 2, revenue: 180 },
];
const pageSelector = { id: 'fixture-selector', async select() { return targets; } };

const gateway = {
  async query() { throw new Error('Unknown table (fixture gateway)'); },
  async explain() { return ''; },
  async columns() { return []; },
};

const card = (strategy, verdict) => ({
  dims: { strategy_id: strategy, segment_key: 'all' },
  metrics: { verdict, trigger_state: verdict === 'include' ? 'triggered' : 'silent', trigger_evaluated: 1 },
});

function datasets() {
  return [
    {
      id: 'fixture-page',
      dependsOn: [],
      scope: 'page',
      provides: [],
      descriptor: { id: 'fixture-page', replay: 'keep' },
      async collect(page) {
        return {
          id: 'fixture-page',
          rows: [{ dims: { week: '2026-09-28' }, metrics: { sessions: page.qualified.entrySessions } }],
          notes: { fixture_page_note: page.idsitehsr },
          requirements: [{ key: 'H98', status: 'available', rowCount: 1 }],
        };
      },
    },
    requirementStatus,
    {
      id: 'fixture-site',
      dependsOn: [],
      scope: 'site',
      provides: ['H99'],
      descriptor: { id: 'fixture-site', replay: 'keep' },
      async collect(_page, ctx) {
        return {
          id: 'fixture-site',
          rows: [{ dims: { week: '2026-09-28' }, metrics: { pages: ctx.datasets.size } }],
          notes: { fixture_site_note: 'ran once' },
          requirements: [{ key: 'H99', status: 'available', rowCount: 1 }],
        };
      },
    },
    {
      id: 'cards-fx',
      dependsOn: [],
      scope: 'site',
      provides: [],
      descriptor: { id: 'cards-fx', replay: 'recollect', role: 'card', catalogId: 'FX' },
      async collect() {
        return { id: 'cards-fx', rows: [card('S1', 'include')] };
      },
    },
    {
      id: 'cards-fy',
      dependsOn: [],
      scope: 'page',
      provides: [],
      descriptor: { id: 'cards-fy', replay: 'recollect', role: 'card', catalogId: 'FY' },
      async collect(page, ctx) {
        const status = ctx.datasets.get('requirement-status')?.rows?.length ?? 0;
        return { id: 'cards-fy', rows: [card(`P${page.idsitehsr}`, status > 0 ? 'include' : 'exclude')] };
      },
    },
  ];
}

const STORED = ['siteQueue', 'pageTargets', 'captureQueue', 'datasetRows', 'analysisCheckpoints', 'requirementStatus', 'strategyCards', 'pageAnalyses', 'siteAnalyses', 'pageDescriptors'];
const TIME = /^\d{4}-\d\d-\d\d[ T]\d\d:\d\d/;
const PER_CLAIM = new Set(['claim_token', 'claimedAt']);

/** @param {object} state @param {string} batchId */
function stored(state, batchId) {
  const scrub = (value) => {
    if (value === batchId) return '<batch>';
    if (typeof value === 'string' && TIME.test(value)) return '<time>';
    if (Array.isArray(value)) return value.map(scrub);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, PER_CLAIM.has(k) ? '<claim>' : scrub(v)]));
    }
    return value;
  };
  const sortKey = (row) => JSON.stringify(row);
  return Object.fromEntries(STORED.map((name) => [name, scrub(state[name] ?? []).sort((a, b) => sortKey(a).localeCompare(sortKey(b)))]));
}

async function seeded() {
  const { adapter, snapshot } = createMemoryAePersistence();
  const { batchId } = await createAeBatch({
    persistence: adapter,
    clock,
    windowDays: 7,
    catalogs: ['FX', 'FY'],
    standards: {},
    siteSourceId: siteSource.id,
    qualifierId: qualifier.id,
    pageSelectorId: pageSelector.id,
    maxPagesPerSite: 6,
  });
  for (const target of targets) {
    await adapter.completeCapture({ idsite: 1, idsitehsr: target.idsitehsr, url: target.url, capturedOn: '2026-10-03', bindings: [] });
  }
  const deps = { persistence: adapter, siteSource, qualifier, pageSelector, datasets: datasets(), descriptorSources, logger, clock, gateway };
  return { adapter, snapshot, batchId, deps };
}

/**
 * The handlers in stage order on a claimed site. `shared` runs them in one
 * process on one state; otherwise each starts from the store, as separate
 * stages do.
 * @param {{shared: boolean}} opts
 */
async function runHandlers({ shared }) {
  const { adapter, snapshot, batchId, deps } = await seeded();
  await adapter.enqueueSites(batchId, [site]);
  await adapter.claimNextSite(batchId);
  const window = await adapter.getBatch(batchId);
  const one = createSiteState();
  const state = () => (shared ? one : createSiteState());

  const qualified = await qualify({ site, window, deps, state: state() });
  expect(qualified).toMatchObject({ status: 'ok', facts: { outcome: 'qualified' } });
  const base = { site: { ...site, qualification: qualified.facts.qualification }, window, deps };
  const gate = await captureGate({ ...base, pages: qualified.facts.pages, state: state() });
  expect(gate.facts.outcome).toBe('ready');
  const ready = { ...base, pages: gate.facts.pages };
  await collectDatasets({ ...ready, scope: 'page', state: state() });
  await draftDescriptors({ ...ready, state: state() });
  await collectDatasets({ ...ready, scope: 'site', state: state() });
  const written = await writeAnalysis({ ...ready, state: state() });
  expect(written.facts).toEqual({ outcome: 'analyzed', pagesAnalyzed: 2 });
  return stored(snapshot(), batchId);
}

async function batchRows() {
  const { snapshot, batchId, deps } = await seeded();
  const counts = await runAeBatch(batchId, deps);
  expect(counts).toMatchObject({ queued: 1, qualified: 1, pagesAnalyzed: 2 });
  return stored(snapshot(), batchId);
}

describe('site analysis scenario', () => {
  it('runAeBatch writes the recorded rows', async () => {
    expect(await batchRows()).toMatchSnapshot();
  });

  it('the handlers in sequence on one state write the rows runAeBatch writes', async () => {
    expect(await runHandlers({ shared: true })).toEqual(await batchRows());
  });

  it('the handlers as separate stages, each reading the store, write the same rows', async () => {
    expect(await runHandlers({ shared: false })).toEqual(await batchRows());
  });

  it('a skipped site stops at qualify and records the reason', async () => {
    const { adapter, snapshot, batchId, deps } = await seeded();
    await adapter.enqueueSites(batchId, [site]);
    const window = await adapter.getBatch(batchId);
    const skipping = { ...deps, qualifier: { id: 'no', async qualify() { return { status: 'skipped', reason: 'no entry page' }; } } };
    const result = await qualify({ site, window, deps: skipping });
    expect(result).toEqual({ status: 'ok', message: 'site skipped', facts: { outcome: 'skipped', qualification: { status: 'skipped', reason: 'no entry page' }, pages: [] } });
    expect(snapshot().siteQueue[0]).toMatchObject({ status: 'skipped', reason: 'no entry page' });
  });
});
