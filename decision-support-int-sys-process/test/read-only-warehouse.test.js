import { describe, expect, it } from 'vitest';
import { dayStoreClient, readOnlyClient } from '../scripts/lib/read-only-warehouse.mjs';

function rawClient() {
  const sent = [];
  return {
    sent,
    query: async (args) => sent.push(['query', args.query]),
    insert: async (args) => sent.push(['insert', args.table]),
    command: async (args) => sent.push(['command', args.query]),
    close: async () => {},
  };
}

describe('acceptance warehouse clients', () => {
  it('the read-only client sends reads and refuses every write', async () => {
    const raw = rawClient();
    const client = readOnlyClient(raw);
    await client.query({ query: 'SELECT 1' });
    await expect(client.query({ query: 'INSERT INTO db.t VALUES (1)' })).rejects.toThrow(/refused/);
    await expect(client.insert({ table: 'db.ae_scan_day', values: [] })).rejects.toThrow(/refused/);
    await expect(client.command({ query: 'DROP TABLE db.t' })).rejects.toThrow(/refused/);
    expect(raw.sent).toEqual([['query', 'SELECT 1']]);
  });

  it('the day store client inserts into ae_scan_day only', async () => {
    const raw = rawClient();
    const client = dayStoreClient(raw, 'db.ae_scan_day');
    await client.insert({ table: 'db.ae_scan_day', values: [] });
    await expect(client.insert({ table: 'db.ae_dataset_row', values: [] })).rejects.toThrow(/refused an insert into db.ae_dataset_row/);
    await expect(client.command({ query: 'ALTER TABLE db.ae_scan_day DELETE WHERE 1' })).rejects.toThrow(/refused/);
    await expect(client.query({ query: 'INSERT INTO db.ae_scan_day VALUES (1)' })).rejects.toThrow(/refused/);
    expect(raw.sent).toEqual([['insert', 'db.ae_scan_day']]);
  });
});
