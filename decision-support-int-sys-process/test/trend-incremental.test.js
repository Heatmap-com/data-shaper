import { describe, expect, it } from 'vitest';
import { createMemoryAePersistence } from '../src/adapters/persistence/memory.js';
import { runTagTrend } from '../src/enrichment/tag-trend-run.js';
import { runTrend } from '../src/enrichment/trend-run.js';
import { eachDate, mondayOf } from '../src/triggers/time.js';
import { shipped } from './support/segmentations.js';

const TREND = shipped('trend');
const TAG = shipped('tagTrend');

const IDSITE = 41;
const PATH = 'home > pdp';
const URL_PATH = '/ > /products/a';
const FIVE_PAGES = ['12', '13', '14', '15', '16'];

/**
 * The trend queries over a warehouse with one session a day for each
 * subject: the configured path, page 12, and any selector asked for. A
 * week's `all` row is the number of its days the query read.
 */
function trendWarehouse({ paths = [PATH], urlPaths = [], pages = ['12'] } = {}) {
  const calls = [];
  const values = { traffic_source: 'direct', returning: 'new', buyer: 'non_buyer', rager: 'non_rager' };
  const day = (d, extra) => [['all', 'all'], ...Object.entries(values)].map(([segment, segmentValue]) => ({
    week_start: mondayOf(d), viewport_value: 'desktop', segment, segment_value: segmentValue,
    sessions: 1, buyers: 0, orders: 0, revenue: 0, clicks: 1, progressed: 0, ...extra,
  }));
  const days = (params) => eachDate(params.w0, params.w1);
  return {
    calls,
    async query(sql, params, label) {
      calls.push({ label, params });
      if (label === 'trend:path-rank') {
        return [
          ...paths.map((path, i) => ({ kind: 'template', path, sessions: 10, revenue: 100 - i })),
          ...urlPaths.map((path, i) => ({ kind: 'url', path, sessions: 10, revenue: 100 - i })),
        ];
      }
      if (label === 'trend:paths') {
        const asked = paths.filter((path) => params.templateExact.includes(path));
        return asked.flatMap((path) => days(params).flatMap((d) => day(d, { path })));
      }
      if (label === 'trend:url-paths') {
        const asked = urlPaths.filter((path) => params.urlExact.includes(path));
        return asked.flatMap((path) => days(params).flatMap((d) => day(d, { path })));
      }
      if (label === 'trend:page-rank') return pages.map((idsitehsr) => ({ idsitehsr }));
      if (label === 'trend:pages') return params.pages.flatMap((idsitehsr) => days(params).flatMap((d) => day(d, { idsitehsr })));
      if (label === 'trend:page-urls') return params.pages.map((idsitehsr) => ({ idsitehsr, url: `https://x.com/${idsitehsr}` }));
      if (label === 'trend:selectors') return params.selectors.flatMap((selector) => days(params).flatMap((d) => day(d, { selector })));
      return [];
    },
  };
}

/** The stored path row for each week: its `all` total. */
function pathWeeks(snapshot) {
  return Object.fromEntries((snapshot().trendRows ?? [])
    .filter((row) => row.rowKey === 'path' && row.viewportType === 'all' && row.segment === 'all')
    .map((row) => [row.week, row.sessions])
    .sort());
}

