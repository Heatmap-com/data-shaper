import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { messageFor, queueName } from '../../src/orchestrator/domain/job.js';
import { journalTypes, deliver, makeJob, makeRig, makeStage, queueJob, PAGE_URLS } from './orch-test-helpers.js';

const rigs = [];

afterEach(async () => {
  await Promise.all(rigs.splice(0).map((rig) => rig.cleanup()));
});

async function rig(options) {
  const made = await makeRig(options);
  rigs.push(made);
  return made;
}

const fixedReport = { status: 'fixed', summary: 'fixed it', changes: ['fixture'] };

async function writeResult(runDir, report) {
  await writeFile(path.join(runDir, 'result.json'), JSON.stringify(report));
}

describe('scenario 1: happy path', () => {
  it('runs every unit, advances to the next queue, and journals three unit.done', async () => {
    const r = await rig();
    const stages = [makeStage(), makeStage({ id: 'analysis' })];
    const job = makeJob({ stages });
    await queueJob(r, job);

    const { outcome } = await deliver(r, job.id, 'naming');
    expect(outcome.type).toBe('advance');
    expect(r.calls.handler).toBe(3);

    const stored = await r.store.jobs.get(job.id);
    expect(stored.stages.naming.status).toBe('done');
    expect(stored.stages.analysis.status).toBe('queued');
    expect(journalTypes(r, 'unit.done')).toHaveLength(3);

    const stats = await r.store.queue.stats(queueName('analysis'));
    const analysis = (await r.store.queue.stats()).find((row) => row.queue === 'stage:analysis');
    expect(analysis.ready).toBe(1);
    expect(stats).toBeDefined();
  });
});

describe('scenario 2: pre-check skips', () => {
  it('runs the handler only for units that are not already complete', async () => {
    const r = await rig({ states: { [PAGE_URLS[0]]: 'complete' } });
    const job = makeJob();
    await queueJob(r, job);

    const { outcome } = await deliver(r, job.id, 'naming');
    expect(outcome.type).toBe('advance');
    expect(r.calls.handler).toBe(2);
    expect(journalTypes(r, 'unit.satisfied')).toHaveLength(1);
    expect(journalTypes(r, 'unit.done')).toHaveLength(2);
  });
});

describe('scenario 3: transient, then success', () => {
  it('retries with the policy backoff, then completes on the second delivery', async () => {
    const r = await rig({ states: { [PAGE_URLS[0]]: 'fails:ENOTFOUND' } });
    const job = makeJob({ pages: [PAGE_URLS[0]] });
    await queueJob(r, job);

    const first = await r.executor.execute({ jobId: job.id, stageId: 'naming', owner: 'w1', signal: new AbortController().signal });
    expect(first).toEqual({ type: 'retry', delayMs: 1000, reason: 'DNS lookup failed' });

    const second = await r.executor.execute({ jobId: job.id, stageId: 'naming', owner: 'w1', signal: new AbortController().signal });
    expect(second.type).toBe('advance');
    expect(r.calls.handler).toBe(2);
  });
});

describe('scenario 4: defect, fallback fixes', () => {
  it('advances with recoveredBy fake after the agent completes the unit', async () => {
    const r = await rig({
      states: { [PAGE_URLS[0]]: 'broken' },
      behave: async (request, state) => {
        state.set(PAGE_URLS[0], 'complete');
        await writeResult(request.runDir, fixedReport);
      },
    });
    const stage = makeStage({ fallback: { agent: 'fake', prompt: 'fallback/test.md', maxAttempts: 1 } });
    const job = makeJob({ pages: [PAGE_URLS[0]], stages: [stage] });
    await queueJob(r, job);

    const { outcome } = await deliver(r, job.id, 'naming');
    expect(outcome.type).toBe('advance');
    expect(outcome.recoveredBy).toBe('fake');
    expect(r.calls.agent).toBe(1);
    const stored = await r.store.jobs.get(job.id);
    expect(stored.stages.naming.recoveredBy).toBe('fake');
    expect(journalTypes(r, 'fallback.started')).toHaveLength(1);
  });
});

