import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDetachedLauncher } from '../../src/orchestrator/adapters/launcher/detached.js';
import { createMarkdownJournal } from '../../src/orchestrator/adapters/journal/markdown.js';
import { createStore } from '../../src/orchestrator/adapters/queue/memory.js';
import { createJobAdmin } from '../../src/orchestrator/application/job-admin.js';
import { createWorkerStarter } from '../../src/orchestrator/application/start-workers.js';
import { legacyToJob } from '../../src/orchestrator/domain/legacy-queue.js';
import { decodeEntities, normalizeDomain, sameDomain, siteFromDirectory, siteFromDomain } from '../../src/orchestrator/domain/site.js';
import { OrchestratorError } from '../../src/orchestrator/domain/errors.js';
import { queueName } from '../../src/orchestrator/domain/job.js';
import { deliver, journalTypes, makeJob, makeRig, makeStage, queueJob } from './orch-test-helpers.js';

const rigs = [];
afterEach(async () => {
  while (rigs.length) await rigs.pop().cleanup();
});

describe('site domain', () => {
  it('keeps the host the user named', () => {
    expect(normalizeDomain('Shop.Example')).toBe('shop.example');
    expect(normalizeDomain('https://www.shop.example/collections?x=1')).toBe('www.shop.example');
    expect(normalizeDomain('user@shop.example.')).toBe('shop.example');
    expect(sameDomain('www.shop.example', 'SHOP.example')).toBe(true);
  });

  it('rejects a value that is not a domain', () => {
    expect(() => normalizeDomain('not a site')).toThrow(OrchestratorError);
    expect(() => normalizeDomain('')).toThrow(/required/);
    expect(() => normalizeDomain('localhost')).toThrow(/Not a domain/);
  });

  it('makes a site from a domain and refuses a bare slug', () => {
    expect(siteFromDomain('https://www.shop.example/')).toEqual({ slug: 'shop', domain: 'www.shop.example', origin: 'https://www.shop.example/' });
    expect(siteFromDirectory('47brand.com', { idsite: 5184, name: '&#039;47' })).toMatchObject({ slug: 'site-47brand', name: "'47", idsite: 5184 });
    expect(decodeEntities('Tom &amp; Jerry &#x27;s')).toBe("Tom & Jerry 's");
    expect(decodeEntities('&bogus; &#0;')).toBe('&bogus; &#0;');
    expect(siteFromDomain('47brand.com')).toEqual({ slug: 'site-47brand', domain: '47brand.com', origin: 'https://47brand.com/' });
    expect(() => siteFromDomain('shop')).toThrow(/site\.json, or name the site by its domain/);
  });
});

describe('legacy queue mapping', () => {
  const resolved = { run: { id: 'full', defaults: {}, stages: ['naming', 'analysis', 'bundle'].map((id) => makeStage({ id })) }, refs: [], hash: 'h' };
  const base = { id: 'q1-shop', domain: 'shop.example', process: 'full', priority: 'high', resilience: 'top', created_at: '2026-10-13T06:00:00.000Z' };
  const map = (item) => legacyToJob({ item: { ...base, ...item }, site: siteFromDomain('shop.example'), resolved, pages: [], window: { start: 'a', end: 'b' } });

  it('fails the step a failed item stopped on and keeps its blocker', () => {
    const { job, resume } = map({ status: 'failed', blocker: 'login wall', steps: [{ id: 'naming', status: 'done' }, { id: 'analysis', status: 'running', attempts: 2 }] });
    expect(resume).toBeNull();
    expect(job).toMatchObject({ status: 'failed', blocker: 'login wall' });
    expect(job.stages.analysis).toMatchObject({ status: 'failed', lastError: 'login wall', attempts: 2 });
    expect(job.stages.bundle.status).toBe('pending');
  });

  it('notes a legacy step the run lacks and refuses an unknown status', () => {
    const waiting = map({ status: 'waiting', steps: [{ id: 'naming', status: 'done' }, { id: 'retired-step', status: 'done' }] });
    expect(waiting.resume.id).toBe('analysis');
    expect(waiting.notes).toEqual(['legacy step retired-step has no stage in run full']);
    expect(map({ status: 'paused', steps: [] }).job).toBeNull();
  });
});

