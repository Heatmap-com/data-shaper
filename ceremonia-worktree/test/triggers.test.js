import { describe, expect, it } from 'vitest';
import { createMemoryAePersistence } from '../src/adapters/persistence/memory.js';
import { buildTriggerBatch, collectTriggerWindow } from '../src/triggers/batch.js';
import { resolveDefinitions, getTrigger, listTriggers } from '../src/triggers/definitions.js';
import { PREDICATE_TYPES, chainOutcome, qualifies, showedInterest, superShopper } from '../src/triggers/evaluate.js';
import { assembleSessions } from '../src/triggers/facts.js';
import { queryTriggerTrends } from '../src/triggers/query.js';
import { addDays, mondayOf } from '../src/triggers/time.js';
import { SHIPPED, withSites } from './support/segmentations.js';

const interest = () => getTrigger('showed_interest').predicate;
const purchase = () => getTrigger('abandoned_cart').predicate;
const shopper = () => getTrigger('super_shopper').predicate;

/** @param {object} partial */
function session(partial) {
  return {
    idsite: 3199,
    idvisit: partial.idvisit,
    configId: partial.configId ?? 'visitor-1',
    serverDate: partial.serverDate,
    startedAt: partial.startedAt ?? Date.parse(`${partial.serverDate}T12:00:00Z`),
    device: partial.device ?? 'mobile',
    channel: partial.channel ?? 'campaign',
    source: 'meta',
    medium: 'paid',
    returning: 'new',
    country: 'US',
    landingPage: '/products/a',
    entryTemplate: 'product',
    events: partial.events ?? [],
    orders: partial.orders ?? 0,
    revenue: partial.revenue ?? 0,
    pageviews: partial.pageviews ?? 1,
    clicks: partial.clicks ?? 0,
    scrollPct: partial.scrollPct ?? 0,
    durationSec: partial.durationSec ?? 0,
    productPages: partial.productPages ?? [],
  };
}

describe('showed interest thresholds', () => {
  it('treats every threshold as strictly greater-than', () => {
    const predicate = interest();
    expect(showedInterest(predicate, session({ idvisit: 'a', serverDate: '2026-09-28', pageviews: 3 }))).toBe(false);
    expect(showedInterest(predicate, session({ idvisit: 'b', serverDate: '2026-09-28', pageviews: 4 }))).toBe(true);

    const and = { pageviews: 3, clicks: 4, scrollPct: 51, durationSec: 61 };
    expect(showedInterest(predicate, session({ idvisit: 'c', serverDate: '2026-09-28', ...and }))).toBe(true);
    expect(showedInterest(predicate, session({ idvisit: 'd', serverDate: '2026-09-28', ...and, clicks: 3 }))).toBe(false);
    expect(showedInterest(predicate, session({ idvisit: 'e', serverDate: '2026-09-28', ...and, scrollPct: 50 }))).toBe(false);
    expect(showedInterest(predicate, session({ idvisit: 'f', serverDate: '2026-09-28', ...and, durationSec: 60 }))).toBe(false);
    expect(showedInterest(predicate, session({ idvisit: 'g', serverDate: '2026-09-28', pageviews: 4, clicks: 0 }))).toBe(true);
  });

  it('reads the page count from distinct pages and scroll as a percent of the 0–1000 scale', () => {
    const urls = new Map([
      ['1', 'https://shop.example/products/a'],
      ['2', 'https://shop.example/products/b'],
      ['3', 'https://shop.example/collections/c'],
      ['4', 'https://shop.example/products/d'],
    ]);
    const visit = {
      idvisit: 'p',
      config_id: 'visitor-1',
      server_date: '2026-09-28',
      started_at: '2026-09-28 12:00:00.000000000',
      device: 3,
      referer: 6,
      returning: 0,
      country: 'US',
      entry_hsr: '1',
      utm_source: 'meta',
    };
    const three = assembleSessions({
      visits: [visit],
      pageviews: [
        { idvisit: 'p', hsr: '1', scrollMax: 500, timeOnPageMs: 30000 },
        { idvisit: 'p', hsr: '1', scrollMax: 100, timeOnPageMs: 30000 },
        { idvisit: 'p', hsr: '2', scrollMax: 100, timeOnPageMs: 30000 },
      ],
      urls,
    });
    expect(three[0].pageviews).toBe(2);
    expect(three[0].scrollPct).toBe(50);
    expect(three[0].durationSec).toBe(90);
    expect(three[0].channel).toBe('campaign');
    expect(three[0].device).toBe('mobile');
    expect(showedInterest(interest(), three[0])).toBe(false);

    const four = assembleSessions({
      visits: [visit],
      pageviews: ['1', '2', '3', '4'].map((hsr) => ({ idvisit: 'p', hsr, scrollMax: 0, cappedMs: 0 })),
      urls,
    });
    expect(four[0].pageviews).toBe(4);
    expect(four[0].productPages).toEqual(['1', '2', '4']);
    expect(showedInterest(interest(), four[0])).toBe(true);

    const deep = assembleSessions({
      visits: [visit],
      pageviews: [{ idvisit: 'p', hsr: '1', scrollMax: 510, cappedMs: 61000 }],
      clicks: [{ idvisit: 'p', clicks: 4 }],
      urls,
    });
    expect(deep[0].scrollPct).toBe(51);
    expect(deep[0].durationSec).toBe(61);
    expect(showedInterest(interest(), deep[0])).toBe(true);
  });

  it('rejects a predicate that does not carry its thresholds', () => {
    expect(() => showedInterest({ type: 'session_interest' }, session({ idvisit: 'z', serverDate: '2026-09-28' }))).toThrow(/min_pages/);
  });
});

