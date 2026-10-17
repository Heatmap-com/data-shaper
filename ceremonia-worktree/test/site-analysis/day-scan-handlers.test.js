import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fetchSessionRows } from '../../src/adapters/_lib/session-stream.js';
import { adapter as campaignCoverage } from '../../src/adapters/datasets/campaign-coverage.js';
import { adapter as campaignWeekly } from '../../src/adapters/datasets/campaign-weekly.js';
import { adapter as entryByChannel } from '../../src/adapters/datasets/entry-by-channel.js';
import { adapter as experimentsWeekly } from '../../src/adapters/datasets/experiments-weekly.js';
import { adapter as journeyWeekly } from '../../src/adapters/datasets/journey-weekly.js';
import { adapter as pageSegmentWeekly } from '../../src/adapters/datasets/page-segment-weekly.js';
import { adapter as siteBaselines } from '../../src/adapters/datasets/site-baselines.js';
import { adapter as triggerChains } from '../../src/adapters/datasets/trigger-chains.js';
import { adapter as viewportWeekly } from '../../src/adapters/datasets/viewport-weekly.js';
import { adapter as defaultSix } from '../../src/adapters/page-selectors/default-six.js';
import { adapter as preferNonHome } from '../../src/adapters/qualifiers/prefer-non-home.js';
import { createMemoryDayStore } from '../../src/adapters/day-store/memory.js';
import { createMemoryAePersistence } from '../../src/adapters/persistence/memory.js';
import { createAeBatch } from '../../src/runner-ae.js';
import { captureGate, collectDatasets, createSiteState, qualify, writeAnalysis } from '../../src/site-analysis/handlers.js';
import { createLocalWarehouse } from '../support/local-warehouse.js';
import { BOT, IDSITE, PAGES, warehouseRows } from '../support/site-fixture.js';

/**
 * One site through the handlers twice on the same warehouse: the window
 * queries, then the day scan's site and page passes. Every stored row is
 * the same. The real qualifier, page selector, and session datasets run
 * over `clickhouse local`; two probes read the chosen page's scroll facts
 * and the targets' entry sessions as their datasets do.
 */

const site = { idsite: IDSITE, siteName: 'one' };
const logger = { info() {}, warn() {}, error() {} };

const probeScroll = {
  id: 'probe-scroll',
  dependsOn: [],
  scope: 'page',
  provides: [],
  descriptor: { id: 'probe-scroll', replay: 'keep' },
  async collect(page, ctx) {
    const hsr = String(page.idsitehsr);
    const sessions = await fetchSessionRows(ctx, page.idsite, { idsitehsr: page.idsitehsr });
    const rows = sessions
      .filter((s) => s.entryHsr === hsr)
      .map((s) => ({ dims: { idvisit: s.idvisit }, metrics: { ...s } }));
    return { id: 'probe-scroll', rows };
  },
};

const probeTargets = {
  id: 'probe-targets',
  dependsOn: [],
  scope: 'site',
  sessions: 'targets',
  provides: [],
  descriptor: { id: 'probe-targets', replay: 'keep' },
  async collect(page, ctx) {
    const targets = new Set(ctx.pageTargets.map((t) => String(t.idsitehsr)));
    const sessions = await fetchSessionRows(ctx, page.idsite);
    const rows = sessions
      .filter((s) => targets.has(s.entryHsr))
      .map((s) => ({ dims: { idvisit: s.idvisit, entry: s.entryHsr }, metrics: { tier: s.tier ?? '', orders: s.orders, week: s.week } }));
    return { id: 'probe-targets', rows };
  },
};

const STORED = ['pageTargets', 'datasetRows', 'analysisCheckpoints', 'pageAnalyses', 'siteAnalyses', 'siteQueue', 'triggerDefinitions', 'triggerHits', 'triggerChains'];

/**
 * @param {boolean} dayScan
 * @param {{shared?: boolean, crashAt?: number[], today?: string, dayStore?: object}} [opts] shared: false
 *   starts each handler on a fresh state, as separate stages do; crashAt fails those day queries (1-based)
 *   once each, and the handler reruns on a fresh state, as a resumed stage does; today sets the clock, so
 *   the 7-day window ends the day before; dayStore is deps.dayStore
 */
