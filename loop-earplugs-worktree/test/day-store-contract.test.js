import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createClickHouseDayStore, splitRows } from '../src/adapters/day-store/clickhouse.js';
import { createLocalDayStore } from '../src/adapters/day-store/local.js';
import { createMemoryDayStore } from '../src/adapters/day-store/memory.js';

/**
 * ae_scan_day in memory: inserts keep every row, and a read applies the
 * adapter's query as ClickHouse would: the entry's rows at its latest
 * generated_at, one per part, in part order.
 */
function fakeClient() {
  const rows = [];
  return {
    rows,
    async insert({ table, values }) {
      expect(table).toBe('analysis.ae_scan_day');
      rows.push(...values.map((value) => structuredClone(value)));
    },
    async query({ query, query_params: p }) {
      expect(query).toMatch(/max\(generated_at\)/);
      expect(query).toMatch(/LIMIT 1 BY part/);
      const mine = rows.filter((row) => row.idsite === p.idsite && row.kind === p.kind && row.key === p.key && row.server_date === p.day);
      const latest = mine.map((row) => row.generated_at).sort().at(-1);
      const seen = new Set();
      const out = mine
        .filter((row) => row.generated_at === latest)
        .sort((a, b) => a.part - b.part)
        .filter((row) => (seen.has(row.part) ? false : seen.add(row.part)));
      return { json: async () => out };
    },
  };
}

function ticking() {
  let n = 0;
  return () => `2026-10-14 10:00:00.${String((n += 1)).padStart(3, '0')}`;
}

const dirs = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const STORES = {
  memory: () => createMemoryDayStore(),
  local: () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'day-store-'));
    dirs.push(dir);
    return createLocalDayStore({ dir });
  },
  clickhouse: () => createClickHouseDayStore({ client: fakeClient(), database: 'analysis', now: ticking(), partBytes: 200 }),
};

const KEY = { idsite: 7, kind: 'day', key: '', day: '2026-09-08' };
const SHAPE = { events: ['add_to_cart', 'product_viewed'], partnerTags: false };
const rowsOf = (n, tag = 'a') => Array.from({ length: n }, (_, i) => ({ idvisit: String(1000 + i), tags: `${tag}${i}`, hsrs: ['11', '12'] }));

