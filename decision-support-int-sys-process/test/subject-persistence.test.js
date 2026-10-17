import { describe, expect, it } from 'vitest';
import { createMemoryAePersistence } from '../src/adapters/persistence/memory.js';
import { createClickHouseAePersistence } from '../src/adapters/persistence/clickhouse.js';
import {
  aeMigrationStatements,
  ensureAe,
  migrateAeSchema,
} from '../src/adapters/persistence/clickhouse/schema-migrator.js';
import { storedRowToCollected, toDatasetRows } from '../src/adapters/_lib/rows.js';

const BATCH = '00000000-0000-4000-8000-0000000000aa';
const DB = 'journey_events';

function recordingClient() {
  const commands = [];
  const inserts = [];
  const queries = [];
  return {
    commands,
    inserts,
    queries,
    async command({ query }) { commands.push(query); },
    async insert({ table, values }) { inserts.push({ table, values }); },
    async query({ query, query_params: params }) {
      queries.push({ query: query.replace(/\s+/g, ' ').trim(), params });
      return { json: async () => [] };
    },
  };
}

const experiment = (key, label) => ({
  subjectType: 'experiment',
  subjectKey: key,
  label,
  dims: { status: 'running' },
  role: 'subject',
  selectionReason: 'running experiment',
});

describe('ae schema migration', () => {
  it('adds the subject columns and replaces each altered view', () => {
    const statements = aeMigrationStatements(DB);
    const alters = statements.filter((s) => s.startsWith('ALTER'));
    const views = statements.filter((s) => s.startsWith('CREATE OR REPLACE VIEW'));
    expect(alters).toHaveLength(19);
    expect(alters.every((s) => / ADD COLUMN IF NOT EXISTS /.test(s))).toBe(true);
    expect(statements.some((s) => /DROP|TRUNCATE|DELETE|MODIFY|RENAME/i.test(s))).toBe(false);
    expect(views).toEqual([
      'ae_batch', 'ae_dataset_row', 'ae_analysis_checkpoint', 'ae_requirement_status', 'ae_strategy_card', 'ae_trigger_chain',
    ].map((t) => `CREATE OR REPLACE VIEW ${DB}.${t}_current AS SELECT * FROM ${DB}.${t} FINAL`));
    expect(statements.indexOf(views[0])).toBe(alters.length);
  });

  it('adds the hit dims to the chain table', () => {
    const chain = aeMigrationStatements(DB).filter((s) => s.startsWith(`ALTER TABLE ${DB}.ae_trigger_chain `));
    expect(chain.map((s) => s.split(' ADD COLUMN IF NOT EXISTS ')[1].split(' ')[0])).toEqual([
      'level', 'device', 'channel', 'source', 'medium', 'returning', 'country', 'landing_page', 'entry_template',
    ]);
  });

  it('writes the hit dims on each chain row', async () => {
    const client = recordingClient();
    const { adapter } = createClickHouseAePersistence({ client, database: DB, logger: { info() {}, warn() {}, error() {} } });
    const chain = {
      idsite: 7, triggerKey: 'abandoned_cart', serverDate: '2026-09-11', triggerVersion: 1, idvisit: '6911064341127004002', configId: 'c1',
      level: 'session', device: 'mobile', channel: 'social', source: 'facebook', medium: 'paid', returning: 'new', country: 'us',
      landingPage: '/products/a', entryTemplate: 'product',
      returned: true, sessionsUntilReturn: 1, sessionsUntilPurchase: 0, purchased: false, revenue: 0, secondsToPurchase: 0,
      recovered: false, windowDays: 14, windowCloses: '2026-09-25', final: true,
    };
    await adapter.writeTriggerBatch({ chains: [chain] });
    const [row] = client.inserts.find((insert) => insert.table === `${DB}.ae_trigger_chain`).values;
    expect(row).toMatchObject({
      level: 'session', device: 'mobile', channel: 'social', source: 'facebook', medium: 'paid', returning: 'new', country: 'us',
      landing_page: '/products/a', entry_template: 'product', returned: 1, final: 1,
    });
  });

  it('refuses a statement outside its list before sending any', async () => {
    const client = recordingClient();
    const foreign = `ALTER TABLE ${DB}.ae_dataset_row DROP COLUMN subject_key`;
    await expect(migrateAeSchema(client, DB, [aeMigrationStatements(DB)[0], foreign]))
      .rejects.toThrow(/refuses a statement outside its list/);
    expect(client.commands).toEqual([]);
  });

  it('ensureAe creates the schema, then migrates it', async () => {
    const client = recordingClient();
    await ensureAe(client, DB);
    const migration = aeMigrationStatements(DB);
    expect(client.commands.slice(-migration.length)).toEqual(migration);
    expect(client.commands.slice(0, -migration.length).every((q) => q.startsWith('CREATE'))).toBe(true);
    expect(client.commands.some((q) => /^CREATE TABLE IF NOT EXISTS journey_events\.ae_subject_target\s*\(/.test(q))).toBe(true);
  });
});

describe('subject identity in memory persistence', () => {
  it('keeps two subjects at idsitehsr 0 apart and reads each back', async () => {
    const { adapter } = createMemoryAePersistence();
    const dataset = { id: 'experiment-readout', rows: [{ dims: { variant: 'b' }, metrics: { sessions: 10 } }] };
    const first = toDatasetRows(BATCH, { idsite: 7, idsitehsr: 0, subjectType: 'experiment', subjectKey: 'exp:a' }, dataset);
    const second = toDatasetRows(BATCH, { idsite: 7, idsitehsr: 0, subjectType: 'experiment', subjectKey: 'exp:b' }, dataset);
    expect(first[0].rowKey).not.toBe(second[0].rowKey);
    await adapter.writeDatasetRows([...first, ...second]);
    const read = await adapter.readSubjectDatasetRows({
      batchId: BATCH, idsite: 7, subjectType: 'experiment', subjectKey: 'exp:b', datasetId: 'experiment-readout',
    });
    expect(read.map((r) => [r.subject_type, r.subject_key, JSON.parse(r.metrics).sessions])).toEqual([['experiment', 'exp:b', 10]]);

    await adapter.deleteDatasetRows({
      batchId: BATCH, idsite: 7, subjectType: 'experiment', subjectKey: 'exp:a', datasetIds: ['experiment-readout'],
    });
    const left = await adapter.readDatasetRows({ batchId: BATCH, idsite: 7, idsitehsr: 0, datasetId: 'experiment-readout' });
    expect(left.map((r) => r.subject_key)).toEqual(['exp:b']);
  });

  it('stores a whole-window week in dim_extra, since dim_week holds dates, and reads the row back the same', async () => {
    const { adapter } = createMemoryAePersistence();
    const rows = [
      { dims: { week: 'all', bot_filter: 'exclude_confirmed', step_index: 0, step: 'view' }, metrics: { reached_sessions: 9 } },
      { dims: { week: '2026-09-28', bot_filter: 'exclude_confirmed', step_index: 0, step: 'view' }, metrics: { reached_sessions: 4 } },
    ];
    const written = toDatasetRows(BATCH, { idsite: 7, idsitehsr: 0, subjectType: 'funnel', subjectKey: 'fn:checkout' }, { id: 'funnel-steps', rows });
    expect(written.map((r) => [r.dimWeek, r.dimExtra.week])).toEqual([[undefined, 'all'], ['2026-09-28', undefined]]);
    await adapter.writeDatasetRows(written);
    const read = await adapter.readSubjectDatasetRows({ batchId: BATCH, idsite: 7, subjectType: 'funnel', subjectKey: 'fn:checkout', datasetId: 'funnel-steps' });
    expect(read.map((raw) => storedRowToCollected(raw).dims.week).sort()).toEqual(['2026-09-28', 'all']);
  });

  it('refuses a dim_week that is not a date, as the ClickHouse column does', async () => {
    const { adapter } = createMemoryAePersistence();
    await expect(adapter.writeDatasetRows([{ batchId: BATCH, idsite: 7, idsitehsr: 0, datasetId: 'x', rowKey: 'k', dimWeek: 'all', metrics: {} }]))
      .rejects.toThrow(/dim_week/);
  });

  it('gives page rows their idsitehsr as the subject key and keeps their row key', async () => {
    const dataset = { id: 'entry-by-channel', rows: [{ dims: { channel: 'paid' }, metrics: { sessions: 3 } }] };
    const [page] = toDatasetRows(BATCH, { idsite: 7, idsitehsr: 4100 }, dataset);
    const [typed] = toDatasetRows(BATCH, { idsite: 7, idsitehsr: 4100, subjectType: 'page', subjectKey: '4100' }, dataset);
    expect(typed.rowKey).toBe(page.rowKey);
    expect(page.subjectType).toBeUndefined();

    const { adapter, snapshot } = createMemoryAePersistence();
    await adapter.writeDatasetRows([page, ...toDatasetRows(BATCH, { idsite: 7, idsitehsr: 0 }, dataset)]);
    await adapter.writeAnalysisCheckpoint({ batchId: BATCH, idsite: 7, idsitehsr: 4100, datasetId: 'entry-by-channel' });
    expect(snapshot().datasetRows.map((r) => [r.idsitehsr, r.subject_type, r.subject_key]))
      .toEqual([[4100, 'page', '4100'], [0, 'page', '']]);
    const [checkpoint] = await adapter.readAnalysisCheckpoints({ batchId: BATCH, idsite: 7 });
    expect([checkpoint.subjectType, checkpoint.subjectKey]).toEqual(['page', '4100']);
  });

  it('round-trips subject targets and merges a status update', async () => {
    const { adapter } = createMemoryAePersistence();
    await adapter.writeSubjectTargets(BATCH, 7, [experiment('exp:b', 'Hero test'), experiment('exp:a', 'Price test')]);
    await adapter.updateSubjectTarget({
      batchId: BATCH, idsite: 7, subjectType: 'experiment', subjectKey: 'exp:a', status: 'analyzed',
    });
    const targets = await adapter.readSubjectTargets({ batchId: BATCH, idsite: 7 });
    expect(targets.map((t) => [t.subjectKey, t.label, t.status, t.dims.status])).toEqual([
      ['exp:a', 'Price test', 'analyzed', 'running'],
      ['exp:b', 'Hero test', 'selected', 'running'],
    ]);
    await expect(adapter.updateSubjectTarget({
      batchId: BATCH, idsite: 7, subjectType: 'experiment', subjectKey: 'exp:z', status: 'failed',
    })).rejects.toThrow(/not found/);
  });

  it('stores the batch profile and subject type', async () => {
    const { adapter } = createMemoryAePersistence();
    await adapter.createBatch({
      batchId: BATCH, windowStart: '2026-09-01', windowEnd: '2026-09-30', profile: 'xp', subjectType: 'experiment',
    });
    const batch = await adapter.getBatch(BATCH);
    expect([batch.profile, batch.subjectType]).toEqual(['xp', 'experiment']);
  });
});

describe('subject identity in ClickHouse persistence', () => {
  it('writes the subject columns and filters subject reads by type and key', async () => {
    const client = recordingClient();
    const { adapter } = createClickHouseAePersistence({ client, logger: { info() {} } });
    const dataset = { id: 'experiment-readout', rows: [{ dims: { variant: 'b' }, metrics: { sessions: 10 } }] };
    await adapter.writeDatasetRows([
      ...toDatasetRows(BATCH, { idsite: 7, idsitehsr: 0, subjectType: 'experiment', subjectKey: 'exp:a' }, dataset),
      ...toDatasetRows(BATCH, { idsite: 7, idsitehsr: 4100 }, dataset),
    ]);
    await adapter.writeSubjectTargets(BATCH, 7, [experiment('exp:a', 'Price test')]);
    await adapter.createBatch({ batchId: BATCH, windowStart: '2026-09-01', windowEnd: '2026-09-30', profile: 'xp', subjectType: 'experiment' });
    await adapter.readSubjectDatasetRows({
      batchId: BATCH, idsite: 7, subjectType: 'experiment', subjectKey: 'exp:a', datasetId: 'experiment-readout',
    });

    const rows = client.inserts.find((i) => i.table === `${DB}.ae_dataset_row`).values;
    expect(rows.map((r) => [r.idsitehsr, r.subject_type, r.subject_key])).toEqual([[0, 'experiment', 'exp:a'], [4100, 'page', '4100']]);
    const [target] = client.inserts.find((i) => i.table === `${DB}.ae_subject_target`).values;
    expect([target.subject_type, target.subject_key, target.label, target.status]).toEqual(['experiment', 'exp:a', 'Price test', 'selected']);
    const [batch] = client.inserts.find((i) => i.table === `${DB}.ae_batch`).values;
    expect([batch.profile, batch.subject_type]).toEqual(['xp', 'experiment']);
    const read = client.queries.at(-1);
    expect(read.query).toContain('AND subject_type = {subjectType:String} AND subject_key = {subjectKey:String}');
    expect(read.params).toMatchObject({ subjectType: 'experiment', subjectKey: 'exp:a' });
  });
});
