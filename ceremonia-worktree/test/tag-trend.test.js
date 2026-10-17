import { describe, expect, it } from 'vitest';
import { adapter as selector } from '../src/adapters/session-tag-selectors/traffic-variance.js';
import { groupSpread, normalQuantile, wilsonHilferty } from '../src/enrichment/tag-stats.js';
import {
  NONE_VALUE,
  OTHER_VALUE,
  tagPairs,
  tagTrendRows,
  verifyTagTrend,
} from '../src/enrichment/tag-trend-aggregate.js';
import { planGroups } from '../src/enrichment/segmentation-sql.js';
import {
  PAIR_SEPARATOR,
  tagInventorySql,
  tagTrendAggregateSql,
  tagValueStatsSql,
} from '../src/enrichment/tag-trend-sql.js';
import { selectionRows } from '../src/enrichment/tag-trend-run.js';
import { queryBoundGaps } from '../src/governance/query-bounds.js';
import { fanned, shipped } from './support/segmentations.js';

const TAG_SEGMENTATIONS = shipped('tagTrend');
const TAG_GROUP = planGroups(TAG_SEGMENTATIONS)[0];

/**
 * A value whose sessions earn `rps` on average, from `orders` orders of
 * equal size. Squared sums follow from that shape.
 */
function value(key, name, sessions, orders, rps) {
  const revenue = sessions * rps;
  const aov = orders > 0 ? revenue / orders : 0;
  return {
    key,
    value: name,
    sessions,
    buyers: orders,
    orders,
    revenue,
    visitRevenueSq: orders * aov * aov,
    orderRevenueSq: orders * aov * aov,
  };
}

describe('spread statistics', () => {
  it('inverts the normal CDF and scores a chi-square', () => {
    expect(normalQuantile(0.95)).toBeCloseTo(1.6449, 3);
    expect(normalQuantile(0.0025)).toBeCloseTo(-2.807, 2);
    expect(normalQuantile(0.5)).toBeCloseTo(0, 6);
    expect(wilsonHilferty(18.307, 10)).toBeCloseTo(1.645, 2);
  });

  it('separates groups that earn differently from groups that earn alike', () => {
    const apart = groupSpread([
      { n: 5000, sum: 5000 * 2, sumSq: 50 * 200 ** 2 },
      { n: 5000, sum: 5000 * 12, sumSq: 300 * 200 ** 2 },
    ]);
    expect(apart.z).toBeGreaterThan(3);
    expect(apart.spread).toBeGreaterThan(0.5);

    const alike = groupSpread([
      { n: 5000, sum: 5000 * 5, sumSq: 125 * 200 ** 2 },
      { n: 5000, sum: 5000 * 5.1, sumSq: 127.5 * 200 ** 2 },
    ]);
    expect(alike.z).toBeLessThan(1);
    expect(alike.spread).toBeLessThan(0.05);
  });

  it('returns zero for one group or no revenue', () => {
    expect(groupSpread([{ n: 100, sum: 50, sumSq: 2500 }]).z).toBe(0);
    expect(groupSpread([{ n: 100, sum: 0, sumSq: 0 }, { n: 100, sum: 0, sumSq: 0 }]).z).toBe(0);
  });
});

describe('traffic-variance selector', () => {
  it('keeps traffic keys and drops identities, clicks, products, and identifiers by name and shape', () => {
    const verdicts = selector.candidates([
      { key: 'utm_source', visits: 80000, distinctValues: 70 },
      { key: 'tw_medium', visits: 20000, distinctValues: 3 },
      { key: 'campaign_id', visits: 30000, distinctValues: 16 },
      { key: 'ad_id', visits: 30000, distinctValues: 170 },
      { key: 'tw_profile_id', visits: 22000, distinctValues: 10800 },
      { key: 'gclid', visits: 5000, distinctValues: 5000 },
      { key: 'variant', visits: 8000, distinctValues: 2800 },
      { key: 'utm_term', visits: 4000, distinctValues: 3900 },
      { key: 'utm_content', visits: 150, distinctValues: 10 },
    ]);
    const status = Object.fromEntries(verdicts.map((row) => [row.key, `${row.status}:${row.family}`]));
    expect(status).toEqual({
      utm_source: 'candidate:source',
      tw_medium: 'candidate:medium',
      campaign_id: 'candidate:campaign',
      ad_id: 'candidate:ad',
      tw_profile_id: 'rejected:identity',
      gclid: 'rejected:click_id',
      variant: 'rejected:other',
      utm_term: 'rejected:term',
      utm_content: 'rejected:content',
    });
    expect(verdicts.find((row) => row.key === 'utm_term').reason).toMatch(/identifier/);
  });

  it('selects a key whose values earn differently and rejects one whose values earn alike', () => {
    const candidates = selector.candidates([
      { key: 'utm_source', visits: 30000, distinctValues: 5 },
      { key: 'utm_medium', visits: 30000, distinctValues: 3 },
    ]);
    const [source, medium] = selector.select({
      candidates,
      sessions: 60000,
      values: [
        value('utm_source', 'facebook', 15000, 60, 2),
        value('utm_source', 'klaviyo', 10000, 120, 6),
        value('utm_source', 'ran', 5000, 100, 14),
        value('utm_source', 'tiny', 40, 1, 20),
        value('utm_medium', 'paid', 15000, 150, 5),
        value('utm_medium', 'email', 15000, 152, 5.05),
      ],
    });
    expect(source.status).toBe('selected');
    expect(source.trendValues).toEqual(['facebook', 'klaviyo', 'ran']);
    expect(source.reason).toMatch(/RPS z/);
    expect(medium.status).toBe('rejected');
    expect(medium.reason).toMatch(/earn alike/);
  });

  it('rejects a key with one readable value', () => {
    const candidates = selector.candidates([{ key: 'tw_source', visits: 5000, distinctValues: 2 }]);
    const [row] = selector.select({
      candidates,
      sessions: 5000,
      values: [value('tw_source', 'klaviyo', 4950, 50, 5), value('tw_source', 'x', 50, 0, 0)],
    });
    expect(row.status).toBe('rejected');
    expect(row.reason).toMatch(/1 value/);
  });

  it('writes a selection row per verdict', () => {
    const rows = selectionRows(
      [{ key: 'utm_source', family: 'source', status: 'selected', reason: 'RPS', taggedSessions: 10, distinctValues: 2, rps: { z: 3, spread: 0.5 }, aov: null, trendValues: ['a'], values: [] }],
      { batchId: 'b', idsite: 5795, windowStart: '2026-09-14', windowEnd: '2026-10-09', selector },
    );
    expect(rows[0]).toMatchObject({ tagKey: 'utm_source', adapterId: 'traffic-variance', status: 'selected', rpsZ: 3, aovZ: null, trendValues: ['a'] });
  });
});

