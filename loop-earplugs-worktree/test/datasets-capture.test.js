import { describe, expect, it } from 'vitest';
import { adapter as renderSnapshot } from '../src/adapters/datasets/render-snapshot.js';
import { adapter as saliency } from '../src/adapters/datasets/saliency.js';
import { adapter as tapGeometryWeekly } from '../src/adapters/datasets/tap-geometry-weekly.js';
import { adapter as templateWeekly } from '../src/adapters/datasets/template-weekly.js';
import { adapter as kindFleetWeekly } from '../src/adapters/datasets/kind-fleet-weekly.js';

/**
 * Phase 4 capture datasets (plan §10.2, §12 Phase 4) through a fake
 * gateway. render-snapshot and saliency read the ae_ render tables;
 * tap-geometry-weekly joins memoized clicks to element boxes;
 * template-weekly and kind-fleet-weekly (site scope) roll the batch's
 * persisted dataset rows up by template family and element kind. Every
 * ae_ read degrades to zero rows plus a note on UNKNOWN_TABLE — the
 * tables do not exist until the schema-2 cutover.
 */

const WINDOW = { windowStart: '2026-09-26', windowEnd: '2026-10-02' };
const WEEK = '2026-09-28';
const PAGE = { idsite: 1, idsitehsr: 222, url: 'https://x.com/products/a', pageType: 'product' };
const SITE = { idsite: 1, idsitehsr: 0, siteName: 'x' };
const logger = { info() {}, warn() {}, error() {} };

const UNKNOWN_TABLE_ERR = 'Code: 60. DB::Exception: UNKNOWN_TABLE (journey_events.ae_render_node_current)';

const RENDERS = [
  {
    device_class: 'mobile',
    capture_id: 'c1',
    viewport_w: 390,
    viewport_h: 844,
    page_height_px: 9000,
    fold_px: 844,
    content_hash: 'sha256:a',
    dom_hash: 'sha256:b',
    section_count: 3,
    rendered_at: '2026-10-01 10:00:00.000',
  },
];

const NODES = [
  {
    device_class: 'mobile',
    node_kind: 'section',
    node_id: 's1',
    parent_section_id: '',
    selector: '#reviews',
    section_type: 'reviews_block',
    dom_order: 0,
    x: 0,
    y: 1688,
    w: 390,
    h: 1210,
    is_control: 0,
    looks_clickable: 0,
    is_sticky: 0,
    visual_class: '',
    image_type: '',
    word_count: 412,
    in_first_viewport: 0,
    saliency_model: '',
  },
  {
    device_class: 'mobile',
    node_kind: 'element',
    node_id: 'e1',
    parent_section_id: 's1',
    selector: '.buy',
    section_type: '',
    dom_order: 41,
    x: 16,
    y: 1720,
    w: 358,
    h: 48,
    is_control: 1,
    looks_clickable: 1,
    is_sticky: 0,
    visual_class: 'control',
    image_type: '',
    word_count: 3,
    in_first_viewport: 0,
    saliency_model: '',
  },
];

/**
 * @param {object} fixture label -> rows, or label -> Error to throw
 * @param {object} [opts]
 * @param {Array<object>} [opts.sessions] rows for sessions:entry
 * @param {Array<object>} [opts.clicks] rows for clicks:page, answered for the read's day
 */
