import { describe, expect, it } from 'vitest';
import { loadCatalog } from '../src/catalog/index.js';
import { TAXONOMY_VERSION } from '../src/domain/taxonomy.js';
import { createMemoryAePersistence } from '../src/adapters/persistence/memory.js';
import { _setClockForTests, createClickHouseAePersistence } from '../src/adapters/persistence/clickhouse.js';
import { ensureAeSchema } from '../src/adapters/persistence/clickhouse/schema-migrator.js';
import { DEFAULT_DATABASE as DATABASE } from '../src/adapters/query-gateway/clickhouse.js';
import { AE_PERSISTENCE_ROLES, missingRoleMethods } from '../src/ports/persistence/index.js';

/**
 * Schema-2 persistence contract (data-capture-plan.md §9.1): the memory
 * adapter and the ClickHouse adapter (over a fake client that emulates the
 * _current FINAL views) both run the same script: batch, site queue claims
 * with TTL reclaim, page targets, the capture round trip with taxonomy
 * validation and site re-queue, descriptors latest-per-field, change log
 * window, dataset rows idempotent on row_key, requirement status, cards with
 * cardHistory ordering, analysis rows, and the idempotent reference seed.
 */

const T = (name) => `${DATABASE}.ae_${name}`;
const BATCH = T('batch');
const SITE_QUEUE = T('site_queue');
const PAGE_TARGET = T('page_target');
const CAPTURE_QUEUE = T('capture_queue');
const PAGE_CAPTURE = T('page_capture');
const ELEMENT_BINDING = T('element_binding');
const PAGE_RENDER = T('page_render');
const RENDER_NODE = T('render_node');
const PAGE_DESCRIPTOR = T('page_descriptor');
const STORE_DESCRIPTOR = T('store_descriptor');
const CHANGE_LOG = T('change_log');
const DATASET_ROW = T('dataset_row');
const REQUIREMENT_STATUS = T('requirement_status');
const STRATEGY_CARD = T('strategy_card');
const PAGE_ANALYSIS = T('page_analysis');
const SITE_ANALYSIS = T('site_analysis');
const REQUIREMENT = T('requirement');
const STRATEGY_CATALOG = T('strategy_catalog');
const STRATEGY_CROSSWALK = T('strategy_crosswalk');
const SCREEN_RULE = T('screen_rule');
const TREND_ROW = T('trend_row');
const TREND_SELECTOR = T('trend_selector');
const TAG_TREND = T('session_tag_trend');
const TAG_SELECTION = T('session_tag_selection');
const SEGMENTATION_DEFINITION = T('segmentation_definition');

/** Latest-row-wins resolution, mirroring the _current views in schema2.sql. */
function currentRows(table, rows) {
  const keyFns = {
    [BATCH]: (r) => r.batch_id,
    [SITE_QUEUE]: (r) => `${r.batch_id}|${r.idsite}`,
    [PAGE_TARGET]: (r) => `${r.batch_id}|${r.idsite}|${r.idsitehsr}`,
    [CAPTURE_QUEUE]: (r) => `${r.idsite}|${r.idsitehsr}`,
    [PAGE_CAPTURE]: (r) => `${r.idsite}|${r.idsitehsr}`,
    [ELEMENT_BINDING]: (r) => `${r.idsite}|${r.idsitehsr}|${r.selector}`,
    [PAGE_RENDER]: (r) => `${r.idsite}|${r.idsitehsr}|${r.device_class}`,
    [RENDER_NODE]: (r) => `${r.idsite}|${r.idsitehsr}|${r.device_class}|${r.node_id}`,
    [PAGE_DESCRIPTOR]: (r) => `${r.idsite}|${r.template_key}|${r.device_class}|${r.field_path}`,
    [STORE_DESCRIPTOR]: (r) => `${r.idsite}|${r.field_path}`,
    [CHANGE_LOG]: (r) => `${r.idsite}|${r.change_id}`,
    [DATASET_ROW]: (r) => `${r.batch_id}|${r.idsite}|${r.idsitehsr}|${r.dataset_id}|${r.row_key}`,
    [REQUIREMENT_STATUS]: (r) => `${r.batch_id}|${r.idsite}|${r.idsitehsr}|${r.requirement_key}`,
    [STRATEGY_CARD]: (r) =>
      `${r.batch_id}|${r.idsite}|${r.idsitehsr}|${r.catalog_id}|${r.strategy_id}|${r.segment_key}`,
    [PAGE_ANALYSIS]: (r) => `${r.batch_id}|${r.idsite}|${r.idsitehsr}`,
    [SITE_ANALYSIS]: (r) => `${r.batch_id}|${r.idsite}`,
    [REQUIREMENT]: (r) => `${r.registry_version}|${r.requirement_key}`,
    [STRATEGY_CATALOG]: (r) => `${r.catalog_version}|${r.catalog_id}|${r.strategy_id}`,
    [STRATEGY_CROSSWALK]: (r) => `${r.catalog_version}|${r.intent_id}|${r.catalog_id}|${r.strategy_id}`,
    [SCREEN_RULE]: (r) => `${r.catalog_version}|${r.catalog_id}|${r.rule_id}`,
    [TREND_ROW]: (r) =>
      [r.idsite, r.row_type, r.row_key, r.row_key_1, r.row_key_2, r.viewport_type, r.segment, r.segment_value, r.week, r.idsitehsr].join('|'),
    [TREND_SELECTOR]: (r) => `${r.idsite}|${r.idsitehsr}`,
    [TAG_TREND]: (r) => [r.idsite, r.tag_key, r.tag_value, r.viewport_type, r.segment, r.segment_value, r.week].join('|'),
    [TAG_SELECTION]: (r) => `${r.idsite}|${r.tag_key}`,
    [SEGMENTATION_DEFINITION]: (r) => `${r.idsite}|${r.segmentation}|${r.version}`,
  };
  const byKey = new Map();
  for (const row of rows) {
    const key = keyFns[table](row);
    const prev = byKey.get(key);
    if (!prev || String(prev.generated_at) <= String(row.generated_at)) byKey.set(key, row);
  }
  return [...byKey.values()];
}

const IN_FLIGHT_SITE = ['claimed', 'selecting_pages', 'analyzing'];