describe('tag trend rows', () => {
  const selection = [{ tagKey: 'utm_source', family: 'source', trendValues: ['klaviyo', 'other'] }];

  /** One visit set as fan-out cells, one value of each shipped tag-trend segmentation. */
  function cell(overrides) {
    const { traffic = 'campaign', returning = 'returning', buyer = 'non_buyer', rager = 'non_rager', intent = 'open_cart', ...rest } = overrides;
    return fanned(measures(rest), { traffic_source: traffic, returning, buyer, rager, return_intent: intent }, TAG_SEGMENTATIONS);
  }

  function measures(overrides) {
    return {
      week: '2026-09-14',
      viewport: 'mobile',
      tagKey: 'utm_source',
      tagValue: 'klaviyo',
      sessions: 10,
      buyers: 0,
      orders: 0,
      revenue: 0,
      clicks: 0,
      progressed: 1,
      ...overrides,
    };
  }

  it('keeps a value named like a rollup bucket out of the selected pairs', () => {
    expect(tagPairs(selection)).toEqual([`utm_source${PAIR_SEPARATOR}klaviyo`]);
  });

  it('writes every value, other, and none, and each segmentation partitions the total', () => {
    const cells = [
      ...cell({}),
      ...cell({ intent: 'new', returning: 'new', viewport: 'desktop', sessions: 30, buyers: 1, orders: 1, revenue: 500, buyer: 'buyer' }),
      ...cell({ tagValue: OTHER_VALUE, intent: 'prior_high_intent', sessions: 5 }),
      ...cell({ tagValue: NONE_VALUE, intent: 'new', returning: 'new', traffic: 'direct', sessions: 55 }),
    ];
    const rows = tagTrendRows(selection, ['2026-09-14'], { batchId: 'b', idsite: 5795, cells, segmentations: TAG_SEGMENTATIONS });
    const segments = 1 + TAG_SEGMENTATIONS.reduce((sum, seg) => sum + seg.values.length, 0);
    expect(rows).toHaveLength(3 * 4 * segments);
    const klaviyo = rows.filter((row) => row.tagValue === 'klaviyo' && row.viewportType === 'all');
    const total = klaviyo.find((row) => row.segment === 'all');
    expect(total).toMatchObject({ sessions: 40, orders: 1, revenue: 500 });
    const intent = Object.fromEntries(klaviyo.filter((row) => row.segment === 'return_intent').map((row) => [row.segmentValue, row.sessions]));
    expect(Object.keys(intent)).toEqual(TAG_SEGMENTATIONS.find((seg) => seg.id === 'return_intent').values);
    expect(intent).toMatchObject({ open_cart: 10, new: 30, prior_buyer: 0 });
    expect(verifyTagTrend(rows, selection, 100, TAG_SEGMENTATIONS)).toMatchObject({ ok: true, keys: 1 });
    expect(() => verifyTagTrend(rows, selection, 101, TAG_SEGMENTATIONS)).toThrow(/expected 101/);
    const partial = rows.filter((row) => !(row.segment === 'rager' && row.segmentValue === 'non_rager' && row.tagValue === 'klaviyo'));
    expect(() => verifyTagTrend(partial, selection, 100, TAG_SEGMENTATIONS)).toThrow(/utm_source=klaviyo rager sessions 0 do not add up to 40/);
  });
});

describe('tag trend SQL', () => {
  it('bounds every fact table by idsite and date', () => {
    for (const sql of [tagInventorySql(), tagValueStatsSql(), tagTrendAggregateSql(TAG_GROUP)]) {
      expect(queryBoundGaps(sql)).toEqual([]);
    }
  });

  it('reads history from the lookback start and the window from w0', () => {
    const sql = tagTrendAggregateSql(TAG_GROUP);
    expect(sql).toContain('BETWEEN {p0:Date} AND {w1:Date}');
    expect(sql).toContain('FROM default.udp_session_tags');
    expect(sql).toMatch(/'open_cart'/);
    expect(sql).not.toContain('{idsitehsr');
  });

  it('reads no history when return_intent is not selected', () => {
    const sql = tagTrendAggregateSql(planGroups(shipped('tagTrend', ['traffic_source', 'buyer']))[0]);
    expect(sql).not.toMatch(/\{p0:Date\}|history AS|ragers AS/);
    expect(queryBoundGaps(sql)).toEqual([]);
  });
});
