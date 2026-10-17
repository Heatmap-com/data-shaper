import { describe, expect, it } from 'vitest';
import { queryBoundGaps } from '../src/governance/query-bounds.js';
import {
  chooseSubjects,
  journeyRows,
  onStep,
  pathMatchList,
  rankMoneyPaths,
  selectorRows,
} from '../src/enrichment/trend-aggregate.js';
import {
  pageAggregateSql,
  pageRankSql,
  pathAggregateSql,
  pathRankSql,
  selectorAggregateSql,
  urlPathSql,
} from '../src/enrichment/trend-sql.js';
import { runTrend, verifyTrend } from '../src/enrichment/trend-run.js';
import { createMemoryAePersistence } from '../src/adapters/persistence/memory.js';
import { DVF_DRESSES_NEXT, DVF_HOME, DVF_SECTION5, dvfProofErrors } from './fixtures/dvf-trend-proof.js';
import { FIELDS } from '../src/domain/segmentation/index.js';
import { TREND_COLUMNS } from '../src/enrichment/trend-sql.js';
import { planGroups } from '../src/enrichment/segmentation-sql.js';
import { SHIPPED, fanned, shipped } from './support/segmentations.js';

const weeks = ['2026-09-14'];
const SEGMENTATIONS = shipped('trend');
const ONE_GROUP = planGroups(SEGMENTATIONS)[0];
const EVERY = planGroups([...SHIPPED.forSite(1).values()].filter((seg) => seg.grains.includes('trend')), 1000)[0];

/** A visit set with one value of each shipped trend segmentation, as fan-out cells. */
function cells(overrides, values = { traffic_source: overrides.traffic ?? 'direct', returning: 'new', buyer: 'non_buyer', rager: 'non_rager' }) {
  const { traffic, ...rest } = overrides;
  return fanned(cell(rest), values, SEGMENTATIONS);
}

function cell(overrides) {
  return {
    week: '2026-09-14',
    viewport: 'desktop',
    path: 'home > pdp',
    sessions: 10,
    buyers: 1,
    orders: 1,
    revenue: 40,
    clicks: 0,
    progressed: 2,
    ...overrides,
  };
}

describe('money paths', () => {
  it('ranks paths that earn revenue and keeps a stored list', () => {
    const ranked = rankMoneyPaths([
      cell({ path: 'home', revenue: 500, sessions: 50 }),
      cell({ path: 'home > pdp', revenue: 100, sessions: 10 }),
      cell({ path: 'home > plp > pdp', revenue: 80, sessions: 30 }),
      cell({ path: 'home > cart', revenue: 80, sessions: 5 }),
    ], 2);
    expect(ranked).toEqual(['home > pdp', 'home > plp > pdp']);
    expect(chooseSubjects(['home > cart'], ranked, false, 1)).toEqual(['home > cart']);
    expect(chooseSubjects(['home > cart'], ranked, false, 2)).toEqual(['home > cart', 'home > pdp']);
    expect(chooseSubjects(['home > plp > pdp'], ranked, false, 3)).toEqual(['home > plp > pdp', 'home > pdp']);
    expect(chooseSubjects(['home > cart'], ranked, true, 2)).toEqual(ranked);
  });

  it('matches a URL path and the pages that continue past it', () => {
    const match = pathMatchList(['/collections/dresses > /products/wrap']);
    expect(match.exact).toEqual(['/collections/dresses', '/collections/dresses > /products/wrap']);
    expect(match.extensions).toEqual(['/collections/dresses > /products/wrap > ']);
  });

  it('keeps a step on its own path', () => {
    const templates = ['home', 'pdp', 'cart'];
    expect(onStep('home > plp', templates, 0)).toBe(false);
    expect(onStep('home > pdp', templates, 0)).toBe(true);
    expect(onStep('home > pdp > cart', templates, 1)).toBe(true);
    expect(onStep('home', templates, 1)).toBe(false);
  });

  it('partitions one segmentation and one viewport column', () => {
    const rows = journeyRows(['home > pdp'], weeks, {
      batchId: 'b',
      idsite: 5795,
      segmentations: SEGMENTATIONS,
      cells: [
        ...cells({ viewport: 'desktop', traffic: 'meta', sessions: 4, buyers: 1, orders: 1, revenue: 20, progressed: 1 }),
        ...cells({ viewport: 'mobile', traffic: 'direct', sessions: 6, buyers: 0, orders: 0, revenue: 0, progressed: 0 }),
        ...cells({ viewport: 'unknown', traffic: 'search', sessions: 1, buyers: 0, orders: 0, revenue: 0, progressed: 0 }),
      ],
    });
    const total = rows.find((row) => row.rowKey === 'path' && row.viewportType === 'all' && row.segment === 'all');
    const devices = rows.filter((row) => row.rowKey === 'path' && row.week === '2026-09-14' && row.viewportType !== 'all' && row.segment === 'all');
    const traffic = rows.filter((row) => row.rowKey === 'path' && row.week === '2026-09-14' && row.viewportType === 'all' && row.segment === 'traffic_source');
    expect(total.sessions).toBe(11);
    expect(devices.reduce((sum, row) => sum + row.sessions, 0)).toBe(11);
    expect(traffic.reduce((sum, row) => sum + row.sessions, 0)).toBe(11);
    expect(rows.some((row) => row.rowKey === 'step' && row.rowKey1 === '2:pdp' && row.rowKey2 === 'home > pdp')).toBe(true);
    const urlRows = journeyRows(['/ > /products/wrap'], weeks, {
      batchId: 'b',
      idsite: 5795,
      segmentations: SEGMENTATIONS,
      cells: cells({ urlPath: '/ > /products/wrap', path: '' }),
    }, { pathKey: 'url_path', stepKey: 'url_step', field: 'urlPath' });
    expect(urlRows.some((row) => row.rowKey === 'url_path' && row.rowKey1 === '/ > /products/wrap')).toBe(true);
    expect(urlRows.some((row) => row.rowKey === 'url_step' && row.rowKey1 === '2:/products/wrap')).toBe(true);
  });
});

