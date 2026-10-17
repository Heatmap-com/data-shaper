import { describe, expect, it } from 'vitest';
import { adapter as qualifier } from '../src/adapters/qualifiers/prefer-non-home.js';

/**
 * Qualifier tests from IMPLEMENTATION-PLAN.md section 11, through a fake
 * gateway: homepage 2000/10 + content 1200/6 -> content page; content 400
 * against homepage 2000 -> homepage; chosen page under 100 page hits ->
 * skipped_volume; entry id 0 never wins.
 */

const WINDOW = { windowStart: '2026-09-26', windowEnd: '2026-10-02' };
const WEEK = '2026-09-28';
const logger = { info() {}, warn() {}, error() {} };

/**
 * @param {string} entryHsr
 * @param {object} [over]
 */
function s(entryHsr, over = {}) {
  return {
    idvisit: String(Math.floor(Math.random() * 1e12)),
    first_date: WEEK,
    week: WEEK,
    device: 1,
    referer: 1,
    returning: 0,
    entry_hsr: entryHsr,
    country: 'us',
    fp_hash: '1',
    utm_source: '',
    pageviews: 1,
    capped_ms: 10000,
    saw_product: 0,
    saw_atc: 0,
    saw_checkout: 0,
    saw_purchase: 0,
    orders: 0,
    revenue: 0,
    ...over,
  };
}

/**
 * @param {object} opts
 * @param {object[]} opts.sessions rows for the sessions:entry stream
 * @param {object[]} opts.pages site_hsr resolution rows
 * @param {object[]} [opts.fingerprints]
 * @param {object[]} [opts.versions]
 * @param {object[]} [opts.fleet]
 */
function fakeGateway({ sessions, pages, fingerprints = [], versions = [], fleet = [], pageHits = null }) {
  return {
    async query(_sql, params, label) {
      if (label === 'sessions:entry') return sessions;
      if (label === 'pageviews:page-hits') {
        if (pageHits != null) return [{ hits: pageHits }];
        const wanted = new Set(String(params.hsrs ?? '').split(',').filter(Boolean));
        let hits = 0;
        for (const row of sessions) {
          if (wanted.size && !wanted.has(String(row.entry_hsr))) continue;
          hits += Number(row.pageviews ?? 1);
        }
        return [{ hits }];
      }
      if (label === 'site_hsr:resolve-pages') return pages;
      if (label === 'bot:fingerprints') return fingerprints;
      if (label === 'bot:version-shares' || label === 'bot:version-lookback') return versions;
      if (label === 'fleet:max-idsite') return [{ m: 100 }];
      if (label.startsWith('fleet:bot-rule-c')) return fleet;
      throw new Error(`unexpected query: ${label}`);
    },
    async explain() {
      return 'plan';
    },
    async columns() {
      return [];
    },
  };
}

function makeCtx(gateway) {
  return {
    batchId: 'b1',
    ...WINDOW,
    gateway,
    logger,
    clock: { todayUtc: () => '2026-10-03' },
    datasets: new Map(),
    batchNotes: new Map(),
  };
}

const PAGES = [
  { hsr: '111', url: 'https://x.com', title: 'Home' },
  { hsr: '222', url: 'https://x.com/pages/lp', title: 'LP' },
];

/** @param {number} n @param {string} hsr @param {number} withOrders */
function sessionsFor(n, hsr, withOrders = 0) {
  const rows = [];
  for (let i = 0; i < n; i += 1) {
    rows.push(s(hsr, i < withOrders ? { orders: 1, revenue: 50 } : {}));
  }
  return rows;
}

