import { describe, expect, it } from 'vitest';
import { aboveFoldShare, adapter } from '../src/adapters/datasets/strategy-triggers.js';

/**
 * Trigger tests from IMPLEMENTATION-PLAN.md section 11:
 * - mobile RPS at 0.3x desktop -> rule 9 triggered
 * - the same with 20 desktop sessions -> below_floor
 * - missing scroll unit -> rule 2 blocked
 * - two bundle tiles, 136 vs 43 clicking sessions -> rule 5 triggered
 */

const WEEK = '2026-09-28';

/**
 * @param {object} dims
 * @param {object} metrics
 */
function seg(dims, metrics) {
  return {
    dims: { week: WEEK, device: 'desktop', referer: 'search', returning: 'new', returning_era: 'post_2026_09_07', bot_filter: 'exclude_confirmed', ...dims },
    metrics: {
      sessions: 0,
      single_pageview_sessions: 0,
      orders_udp: 0,
      revenue_udp: 0,
      sessions_scroll_ge_25pct: 0,
      sessions_scroll_ge_70pct: 0,
      ...metrics,
    },
  };
}

function makeCtx(datasets) {
  return {
    batchId: 'b1',
    windowStart: '2026-09-26',
    windowEnd: '2026-10-02',
    gateway: null,
    logger: { info() {}, warn() {}, error() {} },
    clock: { todayUtc: () => '2026-10-03' },
    datasets,
    batchNotes: new Map(),
  };
}

const PAGE = {
  idsite: 1,
  siteName: 'x',
  idsitehsr: 99,
  url: 'https://x.com/pages/lp',
  pageTitle: 'LP',
  pageType: 'content',
  qualified: { entrySessions: 1500, orders: 10, revenue: 1000 },
  unfiltered: { sessions: 1550, orders: 10, revenue: 1000 },
  botSessionsExcluded: 50,
};

/**
 * @param {object} opts
 * @param {Array} opts.segments
 * @param {boolean} [opts.scaleConfirmed]
 * @param {Array} [opts.selectors]
 */
function datasetsWith({ segments, scaleConfirmed = true, selectors = [] }) {
  return new Map([
    ['page-segment-weekly', { id: 'page-segment-weekly', rows: segments, notes: { scroll_scale_confirmed: scaleConfirmed } }],
    ['entry-by-channel', { id: 'entry-by-channel', rows: [] }],
    ['order-value-hist', { id: 'order-value-hist', rows: [] }],
    ['page-country', { id: 'page-country', rows: [] }],
    ['scroll-decile', { id: 'scroll-decile', rows: [] }],
    ['selector-weekly', { id: 'selector-weekly', rows: selectors }],
    ['rage-clicks', { id: 'rage-clicks', rows: [], notes: {} }],
    ['nav-next-page', { id: 'nav-next-page', rows: [], notes: {} }],
    ['campaign-coverage', { id: 'campaign-coverage', rows: [] }],
    ['campaign-weekly', { id: 'campaign-weekly', rows: [] }],
    ['line-items', { id: 'line-items', rows: [] }],
    ['coverage', { id: 'coverage', rows: [] }],
  ]);
}

function ruleState(result, n) {
  return result.notes.strategy_rule_results[n].state;
}

