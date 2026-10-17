import { describe, expect, it } from 'vitest';
import { createMemoryAePersistence } from '../src/adapters/persistence/memory.js';
import { checkBackfillWeeks, backfillDays } from '../src/enrichment/segmentation-backfill.js';
import { runTagTrend } from '../src/enrichment/tag-trend-run.js';
import { runTrend } from '../src/enrichment/trend-run.js';
import { eachDate, mondayOf } from '../src/triggers/time.js';
import { SHIPPED, withSites } from './support/segmentations.js';

const IDSITE = 41;
const PATH = 'home > pdp';
const WEEKS = ['2026-08-03', '2026-08-10', '2026-08-17', '2026-08-24', '2026-08-31', '2026-09-07'];
const GOOGLE_PAID = { value: 'google_paid', when: { all: [{ field: 'referer_type', in: [2, 6] }, { field: 'utm_medium', eq: 'cpc' }] } };

const EDITED = withSites([{ slug: 'test', idsite: IDSITE, defaults: {}, overrides: { channel: { prepend: [GOOGLE_PAID], remove: ['affiliate'] } }, declarations: [] }]);
const SELECTED = ['traffic_source', 'channel'];

/**
 * One session a day on PATH. A query returns the `all` cell only when it
 * carries the `all` tuple, and a cell for each segmentation it names.
 * @param {Record<string, string>} values segmentation id → the day's value
 */
function warehouse(values) {
  const calls = [];
  const cellsOf = (sql, params, extra) => eachDate(params.w0, params.w1).flatMap((d) => [
    ...(sql.includes("tuple('all', 'all')") ? [['all', 'all']] : []),
    ...Object.entries(values).filter(([id]) => sql.includes(`tuple('${id}'`)),
  ].map(([segment, segmentValue]) => ({
    week_start: mondayOf(d), viewport_value: 'desktop', segment, segment_value: segmentValue,
    sessions: 1, buyers: 0, orders: 0, revenue: 0, clicks: 1, progressed: 0, ...extra,
  })));
  return {
    calls,
    async query(sql, params, label) {
      calls.push({ label, params, sql });
      if (label === 'trend:path-rank') return [{ kind: 'template', path: PATH, sessions: 10, revenue: 100 }];
      if (label === 'trend:paths' || label === 'trend:backfill-paths') return cellsOf(sql, params, { path: PATH });
      if (label === 'trend:tag-inventory') return [{ tag_key: 'utm_source', visits: 10, distinct_values: 1 }];
      if (label === 'trend:tag-values') return [{ kind: 'total', sessions: eachDate(params.w0, params.w1).length }];
      if (label === 'trend:tag-trend' || label === 'trend:backfill-tag-trend') return cellsOf(sql, params, { key_value: 'utm_source', trend_value: 'ig' });
      return [];
    },
  };
}

const pathRows = (snapshot, segment) => (snapshot().trendRows ?? [])
  .filter((row) => row.rowKey === 'path' && row.viewportType === 'all' && row.segment === segment);

