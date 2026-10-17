import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEngineContext } from '../../src/composition/engine.js';

let tmp;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), 'engine-day-store-'));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const context = (env) => createEngineContext({
  env: { ANALYSIS_CONFIG: path.join(tmp, 'missing.json'), TELEMETRY: '0', LOG_LEVEL: 'silent', ...env },
});

describe('the engine day store', () => {
  it('opens the configured adapter once, with the overlap', async () => {
    const ctx = await context({ ANALYSIS_DAY_STORE: 'local', ANALYSIS_DAY_STORE_DIR: tmp, ANALYSIS_DAY_OVERLAP: '3' });
    const opened = ctx.dayStore();
    expect(opened.store.id).toBe('local');
    expect(opened.overlapDays).toBe(3);
    expect(ctx.dayStore()).toBe(opened);
    await opened.store.write({ idsite: 1, kind: 'day', key: '', day: '2026-09-10', version: 1, final: true, shape: null, rows: [] });
    expect(await readdir(tmp)).toEqual(['1']);
  });

  it('is null when off', async () => {
    expect((await context({ ANALYSIS_DAY_STORE: 'off' })).dayStore()).toBeNull();
  });

  it('names the discovered adapters for an unknown id', async () => {
    const ctx = await context({ ANALYSIS_DAY_STORE: 'nope' });
    expect(() => ctx.dayStore()).toThrow(/ANALYSIS_DAY_STORE="nope".*clickhouse.*local.*memory/);
  });
});
