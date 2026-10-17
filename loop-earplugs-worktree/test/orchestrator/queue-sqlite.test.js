import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describeQueueContract } from './queue-contract.js';
import { createStore } from '../../src/orchestrator/adapters/queue/sqlite.js';

const execFileAsync = promisify(execFile);
const dirs = [];
const stores = [];

afterEach(() => {
  while (stores.length) stores.pop().close();
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});

function openTemp(clock) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'orchestrator-queue-'));
  dirs.push(dir);
  const store = createStore({ path: 'queue.db', root: dir, clock });
  stores.push(store);
  return { store, dir };
}

describeQueueContract('sqlite', async (clock) => {
  const { store } = openTemp(clock);
  return store;
});

describe('sqlite two processes', () => {
  it('two workers on one database file never claim the same message', { timeout: 20000 }, async () => {
    const { store, dir } = openTemp();
    for (let i = 0; i < 300; i += 1) {
      await store.queue.enqueue('stage:two-process', { jobId: `job-${i}`, priority: 2, rankAt: i, payload: { i } });
    }
    store.close();
    stores.pop();

    const worker = path.join(import.meta.dirname, 'fixtures', 'two-process-worker.mjs');
    const dbFile = path.join(dir, 'queue.db');
    const run = (owner) => execFileAsync(process.execPath, [
      '--disable-warning=ExperimentalWarning', worker, dbFile, owner, path.join(dir, `${owner}.json`),
    ]);
    await Promise.all([run('w1'), run('w2')]);

    const a = JSON.parse(readFileSync(path.join(dir, 'w1.json'), 'utf8')).claimed;
    const b = JSON.parse(readFileSync(path.join(dir, 'w2.json'), 'utf8')).claimed;
    expect(a.length).toBeGreaterThan(0);
    expect(b.length).toBeGreaterThan(0);
    expect(a.filter((id) => b.includes(id))).toEqual([]);
    expect(a.length + b.length).toBe(300);
  });
});