describe('abandoned cart', () => {
  it('keeps checkout start as intent and an order as a purchase', () => {
    const sessions = [
      session({ idvisit: 'atc', serverDate: '2026-09-28', events: ['add_to_cart'] }),
      session({ idvisit: 'start', serverDate: '2026-09-28', events: ['checkout_started'] }),
      session({ idvisit: 'bought', serverDate: '2026-09-28', events: ['add_to_cart', 'checkout_completed'] }),
      session({ idvisit: 'order', serverDate: '2026-09-28', events: ['add_to_cart'], orders: 1, revenue: 20 }),
    ];
    const batch = buildTriggerBatch({ asOf: '2026-09-28', idsite: 3199, sessions });
    const keys = batch.hits.filter((hit) => hit.triggerKey === 'abandoned_cart').map((hit) => hit.idvisit);
    expect(keys.sort()).toEqual(['atc', 'start']);
    expect(batch.hits.find((hit) => hit.idvisit === 'atc').triggerVersion).toBe(1);
  });
});

describe('super shopper', () => {
  it('requires the rolling window, two sessions, interest, and cart or three products', () => {
    const asOf = '2026-09-28';
    const args = (sessions) => ({
      predicate: shopper(),
      interestPredicate: interest(),
      purchasePredicate: purchase(),
      sessions,
      asOf,
    });
    const edge = addDays(asOf, -14);
    const outside = addDays(asOf, -15);

    expect(superShopper(args([
      session({ idvisit: '1', serverDate: edge, pageviews: 4, events: ['add_to_cart'] }),
      session({ idvisit: '2', serverDate: asOf, pageviews: 1 }),
    ]))).toBe(true);

    expect(superShopper(args([
      session({ idvisit: '1', serverDate: outside, pageviews: 4, events: ['add_to_cart'] }),
      session({ idvisit: '2', serverDate: asOf, pageviews: 1 }),
    ]))).toBe(false);

    expect(superShopper(args([
      session({ idvisit: '1', serverDate: asOf, pageviews: 4, events: ['add_to_cart'] }),
    ]))).toBe(false);

    expect(superShopper(args([
      session({ idvisit: '1', serverDate: edge, pageviews: 4, productPages: ['a', 'b'] }),
      session({ idvisit: '2', serverDate: asOf, pageviews: 1, productPages: ['c'] }),
    ]))).toBe(true);

    expect(superShopper(args([
      session({ idvisit: '1', serverDate: edge, pageviews: 4, productPages: ['a'] }),
      session({ idvisit: '2', serverDate: asOf, pageviews: 1, productPages: ['b'] }),
    ]))).toBe(false);

    const prior = addDays(asOf, -30);
    expect(superShopper(args([
      session({ idvisit: 'old', serverDate: prior, events: ['checkout_completed'] }),
      session({ idvisit: '1', serverDate: edge, pageviews: 4, productPages: ['a'] }),
      session({ idvisit: '2', serverDate: asOf, pageviews: 1, productPages: ['b'] }),
    ]))).toBe(true);

    const tooOld = addDays(asOf, -366);
    expect(superShopper(args([
      session({ idvisit: 'old', serverDate: tooOld, events: ['checkout_completed'] }),
      session({ idvisit: '1', serverDate: edge, pageviews: 4, productPages: ['a'] }),
      session({ idvisit: '2', serverDate: asOf, pageviews: 1, productPages: ['b'] }),
    ]))).toBe(false);
  });

  it('does not treat four pages as interest when the interest threshold moves to 4', () => {
    const tightened = { ...interest(), min_pages: 4 };
    expect(superShopper({
      predicate: shopper(),
      interestPredicate: tightened,
      purchasePredicate: purchase(),
      asOf: '2026-09-28',
      sessions: [
        session({ idvisit: '1', serverDate: '2026-09-20', pageviews: 4, events: ['add_to_cart'] }),
        session({ idvisit: '2', serverDate: '2026-09-28', pageviews: 1 }),
      ],
    })).toBe(false);
  });
});

