import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const cli = path.join(repo, 'src/orchestrator/cli.js');
const dirs = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function run(args) {
  return new Promise((resolve) => {
    execFile('node', ['--disable-warning=ExperimentalWarning', cli, ...args], { cwd: repo }, (error, stdout, stderr) => {
      resolve({ code: error ? error.code : 0, stdout, stderr });
    });
  });
}

async function config() {
  const dir = await mkdtemp(path.join(tmpdir(), 'orch-cli-'));
  dirs.push(dir);
  const file = path.join(dir, 'config.json');
  await writeFile(file, JSON.stringify({
    root: 'orchestration',
    workspace: path.join(dir, 'runs'),
    journalDir: path.join(dir, 'journal'),
    store: { adapter: 'sqlite', path: path.join(dir, 'orchestrator.db') },
    siteDirectory: { adapter: 'none' },
    governor: { capacity: { chromium: 1, 'clickhouse-heavy': 1 }, leaseMs: 120000 },
    worker: { pollMs: 50, maxPollMs: 100, heartbeatMs: 1000, maxDeliveries: 5 },
    values: {
      analysisRoot: dir,
      naming: {
        botDir: '/bot',
        engineDir: '/engine',
        assetsDir: '/assets',
        datasetRoot: '/bot/dataset',
        container: 'naming-bot',
      },
      report: { python: 'python3', chromePath: '/chrome' },
    },
  }));
  return file;
}