async function run(dayScan, { shared = true, crashAt = [], today = '2026-09-15', dayStore } = {}) {
  const clock = { todayUtc: () => today };
  const warehouse = createLocalWarehouse(warehouseRows());
  const crashes = new Set(crashAt);
  let days = 0;
  const gateway = {
    calls: warehouse.calls,
    columns: warehouse.columns,
    async query(sql, params, label) {
      if (label === 'scan:day') {
        if (crashes.delete(days + 1)) throw new Error('crash');
        days += 1;
      }
      return warehouse.query(sql, params, label);
    },
  };
  const { adapter: persistence, snapshot } = createMemoryAePersistence();
  const { batchId } = await createAeBatch({ persistence, clock, windowDays: 7, catalogs: [], standards: {}, logger });
  await persistence.enqueueSites(batchId, [site]);
  await persistence.claimNextSite(batchId);
  for (const [idsitehsr, url] of PAGES) {
    await persistence.completeCapture({ idsite: IDSITE, idsitehsr, url, capturedOn: '2026-09-15', bindings: [] });
  }
  const deps = {
    persistence,
    gateway,
    logger,
    clock,
    qualifier: preferNonHome,
    pageSelector: defaultSix,
    datasets: [entryByChannel, journeyWeekly, campaignCoverage, campaignWeekly, viewportWeekly, pageSegmentWeekly, probeScroll, siteBaselines, probeTargets, triggerChains, experimentsWeekly],
    pageSelectorOpts: { maxPagesPerSite: 3 },
    dayScan,
    ...(dayStore ? { dayStore } : {}),
  };
  const window = await persistence.getBatch(batchId);
  const fresh = () => {
    const state = createSiteState();
    state.batchNotes.set(`bot:${IDSITE}`, Promise.resolve(BOT));
    return state;
  };
  const one = fresh();
  const state = () => (shared ? one : fresh());
  let crashed = 0;
  /** @param {(state: object) => Promise<object>} handler */
  const stage = async (handler) => {
    for (;;) {
      try {
        return await handler(state());
      } catch (err) {
        if (err.message !== 'crash') throw err;
        crashed += 1;
      }
    }
  };

  const qualified = await stage((st) => qualify({ site, window, deps, state: st }));
  expect(qualified.facts.outcome).toBe('qualified');
  const base = { site: { ...site, qualification: qualified.facts.qualification }, window, deps };
  const gate = await captureGate({ ...base, pages: qualified.facts.pages });
  const ready = { ...base, pages: gate.facts.pages };
  await stage((st) => collectDatasets({ ...ready, scope: 'page', state: st }));
  await stage((st) => collectDatasets({ ...ready, scope: 'site', state: st }));
  await stage((st) => writeAnalysis({ ...ready, state: st }));
  expect(crashed).toBe(crashAt.length);

  const all = snapshot();
  const scrub = (row) => JSON.parse(JSON.stringify(row, (k, v) => (v === batchId ? '<batch>' : /At$|_at$|claim/.test(k) ? '<x>' : v)));
  const byJson = (a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b));
  const stored = Object.fromEntries(STORED.map((name) => [name, (all[name] ?? []).map(scrub).sort(byJson)]));
  const isCursor = (row) => row.dataset_id.startsWith('day-scan:');
  const cursors = stored.analysisCheckpoints.filter(isCursor);
  stored.analysisCheckpoints = stored.analysisCheckpoints.filter((row) => !isCursor(row));
  return { stored, cursors, labels: gateway.calls };
}

