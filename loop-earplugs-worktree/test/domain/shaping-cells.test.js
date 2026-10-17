import { describe, expect, it } from 'vitest';
import { loadAttributeCatalog } from '../../src/catalog/attributes.js';
import { loadSourceKinds } from '../../src/catalog/sources.js';
import {
  OTHER, aggregate, compareCells, conservationProblems, deriveAll, mergeSources, partitionProblems, queryCells, rankKeys, rollingCells, sourceCells,
} from '../../src/domain/shaping/cells.js';
import { checkPeriod } from '../../src/domain/shaping/period.js';
import { lookupTable } from '../../src/domain/shaping/sources.js';

const KINDS = new Map(loadSourceKinds(loadAttributeCatalog()).map((kind) => [kind.id, kind]));
const SESSION = ['sessions', 'buyers', 'orders', 'revenue', 'progressed'];
const WEEK = checkPeriod({ grain: 'week' }).spec;
const DAY = checkPeriod({ grain: 'day', rolling: 3 }).spec;
const WINDOW = { start: '2026-09-07', end: '2026-09-20' };
const m = (sessions, extra = {}) => ({ sessions, buyers: 0, orders: 0, revenue: 0, progressed: 0, ...extra });
const cell = (period, keys, measures, segment = 'all', value = 'all') => ({ period, segment, value, keys, m: measures });

describe('queryCells', () => {
  it('keys cells by attribute, mapping a lookup through its key, and reads 64-bit strings as numbers', () => {
    const { table } = lookupTable(KINDS.get('site_catalog'), [{ path: '/products/a', product_type: 'shirts', collection: 'c', price_band: 'b' }]);
    const lookups = new Map([['site_catalog.product_type', { key: 'landing_path', column: 'product_type', fallback: '(unmatched)', table }]]);
    const rows = [
      { week_start: '2026-09-07', segment: 'all', segment_value: 'all', a_landing_path: '/products/a', a_device: '1', sessions: '4', buyers: '1', orders: '1', revenue: 50, progressed: '2' },
      { week_start: '2026-09-07', segment: 'all', segment_value: 'all', a_landing_path: '/pages/x', a_device: '1', sessions: '3', buyers: '0', orders: '0', revenue: 0, progressed: '0' },
    ];
    const types = new Map([['landing_path', 'string'], ['device', 'string']]);
    const cells = queryCells(rows, { by: ['site_catalog.product_type'], queryKeys: ['landing_path'], types, lookups, sessionMeasures: SESSION });
    expect(cells.map((c) => [c.keys, c.m.sessions])).toEqual([[['shirts'], 4], [['(unmatched)'], 3]]);
  });
});

describe('sources and the merge', () => {
  const kind = KINDS.get('meta_ads');
  const rows = [
    { date: '2026-09-06', campaign_name: 'fall', spend: 5 },
    { date: '2026-09-07', campaign_name: ' fall ', spend: 10 },
    { date: '2026-09-08', campaign_name: 'fall', spend: 20 },
    { date: '2026-09-15', campaign_name: 'ghost', spend: 7 },
  ];
  const outputPeriods = new Set(['2026-09-07', '2026-09-14']);
  const built = sourceCells({ kind, rows, measures: ['spend'], by: ['utm_campaign'], lookups: new Map(), filter: null, period: WEEK, window: WINDOW, queryWindow: WINDOW, outputPeriods });

  it('sums a source onto all cells in its periods and keys, inside the query window', () => {
    expect(built.cells).toEqual([
      cell('2026-09-07', ['fall'], { 'meta_ads.spend': 30 }),
      cell('2026-09-14', ['ghost'], { 'meta_ads.spend': 7 }),
    ]);
    expect(built.totals).toEqual({ 'meta_ads.spend': 37 });
  });

  it('applies a filter over the mapped keys', () => {
    const only = sourceCells({ kind, rows, measures: ['spend'], by: [], lookups: new Map(), filter: (values) => values.utm_campaign === 'ghost', period: WEEK, window: WINDOW, queryWindow: WINDOW, outputPeriods });
    expect(only.totals).toEqual({ 'meta_ads.spend': 7 });
  });

  it('puts source measures on segment all only, and keeps spend no session arrived from', () => {
    const sessions = [cell('2026-09-07', ['fall'], m(5)), cell('2026-09-07', ['fall'], m(5), 'returning', 'new')];
    const merged = mergeSources(sessions, built.cells, { sessionMeasures: SESSION, sourceMeasures: ['meta_ads.spend'] });
    expect(merged.map((c) => [c.period, c.segment, c.keys[0], c.m.sessions, c.m['meta_ads.spend']])).toEqual([
      ['2026-09-07', 'all', 'fall', 5, 30],
      ['2026-09-07', 'returning', 'fall', 5, null],
      ['2026-09-14', 'all', 'ghost', 0, 7],
    ]);
    expect(conservationProblems(merged, built.totals, outputPeriods)).toEqual([]);
    expect(conservationProblems(merged.slice(0, 2), built.totals, outputPeriods)).toEqual(['meta_ads.spend: the rows hold 30, the source holds 37']);
  });
});

