import { messageFor, nextStage, queueName } from '../domain/job.js';

/**
 * The job is written before the queue moves. A crash in between is a redelivery that the executor short-circuits.
 * A cancelled job keeps its status: its message is acked and nothing is forwarded.
 */
export function createSettler({ queue, jobs, journal, clock }) {
  return async function settle(lease, outcome) {
    const { jobId } = lease.message;
    const stageId = lease.message.payload.stage;
    const at = clock.now().toISOString();

    if (outcome.type === 'cancelled') {
      await queue.ack(lease);
      const job = await jobs.get(jobId);
      if (job) await journal.record(job, { type: 'stage.cancelled', stage: stageId, message: `${stageId} not run: the job was cancelled.` });
      return;
    }

    if (outcome.type === 'advance') {
      let job = await jobs.update(jobId, (draft) => {
        Object.assign(draft.stages[stageId], { status: 'done', finishedAt: at, note: outcome.note });
        if (outcome.recoveredBy) draft.stages[stageId].recoveredBy = outcome.recoveredBy;
      });
      if (job.status === 'cancelled') {
        await queue.ack(lease);
        await journal.record(job, { type: 'stage.done', stage: stageId, message: `step ${stageId} done. The job was cancelled, so it stops here.` });
        return;
      }
      const next = nextStage(job, stageId);
      if (!next) {
        job = await jobs.update(jobId, (draft) => { draft.status = 'done'; });
        await queue.ack(lease);
        await journal.record(job, { type: 'job.done', stage: stageId, message: `step ${stageId} done. The job is done.` });
        return;
      }
      job = await jobs.update(jobId, (draft) => { draft.stages[next.id].status = 'queued'; });
      await queue.forward(lease, queueName(next.id), messageFor(job, next));
      await journal.record(job, { type: 'stage.done', stage: stageId, message: `step ${stageId} done${outcome.recoveredBy ? ` (recovered by ${outcome.recoveredBy})` : ''}. Queued for ${next.id}.` });
      return;
    }
    if (outcome.type === 'retry') {
      const job = await jobs.update(jobId, (draft) => { draft.stages[stageId].status = 'queued'; });
      await queue.release(lease, { delayMs: outcome.delayMs, reason: outcome.reason });
      await journal.record(job, { type: 'stage.retry', stage: stageId, message: `${stageId} retries in ${Math.round(outcome.delayMs / 1000)}s: ${outcome.reason}.` });
      return;
    }
    const status = outcome.type === 'blocked' ? 'blocked' : 'failed';
    const job = await jobs.update(jobId, (draft) => {
      draft.stages[stageId].status = status;
      if (draft.status === 'cancelled') return;
      draft.status = status;
      draft.blocker = outcome.reason;
    });
    await queue.deadLetter(lease, outcome.reason);
    await journal.record(job, { type: `job.${status}`, stage: stageId, message: `${status}. ${outcome.reason}` });
  };
}
