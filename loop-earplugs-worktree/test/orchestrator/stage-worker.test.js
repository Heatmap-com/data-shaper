import { afterEach, describe, expect, it, vi } from 'vitest';
import { LeaseLostError } from '../../src/orchestrator/ports/queue.js';
import { createStageWorker } from '../../src/orchestrator/application/stage-worker.js';
import { makeJob, makeRig, makeStage, queueJob, PAGE_URLS } from './orch-test-helpers.js';

const rigs = [];

afterEach(async () => {
  await Promise.all(rigs.splice(0).map((rig) => rig.cleanup()));
});

async function rig(options) {
  const made = await makeRig(options);
  rigs.push(made);
  return made;
}

const quiet = (warnings = []) => ({ warn: (obj, msg) => warnings.push(msg), error: () => {} });

const blockUntilAbort = (then) => async (ctx) => {
  await new Promise((resolve) => {
    if (ctx.signal.aborted) return resolve();
    ctx.signal.addEventListener('abort', resolve, { once: true });
  });
  return then(ctx);
};

describe('scenario 9: lost lease', () => {
  it('aborts the delivery and never settles', async () => {
    const r = await rig({ handler: blockUntilAbort((ctx) => { throw ctx.signal.reason ?? new Error('aborted'); }) });
    const job = makeJob({ pages: [PAGE_URLS[0]] });
    await queueJob(r, job);

    const queue = { ...r.store.queue, extend: async () => { throw new LeaseLostError('m'); } };
    const settle = vi.fn();
    const warnings = [];
    const worker = createStageWorker({
      stage: makeStage({ leaseMs: 3000 }),
      queue,
      executor: r.executor,
      settle,
      logger: quiet(warnings),
      sleep: r.sleep,
      options: { pollMs: 20, maxPollMs: 50, leaseMs: 3000, owner: 'w1', maxDeliveries: 5 },
    });
    const started = worker.start().catch(() => {});
    await vi.waitFor(() => {
      expect(warnings.some((msg) => String(msg).includes('lease lost'))).toBe(true);
    }, { timeout: 8000, interval: 50 });
    await vi.waitFor(() => {
      expect(r.state.get(PAGE_URLS[0]) ?? 'incomplete').toBe('incomplete');
    }, { timeout: 2000, interval: 20 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await worker.stop();
    await started;
    expect(settle).not.toHaveBeenCalled();
  }, 15_000);
});

describe('scenario 10: graceful stop', () => {
  it('stop() mid-handler releases the message with delayMs 0', async () => {
    let entered;
    const handlerRunning = new Promise((resolve) => { entered = resolve; });
    const r = await rig({
      handler: async (ctx) => {
        entered();
        return blockUntilAbort(() => ({ status: 'error', message: 'aborted', exitCode: null }))(ctx);
      },
    });
    const job = makeJob({ pages: [PAGE_URLS[0]] });
    await queueJob(r, job);

    const releases = [];
    const queue = {
      ...r.store.queue,
      release: async (lease, opts) => {
        releases.push(opts);
        return r.store.queue.release(lease, opts);
      },
    };
    const settle = vi.fn();
    const worker = createStageWorker({
      stage: makeStage(),
      queue,
      executor: r.executor,
      settle,
      logger: quiet(),
      sleep: r.sleep,
      options: { pollMs: 20, maxPollMs: 50, leaseMs: 60_000, owner: 'w1', maxDeliveries: 5 },
    });
    const started = worker.start().catch(() => {});
    await handlerRunning;
    await worker.stop();
    await started;
    expect(releases).toContainEqual({ delayMs: 0, reason: 'worker stopped' });
    expect(settle).not.toHaveBeenCalled();

    const stats = await r.store.queue.stats();
    expect(stats.find((row) => row.queue === 'stage:naming').ready).toBe(1);
  }, 15_000);
});

describe('scenario 11: the governor', () => {
  it('two stages declaring chromium with capacity 1 never overlap', async () => {
    const intervals = [];
    let stateRef;
    const r = await rig({
      capacity: { chromium: 1 },
      handler: async (ctx) => {
        const start = Date.now();
        await new Promise((resolve) => setTimeout(resolve, 250));
        intervals.push([start, Date.now()]);
        stateRef.set(ctx.unit.key, 'complete');
        return { status: 'ok', exitCode: 0 };
      },
    });
    stateRef = r.state;

    const job1 = makeJob({ pages: [PAGE_URLS[0]], stages: [makeStage({ resources: ['chromium'] })] });
    const job2 = makeJob({ pages: [PAGE_URLS[1]], stages: [makeStage({ id: 'analysis', resources: ['chromium'] })] });
    await r.store.jobs.create(job1);
    await r.store.jobs.create(job2);

    const [first, second] = await Promise.all([
      r.executor.execute({ jobId: job1.id, stageId: 'naming', owner: 'w1' }),
      r.executor.execute({ jobId: job2.id, stageId: 'analysis', owner: 'w2' }),
    ]);
    expect(first.type).toBe('advance');
    expect(second.type).toBe('advance');
    expect(intervals).toHaveLength(2);
    const [[s1, e1], [s2]] = intervals.sort((a, b) => a[0] - b[0]);
    expect(s2).toBeGreaterThanOrEqual(e1);
  }, 15_000);
});

describe('scenario 12: a dropped heartbeat is not a lost lease', () => {
  it('retries two transport errors and still settles the delivery', async () => {
    const r = await rig({
      handler: async (ctx) => {
        await new Promise((resolve) => setTimeout(resolve, 2500));
        r.state.set(ctx.unit.key, 'complete');
        return { status: 'ok', exitCode: 0 };
      },
    });
    const job = makeJob({ pages: [PAGE_URLS[0]] });
    await queueJob(r, job);

    let attempts = 0;
    const queue = {
      ...r.store.queue,
      extend: async (lease, leaseMs) => {
        attempts += 1;
        if (attempts <= 2) throw new Error('ECONNRESET');
        return r.store.queue.extend(lease, leaseMs);
      },
    };
    const warnings = [];
    const worker = createStageWorker({
      stage: makeStage({ leaseMs: 3000 }),
      queue,
      executor: r.executor,
      settle: r.settle,
      logger: quiet(warnings),
      sleep: r.sleep,
      options: { pollMs: 20, maxPollMs: 50, leaseMs: 3000, owner: 'w1', maxDeliveries: 5, once: true, now: () => 0 },
    });
    await worker.start();
    expect(warnings.filter((msg) => String(msg).includes('heartbeat failed'))).toHaveLength(2);
    expect(warnings.some((msg) => String(msg).includes('lease lost'))).toBe(false);
    const stored = await r.store.jobs.get(job.id);
    expect(stored.stages.naming.status).toBe('done');
  }, 15_000);
});

describe('scenario 13: once on an empty queue', () => {
  it('returns instead of polling forever', async () => {
    const r = await rig();
    const worker = createStageWorker({
      stage: makeStage(),
      queue: r.store.queue,
      executor: r.executor,
      settle: r.settle,
      logger: quiet(),
      sleep: r.sleep,
      options: { pollMs: 20, maxPollMs: 50, leaseMs: 3000, owner: 'w1', maxDeliveries: 5, once: true },
    });
    await worker.start();
    expect(r.calls.handler).toBe(0);
  });
});

describe('scenario 14: a delivery that keeps throwing', () => {
  it('fails the job at maxDeliveries instead of releasing it forever', async () => {
    const r = await rig();
    const job = makeJob({ pages: [PAGE_URLS[0]] });
    await queueJob(r, job);
    const worker = createStageWorker({
      stage: makeStage(),
      queue: r.store.queue,
      executor: { execute: async () => { throw new Error('boom'); } },
      settle: r.settle,
      logger: quiet(),
      sleep: r.sleep,
      options: { pollMs: 20, maxPollMs: 50, leaseMs: 3000, owner: 'w1', maxDeliveries: 1, once: true },
    });
    await worker.start();
    const stored = await r.store.jobs.get(job.id);
    expect(stored.status).toBe('failed');
    expect(stored.blocker).toMatch(/worker error: boom \(after 1 deliveries\)/);
    const [naming] = await r.store.queue.stats();
    expect(naming.dead).toBe(1);
  });
});
