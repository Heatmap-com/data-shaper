import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseDescriptorImport, DESCRIPTOR_EXPIRY_DAYS } from '../src/descriptor-import.js';
import { parseGovernanceImport, changeId } from '../src/governance-import.js';
import { adapter as botDraft } from '../src/adapters/descriptor-sources/bot-draft.js';
import { adapter as descriptorSnapshot } from '../src/adapters/datasets/descriptor-snapshot.js';
import { createMemoryAePersistence } from '../src/adapters/persistence/memory.js';
import { main } from '../src/cli.js';

/**
 * Phase 5 descriptor and governance import (plan §13 descriptor-import):
 * schema validation and normalization, the bot-draft adapter's flag
 * literals, descriptor-snapshot expiry evaluation (the G1 gate input), the
 * governance round trip on the memory adapter, and the CLI error contract
 * (every violation printed, exit 1, --dry-run writes nothing).
 */

const NOW = new Date('2026-10-04T00:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const PAGE = { idsite: 1, idsitehsr: 222, url: 'https://x.com/products/a', pageType: 'product' };
const logger = { info() {}, warn() {}, error() {} };

afterEach(() => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
  while (tempDirs.length > 0) rmSync(tempDirs.pop(), { recursive: true, force: true });
});

describe('parseDescriptorImport', () => {
  it('normalizes good rows with schema defaults', () => {
    const { rows, errors } = parseDescriptorImport(
      [
        {
          idsite: 7,
          idsitehsr: 99,
          field_path: 'p01.job',
          value: 'landing',
          provenance: 'operator',
          confidence: 'high',
          owner: 'ken',
        },
        {
          idsite: 7,
          field_path: 's20.returns_policy',
          value: { exchange: 'variant' },
          provenance: 'operator',
          confidence: 'low',
          owner: 'ken',
          device_class: 'mobile',
        },
      ],
      { now: NOW },
    );
    expect(errors).toEqual([]);
    expect(rows).toHaveLength(2);

    expect(rows[0]).toMatchObject({
      idsite: 7,
      template_key: 'url:99', // idsitehsr carried → URL override key
      device_class: 'all', // default
      field_path: 'p01.job',
      value_json: '"landing"',
      provenance: 'operator',
      confidence: 'high',
      human_confirmed_by: '', // default
      owner: 'ken',
      captured_at: NOW.toISOString(),
    });
    expect(Date.parse(rows[0].expires_at)).toBe(NOW.getTime() + 90 * DAY_MS);

    // Store fields never carry a template_key (they land in
    // ae_store_descriptor); the explicit device_class is kept.
    expect(rows[1].template_key).toBeUndefined();
    expect(rows[1].device_class).toBe('mobile');
    expect(rows[1].value_json).toBe('{"exchange":"variant"}');
  });

  it('defaults template_key to "template" when no idsitehsr is carried', () => {
    const { rows } = parseDescriptorImport(
      [{ idsite: 7, field_path: 'p01.job', value: 'landing', provenance: 'operator', confidence: 'high', owner: 'ken' }],
      { now: NOW },
    );
    expect(rows[0].template_key).toBe('template');
  });

  it('accepts sub-paths whose base path exists in the schema', () => {
    const { rows, errors } = parseDescriptorImport(
      [{ idsite: 7, field_path: 'p10.hierarchy.movable', value: true, provenance: 'operator', confidence: 'high', owner: 'ken' }],
      { now: NOW },
    );
    expect(errors).toEqual([]);
    expect(rows[0].field_path).toBe('p10.hierarchy.movable');
  });

  it('rejects a path that is not in the schema', () => {
    const { errors } = parseDescriptorImport(
      [{ idsite: 7, field_path: 'p99.nope', value: 1, provenance: 'operator', confidence: 'high', owner: 'ken' }],
      { now: NOW },
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/field_path "p99\.nope" is not in descriptor\.schema\.json/);
  });

  it('rejects a sub-path whose base path is not in the schema', () => {
    const { errors } = parseDescriptorImport(
      [{ idsite: 7, field_path: 'p99.nope.deeper', value: 1, provenance: 'operator', confidence: 'high', owner: 'ken' }],
      { now: NOW },
    );
    expect(errors.some((e) => e.includes('not in descriptor.schema.json'))).toBe(true);
  });

  it('rejects bad provenance and bad confidence', () => {
    const { errors } = parseDescriptorImport(
      [
        { idsite: 7, field_path: 'p01.job', provenance: 'oracle', confidence: 'high', owner: 'k' },
        { idsite: 7, field_path: 'p01.job', provenance: 'operator', confidence: 'medium', owner: 'k' },
      ],
      { now: NOW },
    );
    expect(errors).toHaveLength(2);
    expect(errors[0]).toMatch(/provenance "oracle"/);
    expect(errors[1]).toMatch(/confidence "medium"/);
  });

  it('rejects a missing or empty owner and a bad idsite', () => {
    const { errors } = parseDescriptorImport(
      [
        { idsite: 7, field_path: 'p01.job', provenance: 'operator', confidence: 'high', owner: '' },
        { idsite: 0, field_path: 'p01.job', provenance: 'operator', confidence: 'high', owner: 'k' },
        { idsite: 7, field_path: 's16.owners', provenance: 'operator', confidence: 'high', owner: 'k', template_key: 'pdp' },
      ],
      { now: NOW },
    );
    expect(errors.some((e) => e.includes('owner must be a non-empty string'))).toBe(true);
    expect(errors.some((e) => e.includes('idsite must be a positive integer'))).toBe(true);
    expect(errors.some((e) => e.includes('must not carry a template_key'))).toBe(true);
  });

  it("serializes undefined/null value to the string 'null' (Unknown)", () => {
    const { rows } = parseDescriptorImport(
      [
        { idsite: 7, field_path: 'p02.context', provenance: 'operator', confidence: 'high', owner: 'k' },
        { idsite: 7, field_path: 'p01.job', value: null, provenance: 'operator', confidence: 'high', owner: 'k' },
        { idsite: 7, field_path: 'p01.job', value: 42, provenance: 'operator', confidence: 'high', owner: 'k' },
      ],
      { now: NOW },
    );
    expect(rows.map((r) => r.value_json)).toEqual(['null', 'null', '42']);
  });

  it('defaults expiry to captured_at + 90 days (the exported constant)', () => {
    expect(DESCRIPTOR_EXPIRY_DAYS).toBe(90);
    const captured = '2026-10-01T12:00:00.000Z';
    const { rows } = parseDescriptorImport(
      [{ idsite: 7, field_path: 'p01.job', value: 'x', provenance: 'operator', confidence: 'high', owner: 'k', captured_at: captured }],
      { now: NOW },
    );
    expect(rows[0].captured_at).toBe(captured);
    expect(rows[0].expires_at).toBe(new Date(Date.parse(captured) + 90 * DAY_MS).toISOString());
  });
});

