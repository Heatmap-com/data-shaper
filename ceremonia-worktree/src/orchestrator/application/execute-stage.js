import { classifyFailure } from '../domain/failure.js';
import { backoffMs } from '../domain/retry.js';
import { unitsFor } from '../domain/pages.js';

/**
 * One delivery of one stage for one job. It returns how to settle the message
 * and never touches the queue.
 *
 * @typedef {{type: 'advance', note: string, recoveredBy?: string}
 *   | {type: 'retry', delayMs: number, reason: string}
 *   | {type: 'blocked', reason: string}
 *   | {type: 'failed', reason: string}
 *   | {type: 'cancelled'}} Settlement
 */
export function createStageExecutor({ jobs, handlers, checks, fallback, governor, journal, contexts, random = Math.random }) {
  return { execute };

  /** @returns {Promise<Settlement>} */
  async function execute({ jobId, stageId, owner, signal }) {
    let job = await jobs.get(jobId);
    if (!job) return { type: 'failed', reason: `no job ${jobId}` };
    if (job.status === 'cancelled') return { type: 'cancelled' };
    if (job.stages[stageId]?.status === 'done') return { type: 'advance', note: 'already done (redelivery)' };
    const stage = job.run.stages.find((row) => row.id === stageId);
    if (!stage) return { type: 'failed', reason: `job has no stage ${stageId}` };
    if (!stage.handler?.use || !stage.check?.use) return { type: 'failed', reason: `stage ${stageId} needs a handler and a completion check` };

    job = await jobs.update(jobId, (draft) => {
      const state = draft.stages[stageId];
      state.status = 'running';
      state.attempts += 1;
      state.startedAt ??= new Date().toISOString();
      if (draft.status !== 'cancelled') draft.status = 'running';
    });
    const attempt = job.stages[stageId].attempts;
    await journal.record(job, { type: 'stage.started', stage: stageId, message: `stage ${stageId} started, attempt ${attempt}.` });

    let recoveredBy = null;
    const units = unitsFor(stage, job);
    for (const unit of units) {
      const ctx = await contexts.create({ job, stage, unit, attempt, owner, signal });
      const before = await verify(stage, ctx);
      if (before.ok) {
        await journal.record(job, { type: 'unit.satisfied', stage: stageId, message: `${unit.key} already complete: ${before.summary}` });
        continue;
      }
      const failure = await runPrimary(stage, ctx);
      if (!failure) {
        await journal.record(job, { type: 'unit.done', stage: stageId, message: `${unit.key} complete.` });
        continue;
      }
      const verdict = classifyFailure(stage.errors, failure);
      await journal.record(job, { type: 'unit.failed', stage: stageId, message: `${unit.key}: ${verdict.class}, ${verdict.reason}.`, data: { failure } });
      await jobs.update(jobId, (draft) => { draft.stages[stageId].lastError = `${verdict.class}: ${verdict.reason}`; });

      if (verdict.class === 'blocked') return { type: 'blocked', reason: `${stageId} on ${unit.key}: ${verdict.reason}` };
      if (verdict.class === 'transient' && attempt < (stage.retry?.maxAttempts ?? 1)) {
        return { type: 'retry', delayMs: backoffMs(stage.retry, attempt, random), reason: verdict.reason };
      }
      const outcome = await fallback.recover({ job, stage, unit, ctx, failure, verdict, rerun: () => runPrimary(stage, ctx), verify: () => verify(stage, ctx) });
      if (outcome.type !== 'recovered') return outcome;
      recoveredBy = outcome.agent;
    }
    return { type: 'advance', note: `${units.length} unit(s) complete.`, recoveredBy };
  }

  async function runPrimary(stage, ctx) {
    const handler = await handlers.get(stage.handler.use);
    const result = await governor.withResources(stage.resources ?? [], ctx.owner, ctx.signal, () => handler.run(ctx, stage.handler));
    if (result.status !== 'ok') {
      return { kind: 'handler', message: result.message ?? `exit ${result.exitCode}`, command: result.command, exitCode: result.exitCode, timedOut: result.timedOut, logTail: result.logTail, hint: result.verdict };
    }
    const after = await verify(stage, ctx);
    return after.ok ? null : { kind: 'check', message: `handler exited cleanly but the check failed: ${after.summary}`, command: result.command, exitCode: result.exitCode, details: after.details, logTail: result.logTail };
  }

  async function verify(stage, ctx) {
    const check = await checks.get(stage.check.use);
    return check.evaluate(ctx, stage.check);
  }
}