function createFakeAeClient() {
  /** @type {Map<string, object[]>} */
  const tables = new Map();
  /** @type {string[]} */
  const commands = [];
  const rowsOf = (t) => tables.get(t) ?? [];

  return {
    tables,
    commands,
    async insert({ table, values }) {
      tables.set(table, [...rowsOf(table), ...values]);
    },
    async command({ query, query_params = {} }) {
      commands.push(query);
      if (query.startsWith('CREATE ')) return;
      if (query.includes(`INSERT INTO ${SITE_QUEUE}`)) {
        const batchId = query_params.batchId;
        const existing = new Set(
          currentRows(SITE_QUEUE, rowsOf(SITE_QUEUE))
            .filter((r) => r.batch_id === batchId)
            .map((r) => Number(r.idsite)),
        );
        const fresh = [];
        for (let i = 0; query_params[`idsite${i}`] !== undefined; i += 1) {
          if (existing.has(query_params[`idsite${i}`])) continue;
          fresh.push({
            batch_id: batchId,
            idsite: query_params[`idsite${i}`],
            site_name: query_params[`name${i}`],
            status: 'queued',
            reason: '',
            claim_token: '',
            pages_selected: 0,
            pages_analyzed: 0,
            entry_sessions: 0,
            orders: 0,
            revenue: 0,
            generated_at: query_params[`ts${i}`],
          });
        }
        tables.set(SITE_QUEUE, [...rowsOf(SITE_QUEUE), ...fresh]);
        return;
      }
      if (query.startsWith(`ALTER TABLE ${DATASET_ROW}`)) {
        const ids = new Set(query_params.ids);
        const pageScoped = query.includes('idsitehsr = {idsitehsr:UInt64}');
        tables.set(DATASET_ROW, rowsOf(DATASET_ROW).filter((r) => !(
          r.batch_id === query_params.batchId
          && Number(r.idsite) === Number(query_params.idsite)
          && ids.has(r.dataset_id)
          && (!pageScoped || Number(r.idsitehsr) === Number(query_params.idsitehsr))
        )));
        return;
      }
      throw new Error(`fake client: unexpected command ${query.slice(0, 80)}`);
    },
    async query({ query, query_params = {} }) {
      let rows = [];
      if (query.includes(`FROM ${SITE_QUEUE}`)) {
        const cur = currentRows(SITE_QUEUE, rowsOf(SITE_QUEUE));
        if (query.includes('LIMIT 1')) {
          const staleBefore = String(query_params.staleBefore ?? '');
          rows = cur
            .filter((r) => r.batch_id === query_params.batchId)
            .filter(
              (r) =>
                r.status === 'queued' ||
                (IN_FLIGHT_SITE.includes(r.status) && String(r.generated_at) <= staleBefore),
            )
            .sort((a, b) => Number(a.idsite) - Number(b.idsite))
            .slice(0, 1);
        } else if (query.includes('claim_token')) {
          rows = cur
            .filter((r) => r.batch_id === query_params.batchId && Number(r.idsite) === Number(query_params.idsite))
            .map((r) => ({ claim_token: r.claim_token ?? '' }));
        } else {
          rows = cur.filter(
            (r) => r.batch_id === query_params.batchId && Number(r.idsite) === Number(query_params.idsite),
          );
        }
      } else if (query.includes(`FROM ${PAGE_TARGET}`)) {
        const cur = currentRows(PAGE_TARGET, rowsOf(PAGE_TARGET));
        if (query.includes('count(')) {
          const counts = new Map();
          for (const r of cur.filter(
            (r) =>
              r.batch_id === query_params.batchId &&
              Number(r.idsite) === Number(query_params.idsite) &&
              r.status === 'awaiting_capture',
          )) {
            counts.set(r.batch_id, (counts.get(r.batch_id) ?? 0) + 1);
          }
          rows = [...counts].map(([batch_id, awaiting]) => ({ batch_id, awaiting }));
        } else if (query.includes('awaiting_capture')) {
          rows = cur.filter(
            (r) =>
              Number(r.idsite) === Number(query_params.idsite) &&
              Number(r.idsitehsr) === Number(query_params.idsitehsr) &&
              r.status === 'awaiting_capture',
          );
        } else {
          rows = cur.filter(
            (r) =>
              r.batch_id === query_params.batchId &&
              Number(r.idsite) === Number(query_params.idsite) &&
              Number(r.idsitehsr) === Number(query_params.idsitehsr),
          );
        }
      } else if (query.includes(`FROM ${CAPTURE_QUEUE}`)) {
        const cur = currentRows(CAPTURE_QUEUE, rowsOf(CAPTURE_QUEUE));
        if (query.includes('LIMIT 1')) {
          const staleBefore = String(query_params.staleBefore ?? '');
          rows = cur
            .filter(
              (r) =>
                r.status === 'queued' ||
                (r.status === 'claimed' && String(r.generated_at) <= staleBefore),
            )
            .sort(
              (a, b) =>
                String(a.requested_on).localeCompare(String(b.requested_on)) ||
                Number(a.idsite) - Number(b.idsite) ||
                Number(a.idsitehsr) - Number(b.idsitehsr),
            )
            .slice(0, 1);
        } else if (query.includes('claim_token')) {
          rows = cur
            .filter(
              (r) =>
                Number(r.idsite) === Number(query_params.idsite) &&
                Number(r.idsitehsr) === Number(query_params.idsitehsr),
            )
            .map((r) => ({ claim_token: r.claim_token ?? '' }));
        } else {
          rows = cur.filter(
            (r) =>
              Number(r.idsite) === Number(query_params.idsite) &&
              Number(r.idsitehsr) === Number(query_params.idsitehsr),
          );
        }
      } else if (query.includes(`FROM ${PAGE_RENDER}`)) {
        rows = currentRows(PAGE_RENDER, rowsOf(PAGE_RENDER)).filter(
          (r) =>
            Number(r.idsite) === Number(query_params.idsite) &&
            Number(r.idsitehsr) === Number(query_params.idsitehsr) &&
            r.device_class === query_params.deviceClass,
        );
      } else if (query.includes(`FROM ${PAGE_CAPTURE}`)) {
        rows = currentRows(PAGE_CAPTURE, rowsOf(PAGE_CAPTURE)).filter(
          (r) =>
            Number(r.idsite) === Number(query_params.idsite) &&
            Number(r.idsitehsr) === Number(query_params.idsitehsr),
        );
      } else if (query.includes(`FROM ${PAGE_DESCRIPTOR}`)) {
        rows = currentRows(PAGE_DESCRIPTOR, rowsOf(PAGE_DESCRIPTOR))
          .filter(
            (r) =>
              Number(r.idsite) === Number(query_params.idsite) &&
              r.template_key === query_params.templateKey &&
              r.device_class === query_params.deviceClass,
          )
          .sort((a, b) => String(a.field_path).localeCompare(String(b.field_path)));
      } else if (query.includes(`FROM ${STORE_DESCRIPTOR}`)) {
        rows = currentRows(STORE_DESCRIPTOR, rowsOf(STORE_DESCRIPTOR))
          .filter((r) => Number(r.idsite) === Number(query_params.idsite))
          .sort((a, b) => String(a.field_path).localeCompare(String(b.field_path)));
      } else if (query.includes(`FROM ${CHANGE_LOG}`)) {
        rows = currentRows(CHANGE_LOG, rowsOf(CHANGE_LOG))
          .filter(
            (r) =>
              Number(r.idsite) === Number(query_params.idsite) &&
              String(r.effective_at) >= String(query_params.fromIso) &&
              String(r.effective_at) <= String(query_params.toIso),
          )
          .sort(
            (a, b) =>
              String(a.effective_at).localeCompare(String(b.effective_at)) ||
              String(a.change_id).localeCompare(String(b.change_id)),
          );
      } else if (query.includes(`FROM ${STRATEGY_CARD}`)) {
        rows = currentRows(STRATEGY_CARD, rowsOf(STRATEGY_CARD))
          .filter(
            (r) =>
              Number(r.idsite) === Number(query_params.idsite) &&
              r.strategy_id === query_params.strategyId,
          )
          .sort((a, b) => String(b.generated_at).localeCompare(String(a.generated_at)))
          .slice(0, Number(query_params.n));
      } else if (query.includes(`FROM ${BATCH}`)) {
        rows = currentRows(BATCH, rowsOf(BATCH)).filter((r) => r.batch_id === query_params.batchId);
      } else if (query.includes(`FROM ${DATASET_ROW}`)) {
        rows = currentRows(DATASET_ROW, rowsOf(DATASET_ROW)).filter((r) =>
          r.batch_id === query_params.batchId
          && Number(r.idsite) === Number(query_params.idsite)
          && Number(r.idsitehsr) === Number(query_params.idsitehsr)
          && r.dataset_id === query_params.datasetId);
      } else if ((query.includes(`FROM ${TREND_ROW}`) || query.includes(`FROM ${TAG_TREND}`)) && query.includes('{segment:String}')) {
        const table = query.includes(`FROM ${TREND_ROW}`) ? TREND_ROW : TAG_TREND;
        const site = currentRows(table, rowsOf(table))
          .filter((r) => Number(r.idsite) === Number(query_params.idsite) && r.segment === query_params.segment);
        if (query.includes('DISTINCT segment_value')) {
          rows = [...new Set(site.map((r) => r.segment_value))].sort().map((segment_value) => ({ segment_value }));
        } else {
          const ranges = new Map();
          for (const r of site) {
            if (table === TREND_ROW && !['path', 'url_path', 'page', 'selector'].includes(r.row_key)) continue;
            const key = table === TREND_ROW ? `${r.row_key}|${r.idsitehsr}|${r.row_key_1}|${r.row_key_2}` : r.tag_key;
            const seen = ranges.get(key);
            const subject = table === TREND_ROW ? { row_key: r.row_key, row_key_1: r.row_key_1, row_key_2: r.row_key_2, idsitehsr: r.idsitehsr } : { tag_key: r.tag_key };
            ranges.set(key, { ...subject, first: seen && seen.first < r.week ? seen.first : r.week, last: seen && seen.last > r.week ? seen.last : r.week });
          }
          rows = [...ranges.keys()].sort().map((key) => ranges.get(key));
        }
      } else if (query.includes(`FROM ${TREND_ROW}`) && query.includes('max(week)')) {
        const latest = new Map();
        for (const r of currentRows(TREND_ROW, rowsOf(TREND_ROW))) {
          if (Number(r.idsite) !== Number(query_params.idsite)) continue;
          if (r.viewport_type !== 'all' || r.segment !== 'all' || r.segment_value !== 'all') continue;
          if (!['path', 'url_path', 'page', 'selector'].includes(r.row_key)) continue;
          const key = `${r.row_key}|${r.idsitehsr}|${r.row_key_1}`;
          if ((latest.get(key)?.week ?? '') < r.week) latest.set(key, { row_key: r.row_key, row_key_1: r.row_key_1, idsitehsr: r.idsitehsr, week: r.week });
        }
        rows = [...latest.values()].sort((a, b) => a.row_key.localeCompare(b.row_key) || Number(a.idsitehsr) - Number(b.idsitehsr) || a.row_key_1.localeCompare(b.row_key_1));
      } else if (query.includes(`FROM ${TAG_TREND}`)) {
        const latest = new Map();
        for (const r of currentRows(TAG_TREND, rowsOf(TAG_TREND))) {
          if (Number(r.idsite) !== Number(query_params.idsite)) continue;
          if (r.viewport_type !== 'all' || r.segment !== 'all' || r.segment_value !== 'all') continue;
          if ((latest.get(r.tag_key) ?? '') < r.week) latest.set(r.tag_key, r.week);
        }
        rows = [...latest].sort(([a], [b]) => a.localeCompare(b)).map(([tag_key, week]) => ({ tag_key, week }));
      } else if (query.includes(`FROM ${TREND_ROW}`)) {
        const subjects = new Map();
        for (const r of currentRows(TREND_ROW, rowsOf(TREND_ROW))) {
          if (Number(r.idsite) !== Number(query_params.idsite)) continue;
          if (r.viewport_type !== 'all' || r.segment !== 'all' || r.segment_value !== 'all') continue;
          if (!['path', 'url_path', 'page'].includes(r.row_key)) continue;
          const rank = Math.trunc(Number(JSON.parse(r.metrics).rank) || 0);
          const key = `${r.row_key}|${r.row_key_1}`;
          const seen = subjects.get(key);
          if (!seen || rank < seen.rank) subjects.set(key, { row_key: r.row_key, row_key_1: r.row_key_1, rank });
        }
        rows = [...subjects.values()].sort((a, b) => a.rank - b.rank || a.row_key_1.localeCompare(b.row_key_1)).slice(0, 100);
      } else if (query.includes(`FROM ${SEGMENTATION_DEFINITION}`)) {
        rows = currentRows(SEGMENTATION_DEFINITION, rowsOf(SEGMENTATION_DEFINITION))
          .filter((r) => Number(r.idsite) === Number(query_params.idsite) || Number(r.idsite) === 0);
      } else if (query.includes(`FROM ${TREND_SELECTOR}`)) {
        rows = currentRows(TREND_SELECTOR, rowsOf(TREND_SELECTOR)).filter((r) => Number(r.idsite) === Number(query_params.idsite));
      } else if (query.includes(`FROM ${TAG_SELECTION}`)) {
        const site = currentRows(TAG_SELECTION, rowsOf(TAG_SELECTION)).filter((r) => Number(r.idsite) === Number(query_params.idsite));
        const latest = site.reduce((a, b) => (!a || String(b.generated_at) > String(a.generated_at) ? b : a), null);
        rows = site
          .filter((r) => r.status === 'selected' && r.batch_id === latest?.batch_id)
          .sort((a, b) => a.tag_key.localeCompare(b.tag_key));
      } else {
        throw new Error(`fake client: unexpected query ${query.slice(0, 80)}`);
      }
      return { json: async () => rows.map((r) => ({ ...r })) };
    },
  };
}