// --- bot-draft ------------------------------------------------------------

const RENDERS = [
  { device_class: 'desktop', viewport_w: 1440, viewport_h: 900 },
  { device_class: 'mobile', viewport_w: 390, viewport_h: 844 },
];

const NODES = [
  // sections (desktop) — note the guarantee section: p09 must be drafted
  // WITHOUT guarantee_terms
  { device_class: 'desktop', node_kind: 'section', node_id: 's1', parent_section_id: '', selector: '#hero', section_type: 'hero', dom_order: 0, y: 0, is_control: 0, looks_clickable: 0, in_first_viewport: 0 },
  { device_class: 'desktop', node_kind: 'section', node_id: 's2', parent_section_id: '', selector: '#reviews', section_type: 'reviews_block', dom_order: 1, y: 1200, is_control: 0, looks_clickable: 0, in_first_viewport: 0 },
  { device_class: 'desktop', node_kind: 'section', node_id: 's3', parent_section_id: '', selector: '#guarantee', section_type: 'guarantee', dom_order: 2, y: 2400, is_control: 0, looks_clickable: 0, in_first_viewport: 0 },
  { device_class: 'desktop', node_kind: 'section', node_id: 's4', parent_section_id: '', selector: '#faq', section_type: 'faq_block', dom_order: 3, y: 3600, is_control: 0, looks_clickable: 0, in_first_viewport: 0 },
  { device_class: 'desktop', node_kind: 'section', node_id: 's5', parent_section_id: '', selector: 'header', section_type: 'nav', dom_order: 4, y: 0, is_control: 0, looks_clickable: 0, in_first_viewport: 0 },
  // elements (desktop)
  { device_class: 'desktop', node_kind: 'element', node_id: 'e1', parent_section_id: 's5', selector: 'header nav a', dom_order: 5, y: 10, is_control: 0, looks_clickable: 1, in_first_viewport: 1 },
  { device_class: 'desktop', node_kind: 'element', node_id: 'e2', parent_section_id: 's1', selector: '#buy-now', dom_order: 6, y: 400, is_control: 1, looks_clickable: 1, in_first_viewport: 1 },
  { device_class: 'desktop', node_kind: 'element', node_id: 'e3', parent_section_id: 's1', selector: 'img.hero-star', dom_order: 7, y: 100, is_control: 0, looks_clickable: 1, in_first_viewport: 1 },
  { device_class: 'desktop', node_kind: 'element', node_id: 'e4', parent_section_id: 's1', selector: '#express-checkout', dom_order: 8, y: 500, is_control: 1, looks_clickable: 1, in_first_viewport: 1 },
  { device_class: 'desktop', node_kind: 'element', node_id: 'e5', parent_section_id: 's1', selector: 'a[href*=returns-policy]', dom_order: 9, y: 600, is_control: 0, looks_clickable: 0, in_first_viewport: 0 },
  { device_class: 'desktop', node_kind: 'element', node_id: 'e6', parent_section_id: 's5', selector: '#search', dom_order: 10, y: 20, is_control: 1, looks_clickable: 1, in_first_viewport: 1 },
  // one mobile section/element so device rows exist
  { device_class: 'mobile', node_kind: 'section', node_id: 'm1', parent_section_id: '', selector: '#hero', section_type: 'hero', dom_order: 0, y: 0, is_control: 0, looks_clickable: 0, in_first_viewport: 0 },
  { device_class: 'mobile', node_kind: 'element', node_id: 'm2', parent_section_id: 'm1', selector: '#buy-now', dom_order: 1, y: 300, is_control: 1, looks_clickable: 1, in_first_viewport: 1 },
];

