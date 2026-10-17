import { describe, expect, it } from 'vitest';
import { createMemoryPersistence } from '../src/adapters/persistence/memory.js';
import { createClickHousePersistence } from '../src/adapters/persistence/clickhouse.js';
import { TAXONOMY_VERSION, ELEMENT_CLASSES } from '../src/domain/taxonomy.js';
import { V1_PERSISTENCE_ROLES, missingRoleMethods } from '../src/ports/persistence/index.js';

/**
 * Persistence contract (IMPLEMENTATION-PLAN.md section 11): the memory
 * adapter and the ClickHouse adapter (over a fake client that emulates the
 * _current views) both round-trip a batch, a queue claim, an analysis row,
 * and a dataset row. A second write of the same row_key leaves one current
 * row. The naming script claims, fails, and completes naming jobs, and the
 * resume read returns the stored batch.
 */

/** Latest-row-wins resolution, mirroring the _current views in SCHEMA_SQL. */
function currentRows(table, rows) {
  const keyFns = {
    [BATCH]: (r) => r.batch_id,
    [QUEUE]: (r) => `${r.batch_id}|${r.idsite}`,
    [ANALYSIS]: (r) => `${r.batch_id}|${r.idsite}|${r.idsitehsr}`,
    [DATASET]: (r) => `${r.batch_id}|${r.idsite}|${r.idsitehsr}|${r.dataset_id}|${r.row_key}`,
    [NAMING_QUEUE]: (r) => `${r.idsite}|${r.idsitehsr}`,
    [PAGE_NAMING]: (r) => `${r.idsite}|${r.idsitehsr}`,
    [ELEMENT_NAME]: (r) => `${r.idsite}|${r.idsitehsr}|${r.selector}`,
  };
  const version = table === BATCH ? 'created_at' : 'generated_at';
  const byKey = new Map();
  for (const row of rows) {
    const key = keyFns[table](row);
    const prev = byKey.get(key);
    if (!prev || String(prev[version]) <= String(row[version])) byKey.set(key, row);
  }
  return [...byKey.values()];
}

const BATCH = 'journey_events.landing_page_batch';
const QUEUE = 'journey_events.site_queue';
const ANALYSIS = 'journey_events.landing_page_analysis';
const DATASET = 'journey_events.landing_page_dataset';
const NAMING_QUEUE = 'journey_events.naming_queue';
const PAGE_NAMING = 'journey_events.page_naming';
const ELEMENT_NAME = 'journey_events.page_element_name';