describe('scenario 5: the agent lies', () => {
  it('runs out of fallback attempts and fails with the last check summary', async () => {
    const r = await rig({
      states: { [PAGE_URLS[0]]: 'broken' },
      behave: async (request) => writeResult(request.runDir, fixedReport),
    });
    const stage = makeStage({ fallback: { agent: 'fake', prompt: 'fallback/test.md', rerunPrimary: true } });
    const job = makeJob({ pages: [PAGE_URLS[0]], stages: [stage] });
    await queueJob(r, job);

    const { outcome } = await deliver(r, job.id, 'naming');
    expect(outcome.type).toBe('failed');
    expect(outcome.reason).toContain('fallback used 1 attempt(s)');
    expect(outcome.reason).toContain('the check still fails');
    expect(r.calls.agent).toBe(1);
    expect(r.calls.handler).toBe(2);

    const stored = await r.store.jobs.get(job.id);
    expect(stored.status).toBe('failed');
    expect(stored.stages.naming.status).toBe('failed');
    const dead = await r.store.queue.listDead(queueName('naming'));
    expect(dead).toHaveLength(1);
  });
});

describe('scenario 6: the agent reports blocked', () => {
  it('blocks the job and dead-letters the message with the blocker text', async () => {
    const r = await rig({
      states: { [PAGE_URLS[0]]: 'broken' },
      behave: async (request) => writeResult(request.runDir, { status: 'blocked', summary: 'cannot continue', blocker: 'needs credentials' }),
    });
    const stage = makeStage({ fallback: { agent: 'fake', prompt: 'fallback/test.md' } });
    const job = makeJob({ pages: [PAGE_URLS[0]], stages: [stage] });
    await queueJob(r, job);

    const { outcome } = await deliver(r, job.id, 'naming');
    expect(outcome.type).toBe('blocked');

    const stored = await r.store.jobs.get(job.id);
    expect(stored.status).toBe('blocked');
    expect(stored.blocker).toContain('needs credentials');
    const dead = await r.store.queue.listDead(queueName('naming'));
    expect(dead).toHaveLength(1);
    expect(dead[0].lastError).toContain('needs credentials');
  });
});

describe('scenario 7: the resilience limit', () => {
  const lying = async (request) => writeResult(request.runDir, fixedReport);

  it('standard allows one fallback attempt', async () => {
    const r = await rig({ states: { [PAGE_URLS[0]]: 'broken' }, behave: lying });
    const stage = makeStage({ fallback: { agent: 'fake', prompt: 'fallback/test.md' } });
    const job = makeJob({ pages: [PAGE_URLS[0]], stages: [stage], resilience: 'standard' });
    await queueJob(r, job);

    const { outcome } = await deliver(r, job.id, 'naming');
    expect(outcome.type).toBe('failed');
    expect(outcome.reason).toContain('fallback used 1 attempt(s)');
    expect(r.calls.agent).toBe(1);
  });

  it('top allows three fallback attempts', async () => {
    const r = await rig({ states: { [PAGE_URLS[0]]: 'broken' }, behave: lying });
    const stage = makeStage({ fallback: { agent: 'fake', prompt: 'fallback/test.md' } });
    const job = makeJob({ pages: [PAGE_URLS[0]], stages: [stage], resilience: 'top' });
    await queueJob(r, job);

    const { outcome } = await deliver(r, job.id, 'naming');
    expect(outcome.type).toBe('failed');
    expect(outcome.reason).toContain('fallback used 3 attempt(s)');
    expect(r.calls.agent).toBe(3);
  });
});

describe('scenario 8: redelivery after done', () => {
  it('advances without running anything, and forward dedupe drops the second copy', async () => {
    const r = await rig();
    const stages = [makeStage(), makeStage({ id: 'analysis' })];
    const job = makeJob({ pages: [PAGE_URLS[0]], stages });
    await queueJob(r, job);

    const first = await deliver(r, job.id, 'naming');
    expect(first.outcome.type).toBe('advance');
    expect(r.calls.handler).toBe(1);

    const redelivered = await r.store.queue.enqueue(queueName('naming'), { ...messageFor(job, stages[0]), dedupeKey: null });
    expect(redelivered.deduped).toBe(false);
    const second = await deliver(r, job.id, 'naming');
    expect(second.outcome).toEqual({ type: 'advance', note: 'already done (redelivery)' });
    expect(r.calls.handler).toBe(1);
    expect(journalTypes(r, 'stage.started')).toHaveLength(1);

    const analysis = (await r.store.queue.stats()).find((row) => row.queue === 'stage:analysis');
    expect(analysis.ready).toBe(1);
    const dupe = await r.store.queue.enqueue(queueName('analysis'), messageFor(job, stages[1]));
    expect(dupe.deduped).toBe(true);
    const after = (await r.store.queue.stats()).find((row) => row.queue === 'stage:analysis');
    expect(after.ready).toBe(1);
  });
});