const SEGMENT_ROWS = [
  { dims: { week: '2026-09-28', device: 'desktop', referer: 'direct', returning: 'new', bot_filter: 'exclude_confirmed' }, metrics: { sessions: 60 } },
  { dims: { week: '2026-09-28', device: 'mobile', referer: 'paid_social', returning: 'returning', bot_filter: 'exclude_confirmed' }, metrics: { sessions: 40 } },
  { dims: { week: '2026-09-28', device: 'desktop', referer: 'direct', returning: 'new', bot_filter: 'none' }, metrics: { sessions: 100 } },
  { dims: { week: '2026-09-28', device: 'mobile', referer: 'search', returning: 'new', bot_filter: 'none' }, metrics: { sessions: 100 } },
];

const ORDER_VALUE_ROWS = [
  { dims: { bot_filter: 'exclude_confirmed', bucket: '0-50' }, metrics: { orders: 30, revenue: 900 } },
  { dims: { bot_filter: 'exclude_confirmed', bucket: '50-100' }, metrics: { orders: 10, revenue: 800 } },
];

const EVENT_ROWS = [
  { dims: { event_name: 'faq.expand', week: '2026-09-28' }, metrics: { events: 5 } },
  { dims: { event_name: 'gallery.view', week: '2026-09-28' }, metrics: { events: 2 } },
];

/** @param {{unknownTable?: boolean}} [opts] */
function fakeRenderGateway(opts = {}) {
  return {
    async query(_sql, _params, label) {
      if (opts.unknownTable) throw new Error('Code: 60. UNKNOWN_TABLE (ae_page_render_current)');
      if (label === 'bot-draft:renders') return RENDERS;
      if (label === 'bot-draft:nodes') return NODES;
      throw new Error(`unexpected query: ${label}`);
    },
  };
}

/** @param {object} gateway @param {Array<[string, object]>} [datasets] */
function draftCtx(gateway, datasets = []) {
  return {
    gateway,
    logger,
    clock: { todayUtc: () => '2026-10-04' },
    datasets: new Map(datasets),
    batchNotes: new Map(),
  };
}