function createFakeClient() {
  /** @type {Map<string, object[]>} */
  const tables = new Map();
  const rowsOf = (t) => tables.get(t) ?? [];

  return {
    tables,
    async insert({ table, values }) {
      tables.set(table, [...rowsOf(table), ...values]);
    },
    async command({ query, query_params = {} }) {
      if (query.includes(`INSERT INTO ${QUEUE}`)) {
        const batchId = query_params.batchId;
        const existing = new Set(
          currentRows(QUEUE, rowsOf(QUEUE))
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
            idsitehsr: 0,
            landing_page_url: '',
            page_type: '',
            entry_sessions: 0,
            orders: 0,
            revenue: 0,
            reason: '',
            generated_at: query_params[`ts${i}`],
          });
        }
        tables.set(QUEUE, [...rowsOf(QUEUE), ...fresh]);
        return;
      }
      throw new Error(`fake client: unexpected command ${query.slice(0, 60)}`);
    },
    async query({ query, query_params = {} }) {
      let rows = [];
      const page = (r) => Number(r.idsite) === Number(query_params.idsite) && Number(r.idsitehsr) === Number(query_params.idsitehsr);
      if (query.includes(`FROM ${NAMING_QUEUE}`) && query.includes('LIMIT 1')) {
        rows = currentRows(NAMING_QUEUE, rowsOf(NAMING_QUEUE))
          .filter((r) => r.status === 'queued' || (r.status === 'claiming' && String(r.generated_at) < query_params.staleBefore))
          .sort((a, b) => String(a.requested_on).localeCompare(String(b.requested_on)) || a.idsite - b.idsite || a.idsitehsr - b.idsitehsr)
          .slice(0, 1);
      } else if (query.includes(`FROM ${NAMING_QUEUE}`)) {
        rows = currentRows(NAMING_QUEUE, rowsOf(NAMING_QUEUE)).filter(page);
      } else if (query.includes(`FROM ${PAGE_NAMING}`)) {
        rows = currentRows(PAGE_NAMING, rowsOf(PAGE_NAMING)).filter(page);
      } else if (query.includes(`FROM ${QUEUE}`) && query.includes('awaiting_naming')) {
        rows = currentRows(QUEUE, rowsOf(QUEUE)).filter((r) => page(r) && r.status === 'awaiting_naming');
      } else if (query.includes(`FROM ${QUEUE}`) && query.includes('LIMIT 1')) {
        const staleBefore = new Date(Date.now() - 15 * 60 * 1000).toISOString();
        const claimed = currentRows(QUEUE, rowsOf(QUEUE))
          .filter((r) => r.batch_id === query_params.batchId)
          .filter(
            (r) =>
              r.status === 'queued' ||
              (['qualifying', 'analyzing'].includes(r.status) && Date.parse(String(r.generated_at).replace(' ', 'T')) < Date.now() - 15 * 60 * 1000),
          )
          .sort((a, b) => Number(a.idsite) - Number(b.idsite))
          .slice(0, 1)
          .map((r) => ({ idsite: r.idsite, site_name: r.site_name }));
        rows = claimed;
      } else if (query.includes(`FROM ${QUEUE}`) && query.includes('claim_token')) {
        rows = currentRows(QUEUE, rowsOf(QUEUE))
          .filter((r) => r.batch_id === query_params.batchId && Number(r.idsite) === Number(query_params.idsite))
          .map((r) => ({ claim_token: r.claim_token ?? '' }));
      } else if (query.includes(`FROM ${QUEUE}`)) {
        rows = currentRows(QUEUE, rowsOf(QUEUE)).filter(
          (r) => r.batch_id === query_params.batchId && Number(r.idsite) === Number(query_params.idsite),
        );
      } else if (query.includes(`FROM ${BATCH}`)) {
        rows = currentRows(BATCH, rowsOf(BATCH)).filter((r) => r.batch_id === query_params.batchId);
      } else {
        throw new Error(`fake client: unexpected query ${query.slice(0, 60)}`);
      }
      return { json: async () => rows.map((r) => ({ ...r })) };
    },
  };
}

const BATCH_ID = '11111111-2222-3333-4444-555555555555';
const SPEC = {
  batchId: BATCH_ID,
  windowStart: '2026-09-26',
  windowEnd: '2026-10-02',
  siteSource: 'static-idsites',
  qualifier: 'prefer-non-home',
  minSessions: 1000,
  minOrders: 5,
  minShareOfHome: 0.5,
  status: 'running',
  metadata: { schema_version: 1 },
};

function analysisRecord(over = {}) {
  return {
    batchId: BATCH_ID,
    idsite: 1,
    idsitehsr: 99,
    landingPageUrl: 'https://x.com/pages/lp',
    pageTitle: 'LP',
    pageType: 'content',
    windowStart: '2026-09-26',
    windowEnd: '2026-10-02',
    entrySessions: 2000,
    orders: 10,
    revenue: 500,
    rps: 0.25,
    singlePageviewShare: 0.4,
    scrollReach25: 0.3,
    scrollReach70: 0.1,
    desktopRps: 0.3,
    mobileRps: 0.1,
    mobileToDesktopRps: 0.33,
    botSessionsExcluded: 100,
    sessionsUnfiltered: 2100,
    ordersUnfiltered: 11,
    strategiesTriggered: 2,
    strategiesBelowFloor: 1,
    strategiesBlocked: 3,
    strategiesSilent: 8,
    status: 'analyzed',
    metadata: { qualifier: {} },
    ...over,
  };
}

/**
 * The contract script every persistence adapter must pass.
 * @param {object} persistence
 * @param {(kind: string) => object[]} readCurrent
 */
