import { describe, expect, it } from 'vitest';
import { loadCatalog } from '../src/catalog/index.js';
import { TAXONOMY_VERSION } from '../src/domain/taxonomy.js';
import { adapter as strategyTriggers } from '../src/adapters/datasets/strategy-triggers.js';
import { adapter as cardsLp } from '../src/adapters/datasets/cards-lp.js';

/**
 * LP parity (plan §13 lp-parity.test.js): on the v1 fixtures from
 * strategy-triggers.test.js, cards-lp over a requirement-status fixture that
 * marks every LP requirement available produces the same verdicts and
 * metrics as v1 strategy-triggers. Mapping (plan §9.4 G6, LP rollup rules):
 * triggered -> verdict 'include' / trigger_state 'triggered';
 * silent -> 'silent'; below_floor -> verdict 'conditional' /
 * trigger_state 'below_floor'; blocked -> verdict 'blocked';
 * metric/value/threshold are copied. A card with a missing requirement is
 * conditional with trigger_evaluated 0 — never silent.
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

/**
 * The strategy-triggers fixtures from test/strategy-triggers.test.js.
 * @param {object} opts
 * @param {Array} opts.segments
 * @param {boolean} [opts.scaleConfirmed]
 * @param {Array} [opts.selectors]
 * @param {Array} [opts.hist]
 */
