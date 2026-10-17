import { describe, expect, it } from 'vitest';
import { SHIPPED_DEFAULTS } from '../src/application/segmentation/registry.js';
import { buildTrendRow } from '../src/enrichment/trend-row.js';

const journey = {
  batchId: 'batch-1',
  idsite: 5795,
  rowType: 'journey',
  rowKey: 'path',
  rowKey1: 'home > pdp',
  viewportType: 'all',
  segment: 'traffic_source',
  segmentValue: 'meta',
  week: '2026-09-28',
  sessions: 1200,
  buyers: 9,
  orders: 9,
  revenue: 5400,
};

describe('buildTrendRow', () => {
  it('keeps the same metric columns for a journey, a page, and an element', () => {
    const path = buildTrendRow(journey);
    const page = buildTrendRow({
      ...journey,
      rowType: 'page',
      rowKey: 'page',
      rowKey1: '51308585',
      rowKey2: 'https://example.com/products/a',
      idsitehsr: 51308585,
      segment: 'returning',
      segmentValue: 'new',
    });
    const element = buildTrendRow({
      ...journey,
      rowType: 'element',
      rowKey: 'element_class',
      rowKey1: 'pdp.gallery_main',
      rowKey2: '#gallery',
      clicks: 40,
      sessions: 800,
    });
    for (const row of [path, page, element]) {
      expect(Object.keys(row).sort()).toEqual([
        'batchId', 'buyers', 'clicks', 'idsite', 'idsitehsr', 'metrics', 'orders',
        'progressed', 'revenue', 'rowKey', 'rowKey1', 'rowKey2', 'rowType',
        'segment', 'segmentValue', 'sessions', 'viewportType', 'week',
      ]);
    }
    expect(path.idsitehsr).toBe(0);
    expect(path.clicks).toBe(0);
    expect(page.idsitehsr).toBe(51308585);
    expect(element.rowKey2).toBe('#gallery');
    expect(element.clicks).toBe(40);
  });

  it('rejects a week that is not a Monday and a blank segment', () => {
    expect(() => buildTrendRow({ ...journey, week: '2026-10-06' })).toThrow(/Monday/);
    expect(() => buildTrendRow({ ...journey, segment: '  ' })).toThrow(/segment/);
    expect(() => buildTrendRow({ ...journey, rowType: 'funnel' })).toThrow(/rowType/);
    expect(() => buildTrendRow({ ...journey, viewportType: 'phone' })).toThrow(/viewportType/);
  });

  it('splits the trend by the first four segmentations unless the run or site says otherwise', () => {
    expect(SHIPPED_DEFAULTS.trend).toEqual(['traffic_source', 'returning', 'buyer', 'rager']);
  });
});