describe('bot-draft adapter', () => {
  it('drafts p00/p04/p07/p08/p09/p10/p11 from a fixture render', async () => {
    const rows = await botDraft.draft(PAGE, draftCtx(fakeRenderGateway()));
    const byPathDevice = new Map(rows.map((r) => [`${r.field_path}|${r.device_class}`, r]));

    // p00.walk per device, from the render row
    const walk = byPathDevice.get('p00.walk|desktop');
    expect(JSON.parse(walk.value_json)).toEqual({ url: PAGE.url, device: 'desktop', viewport: { w: 1440, h: 900 } });
    expect(byPathDevice.get('p00.walk|mobile')).toBeDefined();

    // p04.first_viewport: in-first-viewport element list in DOM order
    const fv = JSON.parse(byPathDevice.get('p04.first_viewport|desktop').value_json);
    expect(fv).toEqual(['header nav a', '#buy-now', 'img.hero-star', '#express-checkout', '#search']);

    // p07.navigation from render node counts only
    const nav = JSON.parse(byPathDevice.get('p07.navigation|desktop').value_json);
    expect(nav).toEqual({ menu_depth: 1, search_present: 1 });

    // p08.commerce: only what the render shows; cart type unknown
    const commerce = JSON.parse(byPathDevice.get('p08.commerce|desktop').value_json);
    expect(commerce).toEqual({ add_to_cart: 1, express_checkout: 1, variant_selector: 0, cart_type: 'unknown' });

    // p10.hierarchy: order and depths only
    const hierarchy = JSON.parse(byPathDevice.get('p10.hierarchy|desktop').value_json);
    expect(hierarchy.order).toEqual(['s1', 's2', 's3', 's4', 's5']);
    expect(hierarchy.depths).toEqual({ s1: 0, s2: 1200, s3: 2400, s4: 3600, s5: 0 });
    expect(hierarchy.movable).toBeUndefined();

    // p11.affordances: looks-clickable non-controls
    const affordances = JSON.parse(byPathDevice.get('p11.affordances|desktop').value_json);
    expect(affordances).toEqual(['header nav a', 'img.hero-star']);
  });

  it('drafts p09 without guarantee_terms (except_guarantee_terms)', async () => {
    const rows = await botDraft.draft(PAGE, draftCtx(fakeRenderGateway()));
    const p09 = rows.find((r) => r.field_path === 'p09.proof_risk' && r.device_class === 'desktop');
    expect(p09).toBeDefined();
    const value = JSON.parse(p09.value_json);
    expect(value.guarantee_terms).toBeUndefined();
    expect(value).toMatchObject({ reviews_block: 1, faq_block: 1, returns_policy_link: 1, brag_bar: 0 });
  });

  it('never drafts p02/p13/p15/s20/s26/s31/s33, with renders present and absent', async () => {
    const forbidden = ['p02.context', 'p13.constraints', 'p15.revenue_join', 's20.returns_policy', 's26.economics', 's31.consent', 's33.fraud_policy'];
    for (const gateway of [fakeRenderGateway(), fakeRenderGateway({ unknownTable: true })]) {
      const rows = await botDraft.draft(PAGE, draftCtx(gateway, [
        ['page-segment-weekly', { id: 'page-segment-weekly', rows: SEGMENT_ROWS }],
        ['order-value-hist', { id: 'order-value-hist', rows: ORDER_VALUE_ROWS }],
        ['custom-event-inventory', { id: 'custom-event-inventory', rows: EVENT_ROWS }],
      ]));
      for (const path of forbidden) {
        expect(rows.some((r) => r.field_path === path || r.field_path.startsWith(`${path}.`))).toBe(false);
      }
    }
  });

  it('skips p03/p05 when no datasets are present; drafts measured-only fields when they are', async () => {
    // No datasets: measured paths are skipped entirely, render paths remain.
    const none = await botDraft.draft(PAGE, draftCtx(fakeRenderGateway()));
    expect(none.some((r) => r.field_path === 'p03.offer')).toBe(false);
    expect(none.some((r) => r.field_path === 'p05.traffic')).toBe(false);

    // With measured data: p03 carries aov_measured (never a guessed
    // shipping_threshold), p05 carries the splits and never source→promise.
    const rows = await botDraft.draft(PAGE, draftCtx(fakeRenderGateway(), [
      ['page-segment-weekly', { id: 'page-segment-weekly', rows: SEGMENT_ROWS }],
      ['order-value-hist', { id: 'order-value-hist', rows: ORDER_VALUE_ROWS }],
      ['custom-event-inventory', { id: 'custom-event-inventory', rows: EVENT_ROWS }],
    ]));
    const offer = rows.find((r) => r.field_path === 'p03.offer');
    expect(offer.device_class).toBe('all');
    expect(JSON.parse(offer.value_json)).toEqual({ aov_measured: 42.5 });

    const traffic = JSON.parse(rows.find((r) => r.field_path === 'p05.traffic').value_json);
    expect(traffic.device_split).toEqual({ desktop: 0.6, mobile: 0.4 });
    expect(traffic.new_returning_split).toEqual({ new: 0.6, returning: 0.4 });
    expect(traffic.source_shares).toEqual({ direct: 0.6, paid_social: 0.4 });
    expect(Object.keys(traffic).some((k) => /promise/i.test(k))).toBe(false);

    // p14: the observed event-name list only, no validation status.
    const events = rows.find((r) => r.field_path === 'p14.events');
    expect(JSON.parse(events.value_json)).toEqual(['faq.expand', 'gallery.view']);
  });

  it('drafts p14 as an empty list when the inventory dataset is absent', async () => {
    const rows = await botDraft.draft(PAGE, draftCtx(fakeRenderGateway()));
    const events = rows.find((r) => r.field_path === 'p14.events');
    expect(JSON.parse(events.value_json)).toEqual([]);
  });

  it('marks every draft bot_draft / low / owner bot-draft with a 90-day expiry', async () => {
    const rows = await botDraft.draft(PAGE, draftCtx(fakeRenderGateway()));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.provenance).toBe('bot_draft');
      expect(row.confidence).toBe('low');
      expect(row.owner).toBe('bot-draft');
      expect(row.human_confirmed_by).toBe('');
      expect(row.template_key).toBe('url:222');
      expect(Date.parse(row.expires_at) - Date.parse(row.captured_at)).toBe(90 * DAY_MS);
    }
  });

  it('tolerates UNKNOWN_TABLE render reads: render paths skipped, no throw', async () => {
    const rows = await botDraft.draft(PAGE, draftCtx(fakeRenderGateway({ unknownTable: true })));
    const renderPaths = ['p00.walk', 'p04.first_viewport', 'p07.navigation', 'p08.commerce', 'p09.proof_risk', 'p10.hierarchy', 'p11.affordances'];
    for (const path of renderPaths) {
      expect(rows.some((r) => r.field_path === path)).toBe(false);
    }
  });

  it('memoizes render reads on batchNotes', async () => {
    const gateway = fakeRenderGateway();
    const spy = vi.spyOn(gateway, 'query');
    const ctx = draftCtx(gateway);
    await botDraft.draft(PAGE, ctx);
    const callsAfterFirst = spy.mock.calls.length;
    await botDraft.draft(PAGE, ctx);
    expect(spy.mock.calls.length).toBe(callsAfterFirst); // no second gateway read
  });
});