const BATCH_ID = '11111111-2222-3333-4444-555555555555';
const BATCH_2 = '22222222-3333-4444-5555-666666666666';
const WINDOW = { windowStart: '2026-09-04', windowEnd: '2026-10-03' };

const SPEC = {
  batchId: BATCH_ID,
  ...WINDOW,
  windowDays: 30,
  catalogs: ['LP', 'PO'],
  standards: { LP: { floor_rps: 0.5 }, PO: { floor_rps: 0.4 } },
};

/**
 * The schema-2 contract script every AE adapter must pass.
 * @param {object} ae AePersistencePort adapter
 * @param {(kind: string) => object[]} readCurrent current rows per store
 * @param {object} bundle catalog bundle for seedReference
 * @param {() => Promise<void>} [tick] advance the adapter's clock (ClickHouse
 *   tests control time; the memory clock is monotonic on its own)
 */
async function contract(ae, readCurrent, bundle, tick) {
  // --- batch ---
  await ae.createBatch(SPEC);
  const batch = await ae.getBatch(BATCH_ID);
  expect(batch.windowDays).toBe(30);
  expect(batch.catalogs).toEqual(['LP', 'PO']);
  expect(batch.standards).toEqual({ LP: { floor_rps: 0.5 }, PO: { floor_rps: 0.4 } });
  expect(batch.status).toBe('open');
  expect(await ae.getBatch('99999999-9999-9999-9999-999999999999')).toBeNull();

  // --- site queue: idempotent enqueue, exclusive claims, TTL reclaim ---
  await ae.enqueueSites(BATCH_ID, [
    { idsite: 1, siteName: 'one' },
    { idsite: 2, siteName: 'two' },
  ]);
  await ae.enqueueSites(BATCH_ID, [{ idsite: 1, siteName: 'one' }]); // idempotent
  expect(readCurrent('siteQueue')).toHaveLength(2);

  const claim1 = await ae.claimNextSite(BATCH_ID);
  expect(claim1.idsite).toBe(1);
  expect(claim1.siteName).toBe('one');
  const claim2 = await ae.claimNextSite(BATCH_ID);
  expect(claim2.idsite).toBe(2);

  // fresh claims are exclusive: nothing left while both are in flight
  expect(await ae.claimNextSite(BATCH_ID)).toBeNull();

  // a claim older than the TTL (0 = everything stale) is reclaimed
  const claim3 = await ae.claimNextSite(BATCH_ID, 0);
  expect(claim3.idsite).toBe(1);

  await ae.updateSite({ batchId: BATCH_ID, idsite: 2, status: 'skipped_volume', reason: 'too small' });
  await ae.updateSite({ batchId: BATCH_ID, idsite: 1, status: 'awaiting_capture', reason: 'waiting for capture' });
  const site1 = readCurrent('siteQueue').find((r) => Number(r.idsite) === 1);
  expect(site1.status).toBe('awaiting_capture');
  expect(site1.reason).toBe('waiting for capture');
  const site2 = readCurrent('siteQueue').find((r) => Number(r.idsite) === 2);
  expect(site2.status).toBe('skipped_volume');

  // --- page targets ---
  await ae.writePageTargets(BATCH_ID, 1, [
    {
      idsitehsr: 101,
      url: 'https://one.com/',
      pageTitle: 'Home',
      pageType: 'home',
      templateFamily: 'home',
      role: 'primary',
      selectionReason: 'qualifier pick',
      entrySessions: 500,
      pageviewHits: 1200,
      orders: 4,
      revenue: 400,
    },
    {
      idsitehsr: 102,
      url: 'https://one.com/products/a',
      role: 'sister',
      selectionReason: 'next best entry',
    },
  ]);
  await ae.updatePageTarget({ batchId: BATCH_ID, idsite: 1, idsitehsr: 101, status: 'awaiting_capture' });
  const target101 = readCurrent('pageTargets').find((r) => Number(r.idsitehsr) === 101);
  expect(target101.status).toBe('awaiting_capture');
  expect(target101.role).toBe('primary');
  expect(target101.selection_reason).toBe('qualifier pick');

  // --- capture round trip ---
  expect(await ae.captureStatus({ idsite: 1, idsitehsr: 101 })).toBeNull();

  const job = { idsite: 1, idsitehsr: 101, url: 'https://one.com/', pageType: 'home', deviceClasses: ['desktop', 'mobile'], want: ['naming'] };
  await ae.enqueueCapture(job);
  await ae.enqueueCapture(job); // idempotent on (idsite, idsitehsr)
  expect(readCurrent('captureQueue')).toHaveLength(1);
  expect(readCurrent('captureQueue')[0].status).toBe('queued');

  const capture1 = await ae.claimCapture();
  expect(capture1.idsite).toBe(1);
  expect(capture1.idsitehsr).toBe(101);
  expect(capture1.token).toBeTruthy();
  expect(await ae.claimCapture()).toBeNull(); // fresh claim is exclusive
  const reclaimed = await ae.claimCapture(0); // stale reclaim with TTL 0
  expect(reclaimed.idsitehsr).toBe(101);

  // invalid element_class throws and writes nothing
  await expect(
    ae.completeCapture({
      idsite: 1,
      idsitehsr: 101,
      capturedOn: '2026-10-03',
      bindings: [{ selector: '#hero button', element_class: 'not_a_class', name: 'Hero' }],
    }),
  ).rejects.toThrow(/element_class/);
  expect(await ae.captureStatus({ idsite: 1, idsitehsr: 101 })).toBeNull();
  expect(readCurrent('pageCaptures')).toHaveLength(0);
  expect(readCurrent('elementBindings')).toHaveLength(0);
  expect(readCurrent('captureQueue')[0].status).toBe('claimed');

  const requeued = await ae.completeCapture({
    idsite: 1,
    idsitehsr: 101,
    url: 'https://one.com/',
    capturedOn: '2026-10-03',
    coverage: { classes: ['hero_cta', 'nav_link'], selectors_bound: 2 },
    hasRender: true,
    bindings: [
      { selector: '#hero button', element_class: 'hero_cta', name: 'Hero CTA' },
      { selector: '#nav a', element_class: 'nav_link', name: 'Nav', position_index: 3 },
    ],
  });
  expect(requeued).toHaveLength(1);
  expect(requeued[0].idsite).toBe(1);

  const status = await ae.captureStatus({ idsite: 1, idsitehsr: 101 });
  expect(status).toEqual({
    status: 'complete',
    taxonomyVersion: TAXONOMY_VERSION,
    capturedOn: '2026-10-03',
    hasRender: true,
    hasSaliency: false,
  });

  const bindings = readCurrent('elementBindings').sort((a, b) => String(a.selector).localeCompare(String(b.selector)));
  expect(bindings).toHaveLength(2);
  expect(bindings.map((b) => b.element_class).sort()).toEqual(['hero_cta', 'nav_link']);
  expect(bindings.every((b) => b.taxonomy_version === TAXONOMY_VERSION)).toBe(true);
  expect(bindings.find((b) => b.selector === '#nav a').position_index).toBe(3);

  // the awaiting page target went back to 'selected' and, with no remaining
  // awaiting_capture pages, the site went back to 'queued'
  expect(readCurrent('pageTargets').find((r) => Number(r.idsitehsr) === 101).status).toBe('selected');
  expect(readCurrent('pageTargets').find((r) => Number(r.idsitehsr) === 102).status).toBe('selected');
  const site1After = readCurrent('siteQueue').find((r) => Number(r.idsite) === 1);
  expect(site1After.status).toBe('queued');
  expect(site1After.reason).toBe('capture complete');
  expect(readCurrent('captureQueue')[0].status).toBe('done');

  // --- capture with renders: ae_page_render + ae_render_node round trip ---
  const renderFixture = (over = {}) => ({
    device_class: 'desktop',
    viewport_w: 1440,
    viewport_h: 900,
    page_height_px: 4800,
    fold_px: 900,
    screenshot_uri: '../captures/1/102/desktop.shot.png',
    content_hash: 'sha256:desktop-a',
    dom_hash: 'sha256:desktop-dom-a',
    rendered_at: '2026-10-03T12:00:00.000Z',
    renderer_version: 'bot 1.0',
    sections: [{ id: 's1', selector: '#hero', top: 0, height: 800, type: 'hero', words: 12 }],
    elements: [
      {
        selector: '#buy',
        section_id: 's1',
        dom_order: 0,
        x: 100,
        y: 520,
        w: 220,
        h: 56,
        is_control: true,
        looks_clickable: true,
        sticky: false,
        visual_class: 'control',
        image_type: '',
        words: 2,
      },
      { selector: '#nav a', section_id: 's1', dom_order: 1, x: 40, y: 30, w: 120, h: 24, words: 1 },
    ],
    ...over,
  });
  await ae.completeCapture({
    idsite: 1,
    idsitehsr: 102,
    url: 'https://one.com/products/a',
    capturedOn: '2026-10-03',
    coverage: { named_selectors: 2, devices: ['desktop', 'mobile'], elements_bound: 2, sections_found: 2 },
    bindings: [
      { selector: '#buy', element_class: 'offer_add_to_cart', name: 'Buy' },
      { selector: '#nav a', element_class: 'nav_link', name: 'Nav' },
    ],
    renders: [
      renderFixture(),
      renderFixture({
        device_class: 'mobile',
        viewport_w: 390,
        viewport_h: 844,
        page_height_px: 9120,
        fold_px: 844,
        screenshot_uri: '',
        content_hash: 'sha256:mobile-a',
        dom_hash: 'sha256:mobile-dom-a',
        sections: [{ id: 's1', top: 0, height: 700, type: 'hero', words: 8 }],
        elements: [{ selector: '#buy', section_id: 's1', dom_order: 0, x: 16, y: 420, w: 358, h: 48, words: 2 }],
      }),
    ],
  });

  const capture102 = readCurrent('pageCaptures').find((r) => Number(r.idsitehsr) === 102);
  expect(Number(capture102.has_render)).toBe(1);
  expect(Number(capture102.has_saliency)).toBe(0);
  expect(JSON.parse(capture102.coverage).devices).toEqual(['desktop', 'mobile']);
  const status102 = await ae.captureStatus({ idsite: 1, idsitehsr: 102 });
  expect(status102.hasRender).toBe(true);
  expect(status102.hasSaliency).toBe(false);

  // one ae_page_render row per device, carrying the artifact hashes
  const pageRenders = readCurrent('pageRenders');
  expect(pageRenders).toHaveLength(2);
  const desktopRender = pageRenders.find((r) => r.device_class === 'desktop');
  expect(desktopRender.content_hash).toBe('sha256:desktop-a');
  expect(desktopRender.section_order).toEqual(['s1']);
  expect(String(desktopRender.capture_id)).toBe(String(capture102.capture_id));
  expect(pageRenders.find((r) => r.device_class === 'mobile').screenshot_uri).toBe('');

  // ae_render_node: one row per section and per element, saliency null
  const renderNodes = readCurrent('renderNodes');
  expect(renderNodes).toHaveLength(5); // 2 sections + 3 elements across both devices
  const sectionNode = renderNodes.find((n) => n.node_id === 's1' && n.device_class === 'desktop');
  expect(sectionNode.node_kind).toBe('section');
  expect(Number(sectionNode.y)).toBe(0);
  expect(Number(sectionNode.h)).toBe(800);
  expect(Number(sectionNode.w)).toBe(1440);
  expect(sectionNode.section_type).toBe('hero');
  const elementNode = renderNodes.find((n) => n.node_id === 'el:0' && n.device_class === 'desktop');
  expect(elementNode.node_kind).toBe('element');
  expect(elementNode.selector).toBe('#buy');
  expect(elementNode.parent_section_id).toBe('s1');
  expect(elementNode.visual_class).toBe('control');
  expect(Number(elementNode.is_control)).toBe(1);
  expect(Number(elementNode.in_first_viewport)).toBe(1); // y=520 starts above the 900px fold
  expect(elementNode.saliency_share ?? null).toBeNull();
  expect(String(elementNode.saliency_model ?? '')).toBe('');

  // --- render drift: a changed content_hash logs one content_drift row ---
  await ae.completeCapture({
    idsite: 1,
    idsitehsr: 102,
    url: 'https://one.com/products/a',
    capturedOn: '2026-10-04',
    bindings: [],
    renders: [
      renderFixture({ content_hash: 'sha256:desktop-b', rendered_at: '2026-10-04T12:00:00.000Z' }),
      renderFixture({
        // unchanged mobile hash: no drift row for mobile
        device_class: 'mobile',
        viewport_w: 390,
        viewport_h: 844,
        page_height_px: 9120,
        fold_px: 844,
        content_hash: 'sha256:mobile-a',
        dom_hash: 'sha256:mobile-dom-a',
        sections: [{ id: 's1', top: 0, height: 700, type: 'hero', words: 8 }],
        elements: [{ selector: '#buy', section_id: 's1', dom_order: 0, x: 16, y: 420, w: 358, h: 48, words: 2 }],
      }),
    ],
  });
  const driftRows = readCurrent('changeLog').filter((r) => r.change_kind === 'content_drift');
  expect(driftRows).toHaveLength(1);
  expect(driftRows[0].change_id).toBe('render_drift:102:desktop:sha256:deskt');
  expect(driftRows[0].source).toBe('render_diff');
  expect(driftRows[0].subject).toBe('https://one.com/products/a');
  expect(JSON.parse(driftRows[0].detail)).toEqual({
    old_hash: 'sha256:desktop-a',
    new_hash: 'sha256:desktop-b',
    device_class: 'desktop',
  });
  const driftViaRead = await ae.readChanges(1, '2026-10-04T00:00:00.000Z', '2026-10-04T23:59:59.000Z');
  expect(driftViaRead.filter((r) => r.change_kind === 'content_drift')).toHaveLength(1);

  await ae.enqueueCapture({ idsite: 2, idsitehsr: 201, url: 'https://two.com/', pageType: 'pdp', deviceClasses: ['desktop'], want: ['naming', 'render'] });
  const failedJob = await ae.claimCapture();
  expect(failedJob.idsite).toBe(2);
  await ae.failCapture({ idsite: 2, idsitehsr: 201, reason: 'bot timeout' });
  const failedRow = readCurrent('captureQueue').find((r) => Number(r.idsite) === 2);
  expect(failedRow.status).toBe('failed');
  expect(failedRow.reason).toBe('bot timeout');
  await ae.enqueueCapture({ idsite: 2, idsitehsr: 201, url: 'https://two.com/retry', pageType: 'pdp', deviceClasses: ['desktop'], want: ['naming', 'render'] });
  const retried = readCurrent('captureQueue').find((r) => Number(r.idsite) === 2);
  expect(retried.status).toBe('queued');
  expect(retried.url).toBe('https://two.com/retry');
  expect(retried.claim_token ?? '').toBe('');
  const retriedClaim = await ae.claimCapture();
  expect(retriedClaim.idsite).toBe(2);
  expect(retriedClaim.url).toBe('https://two.com/retry');

  // --- descriptors: latest per field_path wins ---
  await ae.writeDescriptorRows([
    {
      idsite: 1,
      template_key: 'home',
      device_class: 'all',
      field_path: 'p01.job',
      value_json: '"landing"',
      provenance: 'operator',
      confidence: 'high',
      expires_at: '2026-12-31 00:00:00.000',
    },
    {
      idsite: 1,
      template_key: 'home',
      device_class: 'all',
      field_path: 'p01.job',
      value_json: '"browse"',
      provenance: 'bot_draft',
      confidence: 'low',
      expires_at: '2026-12-31 00:00:00.000',
    },
  ]);
  await ae.writeDescriptorRows([
    {
      idsite: 1,
      template_key: 'home',
      field_path: 'p02.context',
      value_json: '{"purchase":"impulse"}',
      provenance: 'operator',
      confidence: 'high',
    },
    {
      idsite: 1,
      field_path: 's16.owners',
      value_json: '{"pdp":"native"}',
      provenance: 'operator',
      confidence: 'high',
    },
  ]);
  const pageDescriptor = await ae.readPageDescriptor({ idsite: 1, template_key: 'home' });
  expect(pageDescriptor.map((r) => r.field_path)).toEqual(['p01.job', 'p02.context']);
  expect(pageDescriptor.find((r) => r.field_path === 'p01.job').value_json).toBe('"browse"');
  expect(pageDescriptor.find((r) => r.field_path === 'p01.job').device_class).toBe('all');
  const storeDescriptor = await ae.readStoreDescriptor({ idsite: 1 });
  expect(storeDescriptor.map((r) => r.field_path)).toEqual(['s16.owners']);
  expect(storeDescriptor[0].value_json).toBe('{"pdp":"native"}');

  // --- change log window ---
  await ae.writeChanges([
    {
      idsite: 1,
      change_id: 'chg-1',
      change_kind: 'theme_deploy',
      effective_at: '2026-09-30 12:00:00',
      detected_at: '2026-10-01 00:00:00',
      source: 'shopify_snapshot',
      subject: 'home',
      detail: { theme_id: 'abc' },
    },
  ]);
  const inWindow = await ae.readChanges(1, '2026-09-01', '2026-10-02');
  expect(inWindow).toHaveLength(1);
  expect(inWindow[0].change_id).toBe('chg-1');
  expect(JSON.parse(inWindow[0].detail).theme_id).toBe('abc');
  expect(await ae.readChanges(1, '2026-10-01', '2026-10-02')).toHaveLength(0);

  // --- dataset rows: second write of the same row_key replaces ---
  const ds = (over = {}) => ({
    batchId: BATCH_ID,
    idsite: 1,
    idsitehsr: 101,
    scope: 'page',
    datasetId: 'page-segment-weekly',
    botFilter: 'exclude_confirmed',
    dimWeek: '2026-09-28',
    dimDevice: 'desktop',
    dimSource: 'paid_social',
    dimReturning: 'new',
    metrics: { sessions: 5 },
    rowKey: 'k1',
    ...over,
  });
  await ae.writeDatasetRows([ds(), ds({ rowKey: 'k2', idsitehsr: 0, scope: 'site', dimDevice: '' })]);
  await ae.writeDatasetRows([ds({ metrics: { sessions: 9 } })]);
  const datasetRows = readCurrent('datasetRows');
  expect(datasetRows).toHaveLength(2);
  const k1 = datasetRows.find((r) => r.row_key === 'k1');
  expect(JSON.parse(k1.metrics).sessions).toBe(9);
  expect(k1.scope).toBe('page');
  expect(datasetRows.find((r) => r.row_key === 'k2').dim_element_class ?? '').toBe('');

  // --- requirement status ---
  await ae.writeRequirementStatus([
    {
      batchId: BATCH_ID,
      idsite: 1,
      idsitehsr: 101,
      requirementKey: 'H01',
      status: 'available',
      datasetId: 'page-segment-weekly',
      source: 'query',
      rowCount: 5,
      detail: '',
    },
  ]);
  const reqStatus = readCurrent('requirementStatus');
  expect(reqStatus).toHaveLength(1);
  expect(reqStatus[0].status).toBe('available');
  expect(Number(reqStatus[0].row_count)).toBe(5);

  // --- cards and cardHistory ordering across batches ---
  await ae.writeCards([
    {
      batchId: BATCH_ID,
      idsite: 1,
      idsitehsr: 101,
      catalogId: 'LP',
      strategyId: 'J2',
      verdict: 'include',
      triggerState: 'triggered',
      missingRequirements: [],
      triggeredRules: ['rule-1'],
      guardrails: ['guard-1'],
      confounds: { seasonality: 'open' },
      card: { id: 'J2', headline: 'first' },
    },
  ]);
  await tick?.(); // the second batch's card must be strictly newer
  await ae.createBatch({ ...SPEC, batchId: BATCH_2 });
  await ae.writeCards([
    {
      batchId: BATCH_2,
      idsite: 1,
      idsitehsr: 101,
      catalogId: 'LP',
      strategyId: 'J2',
      verdict: 'exclude',
      triggerState: 'silent',
      card: { id: 'J2', headline: 'second' },
    },
  ]);
  const cards = readCurrent('strategyCards');
  expect(cards).toHaveLength(2);
  const first = cards.find((c) => c.batch_id === BATCH_ID);
  expect(first.triggered_rules).toEqual(['rule-1']);
  expect(first.guardrails).toEqual(['guard-1']);
  expect(first.missing_requirements).toEqual([]);
  expect(JSON.parse(first.confounds)).toEqual({ seasonality: 'open' });
  expect(JSON.parse(first.card_json)).toEqual({ id: 'J2', headline: 'first' });

  const history = await ae.cardHistory({ idsite: 1, strategyId: 'J2', n: 2 });
  expect(history).toHaveLength(2);
  expect(history[0].batch_id).toBe(BATCH_2); // latest first
  expect(history[1].batch_id).toBe(BATCH_ID);
  expect(history[0].verdict).toBe('exclude');

  // --- analysis rows ---
  await ae.writePageAnalysis({
    batchId: BATCH_ID,
    idsite: 1,
    idsitehsr: 101,
    url: 'https://one.com/',
    pageTitle: 'Home',
    pageType: 'home',
    templateFamily: 'home',
    role: 'primary',
    ...WINDOW,
    entrySessions: 500,
    orders: 4,
    revenue: 400,
    rps: 0.8,
    cvr: 0.008,
    aov: 100,
    singlePageviewShare: 0.4,
    scrollReach25: 0.9,
    scrollReach70: 0.5,
    desktopRps: 1.0,
    mobileRps: 0.6,
    mobileToDesktopRps: 0.6,
    botSessionsExcluded: 20,
    sessionsUnfiltered: 520,
    ordersUnfiltered: 4,
    descriptorStatus: 'current',
    captureStatus: 'current',
    requirementsAvailable: 10,
    requirementsMissing: 2,
    cardsInclude: 3,
    cardsConditional: 1,
    cardsExclude: 0,
    cardsTriggered: 2,
    cardsSilent: 1,
    cardsBelowFloor: 0,
    cardsBlocked: 0,
    status: 'analyzed',
    metadata: { note: 'page' },
  });
  const pageAnalyses = readCurrent('pageAnalyses');
  expect(pageAnalyses).toHaveLength(1);
  expect(Number(pageAnalyses[0].rps)).toBe(0.8);
  expect(pageAnalyses[0].status).toBe('analyzed');
  expect(JSON.parse(pageAnalyses[0].metadata).note).toBe('page');

  await ae.writeSiteAnalysis({
    batchId: BATCH_ID,
    idsite: 1,
    ...WINDOW,
    sessions: 5000,
    orders: 40,
    revenue: 4000,
    rps: 0.8,
    cvr: 0.008,
    aov: 100,
    ppEligibleShare: 0.9,
    ppRenderedShare: 0.85,
    reconciliationMin: 0.8,
    descriptorStatus: 'current',
    sourcesConnected: ['shopify_admin'],
    sourcesMissing: ['redo'],
    toolsInstalled: ['klaviyo'],
    requirementsAvailable: 20,
    requirementsMissing: 3,
    cardsInclude: 5,
    cardsConditional: 0,
    cardsExclude: 1,
    cardsTriggered: 3,
    cardsSilent: 2,
    cardsBelowFloor: 0,
    cardsBlocked: 1,
    status: 'analyzed',
    metadata: { note: 'site' },
  });
  const siteAnalyses = readCurrent('siteAnalyses');
  expect(siteAnalyses).toHaveLength(1);
  expect(siteAnalyses[0].sources_connected).toEqual(['shopify_admin']);
  expect(siteAnalyses[0].sources_missing).toEqual(['redo']);
  expect(JSON.parse(siteAnalyses[0].metadata).note).toBe('site');

  // --- reference seed: idempotent, counts match the bundle ---
  const totalStrategies = Object.values(bundle.strategies).reduce(
    // card_only rows (TD:FIX, TD:F-ROUTE) are fix cards, not catalog strategies
    (n, catalog) => n + catalog.strategies.filter((s) => !s.card_only).length,
    0,
  );
  const totalCrosswalk = bundle.crosswalk.entries.reduce((n, entry) => n + entry.members.length, 0);
  for (let run = 0; run < 2; run += 1) {
    await ae.seedReference(bundle);
    expect(readCurrent('requirements')).toHaveLength(bundle.requirements.requirements.length);
    expect(readCurrent('strategyCatalog')).toHaveLength(totalStrategies);
    expect(readCurrent('crosswalk')).toHaveLength(totalCrosswalk);
    expect(readCurrent('screenRules')).toHaveLength(bundle.screenRules.rules.length);
  }
  const requirementKeys = new Set(readCurrent('requirements').map((r) => r.requirement_key));
  expect(requirementKeys.size).toBe(bundle.requirements.requirements.length);
  for (const card of readCurrent('strategyCatalog')) {
    for (const key of card.requirement_keys) {
      expect(requirementKeys.has(key)).toBe(true);
    }
  }
  const lpJ2 = readCurrent('strategyCatalog').find((r) => r.catalog_id === 'LP' && r.strategy_id === 'J2');
  expect(lpJ2.name).toBe(bundle.strategies.LP.strategies.find((s) => s.id === 'J2').title);
  const aliases = readCurrent('strategyCatalog').filter((r) => r.alias_of !== '');
  expect(aliases).toHaveLength(1);
  expect(aliases[0].alias_of).toBe(
    Object.values(bundle.strategies)
      .flatMap((c) => c.strategies)
      .find((s) => s.alias_of).alias_of,
  );
  const firstCrosswalk = bundle.crosswalk.entries[0];
  expect(
    readCurrent('crosswalk').some(
      (r) => r.intent_id === firstCrosswalk.intent_id && r.strategy_id === firstCrosswalk.members[0],
    ),
  ).toBe(true);
  const screenX01 = readCurrent('screenRules').find((r) => r.rule_id === 'TI:X01');
  expect(screenX01.kind).toBe('contradiction');
  expect(screenX01.disposition).toBe('blocked');
}