function datasetsWith({ segments, scaleConfirmed = true, selectors = [], hist = null }) {
  return new Map([
    ['page-segment-weekly', { id: 'page-segment-weekly', rows: segments, notes: { scroll_scale_confirmed: scaleConfirmed } }],
    ['entry-by-channel', { id: 'entry-by-channel', rows: [] }],
    ['order-value-hist', { id: 'order-value-hist', rows: hist ?? [] }],
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

function makeTriggersCtx(datasets) {
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
 * The cards-lp context: requirement-status marks every registry key
 * available unless overridden, and the strategy-triggers dataset carries
 * the v1 rows just collected. The Phase 5 gate inputs ride along: a
 * descriptor-snapshot dataset with current page fields (§9.4 G1 — without
 * it every card stops at 'no descriptor snapshot') and a capture-status
 * gateway stub reporting a complete capture on the current taxonomy (G2).
 * @param {object} triggerResult the Dataset from strategy-triggers collect()
 * @param {Object<string, string>} [statusOverrides]
 */
function makeCardsCtx(triggerResult, statusOverrides = {}) {
  const bundle = loadCatalog();
  const lpKeys = new Set(
    bundle.strategies.LP.strategies.flatMap((s) => s.requirement_keys ?? []),
  );
  const statusRows = [...lpKeys].map((key) => ({
    dims: { requirement_key: key, scope_hint: 'page' },
    metrics: { status: statusOverrides[key] ?? 'available', row_count: 1, detail: '' },
  }));
  const descriptorRows = ['p01.job', 'p04.first_viewport', 'p08.commerce', 'p13.constraints'].map(
    (field_path) => ({
      dims: { scope: 'page', template_key: 'url:99', device_class: 'all', field_path },
      metrics: { status: 'current', value_json: 'null', provenance: 'operator', confidence: 'high', expires_at: '' },
    }),
  );
  return {
    gateway: {
      async query() {
        return [{ status: 'complete', taxonomy_version: TAXONOMY_VERSION }];
      },
    },
    datasets: new Map([
      ['requirement-status', { id: 'requirement-status', rows: statusRows }],
      ['descriptor-snapshot', { id: 'descriptor-snapshot', rows: descriptorRows }],
      ['strategy-triggers', triggerResult],
    ]),
  };
}

/**
 * Runs v1 strategy-triggers on a fixture, then cards-lp on the same fixture
 * with every LP requirement available.
 * @param {Map} datasets
 */
async function runBoth(datasets) {
  const v1 = await strategyTriggers.collect(PAGE, makeTriggersCtx(datasets));
  const cards = await cardsLp.collect(PAGE, makeCardsCtx(v1));
  return { v1, cards };
}

function v1Row(v1, strategyId) {
  return v1.rows.find((r) => r.dims.strategy_id === strategyId);
}

function card(cards, strategyId) {
  return cards.rows.find((r) => r.dims.strategy_id === strategyId);
}

describe('lp parity: cards-lp mirrors v1 strategy-triggers', () => {
  it('triggered -> verdict include, trigger_state triggered, metrics copied', async () => {
    const segments = [
      seg({ device: 'desktop' }, { sessions: 1000, revenue_udp: 900, orders_udp: 9 }),
      seg({ device: 'mobile' }, { sessions: 500, revenue_udp: 135, orders_udp: 3 }),
    ];
    const { v1, cards } = await runBoth(datasetsWith({ segments }));
    const row = v1Row(v1, 'H1');
    expect(row.metrics.state).toBe('triggered');
    const h1 = card(cards, 'H1');
    expect(h1.metrics.verdict).toBe('include');
    expect(h1.metrics.trigger_state).toBe('triggered');
    expect(h1.metrics.trigger_evaluated).toBe(1);
    expect(h1.metrics.metric).toBe(row.metrics.metric);
    expect(h1.metrics.value).toBe(row.metrics.value);
    expect(h1.metrics.threshold).toBe(row.metrics.threshold);
  });

  it('below_floor -> verdict conditional, trigger_state below_floor, metrics copied', async () => {
    const segments = [
      seg({ device: 'desktop' }, { sessions: 20, revenue_udp: 18, orders_udp: 1 }),
      seg({ device: 'mobile' }, { sessions: 500, revenue_udp: 2.7, orders_udp: 1 }),
    ];
    const { v1, cards } = await runBoth(datasetsWith({ segments }));
    const row = v1Row(v1, 'H1');
    expect(row.metrics.state).toBe('below_floor');
    const h1 = card(cards, 'H1');
    expect(h1.metrics.verdict).toBe('conditional');
    expect(h1.metrics.trigger_state).toBe('below_floor');
    expect(h1.metrics.trigger_evaluated).toBe(1);
    expect(h1.metrics.metric).toBe(row.metrics.metric);
    expect(h1.metrics.value).toBe(row.metrics.value);
    expect(h1.metrics.threshold).toBe(row.metrics.threshold);
  });

  it('silent stays silent', async () => {
    const segments = [seg({}, { sessions: 19609, revenue_udp: 2000, orders_udp: 200 })];
    const hist = [
      { dims: { bot_filter: 'exclude_confirmed', bucket: '200+' }, metrics: { orders: 12, revenue: 1140 } },
      { dims: { bot_filter: 'exclude_confirmed', bucket: '90-100' }, metrics: { orders: 3, revenue: 285 } },
    ];
    const { v1, cards } = await runBoth(datasetsWith({ segments, hist }));
    expect(v1Row(v1, 'F4').metrics.state).toBe('silent');
    const f4 = card(cards, 'F4');
    expect(f4.metrics.trigger_state).toBe('silent');
    expect(f4.metrics.verdict).toBe('silent');
    expect(f4.metrics.trigger_evaluated).toBe(1);
  });

  it('blocked -> verdict blocked', async () => {
    const segments = [seg({}, { sessions: 1000, sessions_scroll_ge_25pct: 100, revenue_udp: 900, orders_udp: 9 })];
    const { v1, cards } = await runBoth(datasetsWith({ segments, scaleConfirmed: false }));
    expect(v1Row(v1, 'B1').metrics.state).toBe('blocked');
    const b1 = card(cards, 'B1');
    expect(b1.metrics.verdict).toBe('blocked');
    expect(b1.metrics.trigger_state).toBe('blocked');
    expect(b1.metrics.trigger_evaluated).toBe(1);
  });

  it('rule 5 bundle tiles: D1, F1, F2 triggered on both sides', async () => {
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
    const { v1, cards } = await runBoth(datasetsWith({ segments, selectors }));
    for (const id of ['D1', 'F1', 'F2']) {
      expect(v1Row(v1, id).metrics.state).toBe('triggered');
      const c = card(cards, id);
      expect(c.metrics.verdict).toBe('include');
      expect(c.metrics.trigger_state).toBe('triggered');
      expect(c.metrics.value).toBe(v1Row(v1, id).metrics.value);
    }
  });

  it('every v1 strategy row has a card with the same state mapping', async () => {
    const segments = [
      seg({ device: 'desktop' }, { sessions: 1000, revenue_udp: 900, orders_udp: 9 }),
      seg({ device: 'mobile' }, { sessions: 500, revenue_udp: 135, orders_udp: 3 }),
    ];
    const { v1, cards } = await runBoth(datasetsWith({ segments }));
    const expected = { triggered: 'include', silent: 'silent', below_floor: 'conditional', blocked: 'blocked' };
    for (const row of v1.rows) {
      const c = card(cards, row.dims.strategy_id);
      expect(c, row.dims.strategy_id).toBeDefined();
      expect(c.metrics.verdict, `${row.dims.strategy_id} state ${row.metrics.state}`).toBe(
        expected[row.metrics.state],
      );
      expect(c.metrics.trigger_state).toBe(row.metrics.state);
      expect(c.metrics.trigger_evaluated).toBe(1);
    }
  });
});

describe('lp parity: a missing requirement never yields silent', () => {
  it('with H10 missing, every LP card citing H10 is conditional with trigger_evaluated 0', async () => {
    const segments = [
      seg({ device: 'desktop' }, { sessions: 1000, revenue_udp: 900, orders_udp: 9 }),
      seg({ device: 'mobile' }, { sessions: 500, revenue_udp: 135, orders_udp: 3 }),
    ];
    const v1 = await strategyTriggers.collect(PAGE, makeTriggersCtx(datasetsWith({ segments })));
    const bundle = loadCatalog();
    const citingH10 = bundle.strategies.LP.strategies
      .filter((s) => (s.requirement_keys ?? []).includes('H10'))
      .map((s) => s.id);
    expect(citingH10).toContain('D7'); // rage-clicks rule 8

    const cards = await cardsLp.collect(PAGE, makeCardsCtx(v1, { H10: 'missing' }));
    for (const id of citingH10) {
      const c = card(cards, id);
      expect(c.metrics.verdict, `LP:${id}`).toBe('conditional');
      expect(c.metrics.trigger_evaluated, `LP:${id}`).toBe(0);
      expect(c.metrics.trigger_state, `LP:${id}`).not.toBe('silent');
      expect(c.metrics.missing_requirements, `LP:${id}`).toEqual(['H10']);
    }
    // H1 does not cite H10: still mirrors its v1 row
    const h1 = card(cards, 'H1');
    expect(h1.metrics.verdict).toBe('include');
    expect(h1.metrics.trigger_evaluated).toBe(1);
  });
});
