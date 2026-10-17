// Characterization baseline (SG0): the trend, tag-trend, and experiment rows
// the segmentations produce over the varied site fixture, on clickhouse local.
// Row order is not part of the contract, so rows are sorted by identity.
// Each snapshot holds every row with a non-zero measure in full, plus the
// count of rows per (row key, viewport, segment, value), which pins the zero
// rows of the grid. A change to these files is a reviewed behaviour change.
import { describe, expect, it } from 'vitest';
import { createMemoryAePersistence } from '../../src/adapters/persistence/memory.js';
import { experimentFactSql } from '../../src/experiments/sql.js';
import { runTagTrend } from '../../src/enrichment/tag-trend-run.js';
import { runTrend } from '../../src/enrichment/trend-run.js';
import { canonical } from '../../src/triggers/definitions.js';
import { hasClickHouseLocal } from '../domain/clickhouse-local.js';
import { createLocalWarehouse } from '../support/local-warehouse.js';
import { variedWarehouseRows } from '../support/segmentation-fixture.js';
import { shipped } from '../support/segmentations.js';
import { IDSITE } from '../support/site-fixture.js';

const WINDOW = { windowStart: '2026-09-07', windowEnd: '2026-09-20' };
const TREND_IDENTITY = ['rowType', 'rowKey', 'rowKey1', 'rowKey2', 'viewportType', 'segment', 'segmentValue', 'week', 'idsitehsr'];
const TREND_MEASURES = ['sessions', 'buyers', 'orders', 'revenue', 'clicks', 'progressed'];
const TAG_IDENTITY = ['tagKey', 'tagValue', 'viewportType', 'segment', 'segmentValue', 'week'];
const TAG_MEASURES = ['sessions', 'buyers', 'orders', 'revenue', 'progressed'];
const EXPERIMENT_IDENTITY = ['exp', 'arm_index', 'day', 'basis', 'viewport_type', 'segment', 'segment_value'];
const EXPERIMENT_MEASURES = ['sessions', 'buyers', 'orders', 'revenue', 'revenue_sq', 'progressed'];

/** Fields a later phase adds to every row on purpose, dropped before comparing. */
export const ADDED_METRICS = ['segmentation_version'];

/**
 * @param {object[]} rows
 * @param {string[]} identity
 * @param {string[]} measures
 * @param {string} shapeKey the field that names a row's family in the grid count
 */
export function compact(rows, identity, measures, shapeKey) {
  const line = (row) => {
    const metrics = row.metrics ? Object.fromEntries(Object.entries(row.metrics).filter(([key]) => !ADDED_METRICS.includes(key))) : null;
    return [
      ...identity.map((field) => String(row[field] ?? '')),
      ...measures.map((field) => `${field}=${Number(row[field] ?? 0)}`),
      ...(metrics ? [canonical(metrics)] : []),
    ].join(' | ');
  };
  const sorted = [...rows].sort((a, b) => {
    for (const field of identity) {
      const left = String(a[field] ?? '');
      const right = String(b[field] ?? '');
      if (left !== right) return left < right ? -1 : 1;
    }
    return 0;
  });
  const shape = new Map();
  for (const row of sorted) {
    const key = [row[shapeKey], row.viewportType ?? row.viewport_type, row.segment, row.segmentValue ?? row.segment_value].join(' | ');
    shape.set(key, (shape.get(key) ?? 0) + 1);
  }
  const nonZero = sorted.filter((row) => measures.some((field) => Number(row[field] ?? 0) !== 0));
  return [
    `rows ${rows.length}, non-zero ${nonZero.length}`,
    '',
    '# grid',
    ...[...shape.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([key, n]) => `${key} | ${n}`),
    '',
    '# non-zero rows',
    ...nonZero.map(line),
    '',
  ].join('\n');
}

/** Memory persistence that keeps the rows each run writes. */
function recording() {
  const { adapter } = createMemoryAePersistence();
  const written = { trend: [], tag: [] };
  return {
    written,
    persistence: {
      ...adapter,
      async writeTrendRows(rows) {
        written.trend.push(...rows);
        return adapter.writeTrendRows(rows);
      },
      async writeTagTrendRows(rows) {
        written.tag.push(...rows);
        return adapter.writeTagTrendRows(rows);
      },
    },
  };
}