describe('chains', () => {
  const hitDay = '2026-09-28';
  const sessions = [
    session({ idvisit: 'hit', serverDate: hitDay, events: ['add_to_cart'], startedAt: Date.parse(`${hitDay}T10:00:00Z`) }),
    session({ idvisit: 'back', serverDate: '2026-09-29', startedAt: Date.parse('2026-09-29T10:00:00Z') }),
    session({
      idvisit: 'buy',
      serverDate: '2026-09-30',
      events: ['checkout_completed'],
      revenue: 40,
      startedAt: Date.parse('2026-09-30T11:00:00Z'),
    }),
  ];

  it('follows any trigger and marks recovery only when the predicate asks for it', () => {
    const open = buildTriggerBatch({ asOf: '2026-09-30', idsite: 3199, sessions });
    const cart = open.chains.find((chain) => chain.triggerKey === 'abandoned_cart' && chain.idvisit === 'hit');
    expect(cart.returned).toBe(true);
    expect(cart.sessionsUntilReturn).toBe(1);
    expect(cart.sessionsUntilPurchase).toBe(2);
    expect(cart.purchased).toBe(true);
    expect(cart.revenue).toBe(40);
    expect(cart.secondsToPurchase).toBe(49 * 3600);
    expect(cart.recovered).toBe(true);
    expect(cart.final).toBe(false);

    const interestHit = session({ idvisit: 'look', serverDate: hitDay, pageviews: 4, configId: 'visitor-2' });
    const interestChain = chainOutcome(
      { ...interestHit, triggerKey: 'showed_interest', serverDate: hitDay },
      interest(),
      purchase(),
      [interestHit, session({ idvisit: 'later', serverDate: '2026-09-30', configId: 'visitor-2', events: ['checkout_completed'], revenue: 10 })],
      '2026-09-30',
    );
    expect(interestChain.purchased).toBe(true);
    expect(interestChain.recovered).toBe(false);

    const closed = buildTriggerBatch({ asOf: addDays(hitDay, 14), idsite: 3199, sessions });
    const closedCart = closed.chains.find((chain) => chain.triggerKey === 'abandoned_cart' && chain.idvisit === 'hit');
    expect(closedCart.final).toBe(true);
    expect(closed.hits.filter((hit) => hit.triggerKey === 'abandoned_cart')).toHaveLength(0);
  });

  it('does not chain a blank config id to another blank config id', () => {
    const blank = [
      session({ idvisit: 'a', serverDate: hitDay, events: ['add_to_cart'], configId: '' }),
      session({ idvisit: 'b', serverDate: '2026-09-29', events: ['checkout_completed'], configId: '' }),
    ];
    const batch = buildTriggerBatch({ asOf: hitDay, idsite: 3199, sessions: blank });
    const chain = batch.chains.find((row) => row.triggerKey === 'abandoned_cart' && row.idvisit === 'a');
    expect(chain.returned).toBe(false);
    expect(chain.purchased).toBe(false);
  });

  it('honors a shorter chain window from config', () => {
    const batch = buildTriggerBatch({
      asOf: '2026-09-29',
      idsite: 3199,
      sessions,
      overrides: { abandoned_cart: { chain_window_days: 1 } },
    });
    const chain = batch.chains.find((row) => row.triggerKey === 'abandoned_cart' && row.idvisit === 'hit');
    expect(chain.returned).toBe(true);
    expect(chain.purchased).toBe(false);
    expect(chain.windowDays).toBe(1);
  });

  it('is idempotent for the same day and the same sessions', () => {
    const first = buildTriggerBatch({ asOf: hitDay, idsite: 3199, sessions });
    const second = buildTriggerBatch({ asOf: hitDay, idsite: 3199, sessions });
    expect(second).toEqual(first);
  });

  it('reports one classify progress event per day', () => {
    const seen = [];
    collectTriggerWindow({
      windowStart: '2026-09-01',
      windowEnd: '2026-09-03',
      idsite: 3199,
      sessions: [session({ idvisit: 'a', serverDate: '2026-09-01', events: ['add_to_cart'] })],
      onProgress: (fields) => {
        if (fields.phase === 'classify') seen.push(fields);
      },
    });
    expect(seen.map((row) => row.done)).toEqual([1, 2, 3]);
    expect(seen[2].total).toBe(3);
    expect(seen[2].day).toBe('2026-09-03');
    expect(seen[2].hits).toBeGreaterThan(0);
  });

  it('keeps a chain that closes before the batch ends and still refreshes an open prior hit', () => {
    const early = '2026-09-01';
    const spanSessions = [
      session({ idvisit: 'early', serverDate: early, events: ['add_to_cart'], startedAt: Date.parse(`${early}T10:00:00Z`) }),
      session({
        idvisit: 'early-buy',
        serverDate: '2026-09-03',
        events: ['checkout_completed'],
        revenue: 40,
        startedAt: Date.parse('2026-09-03T10:00:00Z'),
      }),
      session({ idvisit: 'late', serverDate: '2026-09-20', events: ['add_to_cart'], configId: 'visitor-2' }),
      session({ idvisit: 'ancient', serverDate: '2026-08-01', events: ['add_to_cart'], configId: 'visitor-3' }),
    ];
    const span = collectTriggerWindow({
      windowStart: early,
      windowEnd: '2026-09-30',
      idsite: 3199,
      sessions: spanSessions,
    });
    const earlyChain = span.chains.find((chain) => chain.triggerKey === 'abandoned_cart' && chain.idvisit === 'early');
    expect(earlyChain.final).toBe(true);
    expect(earlyChain.purchased).toBe(true);
    expect(earlyChain.revenue).toBe(40);
    const lateChain = span.chains.find((chain) => chain.triggerKey === 'abandoned_cart' && chain.idvisit === 'late');
    expect(lateChain.final).toBe(false);
    expect(lateChain.purchased).toBe(false);
    expect(span.chains.some((chain) => chain.idvisit === 'ancient')).toBe(false);
    expect(span.hits.filter((hit) => hit.triggerKey === 'abandoned_cart').map((hit) => hit.idvisit).sort())
      .toEqual(['early', 'late']);

    const priorDay = '2026-09-20';
    const shortSessions = [
      session({ idvisit: 'prior', serverDate: priorDay, events: ['add_to_cart'], configId: 'visitor-4' }),
      session({ idvisit: 'inside', serverDate: '2026-09-28', events: ['add_to_cart'], configId: 'visitor-5' }),
    ];
    const oneDay = buildTriggerBatch({ asOf: '2026-09-30', idsite: 3199, sessions: shortSessions });
    const short = collectTriggerWindow({
      windowStart: '2026-09-28',
      windowEnd: '2026-09-30',
      idsite: 3199,
      sessions: shortSessions,
    });
    expect(byChain(short.chains)).toEqual(byChain(oneDay.chains));
    expect(short.chains.find((chain) => chain.idvisit === 'prior').final).toBe(false);
  });
});

