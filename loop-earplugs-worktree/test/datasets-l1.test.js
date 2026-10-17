import { describe, expect, it } from 'vitest';
import { adapter as elementBinding } from '../src/adapters/datasets/element-binding.js';
import { adapter as exposureWeekly } from '../src/adapters/datasets/exposure-weekly.js';
import { adapter as dwellModelInputs } from '../src/adapters/datasets/dwell-model-inputs.js';
import { adapter as funnelSequenceWeekly } from '../src/adapters/datasets/funnel-sequence-weekly.js';
import { adapter as formsWeekly } from '../src/adapters/datasets/forms-weekly.js';
import { adapter as journeyWeekly } from '../src/adapters/datasets/journey-weekly.js';
import { adapter as viewportWeekly } from '../src/adapters/datasets/viewport-weekly.js';
import { adapter as returningHistory } from '../src/adapters/datasets/returning-history.js';
import { adapter as recordingsSample } from '../src/adapters/datasets/recordings-sample.js';
import { adapter as customEventInventory } from '../src/adapters/datasets/custom-event-inventory.js';
import { adapter as pageSpeed } from '../src/adapters/datasets/page-speed.js';

/**
 * Phase 3 L1 page-scope datasets through a fake gateway. Sessions: v1/v2/v4
 * enter the page (hsr 222), v3 enters elsewhere (hsr 111); bot context is
 * empty so every session lands in bot_filter none and exclude_confirmed.
 */

const WINDOW = { windowStart: '2026-09-26', windowEnd: '2026-10-02' };
const WEEK = '2026-09-28';
const PAGE = { idsite: 1, idsitehsr: 222, url: 'https://x.com/products/a', pageType: 'product' };
const logger = { info() {}, warn() {}, error() {} };

/**
 * @param {string} idvisit
 * @param {string} entryHsr
 * @param {object} [over]
 */
function s(idvisit, entryHsr, over = {}) {
  return {
    idvisit,
    first_date: '2026-09-30',
    week: WEEK,
    device: 1,
    referer: 1,
    returning: 0,
    entry_hsr: entryHsr,
    country: 'us',
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
    scroll_max: 0,
    landing_pageviews: 1,
    page_capped_ms: 10000,
    ...over,
  };
}

const SESSIONS = [
  s('v1', '222', { orders: 1, revenue: 50, saw_checkout: 1, pageviews: 3, page_capped_ms: 30000 }),
  s('v2', '222', { device: 3, pageviews: 1, page_capped_ms: 5000 }),
  s('v3', '111'),
  s('v4', '222', { page_capped_ms: 12000 }),
];

const URLS = [
  { hsr: '111', url: 'https://x.com' },
  { hsr: '222', url: 'https://x.com/products/a' },
  { hsr: '333', url: 'https://x.com/products/b' },
  { hsr: '444', url: 'https://x.com/cart' },
  { hsr: '555', url: 'https://x.com/pages/about' },
];

/**
 * @param {object} fixture label -> rows
 * @param {object} [opts]
 * @param {object} [opts.columns] table -> column rows
 */