/** Selects utm_source and utm_campaign with their two largest values. */
export const STUB_TAG_SELECTOR = {
  id: 'stub',
  candidates: (inventory) => inventory.map((row) => ({
    key: row.key, family: 'utm', status: 'candidate', reason: '', taggedSessions: row.visits, distinctValues: row.distinctValues,
  })),
  select: ({ candidates, values }) => candidates.map((row) => {
    const top = values
      .filter((value) => value.key === row.key)
      .sort((a, b) => b.sessions - a.sessions || (a.value < b.value ? -1 : 1))
      .slice(0, 2)
      .map((value) => value.value);
    const chosen = row.key === 'utm_source' || row.key === 'utm_campaign';
    return { ...row, status: chosen ? 'selected' : 'rejected', reason: chosen ? '' : 'stub', trendValues: chosen ? top : [] };
  }),
};

export const TREND_SEEDS = [{ idsite: IDSITE, idsitehsr: 12, trendSelectors: ['s0', 's1', 's2'], status: 'active' }];

/** The experiment fact params for the fixture's e1 test, arms a and b, over the whole fixture. */
export const EXPERIMENT_PARAMS = {
  idsite: IDSITE,
  d0: '2026-09-07',
  d1: '2026-09-16',
  raw: ['|e1|a', '|e1|b'],
  mapped: ['0:0', '0:1'],
  starts: ['2026-09-07'],
  ends: ['2026-09-16'],
  surfaceAll: [0],
  surfacePages: [],
  expo: ['0|t:pdp'],
};

describe.skipIf(!hasClickHouseLocal())('segmentation parity (characterization)', () => {
  it('records the trend rows', async () => {
    const { written, persistence } = recording();
    const result = await runTrend({ idsite: IDSITE, ...WINDOW, pathLimit: 3, seeds: TREND_SEEDS, segmentations: shipped('trend'), gateway: createLocalWarehouse(variedWarehouseRows()), persistence });
    expect(result.check.ok).toBe(true);
    expect(result.selectors).toEqual([{ idsitehsr: 12, selectors: ['s0', 's1', 's2'] }]);
    await expect(compact(written.trend, TREND_IDENTITY, TREND_MEASURES, 'rowKey')).toMatchFileSnapshot('./__snapshots__/segmentation-parity.trend.txt');
  }, 120_000);

  it('records the tag-trend rows', async () => {
    const { written, persistence } = recording();
    const result = await runTagTrend({ idsite: IDSITE, ...WINDOW, selector: STUB_TAG_SELECTOR, segmentations: shipped('tagTrend'), gateway: createLocalWarehouse(variedWarehouseRows()), persistence });
    expect(result.check.ok).toBe(true);
    expect(result.selected.map((row) => row.key).sort()).toEqual(['utm_campaign', 'utm_source']);
    await expect(compact(written.tag, TAG_IDENTITY, TAG_MEASURES, 'tagKey')).toMatchFileSnapshot('./__snapshots__/segmentation-parity.tag.txt');
  }, 120_000);

  it('records the experiment fact rows', async () => {
    const gateway = createLocalWarehouse(variedWarehouseRows());
    const viewed = await gateway.query(experimentFactSql({ withViewed: true, segmentations: shipped('experiments') }), EXPERIMENT_PARAMS, 'experiment:facts');
    const assigned = await gateway.query(experimentFactSql({ withViewed: false, segmentations: shipped('experiments') }), { ...EXPERIMENT_PARAMS, expo: [] }, 'experiment:facts');
    expect(new Set(viewed.map((row) => row.segment))).toEqual(new Set(['all', 'traffic_source', 'returning']));
    const rows = [...viewed.map((row) => ({ ...row, exp: `viewed:${row.exp}` })), ...assigned.map((row) => ({ ...row, exp: `assigned:${row.exp}` }))];
    await expect(compact(rows, EXPERIMENT_IDENTITY, EXPERIMENT_MEASURES, 'basis')).toMatchFileSnapshot('./__snapshots__/segmentation-parity.experiment.txt');
  }, 120_000);
});
