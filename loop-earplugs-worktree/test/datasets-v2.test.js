import { describe, expect, it } from 'vitest';
import { adapter as pageSegmentWeekly } from '../src/adapters/datasets/page-segment-weekly.js';
import { adapter as scrollDecile } from '../src/adapters/datasets/scroll-decile.js';
import { adapter as selectorWeekly } from '../src/adapters/datasets/selector-weekly.js';
import { adapter as rageClicks } from '../src/adapters/datasets/rage-clicks.js';
import { adapter as navNextPage } from '../src/adapters/datasets/nav-next-page.js';
import { adapter as campaignWeekly } from '../src/adapters/datasets/campaign-weekly.js';

/**
 * Phase-3 v2 dataset extensions (plan §10.1) through a fake gateway: one
 * fixture test per changed dataset, following the pattern of
 * prefer-non-home.test.js. Every query label the six datasets can emit is
 * routed here; any new query a dataset adds fails loudly with
 * "unexpected query".
 */

const WINDOW = { windowStart: '2026-09-26', windowEnd: '2026-10-02' };
const WEEK = '2026-09-28';
const HSR = 222;
const logger = { info() {}, warn() {}, error() {} };

let nextVisit = 0;

/**
 * One raw session row as the session-stream queries return it (snake_case,
 * string visits). page-segment-weekly reads its own label; the other
 * datasets read the shared session stream.
 */
function s(over = {}) {
  nextVisit += 1;
  return {
    idvisit: String(nextVisit),
    first_date: WEEK,
    week: WEEK,
    device: 1,
    referer: 1,
    returning: 0,
    entry_hsr: String(HSR),
    country: 'us',
    browser: 'Chrome',
    fp_hash: '1',
    utm_source: '',
    pageviews: 2,
    capped_ms: 20000,
    saw_product: 0,
    saw_atc: 0,
    saw_checkout: 0,
    saw_purchase: 0,
    orders: 0,
    revenue: 0,
    scroll_max: 600,
    landing_pageviews: 1,
    page_capped_ms: 20000,
    viewport_h: 800,
    ...over,
  };
}

/** One raw click row as getClickRows maps it (before the JS mapping). */
function c(over = {}) {
  return {
    idvisit: '1',
    idloghsr: 'pv1',
    selector: '#a',
    week: WEEK,
    date: WEEK,
    server_time: '2026-09-28 10:00:00',
    meta1: '',
    x: 10,
    y: 20,
    time_since_load: 100,
    ...over,
  };
}

/**
 * @param {object} opts
 * @param {object[]} [opts.sessions] rows for the session-stream labels
 * @param {object[]} [opts.clicks] raw click rows
 * @param {object[]} [opts.pageviews] raw pageviews driving the scroll-eff stub
 * @param {object[]} [opts.sequences] pageviews:sequences rows
 * @param {object[]} [opts.urls] urls:site-hsr rows
 * @param {object[]} [opts.tags] session-tags:rows rows
 * @param {object[]} [opts.amElements] selector-weekly:am-elements rows
 * @param {object[]} [opts.elementBindings] element-binding rows
 * @param {object[]} [opts.viewports] viewport:heights rows
 */
