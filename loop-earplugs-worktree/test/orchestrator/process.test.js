import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runProcess } from '../../src/orchestrator/adapters/_lib/process.js';
import { createTail } from '../../src/orchestrator/adapters/_lib/tail.js';

const dirs = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir() {
  const dir = await mkdtemp(path.join(tmpdir(), 'orch-process-'));
  dirs.push(dir);
  return dir;
}

const pidAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('createTail', () => {
  it('keeps only the last N lines', () => {
    const tail = createTail(3);
    for (const line of ['one', 'two', 'three', 'four', 'five']) tail.push(line);
    expect(tail.text()).toBe('three\nfour\nfive');
  });
});

describe('runProcess', () => {
  it('captures stdout and stderr into the log file and the tail', async () => {
    const dir = await tempDir();
    const logFile = path.join(dir, 'run.log');
    const result = await runProcess({
      command: process.execPath,
      args: ['-e', 'console.log("hello out"); console.error("hello err")'],
      cwd: dir,
      logFile,
    });
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.aborted).toBe(false);
    const log = await readFile(logFile, 'utf8');
    expect(log).toContain('hello out');
    expect(log).toContain('hello err');
    expect(result.tail).toContain('hello out');
    expect(result.tail).toContain('hello err');
  });

  it('kills the whole process group on timeout', async () => {
    const dir = await tempDir();
    const pidFile = path.join(dir, 'child.pid');
    const result = await runProcess({
      command: 'sh',
      args: ['-c', `sleep 30 & echo $! > "${pidFile}"; wait`],
      cwd: dir,
      logFile: path.join(dir, 'run.log'),
      timeoutMs: 300,
      killGraceMs: 100,
    });
    expect(result.timedOut).toBe(true);
    const grandchild = Number((await readFile(pidFile, 'utf8')).trim());
    expect(grandchild).toBeGreaterThan(0);
    for (let i = 0; i < 20 && pidAlive(grandchild); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(pidAlive(grandchild)).toBe(false);
  }, 15_000);

  it('kills the process on abort, flagged aborted and not timedOut', async () => {
    const dir = await tempDir();
    const controller = new AbortController();
    const pending = runProcess({
      command: 'sh',
      args: ['-c', 'sleep 30'],
      cwd: dir,
      logFile: path.join(dir, 'run.log'),
      signal: controller.signal,
      killGraceMs: 100,
    });
    setTimeout(() => controller.abort(), 100);
    const result = await pending;
    expect(result.aborted).toBe(true);
    expect(result.timedOut).toBe(false);
  }, 15_000);

  it('streams lines to onLine', async () => {
    const dir = await tempDir();
    const lines = [];
    await runProcess({
      command: process.execPath,
      args: ['-e', 'for (const x of ["a", "b", "c"]) console.log(x)'],
      cwd: dir,
      logFile: path.join(dir, 'run.log'),
      onLine: (line) => lines.push(line),
    });
    expect(lines).toEqual(['a', 'b', 'c']);
  });
});