describe('prefer-non-home qualifier', () => {
  it('prefers a content page with half the homepage sessions and orders', async () => {
    const gateway = fakeGateway({
      sessions: [...sessionsFor(2000, '111', 10), ...sessionsFor(1200, '222', 6)],
      pages: PAGES,
    });
    const q = await qualifier.qualify({ idsite: 1, siteName: 'x' }, makeCtx(gateway));
    expect(q.status).toBe('qualified');
    expect(q.url).toBe('https://x.com/pages/lp');
    expect(q.pageType).toBe('content');
    expect(q.entrySessions).toBe(1200);
    expect(q.orders).toBe(6);
    expect(q.evidence.share_of_home).toBeCloseTo(0.6);
  });

  it('falls back to the homepage when the non-home page is under half', async () => {
    const gateway = fakeGateway({
      sessions: [...sessionsFor(2000, '111', 10), ...sessionsFor(400, '222', 6)],
      pages: PAGES,
    });
    const q = await qualifier.qualify({ idsite: 1, siteName: 'x' }, makeCtx(gateway));
    expect(q.status).toBe('qualified');
    expect(q.url).toBe('https://x.com');
    expect(q.pageType).toBe('home');
    expect(q.reason).toBe('homepage');
  });

  it('skipped_volume when the chosen page fails the gate; no homepage substitution', async () => {
    // content is preferred (900 >= half of 1600); 99 hits fails the gate and
    // the homepage is NOT substituted after that failure
    const gateway = fakeGateway({
      sessions: [...sessionsFor(1600, '111', 10), ...sessionsFor(900, '222', 8)],
      pages: PAGES,
      pageHits: 99,
    });
    const q = await qualifier.qualify({ idsite: 1, siteName: 'x' }, makeCtx(gateway));
    expect(q.status).toBe('skipped_volume');
    expect(q.url).toBe('https://x.com/pages/lp');
    expect(q.orders).toBe(8);
    expect(q.reason).toMatch(/gate/);
  });

  it('the homepage faces the same gate when step 6 selected it', async () => {
    const gateway = fakeGateway({
      sessions: sessionsFor(900, '111', 8),
      pages: PAGES,
      pageHits: 99,
    });
    const q = await qualifier.qualify({ idsite: 1, siteName: 'x' }, makeCtx(gateway));
    expect(q.status).toBe('skipped_volume');
    expect(q.url).toBe('https://x.com');
  });

  it('entry id 0 never wins, even with the most sessions and orders', async () => {
    const gateway = fakeGateway({
      sessions: [
        ...sessionsFor(5000, '0', 20),
        ...sessionsFor(2000, '111', 10),
        ...sessionsFor(1200, '222', 6),
      ],
      pages: PAGES,
    });
    const q = await qualifier.qualify({ idsite: 1, siteName: 'x' }, makeCtx(gateway));
    expect(q.status).toBe('qualified');
    expect(q.url).toBe('https://x.com/pages/lp');
    // 5000 id-0 sessions were excluded from every candidate
    expect(q.entrySessions).toBe(1200);
  });

  it('no homepage row: any non-home page with an order is preferred', async () => {
    const gateway = fakeGateway({
      sessions: [...sessionsFor(1200, '222', 5), ...sessionsFor(5000, '333', 0)],
      pages: [
        { hsr: '222', url: 'https://x.com/pages/lp', title: 'LP' },
        { hsr: '333', url: 'https://x.com/collections/all', title: 'All' },
      ],
    });
    const q = await qualifier.qualify({ idsite: 1, siteName: 'x' }, makeCtx(gateway));
    expect(q.status).toBe('qualified');
    expect(q.url).toBe('https://x.com/pages/lp');
  });

  it('skipped_no_page when nothing resolves to a URL', async () => {
    const gateway = fakeGateway({ sessions: sessionsFor(100, '0'), pages: [] });
    const q = await qualifier.qualify({ idsite: 1, siteName: 'x' }, makeCtx(gateway));
    expect(q.status).toBe('skipped_no_page');
  });

  it('stored entry sessions stay exclude_confirmed; 100 hits still qualifies', async () => {
    const fingerprints = [
      {
        week: WEEK,
        country: 'us',
        city: '',
        resolution: '1000x1000',
        browser: 'Chrome',
        version: '120',
        device: '1',
        fp_hash: '777',
        sessions: 500,
        single_pageview_sessions: 500,
        product_viewed_sessions: 0,
        add_to_cart_sessions: 0,
        orders_udp: 0,
      },
    ];
    const gateway = fakeGateway({
      sessions: [
        ...sessionsFor(100, '111').map((r) => ({ ...r, fp_hash: '777' })),
        ...sessionsFor(900, '111', 5),
      ],
      pages: PAGES,
      fingerprints,
    });
    const q = await qualifier.qualify({ idsite: 1, siteName: 'x' }, makeCtx(gateway));
    expect(q.status).toBe('qualified');
    expect(q.entrySessions).toBe(900);
    expect(q.evidence.unfiltered.sessions).toBe(1000);
    expect(q.evidence.hits).toBe(1000);
  });

  it('the safety rule rescues a bot-fingerprint session that converted', async () => {
    const fingerprints = [
      {
        week: WEEK,
        country: 'us',
        city: '',
        resolution: '1000x1000',
        browser: 'Chrome',
        version: '120',
        device: '1',
        fp_hash: '777',
        sessions: 500,
        single_pageview_sessions: 500,
        product_viewed_sessions: 0,
        add_to_cart_sessions: 0,
        orders_udp: 0,
      },
    ];
    const gateway = fakeGateway({
      sessions: [
        ...sessionsFor(100, '111').map((r) => ({ ...r, fp_hash: '777' })),
        ...sessionsFor(100, '111', 5).map((r, i) => (i === 0 ? { ...r, fp_hash: '777' } : r)),
        ...sessionsFor(800, '111', 5),
      ],
      pages: PAGES,
      fingerprints,
    });
    const q = await qualifier.qualify({ idsite: 1, siteName: 'x' }, makeCtx(gateway));
    // 100 flagged; the flagged session with an order is rescued back in.
    // Without the safety rule this would be 899. Hits clear the volume gate.
    expect(q.status).toBe('qualified');
    expect(q.entrySessions).toBe(900);
    expect(q.evidence.unfiltered.sessions).toBe(1000);
    expect(q.orders).toBe(10);
  });

  it('qualifies a page with 100 hits even when sessions and orders miss the old gate', async () => {
    const gateway = fakeGateway({
      sessions: sessionsFor(10, '111', 0),
      pages: PAGES,
      pageHits: 100,
    });
    const q = await qualifier.qualify({ idsite: 1, siteName: 'x' }, makeCtx(gateway));
    expect(q.status).toBe('qualified');
    expect(q.entrySessions).toBe(10);
    expect(q.orders).toBe(0);
    expect(q.evidence.hits).toBe(100);
  });
});
