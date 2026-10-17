import {
  FINISHED_STATUSES, OPEN_STATUSES, PRIORITY_RANK, assertPriority, blankStage, currentStage, messageFor, notStarted, queueName, queueOrder,
} from '../domain/job.js';
import { NotFoundError, OrchestratorError } from '../domain/errors.js';
import { bareDomain } from '../domain/site.js';

/**
 * Operator commands over existing jobs: pick a job by id, domain, or slug;
 * change its priority; note on it; cancel, clear, and retry. Each change is
 * journaled, and each returns a `message` a person can read as is.
 *
 * @param {{jobs: import('../ports/job-store.js').JobStorePort, queue: import('../ports/queue.js').StageQueuePort,
 *   events: import('../ports/event-log.js').EventLogPort, journal: import('../ports/journal.js').JournalPort,
 *   resolver: {resolve: Function}, clock: {now: () => Date}}} deps
 */
export function createJobAdmin({ jobs, queue, events, journal, resolver, clock }) {
  return { select, position, priority, note, cancel, clear, retry, complete, show };

  /**
   * The job a person means: its id, or the one job for that domain or slug.
   * An open job wins over finished ones; otherwise the newest finished job.
   */
  async function select(selector) {
    const wanted = String(selector ?? '').trim();
    if (!wanted) throw new OrchestratorError('a job id, domain, or site slug is required', { exitCode: 2 });
    const exact = await jobs.get(wanted);
    if (exact) return exact;
    const host = bareDomain(wanted.replace(/^[a-z]+:\/\//i, '').split('/')[0]);
    const matches = (await jobs.list()).filter((job) => job.site.slug === wanted || bareDomain(job.site.domain) === host);
    if (!matches.length) throw new NotFoundError(`no job for "${wanted}"`);
    const open = matches.filter((job) => OPEN_STATUSES.includes(job.status));
    if (open.length > 1) {
      throw new OrchestratorError(`"${wanted}" matches ${open.length} open jobs; pass one id: ${open.map((job) => job.id).join(', ')}`, { exitCode: 2 });
    }
    return open[0] ?? matches.at(-1);
  }

  /** Where a waiting job stands: its place among jobs not yet started, how many lower-priority jobs it is ahead of, and the queue length. */
  async function position(job) {
    const open = await jobs.list({ status: OPEN_STATUSES });
    const waiting = open.filter(notStarted).sort(queueOrder);
    const index = waiting.findIndex((row) => row.id === job.id);
    const ahead = index === -1 ? 0 : waiting.slice(index + 1).filter((row) => PRIORITY_RANK[row.priority] > PRIORITY_RANK[job.priority]).length;
    return { position: index === -1 ? null : index + 1, aheadOfLower: ahead, length: open.length };
  }

  async function priority(selector, level) {
    assertPriority(level);
    const job = await select(selector);
    if (!OPEN_STATUSES.includes(job.status)) {
      throw new OrchestratorError(`${job.site.domain} is ${job.status} and not waiting; retry it before changing priority`, { exitCode: 2 });
    }
    const previous = job.priority;
    const updated = await jobs.update(job.id, (draft) => { draft.priority = level; });
    const messages = await queue.reprioritize(job.id, PRIORITY_RANK[level]);
    await journal.record(updated, { type: 'job.priority', message: `priority ${previous} → ${level}.` });
    const place = await position(updated);
    const stage = currentStage(updated);
    const where = notStarted(updated)
      ? `Waiting position ${place.position}.`
      : `It is on the ${stage?.id ?? 'next'} stage.`;
    return {
      message: `${updated.site.domain} priority is ${level} (was ${previous}). ${where} Queue length ${place.length}.`,
      job: summary(updated), previous, messages, ...place,
    };
  }

  async function note(selector, text) {
    const body = String(text ?? '').trim();
    if (!body) throw new OrchestratorError('a note is required (--text)', { exitCode: 2 });
    const job = await select(selector);
    await journal.record(job, { type: 'job.note', message: body });
    return { message: `Noted on ${job.site.domain}.`, job: summary(job) };
  }

  async function cancel(selector, reason) {
    const job = await select(selector);
    if (!OPEN_STATUSES.includes(job.status)) {
      throw new OrchestratorError(`${job.site.domain} is ${job.status}; only a queued or running job can be cancelled`, { exitCode: 2 });
    }
    const why = String(reason ?? '').trim() || 'cancelled by the operator';
    const updated = await jobs.update(job.id, (draft) => {
      draft.status = 'cancelled';
      draft.blocker = why;
    });
    const discarded = await queue.discard(job.id, 'job cancelled');
    await journal.record(updated, { type: 'job.cancelled', message: `cancelled. ${why}` });
    const held = currentStage(job)?.id;
    const tail = job.status === 'running' && held ? ` The ${held} stage finishes its current attempt and then stops.` : '';
    return { message: `${job.site.domain} is cancelled.${tail}`, job: summary(updated), discarded };
  }

  /**
   * Waiting jobs nothing has started are cancelled. With `finished`, done,
   * blocked, failed, and cancelled jobs leave the store; their journal files
   * stay. A job in a stage is kept whichever flags are passed.
   */
  async function clear({ waiting = true, finished = false } = {}) {
    const all = await jobs.list();
    const removed = [];
    if (waiting) {
      for (const job of all.filter(notStarted)) {
        await jobs.update(job.id, (draft) => { draft.status = 'cancelled'; draft.blocker = 'cleared from the queue'; });
        await queue.discard(job.id, 'cleared from the queue');
        await journal.record(job, { type: 'job.cleared', message: 'cleared from the queue (was waiting).' });
        removed.push({ ...summary(job), was: 'waiting' });
      }
    }
    if (finished) {
      for (const job of all.filter((row) => FINISHED_STATUSES.includes(row.status))) {
        await journal.record(job, { type: 'job.cleared', message: `cleared from the queue (was ${job.status}).` });
        await queue.purge(job.id);
        await events.remove(job.id);
        await jobs.remove(job.id);
        removed.push({ ...summary(job), was: job.status });
      }
    }
    const open = await jobs.list({ status: OPEN_STATUSES });
    const inStage = open.filter((job) => !notStarted(job)).length;
    const what = [waiting && 'waiting', finished && 'finished'].filter(Boolean).join(' and ');
    let message = removed.length
      ? `Removed ${removed.length} ${what} job${removed.length === 1 ? '' : 's'}: ${removed.map((row) => row.domain).join(', ')}.`
      : 'Nothing matched. No jobs removed.';
    if (inStage) message += ` ${inStage} job${inStage === 1 ? '' : 's'} in a stage ${inStage === 1 ? 'was' : 'were'} kept.`;
    message += ` Queue length ${open.length}.`;
    return { message, removed, length: open.length };
  }

  /**
   * Puts a failed or blocked stage back on its queue. Finished stages keep
   * their work. `refresh` re-resolves the run first, so a fixed descriptor
   * or a new stage is picked up.
   */
  async function retry(selector, { stage: stageId, refresh = false } = {}) {
    const job = await select(selector);
    const target = stageId
      ?? job.run.stages.find((stage) => ['failed', 'blocked'].includes(job.stages[stage.id]?.status))?.id;
    if (!target) throw new OrchestratorError(`job ${job.id} has no failed or blocked stage; pass --stage`, { exitCode: 2 });
    if (!job.stages[target]) throw new OrchestratorError(`job ${job.id} has no stage ${target}`, { exitCode: 2 });

    if (refresh) {
      const resolved = await resolver.resolve({ site: job.site, ref: job.run.id });
      await jobs.update(job.id, (draft) => {
        draft.run = resolved.run;
        draft.provenance = { refs: resolved.refs, hash: resolved.hash };
        for (const stage of resolved.run.stages) draft.stages[stage.id] ??= blankStage();
      });
    }

    const updated = await jobs.update(job.id, (draft) => {
      Object.assign(draft.stages[target], { status: 'queued', attempts: 0, fallbackAttempts: 0, lastError: null, finishedAt: null });
      draft.status = 'queued';
      draft.blocker = null;
    });
    await journal.record(updated, { type: 'job.retried', stage: target, message: `retry ${target}${refresh ? ' with the run re-resolved' : ''}. Finished stages were kept.` });
    const base = { job: job.id, stage: target, refreshed: refresh, message: `${job.site.domain} is queued again on ${target}.` };
    const dead = (await queue.listDead(queueName(target))).filter((message) => message.jobId === job.id);
    if (dead.length) {
      await queue.revive(dead[0].id);
      return { ...base, revived: dead[0].id };
    }
    const stage = updated.run.stages.find((row) => row.id === target);
    return { ...base, enqueued: await queue.enqueue(queueName(target), messageFor(updated, stage)) };
  }

  /**
   * Records that a person did a stage that has no automated completion
   * check yet (`check.use` is `pending`), then queues the next stage. A stage
   * with a real check is judged by that check: retry it instead.
   */
  async function complete(selector, { stage: stageId, note: text } = {}) {
    const body = String(text ?? '').trim();
    if (!body) throw new OrchestratorError('say why the stage is done (--note)', { exitCode: 2 });
    const job = await select(selector);
    if (job.status === 'done' || job.status === 'cancelled') throw new OrchestratorError(`${job.site.domain} is ${job.status}`, { exitCode: 2 });
    const target = stageId
      ? job.run.stages.find((stage) => stage.id === stageId)
      : job.run.stages.find((stage) => ['queued', 'running', 'blocked', 'failed'].includes(job.stages[stage.id]?.status));
    if (!target) throw new OrchestratorError(`job ${job.id} has no stage ${stageId ?? 'waiting to be done'}`, { exitCode: 2 });
    if (target.check?.use !== 'pending') {
      throw new OrchestratorError(`stage ${target.id} has the completion check ${target.check?.use}; run retry and the check decides`, { exitCode: 2 });
    }
    const index = job.run.stages.indexOf(target);
    const open = job.run.stages.slice(0, index).filter((stage) => !['done', 'skipped'].includes(job.stages[stage.id].status));
    if (open.length) throw new OrchestratorError(`stage ${target.id} comes after ${open.map((stage) => stage.id).join(', ')}, which ${open.length === 1 ? 'is' : 'are'} not done`, { exitCode: 2 });

    const next = job.run.stages[index + 1] ?? null;
    const at = clock.now().toISOString();
    const updated = await jobs.update(job.id, (draft) => {
      Object.assign(draft.stages[target.id], { status: 'done', finishedAt: at, note: body, recoveredBy: 'operator', lastError: null });
      draft.blocker = null;
      draft.status = next ? 'queued' : 'done';
      if (next) draft.stages[next.id].status = 'queued';
    });
    await queue.discard(job.id, `${target.id} completed by the operator`);
    await queue.purge(job.id);
    if (next) await queue.enqueue(queueName(next.id), messageFor(updated, next));
    await journal.record(updated, { type: 'stage.done', stage: target.id, message: `step ${target.id} done by the operator: ${body}${next ? ` Queued for ${next.id}.` : ' The job is done.'}` });
    return { message: `${job.site.domain}: ${target.id} is done.${next ? ` Queued for ${next.id}.` : ' The job is done.'}`, job: summary(updated), next: next?.id ?? null };
  }

  async function show(selector, limit = 20) {
    const job = await select(selector);
    return { job, events: await events.tail(job.id, limit) };
  }
}

export function summary(job) {
  return {
    id: job.id,
    domain: job.site.domain,
    slug: job.site.slug,
    run: job.run?.id ?? null,
    status: job.status,
    priority: job.priority,
    resilience: job.resilience,
    stage: currentStage(job)?.id ?? null,
    blocker: job.blocker ?? null,
  };
}
