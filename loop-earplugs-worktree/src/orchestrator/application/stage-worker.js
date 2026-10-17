import { LeaseLostError } from '../ports/queue.js';
import { queueName } from '../domain/job.js';

export function createStageWorker({ stage, queue, executor, settle, logger, options, sleep }) {
  const controller = new AbortController();
  let running = null;
  return { start, stop };

  async function start() {
    let wait = options.pollMs;
    while (!controller.signal.aborted) {
      let lease;
      try {
        lease = await queue.reserve(queueName(stage.id), {
          leaseMs: stage.leaseMs ?? options.leaseMs,
          owner: options.owner,
          maxInFlight: stage.concurrency ?? 1,
          maxDeliveries: options.maxDeliveries,
        });
      } catch (err) {
        if (controller.signal.aborted) return;
        logger.warn({ err, stage: stage.id }, 'reserve failed; backing off');
        await sleep(wait, controller.signal);
        wait = Math.min(wait * 2, options.maxPollMs);
        continue;
      }
      if (!lease) {
        if (options.once) return;
        await sleep(wait, controller.signal);
        wait = Math.min(wait * 2, options.maxPollMs);
        continue;
      }
      wait = options.pollMs;
      running = handle(lease);
      await running;
      running = null;
      if (options.once) return;
    }
  }

  async function handle(lease) {
    const local = new AbortController();
    const onStop = () => local.abort(new Error('worker stopping'));
    controller.signal.addEventListener('abort', onStop, { once: true });
    let current = lease;
    const leaseMs = stage.leaseMs ?? options.leaseMs;
    const beat = setInterval(async () => {
      try {
        current = await queue.extend(current, leaseMs);
      } catch (err) {
        const now = (options.now ?? Date.now)();
        if (err instanceof LeaseLostError || now >= current.expiresAt - 1000) {
          logger.warn({ err, stage: stage.id }, 'lease lost; aborting this delivery');
          local.abort(err instanceof LeaseLostError ? err : new LeaseLostError(current.message.id));
          return;
        }
        logger.warn({ err, stage: stage.id }, 'heartbeat failed; retrying before the lease expires');
      }
    }, Math.max(1000, Math.floor(leaseMs / 3)));
    try {
      const outcome = await executor.execute({ jobId: lease.message.jobId, stageId: stage.id, owner: options.owner, signal: local.signal });
      if (controller.signal.aborted) {
        await queue.release(current, { delayMs: 0, reason: 'worker stopped' });
        return;
      }
      await settle(current, outcome);
    } catch (err) {
      if (err instanceof LeaseLostError || local.signal.reason instanceof LeaseLostError) return;
      logger.error({ err, stage: stage.id, job: lease.message.jobId }, 'stage delivery threw');
      const reason = `worker error: ${err.message}`;
      if (lease.message.deliveries >= (options.maxDeliveries ?? 5)) {
        await settle(current, { type: 'failed', reason: `${reason} (after ${lease.message.deliveries} deliveries)` }).catch((settleErr) => {
          logger.error({ err: settleErr, stage: stage.id, job: lease.message.jobId }, 'could not fail the job');
        });
        return;
      }
      await queue.release(current, { delayMs: 60_000, reason }).catch(() => {});
    } finally {
      clearInterval(beat);
      controller.signal.removeEventListener('abort', onStop);
    }
  }

  async function stop() {
    controller.abort();
    await running;
  }
}
