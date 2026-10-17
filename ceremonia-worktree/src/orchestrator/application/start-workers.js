/**
 * Starts one detached worker for every stage when no live worker serves the
 * stages that have work. A worker is live when its heartbeat is newer than
 * three heartbeat intervals.
 *
 * @param {{workers: import('../ports/worker-registry.js').WorkerRegistryPort, queue: import('../ports/queue.js').StageQueuePort,
 *   launcher: import('../ports/worker-launcher.js').WorkerLauncherPort, clock: {now: () => Date}, heartbeatMs: number}} deps
 */
export function createWorkerStarter({ workers, queue, launcher, clock, heartbeatMs }) {
  return async function startWorkers() {
    const now = clock.now().getTime();
    const live = (await workers.list()).filter((worker) => now - worker.lastSeen <= heartbeatMs * 3);
    const busy = (await queue.stats())
      .filter((row) => row.ready + row.delayed + row.leased > 0)
      .map((row) => row.queue.replace(/^stage:/, ''));
    const unserved = busy.filter((stage) => !live.some((worker) => worker.stages.includes(stage)));
    if (!busy.length) return { started: false, message: 'No queued work. No worker started.', live: live.length };
    if (!unserved.length) {
      return { started: false, message: `${live.length} live worker${live.length === 1 ? '' : 's'} already serve${live.length === 1 ? 's' : ''} the queued stages.`, live: live.length };
    }
    const { pid, log } = await launcher.launch({});
    return { started: true, pid, log, message: `Started worker pid ${pid} for ${unserved.join(', ')}. It runs until the queues are empty. Log: ${log}.`, live: live.length };
  };
}
