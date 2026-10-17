import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { adaptersIn, discoverAdapterRoles } from '../src/discover.js';
import { createMemoryAePersistence } from '../src/adapters/persistence/memory.js';
import { createBatch, runBatch } from '../src/application/commands/batch.js';
import { loadCatalog } from '../src/catalog/index.js';
import { loadProfiles } from '../src/composition/registries.js';
import { SHIPPED } from './support/segmentations.js';

/**
 * The funnel and journey profiles on the memory store. 200 sessions view a
 * product; every second adds to cart, every fourth starts checkout, every
 * eighth orders. Even sessions browse home > collection > product, odd ones
 * product > cart. Each selector chooses its subjects by criteria, the
 * readout and the cards carry the subject key, and a site with no subject
 * is skipped.
 */

const roles = await discoverAdapterRoles(path.resolve('src/adapters'));
const datasets = adaptersIn(roles, 'datasets');
const subjectSelectors = adaptersIn(roles, 'subject-selectors');
const profiles = await loadProfiles(path.resolve('profiles'), Object.keys(loadCatalog().strategies));

const site = { idsite: 1, siteName: 'x' };
const WEEKS = ['2026-09-28', '2026-10-05'];
const N = 200;

const visits = Array.from({ length: N }, (_, i) => i);
const SESSIONS = visits.map((i) => ({
  idvisit: String(i), first_date: WEEKS[i % 2], week: WEEKS[i % 2], device: 1, referer: 2, returning: 0, entry_hsr: i % 2 ? '3' : '1',
  country: 'us', browser: 'Chrome', fp_hash: 'fp1', utm_source: '', pageviews: 3, capped_ms: 20000,
  saw_product: 1, saw_atc: i % 2 ? 0 : 1, saw_checkout: i % 4 ? 0 : 1, saw_purchase: i % 8 ? 0 : 1, orders: i % 8 ? 0 : 1, revenue: i % 8 ? 0 : 50,
}));
const at = (i, minute) => (1_790_000_000 + i * 3600 + minute * 60) * 1000;
const EVENTS = visits.flatMap((i) => [
  { idvisit: String(i), event_type: 'product_viewed', ts_ms: at(i, 0) },
  ...(i % 2 ? [] : [{ idvisit: String(i), event_type: 'add_to_cart', ts_ms: at(i, 2) }]),
  ...(i % 4 ? [] : [{ idvisit: String(i), event_type: 'checkout_started', ts_ms: at(i, 5) }]),
  ...(i % 8 ? [] : [{ idvisit: String(i), event_type: 'checkout_completed', ts_ms: at(i, 9) }]),
]);
const PATHS = visits.map((i) => ({ idvisit: String(i), hsrs: i % 2 ? ['3', '4'] : ['1', '2', '3', '3'] }));
const URLS = [['1', 'https://x.com/'], ['2', 'https://x.com/collections/all'], ['3', 'https://x.com/products/a'], ['4', 'https://x.com/cart']];

function gateway({ events = EVENTS, paths = PATHS } = {}) {
  const labels = [];
  return {
    labels,
    async query(_sql, _params, label) {
      labels.push(label);
      if (label === 'sessions:entry') return SESSIONS;
      if (label === 'funnel:events') return events;
      if (label === 'journey:paths') return paths;
      if (label === 'urls:site-hsr') return URLS.map(([hsr, url]) => ({ hsr, url }));
      if (label.startsWith('bot:')) return [];
      throw new Error(`unexpected query: ${label}`);
    },
    async explain() { return 'plan'; },
    async columns() { return []; },
  };
}

function engine(gw) {
  const memory = createMemoryAePersistence();
  const ctx = {
    config: { profile: 'lp', elementNamesPath: null, agents: { analysis: 1 }, dayScan: false },
    logger: { info() {}, warn() {}, error() {} },
    clock: { todayUtc: () => '2026-10-11' },
    telemetry: null,
    profiles: async () => profiles,
    segmentations: async () => SHIPPED,
    select(role, id) {
      if (role === 'subject-selectors') return subjectSelectors.find((s) => s.id === id);
      if (role === 'site-sources') return { id: 'fixture-sites', async listSites() { return [site]; } };
      if (role === 'qualifiers') return { id: 'fixture-qualifier', async qualify() { throw new Error('a keyed profile runs no qualifier'); } };
      if (role === 'page-selectors') return { id: 'fixture-selector', async select() { return []; } };
      return null;
    },
    adapters: (role) => (role === 'datasets' ? datasets : []),
    async ensure() {},
    persistence: () => memory.adapter,
    gateway: () => gw,
  };
  return { ctx, memory };
}

async function batchRun(profile, flags = {}, gw = gateway()) {
  const { ctx, memory } = engine(gw);
  const created = await createBatch.run({ profile, ...flags }, ctx);
  const ran = await runBatch.run({ batch: created.output.replace('batch_id: ', '') }, ctx);
  return { counts: ran.output.counts, snap: memory.snapshot() };
}

