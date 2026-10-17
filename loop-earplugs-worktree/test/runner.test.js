import { describe, expect, it } from 'vitest';
import { createBatch, runBatch } from '../src/runner.js';
import { createMemoryPersistence } from '../src/adapters/persistence/memory.js';

/**
 * Runner test from IMPLEMENTATION-PLAN.md section 11: three fixture sites
 * through the memory persistence adapter. One qualifies, one fails the gate,
 * one throws. Batch counts are 1 qualified, 1 skipped, 1 failed; the thrown
 * site does not drop the batch.
 */

const logger = { info() {}, warn() {}, error() {} };
const clock = { todayUtc: () => '2026-10-03' };
const window = { windowStart: '2026-09-26', windowEnd: '2026-10-02' };

const siteSource = {
  id: 'fixture-three',
  async listSites() {
    return [
      { idsite: 1, siteName: 'qualifies' },
      { idsite: 2, siteName: 'gate-fails' },
      { idsite: 3, siteName: 'throws' },
    ];
  },
};

const qualifier = {
  id: 'fixture-qualifier',
  config: { minShareOfHome: 0.5, minSessions: 1000, minOrders: 5 },
  async qualify(site) {
    if (site.idsite === 3) throw new Error('qualifier exploded');
    if (site.idsite === 2) {
      return { status: 'skipped_volume', entrySessions: 10, orders: 1, revenue: 10, reason: 'too small' };
    }
    return {
      status: 'qualified',
      idsitehsr: 99,
      url: 'https://x.com/pages/lp',
      pageType: 'content',
      entrySessions: 2000,
      orders: 10,
      revenue: 500,
      reason: 'ok',
      evidence: { title: 'LP', unfiltered: { sessions: 2100, orders: 11, revenue: 520 } },
    };
  },
};

const datasets = [
  {
    id: 'fixture-dataset',
    dependsOn: [],
    async collect(page, ctx) {
      expect(ctx.datasets.size).toBe(0);
      return {
        id: 'fixture-dataset',
        rows: [{ dims: { week: '2026-09-28', device: 'desktop', bot_filter: 'exclude_confirmed' }, metrics: { sessions: page.qualified.entrySessions } }],
        notes: { fixture: true },
      };
    },
  },
  {
    id: 'fixture-triggers',
    dependsOn: ['fixture-dataset'],
    async collect(page, ctx) {
      expect(ctx.datasets.has('fixture-dataset')).toBe(true);
      return {
        id: 'fixture-triggers',
        rows: [{ dims: { rule: 9 }, metrics: { state: 'silent' } }],
        analysis: {
          strategiesTriggered: 0,
          strategiesBelowFloor: 0,
          strategiesBlocked: 0,
          strategiesSilent: 14,
          rps: page.qualified.revenue / page.qualified.entrySessions,
        },
      };
    },
  },
];

async function seedFreshNaming(adapter) {
  await adapter.completeNaming({
    idsite: 1,
    idsitehsr: 99,
    url: 'https://x.com/pages/lp',
    namedOn: '2026-10-03',
    names: [{ selector: '.tile', element_class: 'product_tile', name: 'Tile' }],
  });
}

const gateway = {
  async query() {
    throw new Error('no gateway in the runner test');
  },
  async explain() {
    return '';
  },
  async columns() {
    return [];
  },
};