/** @param {object[]} chains */
function byChain(chains) {
  return [...chains].sort((a, b) => `${a.triggerKey}|${a.serverDate}|${a.idvisit}`.localeCompare(
    `${b.triggerKey}|${b.serverDate}|${b.idvisit}`,
  ));
}

describe('definition versions', () => {
  it('bumps the version when a threshold changes and keeps it on the next identical run', () => {
    const first = resolveDefinitions({ showed_interest: { min_pages: 4 } });
    expect(first.find((row) => row.key === 'showed_interest').version).toBe(2);
    expect(first.find((row) => row.key === 'super_shopper').version).toBe(2);
    expect(first.find((row) => row.key === 'abandoned_cart').version).toBe(1);

    const second = resolveDefinitions({ showed_interest: { min_pages: 4 } }, first);
    expect(second.find((row) => row.key === 'showed_interest').version).toBe(2);

    const third = resolveDefinitions({ showed_interest: { min_pages: 5 } }, second);
    expect(third.find((row) => row.key === 'showed_interest').version).toBe(3);
    expect(third.find((row) => row.key === 'super_shopper').version).toBe(3);
  });

  it('adds a trigger of a known predicate type from config alone', () => {
    const defs = resolveDefinitions({
      loyal_browse: {
        name: 'Loyal browse',
        level: 'session',
        predicate: {
          type: 'session_interest',
          min_pages: 1,
          min_clicks: 0,
          min_scroll_pct: 0,
          min_duration_sec: 0,
          chain_window_days: 7,
        },
      },
    });
    const loyal = defs.find((row) => row.key === 'loyal_browse');
    expect(loyal.version).toBe(1);
    const batch = buildTriggerBatch({
      asOf: '2026-09-28',
      idsite: 3199,
      sessions: [session({ idvisit: 'two', serverDate: '2026-09-28', pageviews: 2 })],
      overrides: {
        loyal_browse: {
          name: 'Loyal browse',
          level: 'session',
          predicate: loyal.predicate,
        },
      },
    });
    expect(batch.hits.some((hit) => hit.triggerKey === 'loyal_browse')).toBe(true);
  });

  it('lists the shipped triggers and their thresholds', () => {
    const listed = listTriggers();
    expect(listed.map((row) => row.key)).toEqual(['abandoned_cart', 'showed_interest', 'super_shopper']);
    expect(getTrigger('showed_interest').predicate).toMatchObject({
      min_pages: 3,
      min_clicks: 3,
      min_scroll_pct: 50,
      min_duration_sec: 60,
    });
    expect(() => getTrigger('missing')).toThrow(/unknown trigger/);
  });
});