describe('strategy-triggers', () => {
  it('rule 9 triggers when mobile RPS is 0.3x desktop', async () => {
    const segments = [
      seg({ device: 'desktop' }, { sessions: 1000, revenue_udp: 900, orders_udp: 9 }),
      seg({ device: 'mobile' }, { sessions: 500, revenue_udp: 135, orders_udp: 3 }),
    ];
    const result = await adapter.collect(PAGE, makeCtx(datasetsWith({ segments })));
    expect(ruleState(result, 9)).toBe('triggered');
    expect(result.analysis.mobileToDesktopRps).toBeCloseTo(0.3, 3);
    expect(result.analysis.mobileRps).toBeCloseTo(0.27, 2);
    expect(result.analysis.desktopRps).toBeCloseTo(0.9, 2);
    const h1 = result.rows.find((r) => r.dims.strategy_id === 'H1');
    expect(h1.metrics.state).toBe('triggered');
    expect(result.analysis.strategiesTriggered).toBeGreaterThanOrEqual(1);
  });

  it('rule 9 is below_floor with 20 desktop sessions', async () => {
    const segments = [
      seg({ device: 'desktop' }, { sessions: 20, revenue_udp: 18, orders_udp: 1 }),
      seg({ device: 'mobile' }, { sessions: 500, revenue_udp: 2.7, orders_udp: 1 }),
    ];
    const result = await adapter.collect(PAGE, makeCtx(datasetsWith({ segments })));
    expect(ruleState(result, 9)).toBe('below_floor');
    const h1 = result.rows.find((r) => r.dims.strategy_id === 'H1');
    expect(h1.metrics.state).toBe('below_floor');
  });

  it('rule 2 is blocked when the scroll unit is not confirmed', async () => {
    const segments = [seg({}, { sessions: 1000, sessions_scroll_ge_25pct: 100, revenue_udp: 900, orders_udp: 9 })];
    const result = await adapter.collect(PAGE, makeCtx(datasetsWith({ segments, scaleConfirmed: false })));
    expect(ruleState(result, 2)).toBe('blocked');
    const b1 = result.rows.find((r) => r.dims.strategy_id === 'B1');
    expect(b1.metrics.state).toBe('blocked');
  });

  it('rule 2 triggers when under 30% reach 25% depth', async () => {
    const segments = [seg({}, { sessions: 1000, sessions_scroll_ge_25pct: 100, revenue_udp: 900, orders_udp: 9 })];
    const result = await adapter.collect(PAGE, makeCtx(datasetsWith({ segments })));
    expect(ruleState(result, 2)).toBe('triggered');
    expect(result.analysis.scrollReach25).toBeCloseTo(0.1, 3);
  });

  it('rule 5 triggers on two same-class bundle tiles with a click-rate gap', async () => {
    const segments = [seg({}, { sessions: 19609, revenue_udp: 2000, orders_udp: 200 })];
    const sel = (selector, clicks, clickingSessions, orders) => ({
      dims: {
        week: WEEK,
        selector,
        device: 'desktop',
        element_class: 'bundle_product_add',
        element_id: `id-${selector}`,
        bot_filter: 'exclude_confirmed',
      },
      metrics: {
        clicks,
        clicking_sessions: clickingSessions,
        sessions_with_order: orders,
        revenue_udp: orders * 50,
        entry_sessions: 19609,
        median_y: 400,
      },
    });
    const selectors = [sel('tile-red', 150, 136, 15), sel('tile-no6', 50, 43, 4)];
    const result = await adapter.collect(PAGE, makeCtx(datasetsWith({ segments, selectors })));
    expect(ruleState(result, 5)).toBe('triggered');
    for (const id of ['D1', 'F1', 'F2']) {
      expect(result.rows.find((r) => r.dims.strategy_id === id).metrics.state).toBe('triggered');
    }
    // every rule result is recorded for the audit
    expect(result.notes.strategy_rule_results[5].detail).toMatch(/bundle_product_add/);
  });

  it('rule 5 is blocked when no element classes are available', async () => {
    const segments = [seg({}, { sessions: 19609, revenue_udp: 2000, orders_udp: 200 })];
    const selectors = [
      {
        dims: { week: WEEK, selector: 'tile-red', device: 'desktop', element_class: '', bot_filter: 'exclude_confirmed' },
        metrics: { clicks: 150, clicking_sessions: 136, sessions_with_order: 15, revenue_udp: 750, entry_sessions: 19609 },
      },
    ];
    const result = await adapter.collect(PAGE, makeCtx(datasetsWith({ segments, selectors })));
    expect(ruleState(result, 5)).toBe('blocked');
  });

  it('rule 14 reads bunching just below a round threshold; the open bucket is not bunching', async () => {
    const segments = [seg({}, { sessions: 19609, revenue_udp: 2000, orders_udp: 200 })];
    const hist = (bucket, orders) => ({
      dims: { bot_filter: 'exclude_confirmed', bucket },
      metrics: { orders, revenue: orders * 95 },
    });
    const withClosedModal = datasetsWith({ segments });
    withClosedModal.set('order-value-hist', {
      id: 'order-value-hist',
      rows: [hist('90-100', 12), hist('200+', 3), hist('20-30', 2)],
    });
    const closed = await adapter.collect(PAGE, makeCtx(withClosedModal));
    expect(ruleState(closed, 14)).toBe('triggered');
    expect(closed.notes.strategy_rule_results[14].value).toBe('90-100');

    const withOpenModal = datasetsWith({ segments });
    withOpenModal.set('order-value-hist', {
      id: 'order-value-hist',
      rows: [hist('200+', 12), hist('90-100', 3)],
    });
    const open = await adapter.collect(PAGE, makeCtx(withOpenModal));
    expect(ruleState(open, 14)).toBe('silent');
  });

  it('the analysis patch carries the atomic columns and the state counts add up', async () => {
    const segments = [
      seg({ device: 'desktop' }, { sessions: 1000, revenue_udp: 900, orders_udp: 9, single_pageview_sessions: 400 }),
      seg({ device: 'mobile' }, { sessions: 500, revenue_udp: 135, orders_udp: 3 }),
    ];
    const result = await adapter.collect(PAGE, makeCtx(datasetsWith({ segments })));
    const a = result.analysis;
    expect(a.rps).toBeCloseTo((900 + 135) / 1500, 4);
    expect(a.singlePageviewShare).toBeCloseTo(400 / 1500, 4);
    const total = a.strategiesTriggered + a.strategiesBelowFloor + a.strategiesBlocked + a.strategiesSilent;
    expect(total).toBe(Object.keys(result.notes.strategies).length);
    expect(result.rows).toHaveLength(total);
  });

  it('rules 15-18 promote a class leader that sits below a weaker sibling', async () => {
    const segments = [seg({}, { sessions: 2000, revenue_udp: 2000, orders_udp: 20 })];
    const tile = (selector, element_class, orders, y, clicking = 40) => ({
      dims: { week: WEEK, selector, device: 'desktop', element_class, bot_filter: 'exclude_confirmed' },
      metrics: {
        clicks: clicking,
        clicking_sessions: clicking,
        sessions_with_order: orders,
        revenue_udp: orders * 80,
        entry_sessions: 2000,
        median_y: y,
      },
    });
    const selectors = [
      tile('.hero-product', 'product_tile', 2, 80),
      tile('.buried-product', 'product_tile', 12, 700),
      tile('.faq-shipping', 'faq_item', 1, 200),
      tile('.faq-returns', 'faq_item', 8, 900),
      tile('.nav-shop', 'nav_link', 2, 20, 80),
      tile('.nav-sale', 'nav_link', 10, 20, 20),
    ];
    const result = await adapter.collect(PAGE, makeCtx(datasetsWith({ segments, selectors })));
    expect(ruleState(result, 15)).toBe('triggered');
    expect(ruleState(result, 16)).toBe('triggered');
    expect(ruleState(result, 17)).toBe('triggered');
    expect(ruleState(result, 18)).toBe('triggered');
    expect(result.rows.find((r) => r.dims.strategy_id === 'P1').metrics.state).toBe('triggered');
    expect(result.rows.find((r) => r.dims.strategy_id === 'P2').metrics.state).toBe('triggered');
    expect(result.rows.find((r) => r.dims.strategy_id === 'P3').metrics.state).toBe('triggered');
    expect(result.rows.find((r) => r.dims.strategy_id === 'P4').metrics.state).toBe('triggered');
  });

  it('rule 4 counts a hero above the fold when the viewport is taller than its top', async () => {
    const segments = [seg({}, { sessions: 2000, revenue_udp: 2000, orders_udp: 20 })];
    const binding = {
      dims: { selector: 'main a.hero', element_class: 'hero_cta' },
      metrics: { name: 'Hero CTA' },
    };
    const render = (device, y) => ({
      dims: { device_class: device, node_kind: 'element', selector: 'main a.hero' },
      metrics: { y },
    });
    const viewports = [
      { device_type: 1, h: 900, sessions: 40 },
      { device_type: 1, h: 500, sessions: 60 },
      { device_type: 3, h: 700, sessions: 50 },
    ];
    const ctx = makeCtx(datasetsWith({ segments }));
    ctx.datasets.set('element-binding', { id: 'element-binding', rows: [binding] });
    ctx.datasets.set('render-snapshot', { id: 'render-snapshot', rows: [render('desktop', 600), render('mobile', 80)] });
    ctx.gateway = { async query() { return viewports; } };

    const buried = await adapter.collect(PAGE, ctx);
    expect(ruleState(buried, 4)).toBe('triggered');
    expect(buried.rows.find((r) => r.dims.strategy_id === 'B3').metrics.detail).toContain('60.0%');

    ctx.gateway = { async query() { return [{ device_type: 1, h: 900, sessions: 100 }]; } };
    ctx.datasets.set('render-snapshot', { id: 'render-snapshot', rows: [render('desktop', 76)] });
    const visible = await adapter.collect(PAGE, ctx);
    expect(ruleState(visible, 4)).toBe('silent');
    expect(aboveFoldShare([{ device: 'desktop', y: 76 }], [{ device: 'desktop', h: 900, sessions: 10 }]).share).toBe(1);
  });

  it('rules 15 and 17 use a 1.25x order-rate bar', async () => {
    const segments = [seg({}, { sessions: 2000, revenue_udp: 2000, orders_udp: 20 })];
    const tile = (selector, element_class, orders, y, clicking = 32) => ({
      dims: { week: WEEK, selector, device: 'desktop', element_class, bot_filter: 'exclude_confirmed' },
      metrics: {
        clicks: clicking,
        clicking_sessions: clicking,
        sessions_with_order: orders,
        revenue_udp: orders * 80,
        entry_sessions: 2000,
        median_y: y,
      },
    });
    const atBar = await adapter.collect(PAGE, makeCtx(datasetsWith({
      segments,
      selectors: [
        tile('.above', 'product_tile', 4, 100),
        tile('.below', 'product_tile', 5, 200),
        tile('.nav-busy', 'nav_link', 4, 20, 80),
        tile('.nav-better', 'nav_link', 5, 40, 32),
      ],
    })));
    expect(ruleState(atBar, 15)).toBe('triggered');
    expect(ruleState(atBar, 17)).toBe('triggered');

    const underBar = await adapter.collect(PAGE, makeCtx(datasetsWith({
      segments,
      selectors: [
        tile('.above', 'product_tile', 5, 100),
        tile('.below', 'product_tile', 6, 200),
        tile('.nav-busy', 'nav_link', 10, 20, 80),
        tile('.nav-better', 'nav_link', 6, 40, 40),
      ],
    })));
    expect(ruleState(underBar, 15)).toBe('silent');
    expect(ruleState(underBar, 17)).toBe('silent');
  });

  it('promotion rules are blocked when a class has fewer than two named members', async () => {
    const segments = [seg({}, { sessions: 2000, revenue_udp: 2000, orders_udp: 20 })];
    const selectors = [
      {
        dims: { week: WEEK, selector: '.only-faq', device: 'desktop', element_class: 'faq_item', bot_filter: 'exclude_confirmed' },
        metrics: { clicks: 40, clicking_sessions: 40, sessions_with_order: 8, revenue_udp: 400, entry_sessions: 2000, median_y: 800 },
      },
    ];
    const result = await adapter.collect(PAGE, makeCtx(datasetsWith({ segments, selectors })));
    expect(ruleState(result, 16)).toBe('blocked');
    expect(result.rows.find((r) => r.dims.strategy_id === 'P2').metrics.state).toBe('blocked');
  });
});