describe('backfill on a version change', () => {
  it('rewrites every stored week of the changed segmentation only, and zeroes a retired value', async () => {
    const { adapter: persistence, snapshot } = createMemoryAePersistence();
    const first = await runTrend({
      idsite: IDSITE, windowStart: WEEKS[0], windowEnd: '2026-09-13', pathLimit: 1,
      segmentations: SHIPPED.select(IDSITE, 'trend', SELECTED),
      gateway: warehouse({ traffic_source: 'direct', channel: 'affiliate' }), persistence,
    });
    expect(first.weeks).toEqual(WEEKS);
    expect(first.backfill).toEqual([]);
    const storedSource = pathRows(snapshot, 'traffic_source');

    const gateway = warehouse({ traffic_source: 'direct', channel: 'google_paid' });
    const second = await runTrend({
      idsite: IDSITE, windowStart: WEEKS[5], windowEnd: '2026-09-13', pathLimit: 1,
      segmentations: EDITED.select(IDSITE, 'trend', SELECTED),
      gateway, persistence,
    });
    expect(second.segmentations).toEqual([
      { id: 'traffic_source', version: 1, changed: false },
      { id: 'channel', version: 2, changed: true },
    ]);
    expect(second.backfill).toEqual([{ id: 'channel', from: 1, to: 2, weeks: [WEEKS[0], WEEKS[4]], rows: expect.any(Number), retired: ['affiliate'] }]);
    expect(second.check.ok).toBe(true);

    const backfill = gateway.calls.filter((call) => call.label === 'trend:backfill-paths');
    expect(backfill.map((call) => [call.params.w0, call.params.w1])).toEqual([[WEEKS[0], '2026-09-06']]);
    expect(backfill[0].sql).not.toContain("tuple('all', 'all')");
    expect(backfill[0].sql).not.toContain("tuple('traffic_source'");

    const channel = pathRows(snapshot, 'channel');
    expect(new Set(channel.map((row) => row.metrics.segmentation_version))).toEqual(new Set([2]));
    const byValue = (value) => Object.fromEntries(channel.filter((row) => row.segmentValue === value).map((row) => [row.week, row.sessions]));
    expect(byValue('google_paid')).toEqual(Object.fromEntries(WEEKS.map((week) => [week, 7])));
    expect(byValue('affiliate')).toEqual(Object.fromEntries(WEEKS.map((week) => [week, 0])));
    expect(channel.filter((row) => row.segmentValue === 'affiliate').every((row) => row.metrics.retired === true)).toBe(true);

    const source = pathRows(snapshot, 'traffic_source').filter((row) => row.week < WEEKS[5]);
    expect(source).toEqual(storedSource.filter((row) => row.week < WEEKS[5]));
  });

  it('refuses a backfill over the limit before any query, unless every week is asked for', async () => {
    const { adapter: persistence } = createMemoryAePersistence();
    await runTrend({
      idsite: IDSITE, windowStart: WEEKS[0], windowEnd: '2026-09-13', pathLimit: 1,
      segmentations: SHIPPED.select(IDSITE, 'trend', SELECTED),
      gateway: warehouse({ traffic_source: 'direct', channel: 'affiliate' }), persistence,
    });
    const gateway = warehouse({ traffic_source: 'direct', channel: 'google_paid' });
    const run = (over) => runTrend({
      idsite: IDSITE, windowStart: WEEKS[5], windowEnd: '2026-09-13', pathLimit: 1,
      segmentations: EDITED.select(IDSITE, 'trend', SELECTED), gateway, persistence, ...over,
    });
    await expect(run({ maxBackfillWeeks: 4 })).rejects.toThrow(
      /segmentation channel moved from version 1 to 2: its stored rows cover 6 weeks, 2026-08-03 to 2026-09-07, over the backfill limit of 4; pass --backfill-all/,
    );
    expect(gateway.calls).toEqual([]);
    const all = await run({ maxBackfillWeeks: 4, backfillAll: true });
    expect(all.backfill[0]).toMatchObject({ id: 'channel', weeks: [WEEKS[0], WEEKS[4]] });

    const thirty = [{ seg: { id: 'channel' }, previous: 1, version: 2, spans: [{ first: '2026-01-05', last: '2026-07-27' }] }];
    expect(() => checkBackfillWeeks(thirty, { flag: '--backfill-all' })).toThrow(/cover 30 weeks.*limit of 26/);
    expect(() => checkBackfillWeeks(thirty, { flag: '--backfill-all', all: true })).not.toThrow();
  });

  it('ends a subject backfill the day before the run reads it', () => {
    expect(backfillDays({ first: '2026-08-03', last: '2026-09-07' }, '2026-08-31')).toEqual({ w0: '2026-08-03', w1: '2026-08-30' });
    expect(backfillDays({ first: '2026-08-03', last: '2026-08-24' }, null)).toEqual({ w0: '2026-08-03', w1: '2026-08-30' });
    expect(backfillDays({ first: '2026-08-31', last: '2026-09-07' }, '2026-08-31')).toBeNull();
  });

  it('rewrites the tag trend the same way', async () => {
    const { adapter: persistence, snapshot } = createMemoryAePersistence();
    const selector = {
      id: 'stub',
      candidates: (inventory) => inventory.map((row) => ({ ...row, status: 'candidate', family: 'utm' })),
      select: () => [{ key: 'utm_source', status: 'selected', family: 'utm', trendValues: ['ig'] }],
    };
    await runTagTrend({
      idsite: IDSITE, windowStart: WEEKS[0], windowEnd: '2026-09-13', selector,
      segmentations: SHIPPED.select(IDSITE, 'tagTrend', SELECTED),
      gateway: warehouse({ traffic_source: 'direct', channel: 'affiliate' }), persistence,
    });
    const gateway = warehouse({ traffic_source: 'direct', channel: 'google_paid' });
    const second = await runTagTrend({
      idsite: IDSITE, windowStart: WEEKS[5], windowEnd: '2026-09-13', selector,
      segmentations: EDITED.select(IDSITE, 'tagTrend', SELECTED), gateway, persistence,
    });
    expect(second.backfill).toEqual([{ id: 'channel', from: 1, to: 2, weeks: [WEEKS[0], WEEKS[4]], rows: expect.any(Number), retired: ['affiliate'] }]);
    const backfill = gateway.calls.filter((call) => call.label === 'trend:backfill-tag-trend');
    expect(backfill.map((call) => [call.params.w0, call.params.w1])).toEqual([[WEEKS[0], '2026-09-06']]);
    expect(backfill[0].sql).not.toContain("tuple('all', 'all')");

    const channel = (snapshot().tagTrendRows ?? []).filter((row) => row.segment === 'channel' && row.viewportType === 'all' && row.tagValue === 'ig');
    expect(new Set(channel.map((row) => row.metrics.segmentation_version))).toEqual(new Set([2]));
    expect(Object.fromEntries(channel.filter((row) => row.segmentValue === 'affiliate').map((row) => [row.week, [row.sessions, row.metrics.retired]])))
      .toEqual(Object.fromEntries(WEEKS.map((week) => [week, [0, true]])));
  });
});