describe('runner', () => {
  it('one qualifies, one is skipped, one fails; the batch completes', async () => {
    const { adapter, snapshot } = createMemoryPersistence();
    const deps = {
      persistence: adapter,
      siteSource,
      qualifier,
      datasets,
      logger,
      clock,
      gateway,
      siteSourceId: siteSource.id,
    };
    const { batchId } = await createBatch({ ...deps, window });
    await seedFreshNaming(adapter);
    const counts = await runBatch(batchId, { ...deps, ...window });

    expect(counts).toEqual({ queued: 3, qualified: 1, skipped: 1, failed: 1 });

    const state = snapshot();
    const batch = state.batches.find((b) => b.batchId === batchId);
    expect(batch.status).toBe('complete');
    expect(batch.sitesQualified).toBe(1);
    expect(batch.sitesSkipped).toBe(1);
    expect(batch.sitesFailed).toBe(1);

    const byStatus = new Map(state.queue.map((r) => [r.idsite, r.status]));
    expect(byStatus.get(1)).toBe('analyzed');
    expect(byStatus.get(2)).toBe('skipped_volume');
    expect(byStatus.get(3)).toBe('failed');
    expect(state.queue.find((r) => r.idsite === 3).reason).toMatch(/qualifier exploded/);

    const analysis = state.analyses.find((a) => a.idsite === 1);
    expect(analysis).toBeDefined();
    expect(analysis.landingPageUrl).toBe('https://x.com/pages/lp');
    expect(analysis.entrySessions).toBe(2000);
    expect(analysis.sessionsUnfiltered).toBe(2100);
    expect(analysis.botSessionsExcluded).toBe(100);
    expect(analysis.strategiesSilent).toBe(14);
    expect(analysis.rps).toBeCloseTo(0.25);
    expect(analysis.metadata.fixture).toBe(true);
    expect(analysis.metadata.qualifier.unfiltered.sessions).toBe(2100);

    const ds = state.datasets.filter((d) => d.idsite === 1);
    expect(ds).toHaveLength(2);
    expect(ds.find((d) => d.datasetId === 'fixture-dataset').metrics.sessions).toBe(2000);
    expect(ds.find((d) => d.datasetId === 'fixture-triggers').metrics.state).toBe('silent');
  });

  it('resume continues where the batch stopped', async () => {
    const { adapter, snapshot } = createMemoryPersistence();
    const deps = {
      persistence: adapter,
      siteSource,
      qualifier,
      datasets,
      logger,
      clock,
      gateway,
      siteSourceId: siteSource.id,
    };
    const { batchId } = await createBatch({ ...deps, window });
    await seedFreshNaming(adapter);
    await adapter.enqueue(batchId, [{ idsite: 1, siteName: 'qualifies' }]);

    // simulate an interrupted run: site 1 stuck in analyzing. claimTtlMs 0
    // stands in for the 15-minute staleness window so the crashed claim is
    // reclaimable immediately, as it would be after the TTL in production.
    await adapter.claimNext(batchId, 0);
    await adapter.updateQueue({ batchId, idsite: 1, status: 'analyzing' });

    const counts = await runBatch(batchId, { ...deps, ...window, claimTtlMs: 0 });
    expect(counts.qualified).toBe(1);
    expect(snapshot().queue.find((r) => r.idsite === 1).status).toBe('analyzed');
  });

  it('a second run of the same batch does not duplicate dataset rows', async () => {
    const { adapter, snapshot } = createMemoryPersistence();
    const deps = {
      persistence: adapter,
      siteSource: { id: 'one', listSites: async () => [{ idsite: 1, siteName: 'x' }] },
      qualifier,
      datasets,
      logger,
      clock,
      gateway,
      siteSourceId: 'one',
    };
    const { batchId } = await createBatch({ ...deps, window });
    await seedFreshNaming(adapter);
    await runBatch(batchId, { ...deps, ...window });
    const first = snapshot().datasets.length;
    expect(first).toBe(2);

    // rerun: enqueue is idempotent, the site is already analyzed
    const counts = await runBatch(batchId, { ...deps, ...window });
    expect(counts.qualified).toBe(0);
    expect(snapshot().datasets.length).toBe(first);
  });

  it('a qualified page without a fresh name is queued for naming and not analyzed', async () => {
    const { adapter, snapshot } = createMemoryPersistence();
    const deps = {
      persistence: adapter,
      siteSource: { id: 'one', listSites: async () => [{ idsite: 1, siteName: 'x' }] },
      qualifier,
      datasets,
      logger,
      clock,
      gateway,
      siteSourceId: 'one',
    };
    const { batchId } = await createBatch({ ...deps, window });
    const counts = await runBatch(batchId, { ...deps, ...window });
    expect(counts.qualified).toBe(0);
    expect(counts.awaitingNaming).toBe(1);
    expect(snapshot().datasets).toHaveLength(0);
    expect(snapshot().queue.find((r) => r.idsite === 1).status).toBe('awaiting_naming');
    expect(snapshot().namingQueue).toHaveLength(1);

    await adapter.completeNaming({
      idsite: 1,
      idsitehsr: 99,
      url: 'https://x.com/pages/lp',
      namedOn: '2026-10-03',
      names: [{ selector: '.faq', element_class: 'faq_item', name: 'Shipping' }],
    });
    expect(snapshot().queue.find((r) => r.idsite === 1).status).toBe('queued');

    const again = await runBatch(batchId, { ...deps, ...window });
    expect(again.qualified).toBe(1);
    expect(snapshot().queue.find((r) => r.idsite === 1).status).toBe('analyzed');
  });
});
