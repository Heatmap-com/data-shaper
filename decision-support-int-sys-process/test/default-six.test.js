import { describe, expect, it } from 'vitest';
import { adapter as defaultSix } from '../src/adapters/page-selectors/default-six.js';

/**
 * default-six page selector (plan §9.2 stage 1): the qualifier's page as
 * primary, up to two sister pages above the LP floor in the primary's
 * channel mix, and template members for the pdp/collection/cart/home kinds
 * not already selected — capped at opts.maxPages with the priority
 * primary > sisters > template members. Eight candidate pages exercise the
 * ranking, the channel preference, the floor and the truncation.
 */

const WINDOW = { windowStart: '2026-09-26', windowEnd: '2026-10-02' };
const WEEK = '2026-09-28';
const logger = { info() {}, warn() {}, error() {} };

// hsr -> url fixtures; /cart carries the orders/revenue for the stats check
const PAGES = [
  { hsr: '222', url: 'https://x.com/pages/lp', title: 'LP', referer: 2, sessions: 500 }, // primary (content, search)
  { hsr: '333', url: 'https://x.com/cart', title: 'Cart', referer: 2, sessions: 400, orders: 2, revenue: 80 }, // sister (cart, search)
  { hsr: '444', url: 'https://x.com/offers', title: 'Offers', referer: 2, sessions: 350 }, // sister (other, search)
  { hsr: '555', url: 'https://x.com/products/a', title: 'A', referer: 1, sessions: 300 }, // template pdp (direct)
  { hsr: '666', url: 'https://x.com/collections/c', title: 'C', referer: 1, sessions: 200 }, // template collection (direct)
  { hsr: '777', url: 'https://x.com/', title: 'Home', referer: 1, sessions: 150 }, // template home (direct)
  { hsr: '888', url: 'https://x.com/products/b', title: 'B', referer: 1, sessions: 100 }, // pdp kind already covered by 555
  { hsr: '999', url: 'https://x.com/pages/tiny', title: 'Tiny', referer: 2, sessions: 10 }, // below the 30-session floor
];

let nextVisit = 0;

/** Build the session-stream rows for one candidate page. */
function sessionsFor(page) {
  return Array.from({ length: page.sessions }, (_, i) => {
    nextVisit += 1;
    const last = i === page.sessions - 1;
    return {
      idvisit: String(nextVisit),
      first_date: WEEK,
      week: WEEK,
      device: 1,
      referer: page.referer,
      returning: 0,
      entry_hsr: page.hsr,
      country: 'us',
      browser: 'Chrome',
      fp_hash: 'fp1',
      utm_source: '',
      pageviews: 2,
      capped_ms: 20000,
      saw_product: 0,
      saw_atc: 0,
      saw_checkout: 0,
      saw_purchase: 0,
      orders: page.orders && last ? page.orders : 0,
      revenue: page.revenue && last ? page.revenue : 0,
    };
  });
}

function fakeGateway() {
  const sessions = PAGES.flatMap(sessionsFor);
  return {
    async query(sql, params, label) {
      switch (label) {
        case 'sessions:entry':
          return sessions;
        case 'urls:site-hsr-pages':
          return PAGES.map((p) => ({ hsr: p.hsr, url: p.url, title: p.title }));
        case 'bot:fingerprints':
        case 'bot:version-shares':
        case 'bot:version-lookback':
          return [];
        default:
          throw new Error(`unexpected query: ${label}`);
      }
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

const SITE = { idsite: 1, siteName: 'x' };
const QUALIFICATION = {
  status: 'qualified',
  idsitehsr: 222,
  url: 'https://x.com/pages/lp',
  pageType: 'content',
  entrySessions: 500,
  orders: 0,
  revenue: 0,
  evidence: { title: 'LP' },
};

describe('default-six page selector', () => {
  it('selects primary + 2 sisters + template members, capped at 6', async () => {
    const ctx = makeCtx(fakeGateway());
    const selected = await defaultSix.select(SITE, QUALIFICATION, ctx);

    expect(selected).toHaveLength(6);
    expect(selected.map((t) => t.role)).toEqual([
      'primary',
      'sister',
      'sister',
      'template_member',
      'template_member',
      'template_member',
    ]);
    expect(selected.map((t) => t.url)).toEqual([
      'https://x.com/pages/lp',
      'https://x.com/cart',
      'https://x.com/offers',
      'https://x.com/products/a',
      'https://x.com/collections/c',
      'https://x.com/',
    ]);
    expect(selected.map((t) => t.pageType)).toEqual([
      'content',
      'cart',
      'other',
      'product',
      'collection',
      'home',
    ]);

    // the primary is the qualifier's page with the qualification stats
    const primary = selected[0];
    expect(primary.idsitehsr).toBe(222);
    expect(primary.selectionReason).toBe('qualifier choice');
    expect(primary.entrySessions).toBe(500);

    // sister stats come from the batch-window aggregation, not the
    // qualification: /cart keeps its own orders and revenue
    const cart = selected[1];
    expect(cart.entrySessions).toBe(400);
    expect(cart.orders).toBe(2);
    expect(cart.revenue).toBe(80);

    // sisters rank by exclude_confirmed sessions in the primary's channel
    // mix: /products/a has 300 sessions but is direct-dominant, so the two
    // search-dominant pages win the sister slots
    expect(selected[1].url).toBe('https://x.com/cart');
    expect(selected[2].url).toBe('https://x.com/offers');

    // template members fill the missing kinds; /products/b loses to
    // /products/a (lower sessions), cart is already a sister, and the
    // 10-session page never competes
    const pdp = selected.find((t) => t.url === 'https://x.com/products/a');
    expect(pdp.role).toBe('template_member');
    expect(pdp.idsitehsr).toBe(555);
    expect(selected.some((t) => t.idsitehsr === 888)).toBe(false);
    expect(selected.some((t) => t.idsitehsr === 999)).toBe(false);
  });

  it('truncates from the end: primary > sisters > template members', async () => {
    const ctx = makeCtx(fakeGateway());

    const four = await defaultSix.select(SITE, QUALIFICATION, ctx, { maxPages: 4 });
    expect(four.map((t) => t.url)).toEqual([
      'https://x.com/pages/lp',
      'https://x.com/cart',
      'https://x.com/offers',
      'https://x.com/products/a',
    ]);

    const three = await defaultSix.select(SITE, QUALIFICATION, ctx, { maxPages: 3 });
    expect(three.map((t) => t.role)).toEqual(['primary', 'sister', 'sister']);

    const one = await defaultSix.select(SITE, QUALIFICATION, ctx, { maxPages: 1 });
    expect(one.map((t) => t.role)).toEqual(['primary']);
    expect(one[0].idsitehsr).toBe(222);
  });

  it('defaults to six pages when opts are omitted', async () => {
    const ctx = makeCtx(fakeGateway());
    const selected = await defaultSix.select(SITE, QUALIFICATION, ctx);
    expect(selected).toHaveLength(6);
  });
});