describe('trend sql bounds', () => {
  it('bounds every fact alias, and the selector scan bounds the page', () => {
    expect(queryBoundGaps(pathRankSql())).toEqual([]);
    expect(pathRankSql()).toContain("'template'");
    expect(pathRankSql()).toContain("'url'");
    expect(queryBoundGaps(pageRankSql())).toEqual([]);
    for (const group of [ONE_GROUP, EVERY]) {
      expect(queryBoundGaps(pathAggregateSql('template', group))).toEqual([]);
      expect(queryBoundGaps(pathAggregateSql('url', group))).toEqual([]);
      expect(pathAggregateSql('template', group)).toContain("'pdp'");
      expect(pathAggregateSql('url', group)).toContain(urlPathSql('p.url'));
      expect(queryBoundGaps(pageAggregateSql(group))).toEqual([]);
      expect(queryBoundGaps(selectorAggregateSql(group), { idsitehsr: true })).toEqual([]);
    }
  });

  it('reads the rage-click scan and the history CTEs only when a selected segmentation needs them', () => {
    const declared = planGroups(shipped('trend', ['traffic_source', 'channel']))[0];
    expect(pathAggregateSql('template', declared)).not.toMatch(/ragers AS|history AS/);
    expect(pathAggregateSql('template', ONE_GROUP)).toMatch(/ragers AS/);
    expect(pathAggregateSql('template', EVERY)).toMatch(/history AS[\s\S]*LEFT JOIN prior AS p ON p.idvisit = k.idvisit/);
  });

  it('maps every registered field to a non-null trend column', () => {
    expect(Object.keys(TREND_COLUMNS).sort()).toEqual(Object.keys(FIELDS).sort());
  });
});

describe('query groups', () => {
  const seg = (id, n) => ({ id, values: Array.from({ length: n }, (_, i) => `v${i}`) });

  it('packs segmentations in order up to the budget, with the all tuple in the first group', () => {
    const groups = planGroups([seg('a', 16), seg('b', 16), seg('c', 16), seg('d', 2)], 48);
    expect(groups.map((group) => [group.segmentations.map((item) => item.id), group.withAll])).toEqual([[['a', 'b', 'c'], true], [['d'], false]]);
    expect(planGroups(SEGMENTATIONS)).toHaveLength(1);
  });

  it('refuses a segmentation over the budget', () => {
    expect(() => planGroups([seg('wide', 20)], 16)).toThrow('segmentation wide has 20 values, over the query budget of 16');
  });
});