describe('job admin', () => {
  const open = async () => {
    const store = createStore();
    const journal = [];
    const admin = createJobAdmin({ jobs: store.jobs, queue: store.queue, events: store.events, journal: { record: async (job, event) => { journal.push(event); } }, resolver: null, clock: { now: () => new Date('2026-10-13T08:00:00.000Z') } });
    return { store, admin, journal };
  };

  it('asks for an id when a slug matches two open jobs, and picks the newest finished job otherwise', async () => {
    const { store, admin } = await open();
    const one = makeJob({ id: 'acme-1' });
    const two = makeJob({ id: 'acme-2' });
    two.site = { ...two.site, domain: 'acme.example' };
    await store.jobs.create(one);
    await store.jobs.create(two);
    await expect(admin.select('acme')).rejects.toThrow(/matches 2 open jobs; pass one id: acme-1, acme-2/);
    expect((await admin.select('acme.example')).id).toBe('acme-2');
    await store.jobs.update('acme-1', (draft) => { draft.status = 'done'; });
    await store.jobs.update('acme-2', (draft) => { draft.status = 'done'; });
    expect((await admin.select('acme')).id).toBe('acme-2');
    await expect(admin.select('nobody.example')).rejects.toThrow(/no job for "nobody.example"/);
  });

  it('places a high-priority site ahead of lower priorities and behind earlier highs', async () => {
    const { store, admin } = await open();
    const at = (id, priority, minute) => ({ ...makeJob({ id }), priority, createdAt: `2026-10-13T07:0${minute}:00.000Z` });
    await store.jobs.create(at('high-first', 'high', 1));
    await store.jobs.create(at('normal', 'normal', 2));
    await store.jobs.create(at('low', 'low', 3));
    const late = at('high-late', 'high', 4);
    await store.jobs.create(late);
    expect(await admin.position(late)).toEqual({ position: 2, aheadOfLower: 2, length: 4 });
  });

  it('clears waiting jobs and keeps the job in a stage', async () => {
    const { store, admin } = await open();
    const running = makeJob({ id: 'running' });
    running.stages.naming = { ...running.stages.naming, status: 'running', attempts: 1 };
    await store.jobs.create({ ...running, status: 'running' });
    await store.jobs.create(makeJob({ id: 'waiting' }));
    const result = await admin.clear();
    expect(result.removed.map((row) => row.id)).toEqual(['waiting']);
    expect(result.message).toBe('Removed 1 waiting job: acme.test. 1 job in a stage was kept. Queue length 1.');
    expect((await store.jobs.get('running')).status).toBe('running');
  });

  it('completes a stage that has no check yet, in order, and queues the next', async () => {
    const { store, admin, journal } = await open();
    const job = makeJob({
      id: 'acme-1',
      stages: [makeStage({ id: 'naming' }), makeStage({ id: 'analysis', check: { use: 'pending' } }), makeStage({ id: 'bundle', check: { use: 'pending' } })],
    });
    job.stages.naming.status = 'done';
    job.stages.analysis.status = 'blocked';
    await store.jobs.create({ ...job, status: 'blocked', blocker: 'analysis: this stage lands in a later phase' });

    await expect(admin.complete('acme-1', { stage: 'naming', note: 'x' })).rejects.toThrow(/has the completion check fake-check; run retry/);
    await expect(admin.complete('acme-1', { stage: 'bundle', note: 'x' })).rejects.toThrow(/comes after analysis, which is not done/);
    await expect(admin.complete('acme-1', {})).rejects.toThrow(/--note/);

    const result = await admin.complete('acme', { note: 'site-analysis done check: trends check.ok' });
    expect(result).toMatchObject({ next: 'bundle', message: 'acme.test: analysis is done. Queued for bundle.' });
    const after = await store.jobs.get('acme-1');
    expect(after).toMatchObject({ status: 'queued', blocker: null });
    expect(after.stages.analysis).toMatchObject({ status: 'done', recoveredBy: 'operator', note: 'site-analysis done check: trends check.ok', finishedAt: '2026-10-13T08:00:00.000Z' });
    expect((await store.queue.peekReady(queueName('bundle'), 5)).map((row) => row.jobId)).toEqual(['acme-1']);
    expect(journal.at(-1).message).toMatch(/^step analysis done by the operator: /);

    expect((await admin.complete('acme-1', { note: 'bundle anchors match' })).next).toBeNull();
    expect((await store.jobs.get('acme-1')).status).toBe('done');
  });

  it('refuses to reprioritize or cancel a finished job', async () => {
    const { store, admin } = await open();
    await store.jobs.create({ ...makeJob({ id: 'acme-1' }), status: 'done' });
    await expect(admin.priority('acme-1', 'high')).rejects.toThrow(/is done and not waiting/);
    await expect(admin.cancel('acme-1')).rejects.toThrow(/only a queued or running job/);
    await expect(admin.note('acme-1', '  ')).rejects.toThrow(/a note is required/);
  });
});

