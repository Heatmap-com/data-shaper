import { createJob } from './job.js';

/** The run each legacy process became. */
export const LEGACY_RUNS = { full: 'full' };

export const LEGACY_OPEN = new Set(['queued', 'waiting', 'running']);

/**
 * One `process/queue/queue.json` item as an orchestrator job with the same
 * id, priority, resilience, timestamps, and finished steps.
 *
 * - A done item is a done job. Stages its process did not have are `skipped`.
 * - A failed item is a failed job; the step it stopped on carries the blocker.
 * - A queued, waiting, or running item resumes at its first unfinished stage.
 *   A step that was running restarts there; the stage's completion check
 *   decides whether its earlier work already counts.
 *
 * @returns {{job: object, resume: object|null, notes: string[]}}
 */
export function legacyToJob({ item, site, resolved, pages, window }) {
  const job = createJob({
    id: item.id,
    site,
    pages,
    window,
    priority: item.priority ?? 'normal',
    resilience: item.resilience ?? 'standard',
    resolved,
    now: new Date(item.created_at),
  });
  job.updatedAt = item.updated_at ?? job.createdAt;
  job.legacy = { id: item.id, process: item.process, status: item.status, note: item.note ?? null, journal: item.journal ?? null };

  const notes = [];
  const steps = new Map((item.steps ?? []).map((step) => [step.id, step]));
  for (const id of steps.keys()) {
    if (!job.stages[id]) notes.push(`legacy step ${id} has no stage in run ${resolved.run.id}`);
  }

  for (const stage of resolved.run.stages) {
    const step = steps.get(stage.id);
    if (step?.status !== 'done') continue;
    Object.assign(job.stages[stage.id], {
      status: 'done',
      attempts: step.attempts ?? 1,
      startedAt: step.started_at ?? null,
      finishedAt: step.finished_at ?? null,
      note: step.note ?? null,
    });
  }

  const open = resolved.run.stages.filter((stage) => job.stages[stage.id].status !== 'done');
  if (item.status === 'done') {
    job.status = 'done';
    for (const stage of open) Object.assign(job.stages[stage.id], { status: 'skipped', note: `not part of the legacy ${item.process} process` });
    return { job, resume: null, notes };
  }
  if (item.status === 'failed') {
    job.status = 'failed';
    job.blocker = item.blocker ?? 'failed in the legacy queue';
    const stopped = open.find((stage) => steps.get(stage.id)?.status && steps.get(stage.id).status !== 'pending') ?? open[0];
    if (stopped) Object.assign(job.stages[stopped.id], { status: 'failed', lastError: job.blocker, attempts: steps.get(stopped.id)?.attempts ?? 0 });
    return { job, resume: null, notes };
  }
  if (!LEGACY_OPEN.has(item.status)) {
    notes.push(`legacy status "${item.status}" is not one of queued, waiting, running, done, failed`);
    return { job: null, resume: null, notes };
  }
  const resume = open[0] ?? null;
  if (!resume) {
    job.status = 'done';
    return { job, resume: null, notes };
  }
  job.stages[resume.id].status = 'queued';
  const step = steps.get(resume.id);
  if (step?.status === 'running') job.stages[resume.id].note = `was running in the legacy queue (attempt ${step.attempts ?? 1}); restarted here`;
  return { job, resume, notes };
}