describe('selector proof', () => {
  const plan = { paths: [], pages: [], selectorPlan: [{ idsitehsr: DVF_HOME.idsitehsr, selectors: [DVF_DRESSES_NEXT, DVF_SECTION5] }], segmentations: SEGMENTATIONS };

  it('stores every planned selector, and the DVF fixture holds on the DVF device shape', () => {
    const rows = selectorRows([DVF_DRESSES_NEXT, DVF_SECTION5], DVF_HOME.idsitehsr, weeks, {
      batchId: 'b',
      idsite: DVF_HOME.idsite,
      segmentations: SEGMENTATIONS,
      cells: [
        ...cells({ selector: DVF_DRESSES_NEXT, viewport: 'desktop', sessions: 10, clicks: 12 }),
        ...cells({ selector: DVF_DRESSES_NEXT, viewport: 'tablet', sessions: 8, clicks: 9 }),
        ...cells({ selector: DVF_SECTION5, viewport: 'mobile', sessions: 20, clicks: 20 }),
        ...cells({ selector: DVF_SECTION5, viewport: 'desktop', sessions: 2, clicks: 2 }),
      ],
    });
    expect(verifyTrend(rows, plan).ok).toBe(true);
    expect(dvfProofErrors(rows)).toEqual([]);
  });

  it('the DVF fixture rejects a mobile dresses click, and the generic check stays site-neutral', () => {
    const withMobile = selectorRows([DVF_DRESSES_NEXT, DVF_SECTION5], DVF_HOME.idsitehsr, weeks, {
      batchId: 'b',
      idsite: DVF_HOME.idsite,
      segmentations: SEGMENTATIONS,
      cells: [
        ...cells({ selector: DVF_DRESSES_NEXT, viewport: 'mobile', sessions: 3, clicks: 3 }),
        ...cells({ selector: DVF_SECTION5, viewport: 'mobile', sessions: 3, clicks: 3 }),
      ],
    });
    expect(verifyTrend(withMobile, plan).ok).toBe(true);
    expect(dvfProofErrors(withMobile).join('; ')).toMatch(/dresses next/);
  });
});

describe('trend seeds', () => {
  it('writes the injected seeds for the run site only, and leaves configured pages alone', async () => {
    const { adapter } = createMemoryAePersistence();
    const other = { idsite: 77, idsitehsr: 1, status: 'active', trendSelectors: ['#x'] };
    await adapter.writeTrendSelectors([{ idsite: 77, idsitehsr: 1, status: 'paused', trendSelectors: ['#kept'] }]);
    const gateway = { query: async () => [] };
    const run = await runTrend({ idsite: DVF_HOME.idsite, windowStart: '2026-09-14', windowEnd: '2026-09-20', seeds: [DVF_HOME, other], segmentations: SEGMENTATIONS, gateway, persistence: adapter });
    expect(run.selectors).toEqual([{ idsitehsr: DVF_HOME.idsitehsr, selectors: DVF_HOME.trendSelectors }]);
    expect(await adapter.readTrendSelectors(DVF_HOME.idsite)).toEqual([DVF_HOME]);
    expect(await adapter.readTrendSelectors(77)).toEqual([{ idsite: 77, idsitehsr: 1, status: 'paused', trendSelectors: ['#kept'] }]);

    expect((await runTrend({ idsite: 77, windowStart: '2026-09-14', windowEnd: '2026-09-20', seeds: [other], segmentations: SEGMENTATIONS, gateway, persistence: adapter })).check.ok).toBe(true);
    expect(await adapter.readTrendSelectors(77)).toEqual([{ idsite: 77, idsitehsr: 1, status: 'paused', trendSelectors: ['#kept'] }]);
  });
});

describe('the partition check', () => {
  it('names a selected segmentation whose values do not add up to the total', () => {
    const channel = shipped('trend', ['traffic_source', 'channel']);
    const visits = [
      ...fanned(cell({ sessions: 4 }), { traffic_source: 'direct', channel: 'direct' }, channel),
      ...fanned(cell({ sessions: 6 }), { traffic_source: 'meta', channel: 'meta_paid' }, channel),
    ];
    const plan = { paths: ['home > pdp'], pages: [], selectorPlan: [], segmentations: channel };
    const rows = journeyRows(['home > pdp'], weeks, { batchId: 'b', idsite: 5795, segmentations: channel, cells: visits });
    expect(verifyTrend(rows, plan).ok).toBe(true);
    const dropped = journeyRows(['home > pdp'], weeks, {
      batchId: 'b', idsite: 5795, segmentations: channel, cells: visits.filter((item) => !(item.segment === 'channel' && item.segmentValue === 'meta_paid')),
    });
    expect(() => verifyTrend(dropped, plan)).toThrow(/channel sessions 4 do not add up to all 10/);
  });
});