/**
 * The role methods the main script leaves out: dataset reads and deletes,
 * trend rows and selectors, and session tag trends and selection.
 * @param {object} ae AePersistencePort adapter
 * @param {(kind: string) => object[]} readCurrent current rows per store
 * @param {() => Promise<void>} tick advance the adapter's clock
 */
async function roleContract(ae, readCurrent, tick) {
  // --- dataset rows: read one page's rows, delete by page and by site ---
  const ds = (over = {}) => ({
    batchId: BATCH_ID, idsite: 3, idsitehsr: 301, scope: 'page', datasetId: 'rage-clicks',
    botFilter: 'exclude_confirmed', metrics: { sessions: 1 }, rowKey: 'r1', ...over,
  });
  await ae.writeDatasetRows([
    ds(),
    ds({ rowKey: 'r2', idsitehsr: 302 }),
    ds({ rowKey: 'r3', datasetId: 'nav-next-page' }),
    ds({ rowKey: 'r4', batchId: BATCH_2 }),
  ]);
  const stored = await ae.readDatasetRows({ batchId: BATCH_ID, idsite: 3, idsitehsr: 301, datasetId: 'rage-clicks' });
  expect(stored.map((r) => r.row_key)).toEqual(['r1']);
  await ae.deleteDatasetRows({ batchId: BATCH_ID, idsite: 3, idsitehsr: 302, datasetIds: ['rage-clicks'] });
  const keys = () => readCurrent('datasetRows').filter((r) => Number(r.idsite) === 3).map((r) => r.row_key).sort();
  expect(keys()).toEqual(['r1', 'r3', 'r4']);
  await ae.deleteDatasetRows({ batchId: BATCH_ID, idsite: 3, datasetIds: ['rage-clicks', 'nav-next-page'] });
  expect(keys()).toEqual(['r4']);
  await ae.deleteDatasetRows({ batchId: BATCH_ID, idsite: 3, datasetIds: [] });
  expect(keys()).toEqual(['r4']);

  // --- trend rows: the all/all totals name the subjects, lowest rank first ---
  const trend = (over = {}) => ({
    batchId: BATCH_ID, idsite: 7, idsitehsr: 0, rowType: 'path', rowKey: 'path', rowKey1: '/a', rowKey2: '',
    segment: 'all', segmentValue: 'all', viewportType: 'all', week: '2026-09-28', sessions: 10, metrics: { rank: 2 }, ...over,
  });
  await ae.writeTrendRows([
    trend(),
    trend({ rowKey1: '/b', metrics: { rank: 1 } }),
    trend({ rowKey1: '/b', week: '2026-10-05', metrics: { rank: 5 } }),
    trend({ rowKey: 'url_path', rowKey1: '/x', metrics: { rank: 3 } }),
    trend({ rowKey: 'page', rowKey1: '11', idsitehsr: 11, metrics: { rank: 4 } }),
    trend({ rowKey1: '/mobile-only', viewportType: 'mobile', metrics: { rank: 0 } }),
    trend({ rowKey1: '/paid', segment: 'channel', segmentValue: 'paid', metrics: { rank: 0 } }),
    trend({ idsite: 8, rowKey1: '/other' }),
  ]);
  await tick();
  await ae.writeTrendRows([trend({ metrics: { rank: 0 }, sessions: 12 })]);
  expect(await ae.readTrendSubjects(7)).toEqual({ paths: ['/a', '/b'], urlPaths: ['/x'], pages: ['11'] });
  expect(await ae.readTrendSubjects(9)).toEqual({ paths: [], urlPaths: [], pages: [] });

  // --- trend weeks: the latest all/all week of each subject, selectors by page ---
  await ae.writeTrendRows([
    trend({ rowType: 'element', rowKey: 'selector', rowKey1: '#a', idsitehsr: 11, week: '2026-10-05' }),
    trend({ rowType: 'element', rowKey: 'selector', rowKey1: '#a', idsitehsr: 11, week: '2026-10-12', viewportType: 'mobile' }),
  ]);
  expect(await ae.readTrendWeeks(7)).toEqual([
    { rowKey: 'page', rowKey1: '11', idsitehsr: 11, week: '2026-09-28' },
    { rowKey: 'path', rowKey1: '/a', idsitehsr: 0, week: '2026-09-28' },
    { rowKey: 'path', rowKey1: '/b', idsitehsr: 0, week: '2026-10-05' },
    { rowKey: 'selector', rowKey1: '#a', idsitehsr: 11, week: '2026-10-05' },
    { rowKey: 'url_path', rowKey1: '/x', idsitehsr: 0, week: '2026-09-28' },
  ]);
  expect(await ae.readTrendWeeks(9)).toEqual([]);

  // --- trend week range: each subject's first and last week of one segmentation, and its values ---
  await ae.writeTrendRows([
    trend({ rowKey1: '/paid', segment: 'channel', segmentValue: 'organic', week: '2026-10-12', viewportType: 'mobile' }),
    trend({ rowType: 'element', rowKey: 'selector', rowKey1: '#a', idsitehsr: 11, segment: 'channel', segmentValue: 'paid', week: '2026-09-21' }),
    trend({ rowKey: 'step', rowKey1: '/paid', rowKey2: '1', segment: 'channel', segmentValue: 'social', week: '2026-09-14' }),
  ]);
  expect(await ae.readTrendWeekRange(7, 'channel')).toEqual({
    subjects: [
      { rowKey: 'path', rowKey1: '/paid', rowKey2: '', idsitehsr: 0, first: '2026-09-28', last: '2026-10-12' },
      { rowKey: 'selector', rowKey1: '#a', rowKey2: '', idsitehsr: 11, first: '2026-09-21', last: '2026-09-21' },
    ],
    values: ['organic', 'paid', 'social'],
  });
  expect(await ae.readTrendWeekRange(7, 'buyer')).toEqual({ subjects: [], values: [] });

  await ae.writeTrendSelectors([{ idsite: 7, idsitehsr: 11, trendSelectors: ['#a'], status: 'active' }]);
  await tick();
  await ae.writeTrendSelectors([
    { idsite: 7, idsitehsr: 11, trendSelectors: ['#a', '#b'], status: 'active' },
    { idsite: 8, idsitehsr: 12, trendSelectors: ['#z'], status: 'active' },
  ]);
  expect(await ae.readTrendSelectors(7)).toEqual([{ idsite: 7, idsitehsr: 11, trendSelectors: ['#a', '#b'], status: 'active' }]);

  // --- session tags: trend rows replace on identity; the latest selection batch wins ---
  const tagRow = (over = {}) => ({
    batchId: BATCH_ID, idsite: 7, tagKey: 'utm_source', tagValue: 'ig', viewportType: 'all',
    segment: 'all', segmentValue: 'all', week: '2026-09-28', sessions: 4, metrics: {}, ...over,
  });
  await ae.writeTagTrendRows([tagRow(), tagRow({ tagValue: 'fb' })]);
  await tick();
  await ae.writeTagTrendRows([tagRow({ sessions: 9 })]);
  const tagRows = readCurrent('tagTrendRows').filter((r) => Number(r.idsite) === 7);
  expect(tagRows).toHaveLength(2);
  expect(Number(tagRows.find((r) => (r.tag_value ?? r.tagValue) === 'ig').sessions)).toBe(9);
  await ae.writeTagTrendRows([
    tagRow({ week: '2026-10-05' }),
    tagRow({ week: '2026-10-12', segment: 'channel', segmentValue: 'paid' }),
    tagRow({ tagKey: 'country', tagValue: 'US', week: '2026-09-21' }),
  ]);
  expect(await ae.readTagTrendWeeks(7)).toEqual([
    { tagKey: 'country', week: '2026-09-21' },
    { tagKey: 'utm_source', week: '2026-10-05' },
  ]);
  expect(await ae.readTagTrendWeeks(9)).toEqual([]);
  await ae.writeTagTrendRows([tagRow({ week: '2026-09-14', segment: 'channel', segmentValue: 'organic', viewportType: 'mobile' })]);
  expect(await ae.readTagTrendWeekRange(7, 'channel')).toEqual({
    keys: [{ tagKey: 'utm_source', first: '2026-09-14', last: '2026-10-12' }],
    values: ['organic', 'paid'],
  });
  expect(await ae.readTagTrendWeekRange(9, 'channel')).toEqual({ keys: [], values: [] });

  const pick = (over = {}) => ({
    batchId: BATCH_ID, idsite: 7, tagKey: 'utm_source', adapterId: 'traffic-variance', family: 'utm', status: 'selected',
    windowStart: WINDOW.windowStart, windowEnd: WINDOW.windowEnd, trendValues: ['ig'], ...over,
  });
  expect(await ae.readTagSelection(7)).toEqual([]);
  await ae.writeTagSelection([pick(), pick({ tagKey: 'device', family: 'device', status: 'rejected', trendValues: [] })]);
  expect(await ae.readTagSelection(7)).toEqual([{ tagKey: 'utm_source', family: 'utm', trendValues: ['ig'] }]);
  await tick();
  await ae.writeTagSelection([
    pick({ batchId: BATCH_2, tagKey: 'utm_source', trendValues: ['ig', 'fb'] }),
    pick({ batchId: BATCH_2, tagKey: 'country', family: 'geo', trendValues: ['US'] }),
  ]);
  expect(await ae.readTagSelection(7)).toEqual([
    { tagKey: 'country', family: 'geo', trendValues: ['US'] },
    { tagKey: 'utm_source', family: 'utm', trendValues: ['ig', 'fb'] },
  ]);
  expect(await ae.readTagSelection(8)).toEqual([]);

  // --- segmentation definitions: latest version per segmentation, a site row winning over idsite 0 ---
  const def = (over = {}) => ({
    idsite: 7, segmentation: 'channel', version: 1, kind: 'declared', stamp: 's1',
    definition: { rules: [], fallback: 'direct' }, values: ['paid', 'direct'], ...over,
  });
  expect(await ae.readSegmentationDefinitions(7)).toEqual([]);
  await ae.writeSegmentationDefinitions([
    def({ idsite: 0, segmentation: 'buyer', stamp: 'b1', values: ['buyer', 'non_buyer'] }),
    def({ idsite: 0, version: 3, stamp: 'shipped' }),
    def(),
    def({ version: 2, stamp: 's2', values: ['paid', 'organic', 'direct'] }),
  ]);
  expect(await ae.readSegmentationDefinitions(7)).toEqual([
    def({ idsite: 0, segmentation: 'buyer', stamp: 'b1', values: ['buyer', 'non_buyer'] }),
    def({ version: 2, stamp: 's2', values: ['paid', 'organic', 'direct'] }),
  ]);
  expect((await ae.readSegmentationDefinitions(8)).map((r) => [r.idsite, r.segmentation, r.version])).toEqual([
    [0, 'buyer', 1],
    [0, 'channel', 3],
  ]);
  await tick();
  await ae.writeSegmentationDefinitions([def({ version: 2, stamp: 's2', definition: { rules: [], fallback: 'organic' } })]);
  expect((await ae.readSegmentationDefinitions(7)).find((r) => r.segmentation === 'channel').definition).toEqual({ rules: [], fallback: 'organic' });
}