describe('site analysis on the day scan', () => {
  const minHits = preferNonHome.config.minHits;
  let windowRun;
  let scanRun;
  beforeAll(async () => {
    preferNonHome.config.minHits = 1;
    windowRun = await run(false);
    scanRun = await run(true);
  }, 240_000);
  afterAll(() => {
    preferNonHome.config.minHits = minHits;
  });

  it('stores the rows the window queries store', () => {
    expect(scanRun.stored.datasetRows.length).toBeGreaterThan(50);
    expect(scanRun.stored.pageTargets.length).toBe(3);
    const ids = new Set(scanRun.stored.datasetRows.map((row) => row.dataset_id));
    expect([...ids].sort()).toEqual([
      'campaign-coverage', 'campaign-weekly', 'entry-by-channel', 'experiments-weekly', 'journey-weekly', 'page-segment-weekly',
      'probe-scroll', 'probe-targets', 'site-baselines', 'trigger-chains', 'viewport-weekly',
    ]);
    const keys = new Set(scanRun.stored.triggerHits.map((hit) => hit.triggerKey ?? hit.trigger_key));
    expect([...keys].sort()).toEqual(['abandoned_cart', 'showed_interest', 'super_shopper']);
    expect(scanRun.stored.triggerChains.some((chain) => chain.purchased)).toBe(true);
    expect(scanRun.stored).toEqual(windowRun.stored);
  });

  it('reads sessions through the passes, not the window query', () => {
    expect(windowRun.labels.filter((label) => label.startsWith('sessions:')).length).toBeGreaterThan(5);
    expect(scanRun.labels.filter((label) => label.startsWith('sessions:'))).toEqual([]);
    expect(scanRun.labels.filter((label) => label === 'site-baselines:second-pageview')).toEqual([]);
    expect(scanRun.labels).not.toContain('experiments-weekly:partner-tags');
    // The site pass reads from the trigger lane's start (08-16), the page pass the window's 7 days.
    expect(scanRun.labels.filter((label) => label === 'scan:day').length).toBe(30 + 7);
    expect(scanRun.labels.filter((label) => label === 'scan:page-facts').length).toBe(7);
    expect(scanRun.labels.filter((label) => label.startsWith('trigger-chains:') && !label.includes('prior'))).toEqual([]);
  });

  it('empties the day cursors once the site is stored', () => {
    expect(windowRun.cursors).toEqual([]);
    expect(scanRun.cursors.map((row) => [row.dataset_id, row.notes])).toEqual([['day-scan:page', ''], ['day-scan:site', '']]);
  });

  it('stores the same rows when each handler starts on a fresh state, reading each day once', async () => {
    const separate = await run(true, { shared: false });
    expect(separate.stored).toEqual(windowRun.stored);
    expect(separate.labels.filter((label) => label.startsWith('sessions:'))).toEqual([]);
    expect(separate.labels.filter((label) => label === 'scan:day').length).toBe(30 + 7);
  }, 240_000);

  it('resumes a pass after the last day it read', async () => {
    // Day 10 of the site pass and day 4 of the page pass fail once.
    const resumed = await run(true, { shared: false, crashAt: [10, 30 + 4] });
    expect(resumed.stored).toEqual(windowRun.stored);
    expect(resumed.labels.filter((label) => label === 'scan:day').length).toBe(30 + 7);
    expect(resumed.cursors.every((row) => row.notes === '')).toBe(true);
  }, 240_000);

  it('stores the same rows from a day store filled by an earlier window, reading only the days it lacks', async () => {
    const dayStore = { store: createMemoryDayStore(), overlapDays: 2, keepDays: 400 };
    const old = { idsite: IDSITE, kind: 'day', key: '', day: '2025-08-07', version: 1, final: true, shape: null, rows: [] };
    await dayStore.store.write(old);
    // 08-13..09-11; the days through 09-09 are final, and 2025-08-07 is past keepDays.
    await run(true, { today: '2026-09-12', dayStore });
    expect(await dayStore.store.read(old)).toBeNull();
    const written = dayStore.store.size();
    expect(written).toBeGreaterThan(30);

    // 08-16..09-14: 09-10..09-14 are read, and the page pass replays them.
    const later = await run(true, { dayStore });
    expect(later.stored).toEqual(windowRun.stored);
    expect(later.labels.filter((label) => label === 'scan:day').length).toBe(5);

    // The same window on separate stages: each pass reads the two days after 09-12, not final yet.
    const again = await run(true, { shared: false, dayStore });
    expect(again.stored).toEqual(windowRun.stored);
    expect(again.labels.filter((label) => label === 'scan:day').length).toBe(2 + 2);
    expect(again.labels.filter((label) => label === 'scan:page-facts').length).toBe(2);
  }, 240_000);
});