describe.each(Object.keys(STORES))('day store contract: %s', (name) => {
  it('reads back what it wrote', async () => {
    const store = STORES[name]();
    expect(store.id).toBe(name);
    const entry = { ...KEY, version: 3, final: true, shape: SHAPE, rows: rowsOf(12) };
    await store.write(entry);
    expect(await store.read(KEY)).toEqual(entry);
  });

  it('returns null for an entry it never wrote', async () => {
    const store = STORES[name]();
    await store.write({ ...KEY, version: 1, final: false, shape: SHAPE, rows: rowsOf(2) });
    expect(await store.read({ ...KEY, day: '2026-09-09' })).toBeNull();
    expect(await store.read({ ...KEY, kind: 'page-facts', key: '12' })).toBeNull();
  });

  it('replaces an entry whole, a longer one by a shorter one', async () => {
    const store = STORES[name]();
    await store.write({ ...KEY, version: 1, final: false, shape: SHAPE, rows: rowsOf(30, 'old') });
    const shorter = { ...KEY, version: 2, final: true, shape: { events: ['add_to_cart'], partnerTags: true }, rows: rowsOf(3, 'new') };
    await store.write(shorter);
    expect(await store.read(KEY)).toEqual(shorter);
  });

  it('keeps page facts apart per page, with no shape', async () => {
    const store = STORES[name]();
    const a = { idsite: 7, kind: 'page-facts', key: '12', day: KEY.day, version: 1, final: true, shape: null, rows: [{ idvisit: '1', hsr: '12', scrollMax: 40 }] };
    const b = { ...a, key: '13', rows: [] };
    await store.write(a);
    await store.write(b);
    expect(await store.read(a)).toEqual(a);
    expect(await store.read(b)).toEqual(b);
  });

  it('refuses a malformed key', async () => {
    const store = STORES[name]();
    await expect(store.read({ ...KEY, kind: 'visits' })).rejects.toThrow(/unknown kind/);
    await expect(store.write({ ...KEY, day: '9/8/2026', version: 1, final: true, shape: SHAPE, rows: [] })).rejects.toThrow(/YYYY-MM-DD/);
    await expect(store.read({ ...KEY, key: '../x' })).rejects.toThrow(/idsitehsr/);
  });

  it('hands out copies', async () => {
    const store = STORES[name]();
    await store.write({ ...KEY, version: 1, final: true, shape: SHAPE, rows: rowsOf(2) });
    const first = await store.read(KEY);
    first.rows[0].tags = 'changed';
    expect((await store.read(KEY)).rows[0].tags).toBe('a0');
  });

  it.skipIf(name === 'clickhouse')('prunes one site\'s days before a date, of both kinds, and keeps the rest', async () => {
    const store = STORES[name]();
    const at = (day, extra = {}) => ({ ...KEY, day, version: 1, final: true, shape: SHAPE, rows: rowsOf(1), ...extra });
    const facts = (day) => at(day, { kind: 'page-facts', key: '12', shape: null });
    for (const entry of [at('2026-09-06'), at('2026-09-07'), at('2026-09-08'), facts('2026-09-07'), facts('2026-09-08'), at('2026-09-06', { idsite: 8 })]) {
      await store.write(entry);
    }
    expect(await store.prune({ idsite: 7, before: '2026-09-08' })).toBe(3);
    expect(await store.read(at('2026-09-06'))).toBeNull();
    expect(await store.read(at('2026-09-07'))).toBeNull();
    expect(await store.read(facts('2026-09-07'))).toBeNull();
    expect(await store.read(at('2026-09-08'))).not.toBeNull();
    expect(await store.read(facts('2026-09-08'))).not.toBeNull();
    expect(await store.read(at('2026-09-06', { idsite: 8 }))).not.toBeNull();
    expect(await store.prune({ idsite: 9, before: '2026-09-08' })).toBe(0);
  });
});

describe('the ClickHouse day store\'s expiry', () => {
  it('leaves pruning to the table TTL', async () => {
    const client = fakeClient();
    const store = createClickHouseDayStore({ client, database: 'analysis', now: ticking() });
    await store.write({ ...KEY, version: 1, final: true, shape: SHAPE, rows: rowsOf(1) });
    expect(await store.prune({ idsite: 7, before: '2026-12-01' })).toBe(0);
    expect(await store.read(KEY)).not.toBeNull();
  });
});

describe('the ClickHouse day store\'s parts', () => {
  it('splits rows at the part limit and keeps every row', () => {
    const rows = rowsOf(10);
    const parts = splitRows(rows, 120);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((part) => part.text.length <= 120 || part.rows === 1)).toBe(true);
    expect(parts.flatMap((part) => JSON.parse(part.text))).toEqual(rows);
    expect(splitRows([], 120)).toEqual([{ rows: 0, text: '[]' }]);
  });

  it('writes one generated_at per entry and reads null when a part is missing', async () => {
    const client = fakeClient();
    const store = createClickHouseDayStore({ client, database: 'analysis', now: ticking(), partBytes: 200 });
    await store.write({ ...KEY, version: 1, final: true, shape: SHAPE, rows: rowsOf(20) });
    expect(new Set(client.rows.map((row) => row.generated_at)).size).toBe(1);
    expect(client.rows.length).toBeGreaterThan(2);
    expect(client.rows.every((row) => row.parts === client.rows.length)).toBe(true);
    client.rows.splice(1, 1);
    expect(await store.read(KEY)).toBeNull();
  });
});