async function contract(persistence, readCurrent) {
  await persistence.createBatch(SPEC);
  await persistence.enqueue(BATCH_ID, [
    { idsite: 1, siteName: 'one' },
    { idsite: 2, siteName: 'two' },
  ]);

  const [claim1] = await persistence.claimNext(BATCH_ID);
  expect(claim1.idsite).toBe(1);

  // fresh claims are exclusive between agents: the next claim takes the next
  // site, never a copy of an in-flight one
  const [claim2] = await persistence.claimNext(BATCH_ID);
  expect(claim2.idsite).toBe(2);

  await persistence.updateQueue({
    batchId: BATCH_ID,
    idsite: 1,
    status: 'analyzed',
    idsitehsr: 99,
    landingPageUrl: 'https://x.com/pages/lp',
    pageType: 'content',
    entrySessions: 2000,
    orders: 10,
    revenue: 500,
    reason: '',
  });

  // site 2 is still in flight (fresh claim) -> nothing else to claim
  expect(await persistence.claimNext(BATCH_ID)).toEqual([]);

  await persistence.updateQueue({ batchId: BATCH_ID, idsite: 2, status: 'skipped_volume', reason: 'too small' });
  expect(await persistence.claimNext(BATCH_ID)).toEqual([]);

  await persistence.writeAnalysis(analysisRecord());

  const row = (n) => ({
    batchId: BATCH_ID,
    idsite: 1,
    idsitehsr: 99,
    datasetId: 'fixture',
    botFilter: 'exclude_confirmed',
    dimWeek: '2026-09-28',
    dimDevice: 'desktop',
    metrics: { sessions: n },
    rowKey: 'k1',
  });
  await persistence.writeDataset([row(1), { ...row(2), rowKey: 'k2' }]);
  // rerun: same row_key, new metrics; must replace, not duplicate
  await persistence.writeDataset([row(3)]);

  const batch = readCurrent('batch').find((b) => (b.batchId ?? b.batch_id) === BATCH_ID);
  expect(batch.status).toBe('running');
  expect(batch.minSessions ?? batch.min_sessions).toBe(1000);

  const queue = readCurrent('queue').sort((a, b) => Number(a.idsite) - Number(b.idsite));
  expect(queue.map((r) => r.status)).toEqual(['analyzed', 'skipped_volume']);

  const analyses = readCurrent('analysis');
  expect(analyses).toHaveLength(1);
  const a = analyses[0];
  expect(Number(a.entry_sessions ?? a.entrySessions)).toBe(2000);
  expect(Number(a.strategies_silent ?? a.strategiesSilent)).toBe(8);
  const meta = typeof a.metadata === 'string' ? JSON.parse(a.metadata) : a.metadata;
  expect(meta.qualifier).toEqual({});

  const datasets = readCurrent('dataset');
  expect(datasets).toHaveLength(2);
  const k1 = datasets.find((d) => d.row_key === 'k1' || d.rowKey === 'k1');
  const metrics = typeof k1.metrics === 'string' ? JSON.parse(k1.metrics) : k1.metrics;
  expect(metrics.sessions).toBe(3); // the second write won

  // finishing the batch upserts counts and status
  await persistence.createBatch({ ...SPEC, status: 'complete', sitesQueued: 2, sitesQualified: 1, sitesSkipped: 0, sitesFailed: 0 });
  const finished = readCurrent('batch').find((b) => (b.batchId ?? b.batch_id) === BATCH_ID);
  expect(finished.status).toBe('complete');
  expect(Number(finished.sites_qualified ?? finished.sitesQualified)).toBe(1);
}

/**
 * The naming queue and resume read every v1 adapter must pass.
 * @param {object} persistence
 * @param {(kind: string) => object[]} readCurrent
 */