describe('ae persistence contract', () => {
  const bundle = loadCatalog();

  it('memory adapter round-trips the v2 contract', async () => {
    const { adapter, snapshot } = createMemoryAePersistence();
    await contract(adapter, (kind) => snapshot()[kind], bundle);
  });

  it('clickhouse adapter (fake client) round-trips the v2 contract', async () => {
    let now = Date.now();
    const bump = (ms) => {
      now += ms;
    };
    _setClockForTests({ now: () => new Date(now).toISOString().replace('T', ' ').slice(0, -1) });
    const client = createFakeAeClient();
    const { adapter } = createClickHouseAePersistence({ client, logger: { info() {} } });
    const TABLE = {
      siteQueue: SITE_QUEUE,
      pageTargets: PAGE_TARGET,
      captureQueue: CAPTURE_QUEUE,
      pageCaptures: PAGE_CAPTURE,
      elementBindings: ELEMENT_BINDING,
      pageRenders: PAGE_RENDER,
      renderNodes: RENDER_NODE,
      changeLog: CHANGE_LOG,
      datasetRows: DATASET_ROW,
      requirementStatus: REQUIREMENT_STATUS,
      strategyCards: STRATEGY_CARD,
      pageAnalyses: PAGE_ANALYSIS,
      siteAnalyses: SITE_ANALYSIS,
      requirements: REQUIREMENT,
      strategyCatalog: STRATEGY_CATALOG,
      crosswalk: STRATEGY_CROSSWALK,
      screenRules: SCREEN_RULE,
    };
    await contract(
      adapter,
      (kind) => currentRows(TABLE[kind], client.tables.get(TABLE[kind]) ?? []),
      bundle,
      async () => bump(1000),
    );
  });

  it('two agents racing for one queued site: exactly one claims it', async () => {
    const race = async (adapter) => {
      const batchId = '77777777-7777-7777-7777-777777777777';
      await adapter.enqueueSites(batchId, [{ idsite: 5184, siteName: 'one' }]);
      const claims = await Promise.all([adapter.claimNextSite(batchId), adapter.claimNextSite(batchId)]);
      return claims.filter(Boolean).map((claim) => claim.idsite);
    };
    expect(await race(createMemoryAePersistence().adapter)).toEqual([5184]);
    let tick = Date.now();
    _setClockForTests({ now: () => new Date((tick += 1)).toISOString().replace('T', ' ').slice(0, -1) });
    const fake = createFakeAeClient();
    let claimInserts = 0;
    const client = new Proxy(fake, {
      get(target, key) {
        if (key === 'insert') {
          return async (args) => {
            if (args.values?.[0]?.status === 'claimed' && (claimInserts += 1) === 2) await new Promise((resolve) => setTimeout(resolve, 20));
            return target.insert(args);
          };
        }
        const value = target[key];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    expect(await race(createClickHouseAePersistence({ client, logger: { info() {} } }).adapter)).toEqual([5184]);
  });

  it('both adapters implement every schema-2 role method', () => {
    expect(missingRoleMethods(createMemoryAePersistence().adapter, AE_PERSISTENCE_ROLES)).toEqual({});
    expect(missingRoleMethods(createClickHouseAePersistence({ client: createFakeAeClient(), logger: { info() {} } }).adapter, AE_PERSISTENCE_ROLES)).toEqual({});
  });

  it('memory adapter round-trips dataset deletes, trends, and session tags', async () => {
    const { adapter, snapshot } = createMemoryAePersistence();
    await roleContract(adapter, (kind) => snapshot()[kind], async () => {});
  });

  it('clickhouse adapter (fake client) round-trips dataset deletes, trends, and session tags', async () => {
    let now = Date.now();
    _setClockForTests({ now: () => new Date(now).toISOString().replace('T', ' ').slice(0, -1) });
    const client = createFakeAeClient();
    const { adapter } = createClickHouseAePersistence({ client, logger: { info() {} } });
    const TABLE = { datasetRows: DATASET_ROW, tagTrendRows: TAG_TREND };
    await roleContract(
      adapter,
      (kind) => currentRows(TABLE[kind], client.tables.get(TABLE[kind]) ?? []),
      async () => { now += 1000; },
    );
  });

  it('ensureAeSchema runs only complete create statements, in order', async () => {
    const client = createFakeAeClient();
    await ensureAeSchema(client, DATABASE);
    // 64 tables + 62 views, nothing else.
    expect(client.commands).toHaveLength(126);
    expect(client.commands.every((q) => q.startsWith('CREATE TABLE') || q.startsWith('CREATE OR REPLACE VIEW'))).toBe(true);
    expect(client.commands.every((q) => !q.includes('${DATABASE}'))).toBe(true);
    expect(client.commands.some((q) => /DROP|TRUNCATE/i.test(q))).toBe(false);
    const tables = client.commands.filter((q) => q.startsWith('CREATE TABLE'));
    const views = client.commands.filter((q) => q.startsWith('CREATE OR REPLACE VIEW'));
    expect(tables).toHaveLength(64);
    expect(views).toHaveLength(62);
    expect(views.every((q) => q.includes('FINAL'))).toBe(true);
  });
});
