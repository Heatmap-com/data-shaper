import { describe, expect, it } from 'vitest';
import { createAeBatch, runAeBatch } from '../src/runner-ae.js';
import { cardRow } from '../src/site-analysis/rows.js';
import { createMemoryAePersistence } from '../src/adapters/persistence/memory.js';

/**
 * runAeBatch end-to-end over the memory persistence adapter: two selected
 * pages pass their capture gates and their page datasets; the site-scope
 * dataset runs exactly once per site, after the page datasets, and lands
 * in ae_dataset_row with scope 'site' / idsitehsr 0; its requirement and
 * cards outputs land in ae_requirement_status / ae_strategy_card the same
 * way. pageSelectorOpts.maxPagesPerSite truncates the selection.
 */

const logger = { info() {}, warn() {}, error() {} };
const clock = { todayUtc: () => '2026-10-03' };

const siteSource = {
  id: 'fixture-one-site',
  async listSites() {
    return [{ idsite: 1, siteName: 'one' }];
  },
};

const qualifier = {
  id: 'fixture-qualifier',
  async qualify() {
    return {
      status: 'qualified',
      idsitehsr: 101,
      url: 'https://one.com/pages/lp',
      pageType: 'content',
      entrySessions: 500,
      orders: 4,
      revenue: 400,
      evidence: { title: 'LP', unfiltered: { sessions: 520, orders: 4, revenue: 400 } },
    };
  },
};

const targets = [
  {
    idsitehsr: 101,
    url: 'https://one.com/pages/lp',
    pageTitle: 'LP',
    pageType: 'content',
    role: 'primary',
    selectionReason: 'qualifier choice',
    entrySessions: 500,
    orders: 4,
    revenue: 400,
  },
  {
    idsitehsr: 102,
    url: 'https://one.com/products/a',
    pageTitle: 'A',
    pageType: 'product',
    role: 'sister',
    selectionReason: 'next-highest entry page',
    entrySessions: 300,
    orders: 2,
    revenue: 180,
  },
];

/** @param {Array<string>} calls @returns {object} */
function makePageSelector(calls) {
  return {
    id: 'fixture-selector',
    async select(site, qualification, ctx, opts) {
      calls.push(`select:maxPages=${opts?.maxPages}`);
      return targets;
    },
  };
}

const gateway = {
  async query() {
    // Pre-cutover shape: no ae_ tables. Cards must tolerate this and take
    // the honest gate-failure path, not throw.
    throw new Error('Unknown table (fixture gateway)');
  },
  async explain() {
    return '';
  },
  async columns() {
    return [];
  },
};

/** @param {Array<string>} calls @returns {object[]} */
function makeDatasets(calls) {
  return [
    {
      id: 'fixture-page',
      dependsOn: [],
      scope: 'page',
      provides: [],
      async collect(page) {
        calls.push(`page:${page.idsitehsr}`);
        return {
          id: 'fixture-page',
          rows: [{ dims: { week: '2026-09-28' }, metrics: { sessions: page.qualified.entrySessions } }],
        };
      },
    },
    {
      id: 'fixture-site',
      dependsOn: [],
      scope: 'site',
      provides: ['H99'],
      async collect(page, ctx) {
        calls.push('site');
        // the site ctx is pre-seeded with every page dataset this site
        expect(page.idsitehsr).toBe(0);
        expect(page.idsite).toBe(1);
        expect(ctx.datasets.has('fixture-page')).toBe(true);
        expect(ctx.datasets.has('fixture-site')).toBe(false);
        return {
          id: 'fixture-site',
          rows: [{ dims: { week: '2026-09-28' }, metrics: { pages: ctx.datasets.size } }],
          notes: { fixture_site_note: 'ran once' },
          requirements: [{ key: 'H99', status: 'available', rowCount: 1 }],
        };
      },
    },
    {
      id: 'cards-fixture',
      dependsOn: [],
      scope: 'site',
      provides: [],
      descriptor: { id: 'cards-fixture', role: 'card', catalogId: 'FIXTURE' },
      async collect() {
        calls.push('cards');
        return {
          id: 'cards-fixture',
          rows: [
            {
              dims: { strategy_id: 'S1', segment_key: 'all' },
              metrics: { verdict: 'include', trigger_state: 'triggered', trigger_evaluated: 1 },
            },
          ],
        };
      },
    },
  ];
}

/** @param {object} persistence */
async function seedCaptures(persistence) {
  for (const target of targets) {
    await persistence.completeCapture({
      idsite: 1,
      idsitehsr: target.idsitehsr,
      url: target.url,
      capturedOn: '2026-10-03',
      bindings: [],
    });
  }
}