// --- descriptor-snapshot ---------------------------------------------------

const FUTURE = new Date(NOW.getTime() + 30 * DAY_MS).toISOString();
const PAST = new Date(NOW.getTime() - 30 * DAY_MS).toISOString();

/** @returns {Promise<import('../src/adapters/persistence/memory.js')>} */
async function persistenceWithDescriptors() {
  const { adapter } = createMemoryAePersistence();
  await adapter.writeDescriptorRows([
    { idsite: 1, template_key: 'pdp', device_class: 'all', field_path: 'p01.job', value_json: '"landing"', provenance: 'operator', confidence: 'high', owner: 'k', captured_at: NOW.toISOString(), expires_at: FUTURE },
    { idsite: 1, template_key: 'pdp', device_class: 'mobile', field_path: 'p04.first_viewport', value_json: '["#buy"]', provenance: 'bot_draft', confidence: 'high', owner: 'bot-draft', captured_at: NOW.toISOString(), expires_at: PAST },
    { idsite: 1, template_key: 'pdp', device_class: 'all', field_path: 'p09.proof_risk', value_json: '{}', provenance: 'bot_draft', confidence: 'low', owner: 'bot-draft', captured_at: NOW.toISOString(), expires_at: FUTURE },
    { idsite: 1, template_key: 'pdp', device_class: 'all', field_path: 'p10.hierarchy', value_json: '{"order":[]}', provenance: 'operator', confidence: 'high', owner: 'k', captured_at: NOW.toISOString(), expires_at: FUTURE, invalidated_by: 'chg-9' },
    { idsite: 1, field_path: 's16.owners', value_json: '{"pdp":"native"}', provenance: 'operator', confidence: 'high', owner: 'k', captured_at: NOW.toISOString(), expires_at: FUTURE },
    { idsite: 1, field_path: 's31.consent', value_json: '{}', provenance: 'operator', confidence: 'low', owner: 'k', captured_at: NOW.toISOString(), expires_at: FUTURE },
  ]);
  return adapter;
}

function snapshotCtx(persistence) {
  return {
    persistence,
    gateway: {
      async query() {
        throw new Error('gateway must not be used when persistence is present');
      },
    },
    logger,
    clock: { todayUtc: () => '2026-10-04' },
    datasets: new Map(),
    batchNotes: new Map(),
    pageTargets: [{ idsitehsr: 222, templateFamily: 'pdp' }],
  };
}