describe('cancelling a running job', () => {
  it('lets the stage in flight finish and forwards nothing', async () => {
    let rig;
    const job = makeJob({ pages: ['https://acme.test/'], stages: [makeStage({ id: 'naming' }), makeStage({ id: 'analysis' })] });
    rig = await makeRig({
      handler: async (ctx) => {
        await rig.store.jobs.update(job.id, (draft) => { draft.status = 'cancelled'; });
        rig.state.set(ctx.unit.key, 'complete');
        return { status: 'ok', exitCode: 0, command: 'fake' };
      },
    });
    rigs.push(rig);
    await queueJob(rig, job);
    const { outcome } = await deliver(rig, job.id, 'naming');
    expect(outcome.type).toBe('advance');
    const after = await rig.store.jobs.get(job.id);
    expect(after.status).toBe('cancelled');
    expect(after.stages.naming.status).toBe('done');
    expect(after.stages.analysis.status).toBe('pending');
    expect(await rig.store.queue.peekReady(queueName('analysis'), 5)).toEqual([]);
  });

  it('acks a later delivery without running it and keeps the job cancelled', async () => {
    const rig = await makeRig();
    rigs.push(rig);
    const job = makeJob({ pages: ['https://acme.test/'] });
    await queueJob(rig, job);
    await rig.store.jobs.update(job.id, (draft) => { draft.status = 'cancelled'; });
    const { outcome } = await deliver(rig, job.id, 'naming');
    expect(outcome).toEqual({ type: 'cancelled' });
    expect(rig.calls.handler).toBe(0);
    expect((await rig.store.jobs.get(job.id)).status).toBe('cancelled');
    expect(journalTypes(rig, 'stage.cancelled')).toHaveLength(1);
    expect(await rig.store.queue.listDead()).toEqual([]);
  });
});

describe('markdown journal', () => {
  it('writes the header once, then appends', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'orch-journal-'));
    try {
      const journal = createMarkdownJournal({ dir, clock: { now: () => new Date('2026-10-13T07:00:00.000Z') } });
      const job = makeJob({ id: 'acme-1' });
      await journal.record(job, { type: 'job.queued', message: 'queued.' });
      await journal.record(job, { type: 'job.note' });
      const text = readFileSync(path.join(dir, 'acme-1.md'), 'utf8');
      expect(text.startsWith('# acme.test\n\n| | |\n| --- | --- |\n| id | acme-1 |')).toBe(true);
      expect(text.match(/^# /gm)).toHaveLength(1);
      expect(text.endsWith('## Log\n- 2026-10-13T07:00:00.000Z — queued.\n- 2026-10-13T07:00:00.000Z — job.note\n')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('detached launcher', () => {
  it('runs the CLI with run --until-idle and the config, logging to the log directory', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'orch-launch-'));
    try {
      const out = path.join(dir, 'args.json');
      const launcher = createDetachedLauncher({
        cli: path.join(import.meta.dirname, 'fixtures', 'echo-args.mjs'),
        configFile: '/cfg/orchestrator.config.json',
        logDir: path.join(dir, 'workers'),
        cwd: dir,
        clock: { now: () => new Date('2026-10-13T07:00:00.000Z') },
        env: { ...process.env, ECHO_ARGS_OUT: out },
      });
      const { pid, log } = await launcher.launch({});
      expect(pid).toBeGreaterThan(0);
      for (let i = 0; i < 100 && !existsSync(out); i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
      const seen = JSON.parse(readFileSync(out, 'utf8'));
      expect(seen.args).toEqual(['run', '--until-idle', '--config', '/cfg/orchestrator.config.json']);
      expect(realpathSync(seen.cwd)).toBe(realpathSync(dir));
      for (let i = 0; i < 100 && !readFileSync(log, 'utf8'); i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
      expect(path.basename(log)).toBe('worker-2026-10-13T07-00-00-000Z.log');
      expect(readFileSync(log, 'utf8')).toBe('worker log line\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('starting workers', () => {
  const setup = async () => {
    const clock = { t: 100_000, now: () => new Date(clock.t) };
    const store = createStore({ clock });
    const launched = [];
    const start = createWorkerStarter({
      workers: store.workers, queue: store.queue, clock, heartbeatMs: 1000,
      launcher: { launch: async () => { launched.push(1); return { pid: 42, log: 'worker.log' }; } },
    });
    return { store, clock, launched, start };
  };

  it('starts nothing when there is no queued work', async () => {
    const { start, launched } = await setup();
    expect(await start()).toMatchObject({ started: false, message: 'No queued work. No worker started.' });
    expect(launched).toEqual([]);
  });

  it('starts one worker when no live worker serves the queued stage', async () => {
    const { store, clock, start, launched } = await setup();
    await store.queue.enqueue(queueName('naming'), { jobId: 'j', priority: 2, rankAt: 1, payload: { stage: 'naming' } });
    await store.workers.heartbeat({ owner: 'h:1', pid: 1, host: 'h', stages: ['naming'] });
    expect((await start()).started).toBe(false);
    clock.t += 3001;
    const result = await start();
    expect(result).toMatchObject({ started: true, pid: 42 });
    expect(result.message).toMatch(/Started worker pid 42 for naming/);
    expect(launched).toHaveLength(1);
  });
});