async function namingContract(persistence, readCurrent) {
  await persistence.createBatch(SPEC);
  await persistence.enqueue(BATCH_ID, [{ idsite: 3, siteName: 'three' }]);
  await persistence.updateQueue({ batchId: BATCH_ID, idsite: 3, status: 'awaiting_naming', idsitehsr: 99, reason: 'names stale' });

  const job = (idsitehsr) => ({ idsite: 3, idsitehsr, url: `https://x.com/p/${idsitehsr}`, pageType: 'content', reason: 'stale' });
  await persistence.enqueueNaming(job(99));
  await persistence.enqueueNaming(job(100));
  expect(await persistence.namingStatus({ idsite: 3, idsitehsr: 99 })).toBeNull();

  const first = await persistence.claimNaming();
  expect(first).toMatchObject({ idsite: 3, idsitehsr: 99, url: 'https://x.com/p/99', pageType: 'content', reason: 'stale' });
  expect(typeof first.token).toBe('string');
  const second = await persistence.claimNaming();
  expect(second.idsitehsr).toBe(100);
  // both are fresh claims: nothing left to take
  expect(await persistence.claimNaming()).toBeNull();

  await persistence.failNaming({ idsite: 3, idsitehsr: 100, reason: 'bot crashed' });
  expect(await persistence.claimNaming()).toBeNull();

  await expect(persistence.completeNaming({
    idsite: 3, idsitehsr: 99, namedOn: '2026-10-02', names: [{ selector: '#buy', element_class: 'not-a-class' }],
  })).rejects.toThrow(/not in taxonomy/);
  await persistence.completeNaming({
    idsite: 3, idsitehsr: 99, url: 'https://x.com/p/99', namedOn: '2026-10-02',
    names: [{ selector: '#buy', element_class: ELEMENT_CLASSES[0], name: 'Buy' }],
  });
  expect(await persistence.namingStatus({ idsite: 3, idsitehsr: 99 })).toMatchObject({
    status: 'complete', taxonomyVersion: TAXONOMY_VERSION, namedOn: '2026-10-02',
  });
  const site = readCurrent('queue').find((r) => Number(r.idsite) === 3);
  expect(site.status).toBe('queued');
  expect(site.reason).toBe('naming complete');

  const batch = await persistence.readBatch(BATCH_ID);
  expect(batch).toMatchObject({ batchId: BATCH_ID, windowStart: '2026-09-26', windowEnd: '2026-10-02', qualifier: 'prefer-non-home', minSessions: 1000 });
  expect(batch.metadata.schema_version).toBe(1);
  expect(await persistence.readBatch('99999999-9999-9999-9999-999999999999')).toBeNull();
}

describe('persistence contract', () => {
  it('memory adapter round-trips the contract', async () => {
    const { adapter, snapshot } = createMemoryPersistence();
    const KEY = { batch: 'batches', queue: 'queue', analysis: 'analyses', dataset: 'datasets' };
    await contract(adapter, (kind) => snapshot()[KEY[kind]]);
  });

  it('clickhouse adapter (fake client) round-trips the contract', async () => {
    const client = createFakeClient();
    const { adapter } = createClickHousePersistence({ client, logger: { info() {} } });
    const readCurrent = (kind) => {
      const table = { batch: BATCH, queue: QUEUE, analysis: ANALYSIS, dataset: DATASET }[kind];
      return currentRows(
        table,
        client.tables.get(table) ?? [],
      );
    };
    await contract(adapter, readCurrent);
  });

  it('both adapters implement every v1 role method', () => {
    expect(missingRoleMethods(createMemoryPersistence().adapter, V1_PERSISTENCE_ROLES)).toEqual({});
    expect(missingRoleMethods(createClickHousePersistence({ client: createFakeClient(), logger: { info() {} } }).adapter, V1_PERSISTENCE_ROLES)).toEqual({});
  });

  it('memory adapter claims, fails, and completes naming and reads a batch back', async () => {
    const { adapter, snapshot } = createMemoryPersistence();
    await namingContract(adapter, (kind) => snapshot()[{ queue: 'queue' }[kind]]);
  });

  it('clickhouse adapter (fake client) claims, fails, and completes naming and reads a batch back', async () => {
    const client = createFakeClient();
    const { adapter } = createClickHousePersistence({ client, logger: { info() {} } });
    await namingContract(adapter, (kind) => currentRows({ queue: QUEUE }[kind], client.tables.get({ queue: QUEUE }[kind]) ?? []));
  });
});