describe('descriptor-snapshot dataset', () => {
  it('is a site-scope dataset with no provides and no dependsOn', () => {
    expect(descriptorSnapshot.id).toBe('descriptor-snapshot');
    expect(descriptorSnapshot.scope).toBe('site');
    expect(descriptorSnapshot.provides).toEqual([]);
    expect(descriptorSnapshot.dependsOn).toEqual([]);
  });

  it('evaluates expiry per field: current / expired / unknown, invalidated_by marks expired', async () => {
    const adapter = await persistenceWithDescriptors();
    const dataset = await descriptorSnapshot.collect({ idsite: 1, idsitehsr: 0 }, snapshotCtx(adapter));

    const byPath = new Map(dataset.rows.map((r) => [`${r.dims.scope}|${r.dims.field_path}|${r.dims.device_class}`, r]));
    expect(dataset.rows).toHaveLength(6);

    const current = byPath.get('page|p01.job|all');
    expect(current.dims).toEqual({ scope: 'page', template_key: 'pdp', device_class: 'all', field_path: 'p01.job' });
    expect(current.metrics.status).toBe('current');
    expect(current.metrics).toMatchObject({ value_json: '"landing"', provenance: 'operator', confidence: 'high' });

    // past expiry → expired
    expect(byPath.get('page|p04.first_viewport|mobile').metrics.status).toBe('expired');
    // low confidence counts as unknown even when unexpired
    expect(byPath.get('page|p09.proof_risk|all').metrics.status).toBe('unknown');
    // invalidated_by set → expired even when unexpired
    expect(byPath.get('page|p10.hierarchy|all').metrics.status).toBe('expired');

    // store rows carry no template_key
    const owners = byPath.get('store|s16.owners|all');
    expect(owners.dims.scope).toBe('store');
    expect(owners.dims.template_key).toBeUndefined();
    expect(owners.metrics.status).toBe('current');
    expect(byPath.get('store|s31.consent|all').metrics.status).toBe('unknown');

    expect(dataset.notes).toMatchObject({ descriptor_fields_current: 2, expired: 2, unknown: 2 });
  });

  it('falls back to the gateway (UNKNOWN_TABLE-tolerant) without persistence', async () => {
    const gateway = {
      async query(_sql, _params, label) {
        if (label === 'descriptor-snapshot:page') {
          return [
            { template_key: 'pdp', device_class: 'all', field_path: 'p01.job', value_json: '"landing"', provenance: 'operator', confidence: 'high', expires_at: FUTURE, invalidated_by: '' },
          ];
        }
        if (label === 'descriptor-snapshot:store') {
          throw new Error('Code: 60. UNKNOWN_TABLE (ae_store_descriptor_current)');
        }
        throw new Error(`unexpected query: ${label}`);
      },
    };
    const ctx = { ...snapshotCtx(null), gateway, persistence: null };
    const dataset = await descriptorSnapshot.collect({ idsite: 1, idsitehsr: 0 }, ctx);
    expect(dataset.rows).toHaveLength(1);
    expect(dataset.rows[0].metrics.status).toBe('current');
    expect(dataset.notes.descriptor_snapshot_note).toMatch(/ae_store_descriptor_current unreadable/);
  });
});

// --- governance round trip on the memory adapter ---------------------------

const GOVERNANCE_ROWS = [
  {
    kind: 'experiment',
    idsite: 1,
    experiment_id: 'exp-1',
    name: 'hero headline',
    unit: 'session',
    arms: [{ arm: 'control', allocation: 0.5 }, { arm: 'b', allocation: 0.5 }],
    test_code: 'AB',
    mde: 0.05,
    analysis_plan: 'fixed',
    started_at: '2026-09-01T00:00:00.000Z',
    status: 'running',
  },
  {
    kind: 'review_verdict',
    idsite: 1,
    subject_kind: 'event',
    subject_ref: 'faq.expand',
    verdict_kind: 'event_validation',
    outcome: 'pass',
    sample_size: 40,
    agreement_rate: 0.95,
    reviewed_by: 'ken',
  },
  {
    kind: 'change',
    idsite: 1,
    change_kind: 'theme_deploy',
    effective_at: '2026-10-01T00:00:00.000Z',
    subject: 'pdp',
    detail: { theme_id: 'abc' },
  },
  {
    kind: 'calendar_event',
    idsite: 1,
    name: 'black friday',
    window: { start: '2026-11-27', end: '2026-11-30' },
    flags: { sale: true },
  },
];