describe('agent usage limit', () => {
  it('blocks the job instead of spending fallback attempts', async () => {
    const r = await rig({
      states: { [PAGE_URLS[0]]: 'broken' },
      behave: async () => ({ finalText: "403 You've reached your monthly usage limit. Your quota will be refreshed in the next cycle." }),
    });
    const stage = makeStage({ fallback: { agent: 'fake', prompt: 'fallback/test.md', maxAttempts: 3 } });
    const job = makeJob({ pages: [PAGE_URLS[0]], stages: [stage], resilience: 'top' });
    await queueJob(r, job);

    const { outcome } = await deliver(r, job.id, 'naming');
    expect(outcome.type).toBe('blocked');
    expect(outcome.reason).toContain('unavailable (usage limit)');
    expect(r.calls.agent).toBe(1);
    expect(journalTypes(r, 'fallback.finished')).toEqual([expect.objectContaining({ message: expect.stringMatching(/unavailable \(usage limit\)/) })]);
    const stored = await r.store.jobs.get(job.id);
    expect(stored.status).toBe('blocked');
  });
});

describe('fallback edge cases', () => {
  it('trusts a written result.json even when the transcript mentions usage limits', async () => {
    const r = await rig({
      states: { [PAGE_URLS[0]]: 'broken' },
      behave: async (request, state) => {
        state.set(PAGE_URLS[0], 'complete');
        await writeResult(request.runDir, fixedReport);
        return { finalText: 'Done.', tail: "403 You've reached your monthly usage limit." };
      },
    });
    const stage = makeStage({ fallback: { agent: 'fake', prompt: 'fallback/test.md' } });
    const job = makeJob({ pages: [PAGE_URLS[0]], stages: [stage] });
    await queueJob(r, job);

    const { outcome } = await deliver(r, job.id, 'naming');
    expect(outcome.type).toBe('advance');
    expect(outcome.recoveredBy).toBe('fake');
  });

  it('survives an agent result with no finalText', async () => {
    const r = await rig({ states: { [PAGE_URLS[0]]: 'broken' }, behave: async () => ({ finalText: null, exitCode: 1 }) });
    const stage = makeStage({ fallback: { agent: 'fake', prompt: 'fallback/test.md' } });
    const job = makeJob({ pages: [PAGE_URLS[0]], stages: [stage] });
    await queueJob(r, job);

    const { outcome } = await deliver(r, job.id, 'naming');
    expect(outcome.type).toBe('failed');
    expect(outcome.reason).toMatch(/fallback used 1 attempt/);
  });

  it('fails cleanly when the job names a resilience level that does not exist', async () => {
    const r = await rig({ states: { [PAGE_URLS[0]]: 'broken' } });
    const stage = makeStage({ fallback: { agent: 'fake', prompt: 'fallback/test.md' } });
    const job = makeJob({ pages: [PAGE_URLS[0]], stages: [stage], resilience: 'heroic' });
    await queueJob(r, job);

    const { outcome } = await deliver(r, job.id, 'naming');
    expect(outcome).toEqual({ type: 'failed', reason: 'naming: resilience "heroic" is not in general/resilience.json' });
    expect(r.calls.agent).toBe(0);
  });

  it('blocks when the agent command is not installed', async () => {
    const r = await rig({
      states: { [PAGE_URLS[0]]: 'broken' },
      behave: async () => { throw Object.assign(new Error('spawn kimi ENOENT'), { code: 'ENOENT' }); },
    });
    const stage = makeStage({ fallback: { agent: 'fake', prompt: 'fallback/test.md' } });
    const job = makeJob({ pages: [PAGE_URLS[0]], stages: [stage] });
    await queueJob(r, job);

    const { outcome } = await deliver(r, job.id, 'naming');
    expect(outcome.type).toBe('blocked');
    expect(outcome.reason).toMatch(/fake could not start \(spawn kimi ENOENT\)/);
  });

  it('fails a stage that has no completion check instead of throwing', async () => {
    const r = await rig();
    const job = makeJob({ pages: [PAGE_URLS[0]], stages: [makeStage({ check: undefined })] });
    await queueJob(r, job);

    const { outcome } = await deliver(r, job.id, 'naming');
    expect(outcome).toEqual({ type: 'failed', reason: 'stage naming needs a handler and a completion check' });
  });
});