/**
 * @param {number} maxPages
 */
async function runBatch(maxPages) {
  const { adapter, snapshot } = createMemoryAePersistence();
  const calls = [];
  const deps = {
    persistence: adapter,
    siteSource,
    qualifier,
    pageSelector: makePageSelector(calls),
    datasets: makeDatasets(calls),
    logger,
    clock,
    gateway,
    pageSelectorOpts: { maxPagesPerSite: maxPages },
  };
  const { batchId } = await createAeBatch({
    persistence: adapter,
    clock,
    windowDays: 7,
    catalogs: ['LP'],
    standards: {},
    siteSourceId: siteSource.id,
    qualifierId: qualifier.id,
    pageSelectorId: 'fixture-selector',
    maxPagesPerSite: maxPages,
  });
  await seedCaptures(adapter);
  const counts = await runAeBatch(batchId, deps);
  return { batchId, calls, counts, state: snapshot() };
}

describe('runAeBatch', () => {
  it('runs the site dataset once per site, after the page datasets', async () => {
    const { batchId, calls, counts, state } = await runBatch(6);

    expect(counts).toMatchObject({ queued: 1, qualified: 1, pagesAnalyzed: 2 });
    expect(calls).toEqual([
      'select:maxPages=6',
      'page:101',
      'page:102',
      'site',
      'cards',
    ]);

    // page rows keep their scope and hsr
    const pageRows = state.datasetRows.filter((r) => r.dataset_id === 'fixture-page');
    expect(pageRows).toHaveLength(2);
    expect(pageRows.every((r) => r.scope === 'page')).toBe(true);
    expect(pageRows.map((r) => Number(r.idsitehsr)).sort()).toEqual([101, 102]);

    // the site dataset ran exactly once and landed with scope 'site', hsr 0
    const siteRows = state.datasetRows.filter((r) => r.dataset_id === 'fixture-site');
    expect(siteRows).toHaveLength(1);
    expect(siteRows[0].scope).toBe('site');
    expect(Number(siteRows[0].idsitehsr)).toBe(0);
    expect(siteRows[0].batch_id).toBe(batchId);

    // its requirement row folded in at site scope
    const req = state.requirementStatus.find((r) => r.requirement_key === 'H99');
    expect(req).toBeDefined();
    expect(req.status).toBe('available');
    expect(Number(req.idsitehsr)).toBe(0);
    expect(req.dataset_id).toBe('fixture-site');

    // its cards wrote with scope 'site' and hsr 0
    const card = state.strategyCards.find((c) => c.strategy_id === 'S1');
    expect(card).toBeDefined();
    expect(card.scope).toBe('site');
    expect(Number(card.idsitehsr)).toBe(0);
    expect(card.catalog_id).toBe('FIXTURE');

    // the selection fed the site queue columns
    const siteQueue = state.siteQueue.find((r) => Number(r.idsite) === 1);
    expect(Number(siteQueue.pages_selected)).toBe(2);
    expect(Number(siteQueue.pages_analyzed)).toBe(2);
    expect(siteQueue.status).toBe('analyzed');

    // site dataset notes merged into the site analysis metadata
    const siteAnalysis = state.siteAnalyses.find((r) => r.batch_id === batchId);
    expect(JSON.parse(siteAnalysis.metadata).fixture_site_note).toBe('ran once');

    // page analyses: one per analyzed page, with its own target stats
    expect(state.pageAnalyses).toHaveLength(2);
    const p102 = state.pageAnalyses.find((r) => Number(r.idsitehsr) === 102);
    expect(Number(p102.entry_sessions)).toBe(300);
    expect(Number(p102.revenue)).toBe(180);
  });

  it('truncates the selection to one page with maxPagesPerSite = 1', async () => {
    const { calls, counts, state } = await runBatch(1);

    expect(counts.pagesAnalyzed).toBe(1);
    expect(calls[0]).toBe('select:maxPages=1');
    const selected = state.pageTargets.filter((t) => t.batch_id !== undefined);
    expect(selected).toHaveLength(1);
    expect(Number(selected[0].idsitehsr)).toBe(101);
    expect(selected[0].role).toBe('primary');
    const siteQueue = state.siteQueue.find((r) => Number(r.idsite) === 1);
    expect(Number(siteQueue.pages_selected)).toBe(1);

    // the site dataset still runs, once, on the single analyzed page
    const siteRows = state.datasetRows.filter((r) => r.dataset_id === 'fixture-site');
    expect(siteRows).toHaveLength(1);
    expect(siteRows[0].scope).toBe('site');
  });

  it('re-enqueues stale captures as naming+render, desktop+mobile, with the staleness reason', async () => {
    const { adapter, snapshot } = createMemoryAePersistence();
    // 101 carries a complete capture on the previous taxonomy version;
    // 102 has no capture row at all
    const baseStatus = adapter.captureStatus.bind(adapter);
    adapter.captureStatus = async (key) => {
      if (Number(key.idsitehsr) === 101) {
        return {
          status: 'complete',
          taxonomyVersion: '2026-10-03',
          capturedOn: '2026-09-20',
          hasRender: false,
          hasSaliency: false,
        };
      }
      return baseStatus(key);
    };
    const calls = [];
    const deps = {
      persistence: adapter,
      siteSource,
      qualifier,
      pageSelector: makePageSelector(calls),
      datasets: makeDatasets(calls),
      logger,
      clock,
      gateway,
    };
    const { batchId } = await createAeBatch({
      persistence: adapter,
      clock,
      windowDays: 7,
      catalogs: ['LP'],
      standards: {},
      siteSourceId: siteSource.id,
      qualifierId: qualifier.id,
      pageSelectorId: 'fixture-selector',
    });
    const counts = await runAeBatch(batchId, deps);

    expect(counts.awaitingCapture).toBe(1);
    const queue = snapshot().captureQueue;
    expect(queue).toHaveLength(2);
    for (const row of queue) {
      expect(row.want).toEqual(['naming', 'render']);
      expect(row.device_classes).toEqual(['desktop', 'mobile']);
    }
    expect(queue.find((r) => Number(r.idsitehsr) === 101).reason).toBe('taxonomy_upgrade');
    expect(queue.find((r) => Number(r.idsitehsr) === 102).reason).toBe('no_capture');
    // every target waits; the site waits too and no dataset runs
    expect(snapshot().pageTargets.every((t) => t.status === 'awaiting_capture')).toBe(true);
    expect(snapshot().siteQueue.find((r) => Number(r.idsite) === 1).status).toBe('awaiting_capture');
    expect(snapshot().datasetRows).toHaveLength(0);
  });

  it('resumes a queued site without collecting datasets that already finished', async () => {
    const { adapter, snapshot } = createMemoryAePersistence();
    const first = [];
    const deps = {
      persistence: adapter,
      siteSource,
      qualifier,
      pageSelector: makePageSelector(first),
      datasets: makeDatasets(first),
      logger,
      clock,
      gateway,
      pageSelectorOpts: { maxPagesPerSite: 6 },
    };
    const { batchId } = await createAeBatch({
      persistence: adapter,
      clock,
      windowDays: 7,
      catalogs: ['LP'],
      standards: {},
      siteSourceId: siteSource.id,
      qualifierId: qualifier.id,
      pageSelectorId: 'fixture-selector',
      maxPagesPerSite: 6,
    });
    await seedCaptures(adapter);
    await runAeBatch(batchId, deps);
    expect(first).toEqual(['select:maxPages=6', 'page:101', 'page:102', 'site', 'cards']);

    await adapter.updateSite({ batchId, idsite: 1, status: 'queued', reason: 'resume' });
    const second = [];
    const again = await runAeBatch(batchId, {
      ...deps,
      pageSelector: makePageSelector(second),
      datasets: makeDatasets(second),
    });

    expect(second).toEqual(['select:maxPages=6']);
    expect(again).toMatchObject({ qualified: 1, pagesAnalyzed: 2 });
    expect(snapshot().datasetRows.filter((r) => r.dataset_id === 'fixture-page')).toHaveLength(2);
    expect(snapshot().datasetRows.filter((r) => r.dataset_id === 'fixture-site')).toHaveLength(1);
    expect(snapshot().analysisCheckpoints.some((r) => r.dataset_id === 'fixture-page')).toBe(true);
    const siteAnalysis = snapshot().siteAnalyses.find((r) => r.batch_id === batchId);
    expect(JSON.parse(siteAnalysis.metadata).fixture_site_note).toBe('ran once');
  });

  it('keeps a phrase threshold out of the float column and in the card json', () => {
    const row = cardRow('9bbe0ed1-184c-469a-9f56-cae8426b94c2', 5795, 51247422, 'page', 'LP', {
      dims: { strategy_id: 'J2', segment_key: 'all' },
      metrics: {
        verdict: 'include',
        trigger_state: 'triggered',
        trigger_evaluated: 1,
        metric: 'single_pageview_share',
        value: 0.4936,
        threshold: 'step >= 5pp',
      },
    });
    expect(row.value).toBe(0.4936);
    expect(row.threshold).toBeNull();
    expect(JSON.parse(row.cardJson).metrics.threshold).toBe('step >= 5pp');
  });
});