const stepOf = (rows, key, index) => rows.find((r) => r.subject_key === key && r.dim_week === null
  && JSON.parse(r.dim_extra).week === 'all' && r.bot_filter === 'exclude_confirmed' && JSON.parse(r.dim_extra).step_index === index);

describe('the funnel profile', () => {
  it('chooses the catalog funnels with first-step volume and reads their ordered reach', async () => {
    const { counts, snap } = await batchRun('funnel');
    expect(counts).toMatchObject({ qualified: 1, skipped: 0, pagesAnalyzed: 1 });
    expect(snap.batches[0]).toMatchObject({ profile: 'funnel', subject_type: 'funnel', page_selector: 'catalog-funnels', catalogs: ['FN'] });
    expect(snap.subjectTargets.map((t) => [t.subject_key, t.label, t.status])).toEqual([['fn:purchase', 'Product to order', 'analyzed']]);

    const readout = snap.datasetRows.filter((r) => r.dataset_id === 'funnel-steps');
    expect(readout.every((r) => r.subject_type === 'funnel' && r.subject_key === 'fn:purchase' && r.idsitehsr === 0)).toBe(true);
    expect([0, 1, 2, 3].map((i) => JSON.parse(stepOf(readout, 'fn:purchase', i).metrics).reached_sessions)).toEqual([200, 100, 50, 25]);
    expect(JSON.parse(stepOf(readout, 'fn:purchase', 1).metrics)).toMatchObject({ continued_rate: 0.5, median_minutes_from_previous: 2 });

    expect(snap.strategyCards.map((c) => c.strategy_id).sort()).toEqual(['FN:A1', 'FN:A2', 'FN:A3']);
    expect(snap.strategyCards.every((c) => c.subject_key === 'fn:purchase' && c.segment_key === 'fn:purchase')).toBe(true);
    expect(JSON.parse(snap.siteAnalyses[0].metadata).subjects).toEqual([{ type: 'funnel', key: 'fn:purchase', status: 'analyzed' }]);
  });

  it('reads a named funnel with no volume and cards it as missing its events', async () => {
    const { snap } = await batchRun('funnel', { select: '{"funnel": "checkout"}' });
    expect(snap.subjectTargets.map((t) => t.subject_key)).toEqual(['fn:checkout']);
    expect(snap.datasetRows.filter((r) => r.dataset_id === 'funnel-steps')).toEqual([]);
    expect(snap.strategyCards.every((c) => c.verdict === 'conditional' && JSON.parse(c.card_json).metrics.missing_requirements.includes('H12'))).toBe(true);
  });

  it('refuses an unknown funnel when the batch is created', async () => {
    await expect(batchRun('funnel', { select: '{"funnel": "quiz"}' })).rejects.toThrow(/funnel/);
  });

  it('skips a site without funnel events as no_funnels', async () => {
    const { counts, snap } = await batchRun('funnel', {}, gateway({ events: [] }));
    expect(counts).toMatchObject({ skipped: 1, failed: 0 });
    expect(snap.siteQueue[0]).toMatchObject({ status: 'skipped', reason: 'no_funnels' });
  });
});

describe('the journey profile', () => {
  it('chooses the path clusters over the floors and reads each template apart', async () => {
    const { counts, snap } = await batchRun('journey');
    expect(counts.pagesAnalyzed).toBe(2);
    expect(snap.subjectTargets.map((t) => [t.subject_key, t.label])).toEqual([
      ['jr:home>collection>product', 'home > collection > product'],
      ['jr:product>cart', 'product > cart'],
    ]);
    const readout = snap.datasetRows.filter((r) => r.dataset_id === 'journey-path');
    expect([0, 1, 2].map((i) => JSON.parse(stepOf(readout, 'jr:home>collection>product', i).metrics).reached_sessions)).toEqual([100, 100, 100]);
    expect(JSON.parse(stepOf(readout, 'jr:product>cart', -1).metrics)).toMatchObject({ reached_sessions: 200, cvr: 0.125 });
    expect(snap.strategyCards).toHaveLength(6);
    expect(new Set(snap.strategyCards.map((c) => c.segment_key))).toEqual(new Set(['jr:home>collection>product', 'jr:product>cart']));
  });

  it('reads a named template', async () => {
    const { snap } = await batchRun('journey', { select: '{"path": "product>cart"}' });
    expect(snap.subjectTargets.map((t) => t.subject_key)).toEqual(['jr:product>cart']);
  });

  it('skips a site without multi-page sessions as no_journeys', async () => {
    const { snap } = await batchRun('journey', {}, gateway({ paths: [] }));
    expect(snap.siteQueue[0]).toMatchObject({ status: 'skipped', reason: 'no_journeys' });
  });
});