function fakeGateway({ sessions = [], clicks = [], pageviews = [], sequences = [], urls = [], tags = [], amElements = [], elementBindings = [], viewports = [] }) {
  /** @type {Array<{sql: string, params: object, label: string}>} */
  const queries = [];
  return {
    queries,
    async query(sql, params, label) {
      queries.push({ sql, params, label });
      switch (label) {
        case 'sessions:entry+scroll':
        case 'sessions:entry':
          return sessions;
        case 'clicks:page':
          return clicks.filter((c) => c.date === params.day);
        case 'scroll-decile:scroll-eff': {
          // Mirror the dataset's SQL: per-session max of
          // greatest(ifNull(scroll_y_max_relative, 0), ifNull(fold_y_relative, 0)).
          const byVisit = new Map();
          for (const pv of pageviews) {
            const eff = Math.max(Number(pv.scroll_y_max_relative ?? 0), Number(pv.fold_y_relative ?? 0));
            const idvisit = String(pv.idvisit);
            byVisit.set(idvisit, Math.max(byVisit.get(idvisit) ?? 0, eff));
          }
          return [...byVisit.entries()].map(([idvisit, scroll_eff]) => ({ idvisit, scroll_eff }));
        }
        case 'pageviews:sequences':
          return sequences;
        case 'urls:site-hsr':
          return urls;
        case 'session-tags:rows':
          return tags.map(({ session_tags, ...row }) => ({ ...row, tag_json: session_tags }));
        case 'viewport:heights':
          return viewports;
        case 'selector-weekly:am-elements':
          return amElements;
        case 'element-binding':
          return elementBindings;
        case 'check:scroll-scale':
          return [{ mx: 500 }];
        case 'check:time-since-load-unit':
          return [{ mn: 50, p50: 500, mx: 20000 }]; // milliseconds
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
      return [{ name: 'visitor_returning' }, { name: 'custom_var_k5' }, { name: 'config_browser_name' }];
    },
  };
}

/**
 * @param {object} gateway
 * @param {Map<string, object>} [datasets]
 */
function makeCtx(gateway, datasets = new Map()) {
  return {
    batchId: 'b1',
    ...WINDOW,
    gateway,
    logger,
    clock: { todayUtc: () => '2026-10-03' },
    datasets,
    batchNotes: new Map(),
  };
}

const PAGE = { idsite: 1, idsitehsr: HSR, url: 'https://x.com/pages/lp', title: 'LP', pageType: 'content' };

/** @param {Array<{dims: object, metrics: object}>} rows */
function row(rows, dims) {
  return rows.find((r) => Object.entries(dims).every(([k, v]) => r.dims[k] === v));
}

describe('page-segment-weekly v2', () => {
  it('provides H01, H02, H23, H06, H07', () => {
    expect(pageSegmentWeekly.provides).toEqual(['H01', 'H02', 'H23', 'H06', 'H07']);
  });

  it('emits browser and dominant viewport_class dims with a bounded viewports CTE', async () => {
    const gateway = fakeGateway({
      sessions: [
        s({ idvisit: '1', browser: 'Chrome' }),
        s({ idvisit: '2', browser: '' }),
        s({ idvisit: '3', browser: 'Safari', entry_hsr: '111' }),
      ],
      viewports: [
        { idvisit: '1', h: 800 },
        { idvisit: '3', h: 1100 },
      ],
    });
    const result = await pageSegmentWeekly.collect(PAGE, makeCtx(gateway));

    const chromeRow = row(result.rows, { browser: 'chrome', viewport_class: 'medium', bot_filter: 'none' });
    expect(chromeRow).toBeDefined();
    expect(chromeRow.metrics.sessions).toBe(1);

    const unknownRow = row(result.rows, { browser: 'unknown', viewport_class: 'unknown', bot_filter: 'none' });
    expect(unknownRow).toBeDefined();
    expect(unknownRow.metrics.sessions).toBe(1);

    // the other-page session never reaches the cells
    expect(result.rows.some((r) => r.dims.browser === 'safari')).toBe(false);
    // both bot filters carry the same grain
    expect(row(result.rows, { browser: 'chrome', viewport_class: 'medium', bot_filter: 'exclude_confirmed' })).toBeDefined();

    const sessionQuery = gateway.queries.find((q) => q.label === 'sessions:entry+scroll');
    expect(sessionQuery.sql).toContain('config_browser_name AS browser');
    const viewportQuery = gateway.queries.find((q) => q.label === 'viewport:heights');
    expect(viewportQuery.sql).toContain('viewports AS');
    expect(viewportQuery.sql).toContain('viewport_h_px IS NOT NULL');
    expect(viewportQuery.sql).toMatch(/server_date BETWEEN \{w0:Date\} AND \{w1:Date\}/);
    expect(viewportQuery.sql).toContain('visit_entry_idaction_url = toString({idsitehsr:UInt64})');
    expect(viewportQuery.params.idsitehsr).toBe(HSR);
  });
});

describe('scroll-decile v2', () => {
  it('keeps H08 and applies the fold floor with a no-scroll share', async () => {
    expect(scrollDecile.provides).toEqual(['H08']);
    const gateway = fakeGateway({
      sessions: [s({ idvisit: '1' }), s({ idvisit: '2' })],
      pageviews: [
        { idvisit: '1', scroll_y_max_relative: 300, fold_y_relative: 500 },
        { idvisit: '2', scroll_y_max_relative: 0, fold_y_relative: null },
      ],
    });
    const result = await scrollDecile.collect(PAGE, makeCtx(gateway));

    const noneRows = result.rows.filter((r) => r.dims.bot_filter === 'none');
    const bin50 = row(noneRows, { depth_bin: 50 });
    // fold floor: scroll 300 with fold 500 reaches bin 50 and maxes there
    expect(bin50.metrics.sessions_reached).toBe(1);
    expect(bin50.metrics.sessions_at_max_bin).toBe(1);
    expect(row(noneRows, { depth_bin: 60 }).metrics.sessions_reached).toBe(0);
    // session 2 never scrolled: bin 0 holds both sessions' max, one no-scroll
    const bin0 = row(noneRows, { depth_bin: 0 });
    expect(bin0.metrics.sessions_reached).toBe(2);
    expect(bin0.metrics.sessions_at_max_bin).toBe(1);
    for (const r of noneRows) {
      expect(r.metrics.entry_sessions).toBe(2);
      expect(r.metrics.sessions_no_scroll).toBe(1);
    }

    const effQuery = gateway.queries.find((q) => q.label === 'scroll-decile:scroll-eff');
    expect(effQuery.sql).toContain(
      'greatest(ifNull(scroll_y_max_relative, 0), ifNull(fold_y_relative, 0))',
    );
  });
});

describe('selector-weekly v2', () => {
  it('provides H09 and H21, binds server_date on udp_am_elements (F11), and emits first-click metrics', async () => {
    expect(selectorWeekly.provides).toEqual(['H09', 'H21']);
    const gateway = fakeGateway({
      sessions: [
        s({ idvisit: '1' }),
        s({ idvisit: '2', orders: 1, revenue: 50 }),
      ],
      clicks: [
        // session 1: #nav is its first click by (server_time, time_since_load)
        c({ idvisit: '1', idloghsr: 'pv1', selector: '#nav', server_time: '2026-09-28 10:00:01', time_since_load: 100 }),
        c({ idvisit: '1', idloghsr: 'pv1', selector: '#buy', server_time: '2026-09-28 10:00:05', time_since_load: 500 }),
        // session 2: first (and only) click is #buy
        c({ idvisit: '2', idloghsr: 'pv2', selector: '#buy', server_time: '2026-09-28 11:00:00', time_since_load: 700 }),
      ],
      amElements: [{ selector: '#buy', label: 'Buy', role: 'button' }],
      elementBindings: [{ selector: '#nav', element_class: 'nav_link', name: 'Nav' }],
    });
    const result = await selectorWeekly.collect(PAGE, makeCtx(gateway));

    const navRow = row(result.rows, { selector: '#nav', bot_filter: 'none' });
    expect(navRow).toBeDefined();
    expect(navRow.dims.element_class).toBe('nav_link');
    expect(navRow.metrics.first_click_sessions).toBe(1);
    expect(navRow.metrics.median_time_to_first_click_ms).toBe(100);

    const buyRow = row(result.rows, { selector: '#buy', bot_filter: 'none' });
    expect(buyRow).toBeDefined();
    expect(buyRow.dims.am_label).toBe('Buy');
    // session 1's first click was #nav, so only session 2 counts for #buy
    expect(buyRow.metrics.clicks).toBe(2);
    expect(buyRow.metrics.clicking_sessions).toBe(2);
    expect(buyRow.metrics.sessions_with_order).toBe(1);
    expect(buyRow.metrics.first_click_sessions).toBe(1);
    expect(buyRow.metrics.median_time_to_first_click_ms).toBe(700);

    // F11: the udp_am_elements lookup binds the batch window
    const amQuery = gateway.queries.find((q) => q.label === 'selector-weekly:am-elements');
    expect(amQuery.sql).toContain('server_date BETWEEN {w0:Date} AND {w1:Date}');
    expect(amQuery.params.w0).toBe(WINDOW.windowStart);
    expect(amQuery.params.w1).toBe(WINDOW.windowEnd);

    // the shared click scan now carries server_time and meta1
    const clickQuery = gateway.queries.find((q) => q.label === 'clicks:page');
    expect(clickQuery.sql).toContain('toString(c.server_time) AS server_time');
    expect(clickQuery.sql).toContain('c.meta1 AS meta1');
    expect(clickQuery.sql).toContain('c.a_y AS y');
    expect(clickQuery.sql).toContain('c.a_x AS x');
    expect(clickQuery.sql).not.toContain('c.y AS y');
  });
});

describe('rage-clicks v2', () => {
  it('keeps H10 and emits both rules as distinct rows, never summed', async () => {
    expect(rageClicks.provides).toEqual(['H10']);
    const gateway = fakeGateway({
      sessions: [
        s({ idvisit: '1', browser: 'Chrome' }),
        s({ idvisit: '2', browser: 'Firefox' }),
        s({ idvisit: '3', browser: '' }),
      ],
      clicks: [
        // session 1: engine rule only (3 clicks within 2 s)
        c({ idvisit: '1', selector: '#rage', time_since_load: 100 }),
        c({ idvisit: '1', selector: '#rage', time_since_load: 900 }),
        c({ idvisit: '1', selector: '#rage', time_since_load: 1500 }),
        // session 2: portal rule only (meta1 = 'rage')
        c({ idvisit: '2', selector: '#rage', time_since_load: 100, meta1: 'rage' }),
        // session 3: both rules independently
        c({ idvisit: '3', selector: '#rage', time_since_load: 100, meta1: 'rage' }),
        c({ idvisit: '3', selector: '#rage', time_since_load: 500 }),
        c({ idvisit: '3', selector: '#rage', time_since_load: 900 }),
      ],
    });
    const result = await rageClicks.collect(PAGE, makeCtx(gateway));

    const rules = [...new Set(result.rows.map((r) => r.dims.rule))].sort();
    expect(rules).toEqual(['engine_3in2s', 'portal_meta1']);

    // each rule counts session 3 on its own; summing rules would double-count
    expect(row(result.rows, { rule: 'engine_3in2s', browser: 'chrome' }).metrics.rage_sessions).toBe(1);
    expect(row(result.rows, { rule: 'engine_3in2s', browser: 'unknown' }).metrics.rage_sessions).toBe(1);
    expect(row(result.rows, { rule: 'engine_3in2s', browser: 'firefox' }).metrics.rage_sessions).toBe(0);
    expect(row(result.rows, { rule: 'portal_meta1', browser: 'firefox' }).metrics.rage_sessions).toBe(1);
    expect(row(result.rows, { rule: 'portal_meta1', browser: 'unknown' }).metrics.rage_sessions).toBe(1);
    expect(row(result.rows, { rule: 'portal_meta1', browser: 'chrome' }).metrics.rage_sessions).toBe(0);
    for (const r of result.rows) {
      expect(r.metrics.rage_sessions).toBeLessThanOrEqual(r.metrics.clicking_sessions);
    }
  });
});

describe('nav-next-page v2', () => {
  it('keeps H11 and emits exit and offsite rows from the pageview sequence', async () => {
    expect(navNextPage.provides).toEqual(['H11']);
    expect(navNextPage.dependsOn).toEqual(['selector-weekly']);
    const gateway = fakeGateway({
      sessions: [s({ idvisit: '1' }), s({ idvisit: '2' }), s({ idvisit: '3' }), s({ idvisit: '4' })],
      clicks: [
        c({ idvisit: '1', idloghsr: 'pv1', selector: '#buy' }),
        c({ idvisit: '2', idloghsr: 'pv3', selector: '#buy' }),
        c({ idvisit: '3', idloghsr: 'pv4', selector: '#buy' }),
        // unclassed selector under the population floor: row must be dropped
        c({ idvisit: '4', idloghsr: 'pv6', selector: '#x' }),
      ],
      sequences: [
        { idvisit: '1', idloghsr: 'pv1', hsr: '222' },
        { idvisit: '1', idloghsr: 'pv2', hsr: '333' },
        { idvisit: '2', idloghsr: 'pv3', hsr: '222' },
        { idvisit: '3', idloghsr: 'pv4', hsr: '222' },
        { idvisit: '3', idloghsr: 'pv5', hsr: '444' },
        { idvisit: '4', idloghsr: 'pv6', hsr: '222' },
        { idvisit: '4', idloghsr: 'pv7', hsr: '333' },
      ],
      urls: [
        { hsr: '222', url: 'https://x.com/pages/lp' },
        { hsr: '333', url: 'https://x.com/products/a' },
        { hsr: '444', url: 'https://other.com/offers' },
      ],
      elementBindings: [{ selector: '#buy', element_class: 'buy_button', name: 'Buy' }],
    });
    const result = await navNextPage.collect(PAGE, makeCtx(gateway));

    const productRow = row(result.rows, { selector: '#buy', element_class: 'buy_button', next_page_type: 'product', bot_filter: 'none' });
    expect(productRow).toBeDefined();
    expect(productRow.metrics.clicking_sessions).toBe(1);

    const exitRow = row(result.rows, { selector: '#buy', element_class: 'buy_button', next_page_type: 'exit', bot_filter: 'none' });
    expect(exitRow).toBeDefined();
    expect(exitRow.metrics.clicking_sessions).toBe(1);

    const offsiteRow = row(result.rows, { selector: '#buy', element_class: 'buy_button', next_page_type: 'offsite', bot_filter: 'none' });
    expect(offsiteRow).toBeDefined();
    expect(offsiteRow.metrics.clicking_sessions).toBe(1);

    // unclassed selector under 20 clicking sessions: every row dropped
    expect(result.rows.some((r) => r.dims.selector === '#x')).toBe(false);
    // each kept row also exists on the exclude_confirmed filter
    expect(result.rows.filter((r) => r.dims.bot_filter === 'exclude_confirmed')).toHaveLength(3);
  });
});

describe('campaign-weekly v2', () => {
  it('provides H03 and H04 and parses utm_content/utm_term from session_tags', async () => {
    expect(campaignWeekly.provides).toEqual(['H03', 'H04']);
    const tagged = Array.from({ length: 40 }, (_, i) =>
      s({ idvisit: String(100 + i), utm_source: '' }),
    );
    const gateway = fakeGateway({
      sessions: [
        ...tagged,
        s({ idvisit: '201', utm_source: '' }),
        s({ idvisit: '202', utm_source: '' }),
      ],
      tags: [
        ...tagged.map((t) => ({
          idvisit: t.idvisit,
          session_tags: JSON.stringify({
            utm_source: 'newsletter',
            utm_medium: 'email',
            utm_campaign: 'fall',
            utm_content: 'hero banner',
            utm_term: 'leather',
          }),
        })),
        { idvisit: '201', session_tags: '{"utm_medium":"cpc"}' },
        { idvisit: '202', session_tags: `{"utm_content":"${'c'.repeat(200)}"}` },
      ],
    });
    const coverage = {
      id: 'campaign-coverage',
      rows: [
        {
          dims: { bot_filter: 'exclude_confirmed' },
          metrics: { entry_sessions: 100, sessions_with_tag: 50 },
        },
      ],
    };
    const result = await campaignWeekly.collect(
      PAGE,
      makeCtx(gateway, new Map([['campaign-coverage', coverage]])),
    );

    const mainRow = row(result.rows, {
      utm_source: 'newsletter',
      utm_medium: 'email',
      utm_campaign: 'fall',
      utm_content: 'hero banner',
      utm_term: 'leather',
      bot_filter: 'none',
    });
    expect(mainRow).toBeDefined();
    expect(mainRow.metrics.sessions).toBe(40);

    // content value truncated to 128 chars
    const longRow = result.rows.find((r) => r.dims.utm_content.length === 128);
    expect(longRow).toBeDefined();
    // missing keys fall back to 'unknown'
    expect(result.rows.some((r) => r.dims.utm_term === 'unknown')).toBe(true);
    // sub-30-session campaigns roll into 'other'
    expect(result.rows.some((r) => r.dims.utm_campaign === 'other')).toBe(true);
    // the session stream now exposes the browser column
    const sessionQuery = gateway.queries.find((q) => q.label === 'sessions:entry');
    expect(sessionQuery.sql).toContain('config_browser_name AS browser');
  });
});