describe('trend weeks', () => {
  it('stores only the whole weeks of a mid-week window, and a later overlap leaves a stored week as it was', async () => {
    const { adapter: persistence, snapshot } = createMemoryAePersistence();
    const gateway = trendWarehouse();
    // Thursday 2026-08-06 to Wednesday 2026-09-02: three whole weeks.
    const first = await runTrend({ idsite: IDSITE, segmentations: TREND, windowStart: '2026-08-06', windowEnd: '2026-09-02', gateway, persistence });
    expect(first.weeks).toEqual(['2026-08-10', '2026-08-17', '2026-08-24']);
    expect(first.edges).toEqual({ start: ['2026-08-06', '2026-08-09'], end: ['2026-08-31', '2026-09-02'] });
    expect(pathWeeks(snapshot)).toEqual({ '2026-08-10': 7, '2026-08-17': 7, '2026-08-24': 7 });
    expect(gateway.calls.find((call) => call.label === 'trend:paths').params).toMatchObject({ w0: '2026-08-10', w1: '2026-08-30' });

    // Thursday 2026-08-13 to Sunday 2026-08-23: only 08-17 is whole.
    const second = await runTrend({ idsite: IDSITE, segmentations: TREND, windowStart: '2026-08-13', windowEnd: '2026-08-23', gateway, persistence });
    expect(second.weeks).toEqual(['2026-08-17']);
    expect(second.edges).toEqual({ start: ['2026-08-13', '2026-08-16'], end: null });
    expect(pathWeeks(snapshot)).toEqual({ '2026-08-10': 7, '2026-08-17': 7, '2026-08-24': 7 });
  });

  it('reads the tag trend over the same whole weeks', async () => {
    const { adapter: persistence, snapshot } = createMemoryAePersistence();
    const gateway = trendWarehouse();
    const selector = { id: 'stub', candidates: () => [], select: () => [] };
    const run = await runTagTrend({ idsite: IDSITE, segmentations: TAG, windowStart: '2026-08-06', windowEnd: '2026-09-02', selector, gateway, persistence });
    expect(run).toMatchObject({ weeks: ['2026-08-10', '2026-08-17', '2026-08-24'], edges: { start: ['2026-08-06', '2026-08-09'], end: ['2026-08-31', '2026-09-02'] } });
    expect(gateway.calls.map((call) => [call.label, call.params.w0, call.params.w1])).toEqual([['trend:tag-inventory', '2026-08-10', '2026-08-30']]);
    expect(snapshot().tagTrendRows ?? []).toEqual([]);
  });

  it('writes nothing and reads nothing when the window holds no whole week', async () => {
    const { adapter: persistence, snapshot } = createMemoryAePersistence();
    const gateway = trendWarehouse();
    const run = await runTrend({ idsite: IDSITE, segmentations: TREND, windowStart: '2026-08-12', windowEnd: '2026-08-18', gateway, persistence });
    expect(run).toMatchObject({ weeks: [], rows: 0 });
    expect(gateway.calls).toEqual([]);
    expect(snapshot().trendRows ?? []).toEqual([]);
  });

  it('stamps each segmentation row with its version and records a changed definition after the rows', async () => {
    const { adapter: persistence, snapshot } = createMemoryAePersistence();
    await persistence.writeSegmentationDefinitions([
      { idsite: IDSITE, segmentation: 'buyer', version: 3, kind: 'declared', stamp: 'an older definition', definition: {}, values: ['buyer', 'non_buyer'] },
    ]);
    const run = await runTrend({ idsite: IDSITE, segmentations: TREND, windowStart: '2026-08-10', windowEnd: '2026-08-16', gateway: trendWarehouse(), persistence });
    expect(run.segmentations).toEqual([
      { id: 'traffic_source', version: 1, changed: false },
      { id: 'returning', version: 1, changed: false },
      { id: 'buyer', version: 4, changed: true },
      { id: 'rager', version: 1, changed: false },
    ]);
    const rows = snapshot().trendRows;
    expect(rows.filter((row) => row.segment === 'all').every((row) => !('segmentation_version' in (row.metrics ?? {})))).toBe(true);
    expect(new Set(rows.filter((row) => row.segment === 'buyer').map((row) => row.metrics.segmentation_version))).toEqual(new Set([4]));
    expect((await persistence.readSegmentationDefinitions(IDSITE)).map((r) => [r.segmentation, r.version])).toEqual([
      ['buyer', 4], ['rager', 1], ['returning', 1], ['traffic_source', 1],
    ]);

    const again = await runTrend({ idsite: IDSITE, segmentations: TREND, windowStart: '2026-08-10', windowEnd: '2026-08-16', gateway: trendWarehouse(), persistence });
    expect(again.segmentations.find((s) => s.id === 'buyer')).toEqual({ id: 'buyer', version: 4, changed: false });
  });
});

/** The persistence with the weeks of each trend write recorded, and the rows by subject. */
function recordingWrites(persistence) {
  const writes = [];
  const rows = [];
  return {
    writes,
    rows,
    persistence: {
      ...persistence,
      async writeTrendRows(written) {
        writes.push([...new Set(written.map((row) => row.week))].sort());
        rows.push(written);
        return persistence.writeTrendRows(written);
      },
    },
  };
}

/** The weeks one write stored for a subject's all/all row. */
function subjectWeeks(written, rowKey, rowKey1) {
  return written
    .filter((row) => row.rowKey === rowKey && row.rowKey1 === rowKey1 && row.viewportType === 'all' && row.segment === 'all')
    .map((row) => row.week)
    .sort();
}

