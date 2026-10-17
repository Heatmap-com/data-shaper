import { DescriptorError, OrchestratorError } from './errors.js';

export const PRIORITY_RANK = { critical: 0, high: 1, normal: 2, low: 3 };
export const queueName = (stageId) => `stage:${stageId}`;
export const OPEN_STATUSES = ['queued', 'running'];
export const FINISHED_STATUSES = ['done', 'blocked', 'failed', 'cancelled'];

export const blankStage = () => ({ status: 'pending', attempts: 0, fallbackAttempts: 0, startedAt: null, finishedAt: null, recoveredBy: null, note: null, lastError: null });

export function assertPriority(priority) {
  if (!Object.hasOwn(PRIORITY_RANK, priority)) {
    throw new OrchestratorError(`priority must be one of ${Object.keys(PRIORITY_RANK).join(', ')}; got "${priority}"`, { exitCode: 2 });
  }
  return priority;
}

/** The order the stage queues deliver in: priority, then the job that was queued first. */
export function queueOrder(a, b) {
  return PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || Date.parse(a.createdAt) - Date.parse(b.createdAt);
}

/** A queued job no stage has touched yet: nothing ran, nothing finished. */
export function notStarted(job) {
  return job.status === 'queued'
    && Object.values(job.stages).every((state) => (state.status === 'pending' || state.status === 'queued') && state.attempts === 0);
}

/** The stage the job waits for or holds: the first stage that is queued or running. */
export function currentStage(job) {
  return job.run.stages.find((stage) => ['queued', 'running'].includes(job.stages[stage.id]?.status)) ?? null;
}

export function createJob({ id, site, pages, window, priority, resilience, resolved, now }) {
  const at = now.toISOString();
  return {
    id,
    version: 0,
    status: 'queued',
    priority,
    resilience,
    site,
    pages,
    window,
    run: resolved.run,
    provenance: { refs: resolved.refs, hash: resolved.hash },
    stages: Object.fromEntries(resolved.run.stages.map((stage) => [stage.id, blankStage()])),
    blocker: null,
    createdAt: at,
    updatedAt: at,
  };
}

export function nextStage(job, stageId) {
  const index = job.run.stages.findIndex((stage) => stage.id === stageId);
  return job.run.stages[index + 1] ?? null;
}

export function messageFor(job, stage) {
  return {
    jobId: job.id,
    priority: PRIORITY_RANK[job.priority],
    rankAt: Date.parse(job.createdAt),
    dedupeKey: `${job.id}:${stage.id}`,
    payload: { stage: stage.id },
  };
}

/**
 * The job's date window from the run's `defaults.window`. `{days, end}`
 * is a span ending yesterday or today. `{mode: 'next-weeks', overlapWeeks}`
 * ends on the last Sunday before today, and its start is where a site whose
 * trend is current begins: the overlap weeks plus the new week. The trend
 * stage reads its stored weeks for the actual start.
 */
export function windowFor(defaults = {}, now) {
  const mode = defaults.mode ?? 'days';
  if (mode === 'next-weeks') return nextWeeksFor(defaults, now);
  if (mode !== 'days') throw new DescriptorError(`window mode "${mode}" must be days or next-weeks`);
  const days = defaults.days ?? 30;
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if ((defaults.end ?? 'yesterday') === 'yesterday') end.setUTCDate(end.getUTCDate() - 1);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (days - 1));
  return { start: iso(start), end: iso(end) };
}

const iso = (date) => date.toISOString().slice(0, 10);

function nextWeeksFor(defaults, now) {
  const overlapWeeks = defaults.overlapWeeks ?? 1;
  if (!Number.isInteger(overlapWeeks) || overlapWeeks < 0) {
    throw new DescriptorError(`window overlapWeeks ${JSON.stringify(defaults.overlapWeeks)} must be a whole number`);
  }
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  end.setUTCDate(end.getUTCDate() - (((end.getUTCDay() + 6) % 7) + 1));
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 6 - 7 * overlapWeeks);
  return { mode: 'next-weeks', overlapWeeks, start: iso(start), end: iso(end) };
}