describe('governance import', () => {
  it('produces deterministic change ids and uuid verdict ids', () => {
    expect(changeId('theme_deploy', 'pdp', '2026-10-01T00:00:00.000Z')).toBe(
      changeId('theme_deploy', 'pdp', '2026-10-01T00:00:00.000Z'),
    );
    const { verdicts, changes } = parseGovernanceImport(GOVERNANCE_ROWS, { now: NOW });
    expect(verdicts[0].verdictId).toMatch(/^[0-9a-f-]{36}$/);
    expect(changes[0].change_id).toMatch(/^[0-9a-f]{40}$/);
  });

  it('round-trips experiments, verdicts, changes and calendar on the memory adapter', async () => {
    const parsed = parseGovernanceImport(GOVERNANCE_ROWS, { now: NOW });
    expect(parsed.errors).toEqual([]);

    const { adapter, snapshot } = createMemoryAePersistence();
    await adapter.writeExperiments(parsed.experiments);
    await adapter.writeVerdicts(parsed.verdicts);
    await adapter.writeChanges(parsed.changes);
    await adapter.writeDescriptorRows(parsed.descriptorRows);

    const experiments = snapshot().experiments;
    expect(experiments).toHaveLength(1);
    expect(experiments[0]).toMatchObject({ idsite: 1, experiment_id: 'exp-1', source: 'operator', status: 'running' });
    expect(JSON.parse(experiments[0].arms)).toEqual([
      { arm: 'control', description: '', allocation: 0.5 },
      { arm: 'b', description: '', allocation: 0.5 },
    ]);

    const verdicts = snapshot().verdicts;
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]).toMatchObject({ subject_kind: 'event', verdict_kind: 'event_validation', outcome: 'pass', reviewed_by: 'ken' });

    const changes = snapshot().changeLog;
    expect(changes).toHaveLength(1);
    expect(changes[0].change_id).toBe(changeId('theme_deploy', 'pdp', '2026-10-01T00:00:00.000Z'));
    expect(JSON.parse(changes[0].detail)).toEqual({ theme_id: 'abc' });

    // calendar rides writeDescriptorRows as one s35.calendar store row
    const calendar = snapshot().storeDescriptors;
    expect(calendar).toHaveLength(1);
    expect(calendar[0].field_path).toBe('s35.calendar');
    expect(calendar[0].provenance).toBe('operator');
    expect(JSON.parse(calendar[0].value_json)).toEqual({
      name: 'black friday',
      window: { start: '2026-11-27', end: '2026-11-30' },
      flags: { sale: true },
    });
  });

  it('idempotent re-import: same rows replace instead of duplicating', async () => {
    const { adapter, snapshot } = createMemoryAePersistence();
    // verdict_id pinned: an omitted id mints a new uuid per import (each
    // import is a new review), so idempotency reads the ORDER BY key.
    const rows = GOVERNANCE_ROWS.map((r) => (r.kind === 'review_verdict' ? { ...r, verdict_id: 'vd-1' } : r));
    for (let run = 0; run < 2; run += 1) {
      const parsed = parseGovernanceImport(rows, { now: NOW });
      await adapter.writeExperiments(parsed.experiments);
      await adapter.writeVerdicts(parsed.verdicts);
      await adapter.writeChanges(parsed.changes);
      await adapter.writeDescriptorRows(parsed.descriptorRows);
    }
    expect(snapshot().experiments).toHaveLength(1);
    expect(snapshot().verdicts).toHaveLength(1);
    expect(snapshot().verdicts[0].verdict_id).toBe('vd-1');
    expect(snapshot().changeLog).toHaveLength(1);
    expect(snapshot().storeDescriptors).toHaveLength(1);
  });

  it('rejects unknown kinds and missing fields per kind', () => {
    const { errors } = parseGovernanceImport(
      [
        { kind: 'mystery', idsite: 1 },
        { kind: 'experiment', idsite: 1, arms: [] },
        { kind: 'review_verdict', idsite: 1, subject_kind: 'event', subject_ref: 'x', verdict_kind: 'event_validation', outcome: 'maybe', reviewed_by: 'k' },
        { kind: 'change', idsite: 1, change_kind: 'theme_deploy', effective_at: '2026-10-01' },
        { kind: 'calendar_event', idsite: 1, name: 'x', window: { start: '2026-11-01' } },
      ],
      { now: NOW },
    );
    expect(errors).toHaveLength(6);
    expect(errors[0]).toMatch(/kind "mystery"/);
    expect(errors[1]).toMatch(/experiment_id must be a non-empty string/);
    expect(errors[2]).toMatch(/arms must be a non-empty array/);
    expect(errors[3]).toMatch(/outcome "maybe"/);
    expect(errors[4]).toMatch(/missing required field subject/);
    expect(errors[5]).toMatch(/window\.end is required/);
  });
});

// --- CLI --------------------------------------------------------------------

