import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzeSite, engineCommand, heapMb } from '../../bin/analyze-site.mjs';

/**
 * The analysis stage's command creates one site's batch under the profile,
 * records the batch id for the check, and runs the batch for that site.
 */

const counts = (awaitingCapture) => `{"batchId":"b-1","counts":{"queued":1,"qualified":${1 - awaitingCapture},"awaitingCapture":${awaitingCapture}}}\n`;

function engineFake({ createCode = 0, runCode = 0, awaiting = [] } = {}) {
  const calls = [];
  const said = [];
  let runs = 0;
  return {
    calls,
    said,
    async engine(args) {
      calls.push(args);
      if (args[0] === '--batch') return { code: createCode, stdout: createCode === 0 ? 'batch_id: b-1\n' : '' };
      if (args[0] === '--capture') return { code: 0, stdout: '' };
      const waiting = awaiting[runs] ?? 0;
      runs += 1;
      return { code: runCode, stdout: counts(waiting) };
    },
    say(line) {
      said.push(line);
    },
  };
}

const argv = (dir, extra = []) => ['--profile', 'pdp', '--idsite', '4879', '--window-start', '2026-09-12', '--window-end', '2026-10-11', '--batch-file', path.join(dir, 'batch.json'), ...extra];

describe('analyze-site', () => {
  it('creates the batch over the window days, records it, and runs it for the site', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'analyze-site-'));
    const io = engineFake();
    expect(await analyzeSite(argv(dir, ['--select', '{"limitPerSite": 3}']), io)).toBe(0);
    expect(io.calls).toEqual([
      ['--batch', '--profile', 'pdp', '--site-source', 'static-idsites', '--sites', '4879', '--window-days', '30', '--select', '{"limitPerSite": 3}'],
      ['--run', '--batch', 'b-1', '--site-source', 'static-idsites', '--sites', '4879', '--agents', '1'],
    ]);
    expect(JSON.parse(await readFile(path.join(dir, 'batch.json'), 'utf8'))).toEqual({ batchId: 'b-1', profile: 'pdp', idsite: 4879, windowDays: 30 });
  });

  it('passes no criteria for an empty select and returns the run exit code', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'analyze-site-'));
    const io = engineFake({ runCode: 1 });
    expect(await analyzeSite(argv(dir, ['--select', '{}']), io)).toBe(1);
    expect(io.calls[0]).not.toContain('--select');
  });

  it('captures the pages a run left waiting, then runs the batch again', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'analyze-site-'));
    const io = engineFake({ awaiting: [1, 0] });
    expect(await analyzeSite(argv(dir), io)).toBe(0);
    expect(io.calls.slice(1)).toEqual([
      ['--run', '--batch', 'b-1', '--site-source', 'static-idsites', '--sites', '4879', '--agents', '1'],
      ['--capture', '--agents', '1', '--site-source', 'static-idsites'],
      ['--run', '--batch', 'b-1', '--site-source', 'static-idsites', '--sites', '4879', '--agents', '1'],
    ]);
  });

  it('fails when a page still waits for its capture after the capture run', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'analyze-site-'));
    const io = engineFake({ awaiting: [1, 1] });
    expect(await analyzeSite(argv(dir), io)).toBe(1);
    expect(io.calls).toHaveLength(4);
    expect(io.said.at(-1)).toBe('batch b-1: 1 site still awaiting capture after the capture run');
  });

  it('runs the engine on the analysis heap', () => {
    const { command, args } = engineCommand(['--run', '--batch', 'b-1'], 8192);
    expect(command).toBe(process.execPath);
    expect(args.slice(0, 2)).toEqual(['--expose-gc', '--max-old-space-size=8192']);
    const GB = 1024 ** 3;
    expect(heapMb({}, 64 * GB)).toBe(32768);
    expect(heapMb({}, 128 * GB)).toBe(32768);
    expect(heapMb({}, 24 * GB)).toBe(12288);
    expect(heapMb({}, 8 * GB)).toBe(8192);
    expect(heapMb({ ANALYSIS_HEAP_MB: '24576' }, 64 * GB)).toBe(24576);
    expect(args.at(2)).toMatch(/src[\\/]cli\.js$/);
    expect(args.slice(3)).toEqual(['--run', '--batch', 'b-1']);
  });

  it('stops at a failed creation and at a usage error', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'analyze-site-'));
    const failed = engineFake({ createCode: 1 });
    expect(await analyzeSite(argv(dir), failed)).toBe(1);
    expect(failed.calls).toHaveLength(1);
    const io = engineFake();
    expect(await analyzeSite(['--profile', 'pdp'], io)).toBe(2);
    expect(io.calls).toEqual([]);
  });
});