describe('rank', () => {
  const cells = [
    cell('2026-09-07', ['a'], m(10)), cell('2026-09-07', ['b'], m(4)), cell('2026-09-07', ['c'], m(3)),
    cell('2026-09-14', ['a'], m(1)), cell('2026-09-14', ['c'], m(5)),
    cell('2026-09-07', ['c'], m(3), 'returning', 'new'),
  ];
  const spec = (other) => ({ rank: { by: 'sessions', order: 'desc', limit: 2, other }, measure: { id: 'sessions', kind: 'session' }, additive: SESSION, outputPeriods: new Set(['2026-09-07', '2026-09-14']) });

  it('keeps the top keys over the window and folds the rest into (other)', () => {
    const ranked = rankKeys(cells, spec(true));
    expect(ranked.folded).toBe(1);
    expect(ranked.order).toEqual(['["a"]', '["c"]', `["${OTHER}"]`]);
    expect(aggregate(ranked.cells, SESSION).filter((c) => c.keys[0] === OTHER).map((c) => [c.period, c.m.sessions])).toEqual([['2026-09-07', 4]]);
    expect(ranked.cells.find((c) => c.segment === 'returning').keys).toEqual(['c']);
  });

  it('drops the rest when other is false', () => {
    expect(rankKeys(cells, spec(false)).cells.some((c) => c.keys[0] === 'b')).toBe(false);
  });
});

describe('time', () => {
  it('sums trailing days per series, dense over the output days', () => {
    const cells = [cell('2026-09-05', [], m(1)), cell('2026-09-06', [], m(2)), cell('2026-09-08', [], m(4))];
    const out = rollingCells(cells, { days: DAY.rolling, outputDays: ['2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11'], sessionMeasures: SESSION, sourceMeasures: [] });
    expect(out.map((c) => c.m.sessions)).toEqual([3, 6, 4, 4, 0]);
  });

  it('sets each measure beside the previous period, with no ratio from nothing', () => {
    const derived = [{ id: 'conversion_rate', kind: 'derived', ratio: ['buyers', 'sessions'], scale: 1 }];
    const cells = deriveAll([
      cell('2026-08-31', ['a'], m(10, { buyers: 1 })),
      cell('2026-09-07', ['a'], m(20, { buyers: 4 })),
      cell('2026-09-07', ['b'], m(5, { buyers: 1 })),
    ], derived);
    compareCells(cells, { names: ['sessions', 'conversion_rate'], derived: new Set(['conversion_rate']), sourceMeasures: new Set(), period: WEEK, window: WINDOW });
    const [, a, b] = cells;
    expect(a.m).toMatchObject({ sessions_previous: 10, sessions_change: 1, conversion_rate_previous: 0.1 });
    expect(a.m.conversion_rate_change).toBeCloseTo(1);
    expect(b.m).toMatchObject({ sessions_previous: 0, sessions_change: null, conversion_rate_previous: null, conversion_rate_change: null });
  });
});

describe('partition', () => {
  const seg = { id: 'returning', values: ['new', 'returning'] };

  it('passes when the values hold segment all, and says where they do not', () => {
    const ok = [cell('w', [], m(5, { orders: 1, revenue: 10 })), cell('w', [], m(2, { orders: 1, revenue: 10 }), 'returning', 'new'), cell('w', [], m(3), 'returning', 'returning')];
    expect(partitionProblems(ok, [seg])).toEqual([]);
    const bad = [...ok.slice(0, 2), cell('w', [], m(1), 'returning', 'lapsed')];
    expect(partitionProblems(bad, [seg])).toEqual(['returning returned lapsed, which is not one of its values', '["w"]: returning values hold sessions 3, segment all holds 5']);
  });
});