/** @param {unknown} data @returns {string} temp file path */
const tempDirs = [];
function tempJson(data) {
  const dir = mkdtempSync(path.join(tmpdir(), 'ae-import-'));
  tempDirs.push(dir);
  const file = path.join(dir, 'rows.json');
  writeFileSync(file, JSON.stringify(data));
  return file;
}

const GOOD_DESCRIPTORS = [
  { idsite: 7, idsitehsr: 55, field_path: 'p01.job', value: 'landing', provenance: 'operator', confidence: 'high', owner: 'ken' },
  { idsite: 7, field_path: 'p01.job', value: null, provenance: 'bot_draft', confidence: 'low', owner: 'bot-draft' },
];

describe('cli import commands', () => {
  it('--descriptor-import prints every violation and exits 1 on error', async () => {
    const file = tempJson([
      { idsite: 7, field_path: 'p01.job', provenance: 'oracle', confidence: 'high', owner: 'k' },
      { idsite: 7, field_path: 'p99.nope', provenance: 'operator', confidence: 'high', owner: 'k' },
      { idsite: -1, field_path: 'p01.job', provenance: 'operator', confidence: 'high', owner: '' },
    ]);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await main(['--descriptor-import', file]);
    expect(process.exitCode).toBe(1);
    const printed = spy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(printed).toMatch(/provenance "oracle"/);
    expect(printed).toMatch(/field_path "p99\.nope" is not in descriptor\.schema\.json/);
    expect(printed).toMatch(/idsite must be a positive integer/);
    expect(printed).toMatch(/owner must be a non-empty string/);
  });

  it('--descriptor-import --dry-run validates without writing', async () => {
    const file = tempJson(GOOD_DESCRIPTORS);
    const { adapter } = createMemoryAePersistence();
    const write = vi.spyOn(adapter, 'writeDescriptorRows');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await main(['--descriptor-import', file, '--dry-run'], { persistence: adapter });
    expect(write).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
    expect(log.mock.calls[0][0]).toMatch(/"dry_run":true/);
    expect(log.mock.calls[0][0]).toMatch(/"operator":1/);
    expect(log.mock.calls[0][0]).toMatch(/"bot_draft":1/);
  });

  it('--descriptor-import writes rows and prints counts per provenance', async () => {
    const file = tempJson(GOOD_DESCRIPTORS);
    const { adapter, snapshot } = createMemoryAePersistence();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await main(['--descriptor-import', file], { persistence: adapter });
    expect(process.exitCode).toBeUndefined();
    expect(snapshot().pageDescriptors).toHaveLength(2);
    expect(log.mock.calls[0][0]).toMatch(/"rows":2/);
    expect(log.mock.calls[0][0]).toMatch(/"by_provenance":\{"operator":1,"bot_draft":1\}/);
  });

  it('--governance-import prints every violation and exits 1 on error', async () => {
    const file = tempJson([
      { kind: 'experiment', idsite: 1 },
      { kind: 'review_verdict', idsite: 1, subject_kind: 'event', subject_ref: 'x', verdict_kind: 'event_validation', outcome: 'pass', reviewed_by: '' },
    ]);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await main(['--governance-import', file]);
    expect(process.exitCode).toBe(1);
    const printed = spy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(printed).toMatch(/experiment_id must be a non-empty string/);
    expect(printed).toMatch(/arms must be a non-empty array/);
    expect(printed).toMatch(/reviewed_by must be a non-empty string/);
  });

  it('--governance-import writes all four kinds and prints counts per kind', async () => {
    const file = tempJson(GOVERNANCE_ROWS);
    const { adapter, snapshot } = createMemoryAePersistence();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await main(['--governance-import', file], { persistence: adapter });
    expect(process.exitCode).toBeUndefined();
    expect(snapshot().experiments).toHaveLength(1);
    expect(snapshot().verdicts).toHaveLength(1);
    expect(snapshot().changeLog).toHaveLength(1);
    expect(snapshot().storeDescriptors).toHaveLength(1);
    expect(log.mock.calls[0][0]).toMatch(/"by_kind":\{"experiment":1,"experiment_descriptor":0,"review_verdict":1,"change":1,"calendar_event":1\}/);
  });

  it('--governance-import --dry-run writes nothing', async () => {
    const file = tempJson(GOVERNANCE_ROWS);
    const { adapter } = createMemoryAePersistence();
    const write = vi.spyOn(adapter, 'writeExperiments');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await main(['--governance-import', file, '--dry-run'], { persistence: adapter });
    expect(write).not.toHaveBeenCalled();
  });
});