describe('orchestrator cli', () => {
  it('validates, explains, enqueues, and reports status', async () => {
    const file = await config();
    const valid = await run(['validate', '--config', file]);
    expect(valid.stderr, valid.stderr).toBe('');
    expect(valid.code).toBe(0);
    expect(valid.stdout).toMatch(/valid:/);

    const explained = await run(['explain', 'sayii', '--config', file]);
    expect(explained.code).toBe(0);
    expect(explained.stdout).toMatch(/naming/);
    expect(explained.stdout).toMatch(/fallback\/naming\.md/);

    const queued = await run(['enqueue', 'sayii', '--run', 'naming-only', '--config', file]);
    expect(queued.code, queued.stderr).toBe(0);
    const { job, message } = JSON.parse(queued.stdout);
    expect(message).toMatch(/Waiting position 1\. Queue length 1\./);
    expect(job.site.slug).toBe('sayii');
    expect(job.pages).toHaveLength(3);
    expect(job.stages.naming.status).toBe('queued');

    const status = await run(['status', '--config', file]);
    expect(status.code).toBe(0);
    expect(status.stdout).toMatch(/naming/);

    const again = await run(['enqueue', 'sayii', '--run', 'naming-only', '--config', file]);
    expect(again.code).toBe(2);
    expect(again.stderr).toMatch(/already has open job/);
  }, 20_000);

  it('run --once exits when the stage queue is empty', async () => {
    const file = await config();
    const ran = await run(['run', '--once', '--stages', 'analysis', '--config', file]);
    expect(ran.code, ran.stderr).toBe(0);
  }, 20_000);

  it('enqueues the site default run, which is naming-only during phase 1', async () => {
    const file = await config();
    const queued = await run(['enqueue', 'jormands', '--config', file]);
    expect(queued.code, queued.stderr).toBe(0);
    expect(Object.keys(JSON.parse(queued.stdout).job.stages)).toEqual(['naming']);
  }, 20_000);

  it('reorders by priority, notes, cancels, and clears by domain or slug', async () => {
    const file = await config();
    const json = async (args) => {
      const result = await run([...args, '--config', file]);
      expect(result.code, result.stderr).toBe(0);
      return JSON.parse(result.stdout);
    };
    await json(['enqueue', 'sayii', '--run', 'naming-only']);
    const second = await json(['enqueue', 'jormands', '--run', 'naming-only', '--priority', 'low']);
    expect(second.position).toBe(2);

    const raised = await json(['priority', 'jormands.com.co', 'critical']);
    expect(raised).toMatchObject({ previous: 'low', position: 1, messages: 1 });
    expect(raised.message).toMatch(/priority is critical \(was low\)\. Waiting position 1\. Queue length 2\./);
    const status = await run(['status', '--config', file]);
    expect(status.stdout).toMatch(/Next 5:\n1\. jormands\.com\.co — critical/);

    const bad = await run(['priority', 'sayii', 'urgent', '--config', file]);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toMatch(/priority must be one of critical, high, normal, low/);

    expect((await json(['note', 'sayii', '--text', 'checked by hand'])).message).toBe('Noted on sayiioficial.com.');
    const shown = await json(['show', 'sayii']);
    expect(shown.events.map((event) => event.type)).toEqual(['job.queued', 'job.note']);

    const cancelled = await json(['cancel', 'sayii', '--reason', 'merchant asked to wait']);
    expect(cancelled.job).toMatchObject({ status: 'cancelled', blocker: 'merchant asked to wait' });
    expect(cancelled.discarded).toBe(1);

    const cleared = await json(['clear']);
    expect(cleared.removed.map((row) => row.domain)).toEqual(['jormands.com.co']);
    expect(cleared.message).toMatch(/Removed 1 waiting job: jormands\.com\.co\. Queue length 0\./);
    const history = await json(['clear', '--finished']);
    expect(history.removed.map((row) => row.was)).toEqual(['cancelled', 'cancelled']);
    expect(await json(['jobs'])).toEqual([]);
  }, 30_000);

  it('imports the legacy queue once, keeping finished steps and resuming open items', async () => {
    const file = await config();
    const legacy = path.join(path.dirname(file), 'queue.json');
    const step = (id, status, extra = {}) => ({ id, status, attempts: 1, started_at: '2026-10-13T06:00:00.000Z', finished_at: status === 'done' ? '2026-10-13T07:00:00.000Z' : null, note: `${id} note`, ...extra });
    const full = ['naming', 'analysis', 'bundle', 'bundle-4mb', 'site-opportunity-report', 'today-opportunities', 'user-journey'];
    await writeFile(legacy, JSON.stringify({
      version: 1,
      items: [
        { id: 'q1-tennispremium-co', domain: 'tennispremium.co', process: 'full', priority: 'high', resilience: 'top', status: 'done', created_at: '2026-10-13T06:05:17.208Z', steps: full.map((id) => step(id, 'done')) },
        { id: 'q2-jormands-com-co', domain: 'jormands.com.co', process: 'full', priority: 'normal', resilience: 'standard', status: 'running', created_at: '2026-10-13T06:05:18.000Z', steps: full.map((id, index) => step(id, index < 2 ? 'done' : index === 2 ? 'running' : 'pending')) },
      ],
    }));
    const json = async (args) => {
      const result = await run([...args, '--config', file]);
      expect(result.code, result.stderr).toBe(0);
      return JSON.parse(result.stdout);
    };

    const dry = await json(['import-legacy', '--file', legacy, '--dry-run']);
    expect(dry.imported).toHaveLength(2);
    expect(await json(['jobs'])).toEqual([]);

    const first = await json(['import-legacy', '--file', legacy]);
    expect(first.problems).toEqual([]);
    expect(first.imported.map((row) => [row.id, row.status, row.resume])).toEqual([
      ['q1-tennispremium-co', 'done', null],
      ['q2-jormands-com-co', 'queued', 'bundle'],
    ]);
    const { job: done } = await json(['show', 'q1-tennispremium-co']);
    expect(done).toMatchObject({ status: 'done', priority: 'high', resilience: 'top', createdAt: '2026-10-13T06:05:17.208Z' });
    expect(done.site).toMatchObject({ slug: 'tennispremium', domain: 'tennispremium.co' });
    expect(done.stages.naming).toMatchObject({ status: 'done', note: 'naming note' });
    expect(done.stages['chart-render']).toMatchObject({ status: 'skipped', note: 'not part of the legacy full process' });
    const { job: open } = await json(['show', 'jormands']);
    expect(open.stages.analysis.status).toBe('done');
    expect(open.stages.bundle.status).toBe('queued');
    const status = await run(['status', '--config', file]);
    expect(status.stdout).toMatch(/bundle: 1 ready/);

    const again = await json(['import-legacy', '--file', legacy]);
    expect(again.imported).toEqual([]);
    expect(again.skipped.map((row) => row.reason)).toEqual(['already imported', 'already imported']);
  }, 30_000);

  it('names the example file when the config is missing', async () => {
    const missing = await run(['status', '--config', path.join(tmpdir(), 'no-such-orchestrator.config.json')]);
    expect(missing.code).not.toBe(0);
    expect(missing.stderr).toMatch(/orchestrator\.config\.example\.json/);
  }, 20_000);
});