function fakeGateway(fixture, opts = {}) {
  return {
    async query(_sql, _params, label) {
      if (label in fixture) return fixture[label];
      if (label === 'sessions:entry' || label === 'sessions:entry+scroll') return SESSIONS;
      if (label === 'bot:fingerprints') return [];
      if (label === 'bot:version-shares' || label === 'bot:version-lookback') return [];
      if (label === 'urls:site-hsr') return URLS;
      throw new Error(`unexpected query: ${label}`);
    },
    async explain() {
      return 'plan';
    },
    async columns(table) {
      return opts.columns?.[table] ?? [];
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

const findRow = (dataset, match) =>
  dataset.rows.find((row) =>
    Object.entries(match).every(([key, value]) => row.dims[key] === value),
  );

describe('element-binding', () => {
  it('returns binding rows with names and the taxonomy version note', async () => {
    const gateway = fakeGateway({
      'element-binding:rows': [
        { selector: '.buy', element_class: 'cta', name: 'Buy now', taxonomy_version: 'v2' },
      ],
    });
    const dataset = await elementBinding.collect(PAGE, makeCtx(gateway));
    expect(dataset.rows).toHaveLength(1);
    expect(dataset.rows[0].dims).toEqual({ selector: '.buy', element_class: 'cta' });
    expect(dataset.rows[0].metrics.name).toBe('Buy now');
    expect(dataset.notes.taxonomy_version).toBe('v2');
  });
});

describe('exposure-weekly', () => {
  it('emits element rows with rpes and band rows with the section-mapping note', async () => {
    const gateway = fakeGateway({
      'exposure-weekly:elements': [{ selector: '.buy', idvisit: 'v1', dw_max: 5, dur_max: 8 }],
      'exposure-weekly:zones': [
        { zone_d: '50', idvisit: 'v1', dw_max: 3 },
        { zone_d: '75', idvisit: 'v2', dw_max: 0 },
      ],
    });
    const dataset = await exposureWeekly.collect(PAGE, makeCtx(gateway));
    expect(exposureWeekly.provides).toEqual(['H18', 'T14']);

    const element = findRow(dataset, { element: '.buy', device: 'desktop', bot_filter: 'none' });
    expect(element).toBeDefined();
    expect(element.metrics).toMatchObject({
      exposed_sessions: 1,
      dwell_seconds: 5,
      exposed_orders: 1,
      exposed_revenue: 50,
      rpes: 50,
    });

    const band = findRow(dataset, { depth_band: '50', bot_filter: 'none' });
    expect(band.dims.element).toBe('');
    expect(band.dims.section_id).toBe('');
    expect(band.metrics.exposed_sessions).toBe(1);
    expect(band.metrics.dwell_seconds).toBe(3);
    expect(band.metrics.rpes).toBeUndefined();

    const notExposed = findRow(dataset, { depth_band: '75', bot_filter: 'none' });
    expect(notExposed.metrics.exposed_sessions).toBe(0);

    expect(dataset.notes.exposure_section_mapping).toMatch(/M02 geometry or descriptor p10/);
    expect(dataset.notes.exposure_tracker_events).toBe('none observed (D-01)');
  });
});

describe('dwell-model-inputs', () => {
  it('carries per-session band dwell and engaged time', async () => {
    const gateway = fakeGateway({
      'dwell-model-inputs:zones': [
        { zone_d: '50', idvisit: 'v1', dwell: 3.5 },
        { zone_d: '100', idvisit: 'v1', dwell: 1.5 },
      ],
    });
    const dataset = await dwellModelInputs.collect(PAGE, makeCtx(gateway));
    const row = findRow(dataset, { session: 'v1', device: 'desktop', bot_filter: 'none' });
    expect(row).toBeDefined();
    expect(row.metrics.band_dwell).toEqual({ '50': 3.5, '100': 1.5 });
    expect(row.metrics.total_engaged_ms).toBe(30000);
    expect(row.metrics.orders).toBe(1);
    expect(row.metrics.revenue).toBe(50);
    // every page entry session gets a row, in both bot-filter cells
    const v1Rows = dataset.rows.filter((r) => r.dims.session === 'v1');
    expect(v1Rows.map((r) => r.dims.bot_filter).sort()).toEqual(['exclude_confirmed', 'none']);
  });
});

describe('funnel-sequence-weekly', () => {
  it('counts reach, medians minutes, and checkout-without-ATC', async () => {
    const T = 1_800_000_000_000;
    const gateway = fakeGateway({
      'funnel-sequence-weekly:events': [
        { idvisit: 'v1', event_type: 'product_viewed', ts_ms: T },
        { idvisit: 'v1', event_type: 'add_to_cart', ts_ms: T + 60_000 },
        { idvisit: 'v1', event_type: 'checkout_started', ts_ms: T + 180_000 },
        { idvisit: 'v2', event_type: 'checkout_started', ts_ms: T + 10_000 },
      ],
    });
    const dataset = await funnelSequenceWeekly.collect(PAGE, makeCtx(gateway));

    const checkout = findRow(dataset, { step: 'checkout_started', bot_filter: 'none' });
    expect(checkout.metrics.reached_sessions).toBe(2);
    expect(checkout.metrics.checkout_without_atc_sessions).toBe(1);

    const reach = findRow(dataset, {
      from_step: 'product_viewed',
      to_step: 'checkout_started',
      bot_filter: 'none',
    });
    expect(reach.metrics.sessions).toBe(1);
    expect(reach.metrics.median_minutes_to_step).toBe(3);

    const atc = findRow(dataset, { from_step: 'add_to_cart', to_step: 'checkout_started', bot_filter: 'none' });
    expect(atc.metrics.median_minutes_to_step).toBe(2);

    expect(dataset.notes.funnel_scope).toMatch(/page-filtered by session entry page/);
  });
});

describe('forms-weekly', () => {
  it('computes filled, submitted and the completion share', async () => {
    const gateway = fakeGateway({
      'forms-weekly:events': [
        { idvisit: 'v1', event_type: 'form_filled' },
        { idvisit: 'v2', event_type: 'form_filled' },
        { idvisit: 'v2', event_type: 'form_submitted' },
        { idvisit: 'v3', event_type: 'form_filled' },
      ],
    });
    const dataset = await formsWeekly.collect(PAGE, makeCtx(gateway));
    const desktop = findRow(dataset, { device: 'desktop', bot_filter: 'none' });
    expect(desktop.metrics).toMatchObject({
      form_filled_sessions: 1,
      form_submitted_sessions: 0,
      filled_not_submitted_sessions: 1,
      form_completion_share: 0,
    });
    const mobile = findRow(dataset, { device: 'mobile', bot_filter: 'none' });
    expect(mobile.metrics.form_completion_share).toBe(1);
  });
});

describe('journey-weekly', () => {
  it('flags the multi-PDP session and emits path clusters with orders', async () => {
    const T = 1_800_000_000_000;
    const gateway = fakeGateway({
      'journey-weekly:pageviews': [
        { idvisit: 'v1', idloghsr: 'a1', hsr: '222', ts_ms: T },
        { idvisit: 'v1', idloghsr: 'a2', hsr: '333', ts_ms: T + 60_000 },
        { idvisit: 'v1', idloghsr: 'a3', hsr: '444', ts_ms: T + 120_000 },
        { idvisit: 'v2', idloghsr: 'b1', hsr: '222', ts_ms: T },
        { idvisit: 'v3', idloghsr: 'c1', hsr: '555', ts_ms: T },
        { idvisit: 'v3', idloghsr: 'c2', hsr: '222', ts_ms: T + 60_000 },
        { idvisit: 'v4', idloghsr: 'd1', hsr: '222', ts_ms: T },
      ],
    });
    const dataset = await journeyWeekly.collect(PAGE, makeCtx(gateway));

    const multiPdp = findRow(dataset, { flag: 'multi_pdp', device: 'desktop', bot_filter: 'none' });
    expect(multiPdp.metrics.sessions).toBe(1);
    expect(multiPdp.metrics.share_of_sessions).toBeCloseTo(1 / 3, 4);

    const entered = findRow(dataset, { flag: 'entered_on_page', device: 'desktop', bot_filter: 'none' });
    expect(entered.metrics.share_of_sessions).toBeCloseTo(2 / 3, 4);

    const sawCart = findRow(dataset, { flag: 'saw_cart', device: 'desktop', bot_filter: 'none' });
    expect(sawCart.metrics.sessions).toBe(1);

    const cluster = findRow(dataset, { cluster: 'product->product', bot_filter: 'none' });
    expect(cluster.metrics).toMatchObject({ sessions: 1, orders: 1, revenue_udp: 50 });

    const internalCluster = findRow(dataset, { cluster: 'content->product', bot_filter: 'none' });
    expect(internalCluster.metrics.sessions).toBe(1);
  });
});

describe('viewport-weekly', () => {
  it('shares sum to 1 within each week+device+tier cell', async () => {
    const gateway = fakeGateway({
      'viewport:heights': [
        { idvisit: 'v1', h: 900 },
        { idvisit: 'v4', h: 400 },
        { idvisit: 'v2', h: 500 },
      ],
    });
    const dataset = await viewportWeekly.collect(PAGE, makeCtx(gateway));

    const totals = new Map();
    for (const row of dataset.rows) {
      const key = `${row.dims.week}|${row.dims.device}|${row.dims.bot_filter}`;
      totals.set(key, (totals.get(key) ?? 0) + row.metrics.share_of_device_sessions);
    }
    expect([...totals.values()].every((sum) => Math.abs(sum - 1) < 1e-9)).toBe(true);
    expect(totals.size).toBeGreaterThan(0);

    const tall = findRow(dataset, { viewport_class: 'medium', device: 'desktop', bot_filter: 'none' });
    expect(tall.metrics.share_of_device_sessions).toBe(0.5);
    expect(dataset.notes.viewport_helper).toMatch(/_lib\/viewport\.js/);
  });
});

describe('returning-history', () => {
  it('emits no rows and the explicit H27 missing requirement', async () => {
    const dataset = await returningHistory.collect(PAGE, makeCtx(fakeGateway({})));
    expect(dataset.rows).toEqual([]);
    expect(dataset.requirements).toEqual([
      {
        key: 'H27',
        status: 'missing',
        rowCount: 0,
        detail: 'no_stable_visitor_id (decision docs/decisions/2026-10-04-d02-browser-and-visitor-id.md)',
      },
    ]);
    expect(dataset.notes.returning_fallback).toMatch(/visitor_returning/);
  });
});

describe('recordings-sample', () => {
  it('counts fixture rows with null-safe medians and a sample of ids', async () => {
    const gateway = fakeGateway(
      {
        'recordings-sample:rows': [
          { recording_id: 'r1', time_on_page: 1000, pageview_click_count: 1, device: 1 },
          { recording_id: 'r2', time_on_page: 3000, pageview_click_count: 3, device: 1 },
          { recording_id: 'r3', time_on_page: null, pageview_click_count: null, device: null },
        ],
      },
      { columns: { recordings_new1: [{ name: 'config_device_type', type: 'Nullable(UInt8)' }] } },
    );
    const dataset = await recordingsSample.collect(PAGE, makeCtx(gateway));
    const desktop = findRow(dataset, { population: 'all', device: 'desktop', bot_filter: '' });
    expect(desktop.metrics).toMatchObject({
      recording_count: 2,
      median_time_on_page_ms: 2000,
      median_click_count: 2,
    });
    expect(desktop.dims.sample_recording_ids).toEqual(['r1', 'r2']);
    const unknown = findRow(dataset, { device: 'unknown' });
    expect(unknown.metrics.recording_count).toBe(1);
    expect(unknown.metrics.median_time_on_page_ms).toBeNull();
    expect(unknown.metrics.median_click_count).toBeNull();
  });

  it('maps device values through deviceName when present', async () => {
    const gateway = fakeGateway(
      {
        'recordings-sample:rows': [
          { recording_id: 'r1', time_on_page: 100, pageview_click_count: 2, device: 3 },
        ],
      },
      { columns: { recordings_new1: [{ name: 'config_device_type', type: 'Nullable(UInt8)' }] } },
    );
    const dataset = await recordingsSample.collect(PAGE, makeCtx(gateway));
    const mobile = findRow(dataset, { device: 'mobile' });
    expect(mobile.metrics.recording_count).toBe(1);
    expect(dataset.notes.recordings_page_join).toMatch(/idloghsr/);
  });

  it('falls back to device all when the device column is absent', async () => {
    const gateway = fakeGateway({
      'recordings-sample:rows': [
        { recording_id: 'r1', time_on_page: 100, pageview_click_count: 2 },
      ],
    });
    const dataset = await recordingsSample.collect(PAGE, makeCtx(gateway));
    const row = findRow(dataset, { device: 'all' });
    expect(row.metrics.recording_count).toBe(1);
  });

  it('samples the smallest recording ids, whatever order the rows arrive in', async () => {
    const rows = Array.from({ length: 60 }, (_, i) => ({ recording_id: `r${String(59 - i).padStart(2, '0')}`, time_on_page: 100, pageview_click_count: 1 }));
    const sampled = async (order) => findRow(await recordingsSample.collect(PAGE, makeCtx(fakeGateway({ 'recordings-sample:rows': order }))), { device: 'all' })
      .dims.sample_recording_ids;
    const forward = await sampled(rows);
    expect(forward).toEqual(Array.from({ length: 50 }, (_, i) => `r${String(i).padStart(2, '0')}`));
    expect(await sampled([...rows].reverse())).toEqual(forward);
  });
});

describe('custom-event-inventory', () => {
  it('marks registered and unregistered names, scoped to the page hsr', async () => {
    const gateway = fakeGateway({
      'custom-event-inventory:events': [
        { event_name: 'faq.expand', idsitehsr: '222', week: WEEK, events: 5, first_seen: '2026-09-28', last_seen: '2026-09-30' },
        { event_name: 'widget.zzz', idsitehsr: '222', week: WEEK, events: 2, first_seen: '2026-09-29', last_seen: '2026-09-29' },
        { event_name: 'other.page', idsitehsr: '999', week: WEEK, events: 9, first_seen: '2026-09-28', last_seen: '2026-10-01' },
      ],
    });
    const dataset = await customEventInventory.collect(PAGE, makeCtx(gateway));
    expect(dataset.rows).toHaveLength(2);
    const registered = findRow(dataset, { event_name: 'faq.expand' });
    expect(registered.metrics.registry).toBe('registered');
    expect(registered.metrics.events).toBe(5);
    expect(registered.metrics.first_seen).toBe('2026-09-28');
    const unregistered = findRow(dataset, { event_name: 'widget.zzz' });
    expect(unregistered.metrics.registry).toBe('unregistered');
    expect(dataset.notes.custom_event_inventory_note).toMatch(/D-01/);
  });
});

describe('page-speed', () => {
  it('returns medians when rows match', async () => {
    const gateway = fakeGateway({
      'page-speed:rows': [
        {
          row_count: 2,
          min_fetched_at: '2026-08-01 00:00:00',
          max_fetched_at: '2026-08-02 00:00:00',
          lcp_ms_p50: 2100.4,
          fcp_ms_p50: 900.2,
        },
      ],
    });
    const dataset = await pageSpeed.collect(PAGE, makeCtx(gateway));
    expect(dataset.rows).toHaveLength(1);
    expect(dataset.rows[0].dims).toEqual({ device: 'all', source: 'page_speed_cache' });
    expect(dataset.rows[0].metrics).toMatchObject({
      row_count: 2,
      min_fetched_at: '2026-08-01 00:00:00',
      max_fetched_at: '2026-08-02 00:00:00',
      lcp_ms_p50: 2100.4,
      fcp_ms_p50: 900.2,
    });
  });

  it('is null-safe when no rows match', async () => {
    const gateway = fakeGateway({
      'page-speed:rows': [
        { row_count: 0, min_fetched_at: '', max_fetched_at: '', lcp_ms_p50: null, fcp_ms_p50: null },
      ],
    });
    const dataset = await pageSpeed.collect(PAGE, makeCtx(gateway));
    expect(dataset.rows[0].metrics).toMatchObject({
      row_count: 0,
      min_fetched_at: null,
      max_fetched_at: null,
      lcp_ms_p50: null,
      fcp_ms_p50: null,
    });
    expect(dataset.notes.page_speed_coverage).toMatch(/CrUX arrives Phase 9/);
  });
});