describe('next weeks', () => {
  it('backfills, then writes the overlap and the new week, then catches up a skipped week', async () => {
    const { adapter, snapshot } = createMemoryAePersistence();
    const { writes, persistence } = recordingWrites(adapter);
    const gateway = trendWarehouse({ urlPaths: [URL_PATH], pages: FIVE_PAGES });
    const next = (today, more = {}) => runTrend({ idsite: IDSITE, segmentations: TREND, nextWeeks: { today, ...more }, pathLimit: 1, gateway, persistence });

    // Wednesday 2026-09-16, nothing stored: six whole weeks ending Sunday 09-13.
    const first = await next('2026-09-16', { backfillWeeks: 6 });
    expect(first.window).toEqual({ windowStart: '2026-08-03', windowEnd: '2026-09-13' });
    expect(writes.at(-1)).toEqual(['2026-08-03', '2026-08-10', '2026-08-17', '2026-08-24', '2026-08-31', '2026-09-07']);

    // A week later: the stored last week again, and the new one.
    const second = await next('2026-09-23');
    expect(second.weeks).toEqual(['2026-09-07', '2026-09-14']);
    expect(writes.at(-1)).toEqual(['2026-09-07', '2026-09-14']);
    expect(gateway.calls.filter((call) => call.label === 'trend:paths').at(-1).params).toMatchObject({ w0: '2026-09-07', w1: '2026-09-20' });

    // Two weeks after that, one run skipped: the overlap and both missing weeks.
    expect((await next('2026-10-07')).weeks).toEqual(['2026-09-14', '2026-09-21', '2026-09-28']);
    expect(Object.keys(pathWeeks(snapshot))).toHaveLength(9);
    expect(Object.values(pathWeeks(snapshot)).every((sessions) => sessions === 7)).toBe(true);

    // Current, with no overlap and full lists: nothing to read.
    const calls = gateway.calls.length;
    expect(await next('2026-10-07', { overlapWeeks: 0 })).toMatchObject({ weeks: [], rows: 0 });
    expect(gateway.calls).toHaveLength(calls);
  });

  it('backfills a new selector and writes the next week for the subjects already stored', async () => {
    const { adapter, snapshot } = createMemoryAePersistence();
    const { rows, persistence } = recordingWrites(adapter);
    const gateway = trendWarehouse();
    await adapter.writeTrendSelectors([{ idsite: IDSITE, idsitehsr: 12, trendSelectors: ['#a'], status: 'active' }]);
    const next = (today, more = {}) => runTrend({ idsite: IDSITE, segmentations: TREND, nextWeeks: { today, ...more }, gateway, persistence });

    // Wednesday 2026-09-16, nothing stored: eight weeks ending Sunday 09-13.
    await next('2026-09-16');
    expect(subjectWeeks(rows[0], 'selector', '#a')).toHaveLength(8);

    await adapter.writeTrendSelectors([{ idsite: IDSITE, idsitehsr: 12, trendSelectors: ['#a', '#b'], status: 'active' }]);
    const calls = gateway.calls.length;
    const run = await next('2026-09-23', { overlapWeeks: 0 });
    expect(run.window).toEqual({ windowStart: '2026-07-27', windowEnd: '2026-09-20' });
    expect(subjectWeeks(rows[1], 'selector', '#b')).toEqual(['2026-07-27', '2026-08-03', '2026-08-10', '2026-08-17', '2026-08-24', '2026-08-31', '2026-09-07', '2026-09-14']);
    expect(subjectWeeks(rows[1], 'selector', '#a')).toEqual(['2026-09-14']);
    expect(subjectWeeks(rows[1], 'path', PATH)).toEqual(['2026-09-14']);
    expect(subjectWeeks(rows[1], 'step', `1:${PATH.split(' > ')[0]}`)).toEqual(['2026-09-14']);
    expect(subjectWeeks(rows[1], 'page', '12')).toEqual(['2026-09-14']);
    expect(gateway.calls.slice(calls).filter((call) => call.label === 'trend:selectors').map((call) => [call.params.w0, call.params.selectors]))
      .toEqual([['2026-07-27', ['#b']], ['2026-09-14', ['#a']]]);

    // The rank is the stored one: the new selector's backfill leaves the path's earlier weeks as they were.
    const stored = (snapshot().trendRows ?? []).filter((row) => row.rowKey === 'path' && row.viewportType === 'all' && row.segment === 'all');
    expect(stored).toHaveLength(9);
    expect(stored.every((row) => row.metrics.rank === 1)).toBe(true);
  });

  it('ranks only on a rerank or a short list, over its own lookback', async () => {
    const { adapter: persistence, snapshot } = createMemoryAePersistence();
    const gateway = trendWarehouse({ paths: [PATH], urlPaths: [URL_PATH], pages: FIVE_PAGES });
    const labels = (from) => gateway.calls.slice(from).map((call) => call.label);

    await runTrend({ idsite: IDSITE, segmentations: TREND, nextWeeks: { today: '2026-09-16', backfillWeeks: 2 }, pathLimit: 2, gateway, persistence });

    // One template path is stored against a limit of two: the next run ranks, and fills the list behind it.
    const second = PATH.replace('pdp', 'cart');
    gateway.calls.length = 0;
    const filled = trendWarehouse({ paths: [second, PATH], urlPaths: [URL_PATH], pages: FIVE_PAGES });
    const run = await runTrend({ idsite: IDSITE, segmentations: TREND, nextWeeks: { today: '2026-09-23' }, pathLimit: 2, gateway: filled, persistence });
    expect(run.paths).toEqual([PATH, second]);
    expect(filled.calls.map((call) => call.label)).toContain('trend:path-rank');
    expect(filled.calls.map((call) => call.label)).not.toContain('trend:page-rank');
    const ranks = Object.fromEntries((snapshot().trendRows ?? [])
      .filter((row) => row.rowKey === 'path' && row.week === '2026-09-14' && row.viewportType === 'all' && row.segment === 'all')
      .map((row) => [row.rowKey1, row.metrics.rank]));
    expect(ranks).toEqual({ [PATH]: 1, [second]: 2 });

    // Full lists: no rank query.
    const at = gateway.calls.length;
    await runTrend({ idsite: IDSITE, segmentations: TREND, nextWeeks: { today: '2026-09-23' }, pathLimit: 1, gateway, persistence });
    expect(labels(at).filter((label) => label.endsWith('-rank'))).toEqual([]);

    // A rerank on a one-week window ranks on the 30 days ending that Sunday.
    const from = gateway.calls.length;
    await runTrend({ idsite: IDSITE, segmentations: TREND, windowStart: '2026-09-14', windowEnd: '2026-09-20', rerank: true, gateway, persistence });
    const rank = gateway.calls.slice(from).filter((call) => call.label.endsWith('-rank')).map((call) => [call.label, call.params.w0, call.params.w1]);
    expect(rank).toEqual([['trend:path-rank', '2026-08-22', '2026-09-20'], ['trend:page-rank', '2026-08-22', '2026-09-20']]);
    expect(gateway.calls.find((call, i) => i >= from && call.label === 'trend:paths').params).toMatchObject({ w0: '2026-09-14', w1: '2026-09-20' });
  });

  it('starts the tag trend from its own stored weeks', async () => {
    const { adapter: persistence } = createMemoryAePersistence();
    const gateway = trendWarehouse();
    const selector = { id: 'stub', candidates: () => [], select: () => [] };
    const next = () => runTagTrend({ idsite: IDSITE, segmentations: TAG, nextWeeks: { today: '2026-09-23', backfillWeeks: 2 }, selector, gateway, persistence });

    expect((await next()).window).toEqual({ windowStart: '2026-09-07', windowEnd: '2026-09-20' });
    await persistence.writeTagTrendRows([{
      batchId: 'b', idsite: IDSITE, tagKey: 'utm_source', tagValue: 'ig', viewportType: 'all',
      segment: 'all', segmentValue: 'all', week: '2026-09-14', sessions: 3, metrics: {},
    }]);
    // A new selection backfills, reaching back past the stored week.
    expect((await next()).weeks).toEqual(['2026-09-07', '2026-09-14']);

    // A frozen selection starts at its key's stored week.
    await persistence.writeTagSelection([{
      batchId: 'b', idsite: IDSITE, tagKey: 'utm_source', adapterId: 'stub', family: 'utm', status: 'selected',
      windowStart: '2026-09-07', windowEnd: '2026-09-20', trendValues: ['ig'],
    }]);
    const frozen = await next();
    expect(frozen).toMatchObject({ frozen: true, weeks: ['2026-09-14'] });
    expect(gateway.calls.filter((call) => call.label === 'trend:tag-trend').at(-1).params).toMatchObject({ w0: '2026-09-14', w1: '2026-09-20' });
  });
});