describe('week over week', () => {
  it('aligns a partial week to the same weekdays and ignores the rest of the prior week', () => {
    expect(mondayOf('2026-09-30')).toBe('2026-09-28');
    expect(mondayOf('2026-09-24')).toBe('2026-09-21');

    const hits = [
      ...['1', '2', '3', '4'].map((id) => hit('2026-09-21', id)),
      ...Array.from({ length: 100 }, (_, i) => hit('2026-09-24', `thu-${i}`)),
      hit('2026-09-28', 'mon-a', { triggerVersion: 1 }),
      hit('2026-09-28', 'mon-b', { triggerVersion: 2 }),
      hit('2026-09-30', 'wed'),
    ];
    const rows = queryTriggerTrends({
      site_id: 3199,
      trigger_key: 'abandoned_cart',
      date_range: { start: '2026-09-28', end: '2026-09-30' },
      granularity: 'week',
      hits,
      chains: [],
      sessions: [],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].week).toBe('2026-09-28');
    expect(rows[0].alignedDates).toEqual(['2026-09-28', '2026-09-29', '2026-09-30']);
    expect(rows[0].partial).toBe(true);
    expect(rows[0].hits).toBe(3);
    expect(rows[0].wow.hits).toEqual({ abs: -1, pct: -0.25 });
    expect(rows[0].versionChanged).toBe(true);
    expect(rows[0].wow.hitRate.pct).toBe(null);
  });

  it('segments by device and channel together', () => {
    const hits = [
      hit('2026-09-28', 'a', { device: 'mobile', channel: 'campaign' }),
      hit('2026-09-28', 'b', { device: 'desktop', channel: 'search' }),
    ];
    const chains = hits.map((row) => ({
      ...row,
      purchased: row.idvisit === 'a',
      recovered: false,
      revenue: row.idvisit === 'a' ? 40 : 0,
    }));
    const sessions = [
      ...hits,
      { ...hits[0], idvisit: 'extra', serverDate: '2026-09-28' },
    ];
    const rows = queryTriggerTrends({
      idsite: 3199,
      trigger_key: 'abandoned_cart',
      date_range: { start: '2026-09-28', end: '2026-09-28' },
      segment_by: ['device', 'channel'],
      hits,
      chains,
      sessions,
    });
    const mobile = rows.find((row) => row.segment.device === 'mobile');
    expect(mobile.segment).toEqual({ device: 'mobile', channel: 'campaign' });
    expect(mobile.hits).toBe(1);
    expect(mobile.sessions).toBe(2);
    expect(mobile.hitRate).toBe(0.5);
    expect(mobile.conversionRate).toBe(1);
    expect(mobile.revenue).toBe(40);
    expect(mobile.rps).toBe(20);
    expect(rows.find((row) => row.segment.device === 'desktop').hits).toBe(1);
    expect(() => queryTriggerTrends({
      site_id: 3199,
      trigger_key: 'abandoned_cart',
      date_range: { start: '2026-09-28', end: '2026-09-28' },
      segment_by: ['browser'],
      hits,
      sessions,
    })).toThrow(/idvisit/);
    expect(() => queryTriggerTrends({
      site_id: 3199,
      trigger_key: 'abandoned_cart',
      date_range: { start: '2026-09-28', end: '2026-09-28' },
      granularity: 'day',
      hits,
      sessions,
    })).toThrow(/week/);
  });

  it('segments by a declared segmentation, shipped or overridden, and the values sum to the unsegmented row', () => {
    const visit = (idvisit, over) => ({ idsite: 3199, idvisit, server_date: '2026-09-28', started_at: '2026-09-28 10:00:00', returning: 0, ...over });
    const sessions = assembleSessions({
      visits: [
        visit('a', { referer: 1 }),
        visit('b', { referer: 7, referer_name: 'Facebook', utm_medium: 'paid' }),
        visit('c', { referer: 7, referer_name: 'instagram' }),
        visit('d', { referer: 6, utm_medium: 'cpc' }),
      ],
    });
    expect(sessions[1].fields).toMatchObject({ referer_type: 7, referer_name: 'facebook', utm_medium: 'paid', source_or_referrer: 'facebook' });
    const hits = ['a', 'b', 'd'].map((id) => hit('2026-09-28', id));
    const trends = (segmentations, segmentBy = ['segmentation:channel']) => queryTriggerTrends({
      idsite: 3199,
      trigger_key: 'abandoned_cart',
      date_range: { start: '2026-09-28', end: '2026-09-28' },
      segment_by: segmentBy,
      segmentations,
      hits,
      chains: [],
      sessions,
    });
    const counts = (rows) => Object.fromEntries(rows.map((row) => [row.segment['segmentation:channel'], [row.sessions, row.hits]]));
    const [whole] = trends(undefined, []);

    const shipped = counts(trends(SHIPPED.forSite(3199)));
    expect(shipped).toEqual({ direct: [1, 1], meta_paid: [1, 1], meta_untagged: [1, 0], other: [1, 1] });
    const edited = withSites([{
      slug: 'test', idsite: 3199, defaults: {}, declarations: [],
      overrides: { channel: { prepend: [{ value: 'google_paid', when: { all: [{ field: 'referer_type', in: [2, 6] }, { field: 'utm_medium', eq: 'cpc' }] } }] } },
    }]);
    const overridden = counts(trends(edited.forSite(3199)));
    expect(overridden).toEqual({ direct: [1, 1], meta_paid: [1, 1], meta_untagged: [1, 0], google_paid: [1, 1] });
    for (const split of [shipped, overridden]) {
      const values = Object.values(split);
      expect([values.reduce((sum, [n]) => sum + n, 0), values.reduce((sum, [, n]) => sum + n, 0)]).toEqual([whole.sessions, whole.hits]);
    }

    expect(() => trends(SHIPPED.forSite(3199), ['segmentation:return_intent'])).toThrow(/return_intent is computed: it has no JavaScript twin/);
    expect(() => trends(SHIPPED.forSite(3199), ['segmentation:rager'])).toThrow(/rager reads has_rage_click, which trigger sessions do not carry/);
    expect(() => trends(SHIPPED.forSite(3199), ['segmentation:tiktok'])).toThrow(/unknown segmentation "tiktok" \(buyer, channel/);
    expect(() => trends(undefined)).toThrow(/needs the site's segmentations/);
  });
});

describe('persistence', () => {
  it('replaces a hit on a rerun of the same identity', async () => {
    const { adapter } = createMemoryAePersistence();
    const batch = buildTriggerBatch({
      asOf: '2026-09-28',
      idsite: 3199,
      sessions: [session({ idvisit: 'atc', serverDate: '2026-09-28', events: ['add_to_cart'] })],
    });
    const written = {
      definitions: batch.definitions.map((row) => ({ ...row, idsite: 3199 })),
      hits: batch.hits,
      chains: batch.chains,
    };
    await adapter.writeTriggerBatch(written);
    await adapter.writeTriggerBatch(written);
    const hits = await adapter.readTriggerHits({ idsite: 3199, triggerKey: 'abandoned_cart' });
    expect(hits).toHaveLength(1);
    const stored = await adapter.readTriggerDefinitions(3199);
    expect(stored.find((row) => row.key === 'abandoned_cart').version).toBe(1);
  });
});

/** @param {string} serverDate @param {string} idvisit @param {object} [extra] */
function hit(serverDate, idvisit, extra = {}) {
  return {
    idsite: 3199,
    triggerKey: 'abandoned_cart',
    serverDate,
    triggerVersion: extra.triggerVersion ?? 1,
    idvisit,
    configId: `c-${idvisit}`,
    level: 'session',
    device: extra.device ?? 'mobile',
    channel: extra.channel ?? 'campaign',
    source: '',
    medium: '',
    returning: 'new',
    country: 'US',
    landingPage: '/',
    entryTemplate: 'home',
  };
}

describe('qualifies (predicate registry)', () => {
  const definition = (key) => getTrigger(key);
  const day = '2026-10-05';

  it('dispatches each shipped predicate type to its evaluator', () => {
    const cart = session({ idvisit: 1, serverDate: day, events: ['add_to_cart'] });
    const bought = session({ idvisit: 2, serverDate: day, events: ['add_to_cart', 'checkout_completed'] });
    expect(qualifies(definition('abandoned_cart'), cart)).toBe(true);
    expect(qualifies(definition('abandoned_cart'), bought)).toBe(false);

    const browsing = { pageviews: 4 };
    expect(qualifies(definition('showed_interest'), browsing)).toBe(true);
    expect(qualifies(definition('showed_interest'), { pageviews: 3 })).toBe(false);

    const sessions = [
      session({ idvisit: 10, serverDate: addDays(day, -2), events: ['add_to_cart'], pageviews: 5 }),
      session({ idvisit: 11, serverDate: day, pageviews: 1 }),
    ];
    const ctx = { interest: interest(), purchase: purchase(), sessions, asOf: day };
    expect(qualifies(definition('super_shopper'), sessions[1], ctx)).toBe(true);
    expect(qualifies(definition('super_shopper'), sessions[1], { ...ctx, sessions: sessions.slice(1) })).toBe(false);
  });

  it('lists the predicate types and rejects any other', () => {
    expect(PREDICATE_TYPES).toEqual(['session_events', 'session_interest', 'visitor_window']);
    expect(() => qualifies({ predicate: { type: 'page_events' } }, {})).toThrow('unknown predicate type "page_events"');
  });
});