function fakeGateway(fixture, opts = {}) {
  /** @type {Array<{sql: string, params: object, label: string}>} */
  const queries = [];
  return {
    queries,
    async query(sql, params, label) {
      queries.push({ sql, params, label });
      if (label in fixture) {
        const hit = fixture[label];
        if (hit instanceof Error) throw hit;
        return hit;
      }
      if (label === 'sessions:entry') return opts.sessions ?? [];
      if (label === 'clicks:page') return (opts.clicks ?? []).filter((c) => String(c.date).slice(0, 10) === params.day);
      if (label === 'bot:fingerprints') return [];
      if (label === 'bot:version-shares' || label === 'bot:version-lookback') return [];
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

const findRow = (dataset, match) =>
  dataset.rows.find((row) =>
    Object.entries(match).every(([key, value]) => row.dims[key] === value),
  );

describe('render-snapshot', () => {
  it('exposes render rows, section rows and element rows per device', async () => {
    const gateway = fakeGateway({
      'render-snapshot:renders': RENDERS,
      'render-snapshot:nodes': NODES,
    });
    const dataset = await renderSnapshot.collect(PAGE, makeCtx(gateway));
    expect(renderSnapshot.provides).toEqual(['M01', 'M02', 'M03', 'M06']);
    expect(renderSnapshot.dependsOn).toEqual(['element-binding']);

    const render = findRow(dataset, { device_class: 'mobile', capture_id: 'c1' });
    expect(render.metrics).toEqual({
      viewport_w: 390,
      viewport_h: 844,
      page_height_px: 9000,
      fold_px: 844,
      content_hash: 'sha256:a',
      dom_hash: 'sha256:b',
      section_count: 3,
      rendered_at: '2026-10-01 10:00:00.000',
    });

    const section = findRow(dataset, { node_kind: 'section', section_id: 's1' });
    expect(section.dims.device_class).toBe('mobile');
    expect(section.metrics).toMatchObject({
      selector: '#reviews',
      top: 1688,
      height: 1210,
      section_type: 'reviews_block',
      word_count: 412,
      in_first_viewport: 0,
    });

    const element = findRow(dataset, { node_kind: 'element', selector: '.buy' });
    expect(element.metrics).toMatchObject({
      section_id: 's1',
      dom_order: 41,
      x: 16,
      y: 1720,
      w: 358,
      h: 48,
      is_control: 1,
      looks_clickable: 1,
      is_sticky: 0,
      visual_class: 'control',
      image_type: '',
      has_saliency: 0,
    });
    expect(dataset.rows).toHaveLength(3);
    expect(dataset.notes.render_devices).toEqual(['mobile']);
  });

  it('degrades each ae_ read independently on UNKNOWN_TABLE', async () => {
    const gateway = fakeGateway({
      'render-snapshot:renders': new Error(UNKNOWN_TABLE_ERR),
      'render-snapshot:nodes': NODES,
    });
    const dataset = await renderSnapshot.collect(PAGE, makeCtx(gateway));
    expect(dataset.rows).toHaveLength(2);
    expect(dataset.notes.render_snapshot_note).toMatch(/ae_page_render_current unreadable/);
    expect(dataset.notes.render_nodes_note).toBeUndefined();

    const bothDown = fakeGateway({
      'render-snapshot:renders': new Error(UNKNOWN_TABLE_ERR),
      'render-snapshot:nodes': new Error(UNKNOWN_TABLE_ERR),
    });
    const empty = await renderSnapshot.collect(PAGE, makeCtx(bothDown));
    expect(empty.rows).toEqual([]);
    expect(empty.notes.render_devices).toEqual([]);
    expect(empty.notes.render_nodes_note).toMatch(/ae_render_node_current unreadable/);
  });

  it('rethrows non-UNKNOWN_TABLE failures', async () => {
    const gateway = fakeGateway({
      'render-snapshot:renders': new Error('Connection refused'),
      'render-snapshot:nodes': [],
    });
    await expect(renderSnapshot.collect(PAGE, makeCtx(gateway))).rejects.toThrow('Connection refused');
  });
});

describe('saliency', () => {
  it('emits rows when nodes carry a saliency model', async () => {
    const gateway = fakeGateway({
      'saliency:nodes': [
        { device_class: 'mobile', node_kind: 'element', node_id: 'e1', selector: '.buy', dom_order: 41, saliency_share: 0.21, saliency_quartile: 3, saliency_model: 'sal-v1' },
        { device_class: 'mobile', node_kind: 'section', node_id: 's1', selector: '#reviews', dom_order: 0, saliency_share: 0.4, saliency_quartile: 1, saliency_model: 'sal-v1' },
      ],
    });
    const dataset = await saliency.collect(PAGE, makeCtx(gateway));
    expect(saliency.provides).toEqual(['M04']);
    expect(dataset.rows).toHaveLength(2);
    expect(dataset.requirements).toBeUndefined();

    const element = findRow(dataset, { node_kind: 'element', selector: '.buy' });
    expect(element.metrics).toEqual({ saliency_share: 0.21, saliency_quartile: 3, saliency_model: 'sal-v1' });
    const section = findRow(dataset, { node_kind: 'section', section_id: 's1' });
    expect(section.dims.selector).toBeUndefined();
    expect(dataset.notes.saliency_model).toBe('sal-v1');
  });

  it('reports M04 missing with model_not_selected when no node carries a model', async () => {
    const gateway = fakeGateway({ 'saliency:nodes': [] });
    const dataset = await saliency.collect(PAGE, makeCtx(gateway));
    expect(dataset.rows).toEqual([]);
    expect(dataset.requirements).toEqual([
      { key: 'M04', status: 'missing', rowCount: 0, detail: 'model_not_selected (Q8)' },
    ]);
    expect(dataset.notes.saliency_model).toBe('none');
  });

  it('degrades to the M04 missing requirement on UNKNOWN_TABLE', async () => {
    const gateway = fakeGateway({ 'saliency:nodes': new Error(UNKNOWN_TABLE_ERR) });
    const dataset = await saliency.collect(PAGE, makeCtx(gateway));
    expect(dataset.rows).toEqual([]);
    expect(dataset.requirements).toEqual([
      { key: 'M04', status: 'missing', rowCount: 0, detail: 'model_not_selected (Q8)' },
    ]);
    expect(dataset.notes.saliency_note).toMatch(/ae_render_node_current unreadable/);
  });
});

describe('tap-geometry-weekly', () => {
  const SESSIONS = [
    { idvisit: 'v1', first_date: WEEK, week: WEEK, device: 1, referer: 1, returning: 0, entry_hsr: '222', country: 'us', browser: 'Chrome', fp_hash: 'fp1', utm_source: '', pageviews: 2, capped_ms: 20000, saw_product: 0, saw_atc: 0, saw_checkout: 0, saw_purchase: 0, orders: 0, revenue: 0 },
    { idvisit: 'v2', first_date: WEEK, week: WEEK, device: 3, referer: 1, returning: 0, entry_hsr: '222', country: 'us', browser: 'Safari', fp_hash: 'fp2', utm_source: '', pageviews: 2, capped_ms: 20000, saw_product: 0, saw_atc: 0, saw_checkout: 0, saw_purchase: 0, orders: 0, revenue: 0 },
  ];

  const CLICKS = [
    { idvisit: 'v1', idloghsr: 'c1', selector: '.buy', week: WEEK, date: WEEK, server_time: `${WEEK} 10:00:01`, meta1: '', x: 10, y: 10, time_since_load: 100 },
    { idvisit: 'v1', idloghsr: 'c2', selector: '.buy', week: WEEK, date: WEEK, server_time: `${WEEK} 10:00:02`, meta1: '', x: 100, y: 120, time_since_load: 900 },
    { idvisit: 'v2', idloghsr: 'c3', selector: '.buy', week: WEEK, date: WEEK, server_time: `${WEEK} 10:00:03`, meta1: '', x: 200, y: 220, time_since_load: -1 },
    { idvisit: 'v2', idloghsr: 'c4', selector: '.nav', week: WEEK, date: WEEK, server_time: `${WEEK} 10:00:04`, meta1: '', x: 5, y: 5, time_since_load: 0 },
    { idvisit: 'v1', idloghsr: 'c5', selector: '.old', week: WEEK, date: WEEK, server_time: `${WEEK} 10:00:05`, meta1: '', x: 50, y: 20, time_since_load: -1 },
  ];

  const BOXES = [
    { device_class: 'desktop', selector: '.buy', x: 0, y: 100, w: 200, h: 50 },
    { device_class: 'mobile', selector: '.buy', x: 0, y: 200, w: 390, h: 48 },
    { device_class: '', selector: '.old', x: 0, y: 0, w: 100, h: 40 },
  ];

  it('computes off-target taps, center offsets and correction pairs per device', async () => {
    const gateway = fakeGateway({ 'tap-geometry-weekly:boxes': BOXES }, { sessions: SESSIONS, clicks: CLICKS });
    const dataset = await tapGeometryWeekly.collect(PAGE, makeCtx(gateway));
    expect(tapGeometryWeekly.provides).toEqual(['H22']);
    expect(tapGeometryWeekly.dependsOn).toEqual(['selector-weekly']);

    // v1 (desktop) .buy: clicks at (10,10) — far above the box (off-target)
    // and (100,120) — inside; tsl 100 -> 900 is one correction pair.
    const desktopBuy = findRow(dataset, { week: WEEK, device: 'desktop', selector: '.buy', bot_filter: 'none' });
    expect(desktopBuy.metrics.clicks).toBe(2);
    expect(desktopBuy.metrics.off_target_taps).toBe(1);
    expect(desktopBuy.metrics.correction_pairs).toBe(1);
    const expectedOffset = (Math.hypot(90, 115) + 5) / 2;
    expect(desktopBuy.metrics.median_offset_from_center_px).toBe(Math.round(expectedOffset * 100) / 100);

    // v2 (mobile) .buy: the mobile box matches the mobile click.
    const mobileBuy = findRow(dataset, { week: WEEK, device: 'mobile', selector: '.buy', bot_filter: 'none' });
    expect(mobileBuy.metrics).toMatchObject({ clicks: 1, off_target_taps: 0, correction_pairs: 0 });
    expect(mobileBuy.metrics.median_offset_from_center_px).toBe(Math.round(Math.hypot(5, -4) * 100) / 100);

    // .nav has no box at all: click counts, geometry stays null.
    const nav = findRow(dataset, { week: WEEK, device: 'mobile', selector: '.nav', bot_filter: 'none' });
    expect(nav.metrics).toEqual({ clicks: 1, off_target_taps: 0, median_offset_from_center_px: null, correction_pairs: 0 });

    // .old's boxes carry no device class: any box stands in (selector_only).
    const old = findRow(dataset, { week: WEEK, device: 'desktop', selector: '.old', bot_filter: 'none' });
    expect(old.metrics).toMatchObject({ clicks: 1, off_target_taps: 0 });

    // tier-null sessions land in both bot filters.
    expect(findRow(dataset, { device: 'desktop', selector: '.buy', bot_filter: 'exclude_confirmed' })).toBeDefined();

    expect(dataset.notes.tap_geometry_device_match).toBe(
      'device_exact: 3, device_fallback: 0, selector_only: 1, no_box: 1',
    );
  });

  it('returns zero rows plus a note when render geometry is absent', async () => {
    const gateway = fakeGateway(
      { 'tap-geometry-weekly:boxes': new Error(UNKNOWN_TABLE_ERR) },
      { sessions: SESSIONS, clicks: CLICKS },
    );
    const dataset = await tapGeometryWeekly.collect(PAGE, makeCtx(gateway));
    expect(dataset.rows).toEqual([]);
    expect(dataset.notes.tap_geometry_note).toBe('no render geometry until capture');
    expect(dataset.notes.tap_geometry_device_match).toMatch(/no render geometry/);
  });
});

describe('template-weekly', () => {
  const TARGETS = [
    { idsitehsr: '222', page_type: 'product', template_family: 'pdps' },
    { idsitehsr: '333', page_type: 'collection', template_family: '' },
  ];

  const PAGE_ROWS = [
    { idsitehsr: '222', week: WEEK, metrics: JSON.stringify({ sessions: 10, orders_udp: 1, revenue_udp: 100 }) },
    { idsitehsr: '222', week: WEEK, metrics: JSON.stringify({ sessions: 5, orders_udp: 0, revenue_udp: 0 }) },
    { idsitehsr: '333', week: WEEK, metrics: JSON.stringify({ sessions: 20, orders_udp: 2, revenue_udp: 50 }) },
  ];

  it('groups page totals by template family with the page_type fallback', async () => {
    const gateway = fakeGateway({
      'template-weekly:targets': TARGETS,
      'template-weekly:page-rows': PAGE_ROWS,
    });
    const ctx = makeCtx(gateway);
    const dataset = await templateWeekly.collect(SITE, ctx);
    expect(templateWeekly.scope).toBe('site');
    expect(templateWeekly.provides).toEqual(['H25']);

    const pdps = findRow(dataset, { template_family: 'pdps', week: WEEK });
    expect(pdps.metrics).toEqual({ entry_sessions: 15, orders: 1, revenue: 100, rps: 6.67 });

    const collection = findRow(dataset, { template_family: 'collection', week: WEEK });
    expect(collection.metrics).toEqual({ entry_sessions: 20, orders: 2, revenue: 50, rps: 2.5 });

    expect(dataset.notes.template_family_source).toBe(
      'template_family column: 1 targets; page_type fallback: 1 targets',
    );

    const pageRowsQuery = gateway.queries.find((q) => q.label === 'template-weekly:page-rows');
    expect(pageRowsQuery.sql).toContain("bot_filter = 'exclude_confirmed'");
    expect(pageRowsQuery.params).toMatchObject({ batchId: 'b1', idsite: 1 });
  });

  it('degrades to zero rows plus notes when the ae_ tables are absent', async () => {
    const targetsDown = fakeGateway({
      'template-weekly:targets': new Error(UNKNOWN_TABLE_ERR),
      'template-weekly:page-rows': PAGE_ROWS,
    });
    const noTargets = await templateWeekly.collect(SITE, makeCtx(targetsDown));
    expect(noTargets.rows).toEqual([]);
    expect(noTargets.notes.template_targets_note).toMatch(/ae_page_target_current unreadable/);

    const rowsDown = fakeGateway({
      'template-weekly:targets': TARGETS,
      'template-weekly:page-rows': new Error(UNKNOWN_TABLE_ERR),
    });
    const noRows = await templateWeekly.collect(SITE, makeCtx(rowsDown));
    expect(noRows.rows).toEqual([]);
    expect(noRows.notes.template_dataset_rows_note).toMatch(/ae_dataset_row_current unreadable/);
  });
});

describe('kind-fleet-weekly', () => {
  const FLEET_ROWS = [
    { dim_selector: '.buy', dim_element_class: 'cta', metrics: JSON.stringify({ clicks: 30, clicking_sessions: 10, revenue_udp: 60 }) },
    { dim_selector: '.buy-2', dim_element_class: 'cta', metrics: JSON.stringify({ clicks: 10, clicking_sessions: 5, revenue_udp: 20 }) },
    { dim_selector: '.size', dim_element_class: 'variant_selector', metrics: JSON.stringify({ clicks: 8, clicking_sessions: 4, revenue_udp: 0 }) },
  ];

  const BINDINGS = [
    { selector: '.buy', element_role: 'add_to_cart', position_index: 0 },
    { selector: '.buy-2', element_role: 'add_to_cart', position_index: 1 },
    { selector: '.size', element_role: 'variant', position_index: -1 },
  ];

  it('aggregates kinds by element role and position index', async () => {
    const gateway = fakeGateway({
      'kind-fleet-weekly:rows': FLEET_ROWS,
      'kind-fleet-weekly:bindings': BINDINGS,
    });
    const dataset = await kindFleetWeekly.collect(SITE, makeCtx(gateway));
    expect(kindFleetWeekly.scope).toBe('site');
    expect(kindFleetWeekly.provides).toEqual(['H25']);

    const atc0 = findRow(dataset, { element_class: 'cta', element_role: 'add_to_cart', position_index: 0 });
    expect(atc0.metrics).toEqual({ instances: 1, clicks: 30, clicking_sessions: 10, revenue: 60, rpc_clicks: 2 });

    const atc1 = findRow(dataset, { element_class: 'cta', element_role: 'add_to_cart', position_index: 1 });
    expect(atc1.metrics).toEqual({ instances: 1, clicks: 10, clicking_sessions: 5, revenue: 20, rpc_clicks: 2 });

    // position_index -1 buckets as 'unknown'.
    const variant = findRow(dataset, { element_class: 'variant_selector', element_role: 'variant', position_index: 'unknown' });
    expect(variant.metrics).toEqual({ instances: 1, clicks: 8, clicking_sessions: 4, revenue: 0, rpc_clicks: 0 });

    expect(dataset.notes.kind_fleet_bindings_matched).toBe('3 of 3 dataset rows matched a binding');
  });

  it('keeps role empty and position unknown when bindings are absent', async () => {
    const gateway = fakeGateway({
      'kind-fleet-weekly:rows': FLEET_ROWS,
      'kind-fleet-weekly:bindings': new Error(UNKNOWN_TABLE_ERR),
    });
    const dataset = await kindFleetWeekly.collect(SITE, makeCtx(gateway));
    expect(dataset.rows).toHaveLength(2);
    const cta = findRow(dataset, { element_class: 'cta', element_role: '', position_index: 'unknown' });
    expect(cta.metrics).toMatchObject({ instances: 2, clicks: 40, clicking_sessions: 15, revenue: 80 });
    expect(dataset.notes.kind_fleet_bindings_note).toMatch(/ae_element_binding_current unreadable/);
  });

  it('returns zero rows plus a note when the dataset rows table is absent', async () => {
    const gateway = fakeGateway({
      'kind-fleet-weekly:rows': new Error(UNKNOWN_TABLE_ERR),
      'kind-fleet-weekly:bindings': BINDINGS,
    });
    const dataset = await kindFleetWeekly.collect(SITE, makeCtx(gateway));
    expect(dataset.rows).toEqual([]);
    expect(dataset.notes.kind_fleet_rows_note).toMatch(/ae_dataset_row_current unreadable/);
  });
});
