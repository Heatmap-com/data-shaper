import { queueName, queueOrder } from '../domain/job.js';

/** Structured monitor snapshot behind `status --json`. */
export async function statusSnapshot({ store, descriptors, config, clock }) {
  const [stats, open, workers, all, stageIds] = await Promise.all([
    store.queue.stats(),
    store.jobs.list({ status: ['queued', 'running'] }),
    store.workers.list(),
    store.jobs.list(),
    descriptors.stageIds(),
  ]);
  const now = clock.now().getTime();
  const staleMs = (config.worker?.heartbeatMs ?? 15_000) * 3;
  const live = (worker) => now - worker.lastSeen <= staleMs;
  const names = [...new Set([...stats.map((row) => row.queue), ...stageIds.map(queueName)])].sort();

  const stages = [];
  for (const name of names) {
    const stat = stats.find((row) => row.queue === name) ?? { queue: name, ready: 0, delayed: 0, leased: 0, dead: 0, leases: [] };
    const stageId = name.startsWith('stage:') ? name.slice('stage:'.length) : name;
    const lease = stat.leases[0] ?? null;
    const job = lease ? await store.jobs.get(lease.jobId) : null;
    const holder = lease ? workers.find((worker) => worker.owner === lease.owner) : null;
    const served = workers.some((worker) => live(worker) && worker.stages.includes(stageId));
    const stalled = Boolean(lease && (!holder || !live(holder))) || (stat.ready > 0 && !served);
    stages.push({ stage: stageId, ...stat, lease, job, holder, stalled });
  }

  const waiting = open.filter((job) => job.status === 'queued').sort(queueOrder);
  const count = (status) => all.filter((job) => job.status === status).length;
  return {
    at: clock.now().toISOString(),
    stages,
    next: waiting.slice(0, 5),
    totals: {
      open: open.length,
      running: open.length - waiting.length,
      waiting: waiting.length,
      done: count('done'),
      blocked: count('blocked'),
      failed: count('failed'),
      cancelled: count('cancelled'),
      dead: stats.reduce((sum, row) => sum + row.dead, 0),
    },
    workers: workers.map((worker) => ({ ...worker, alive: live(worker) })),
  };
}

/** The monitor text: per-stage holder, attempt, and agent; next 5; totals; workers; STALLED markers. */
export async function readStatus({ store, descriptors, config, clock }) {
  const snap = await statusSnapshot({ store, descriptors, config, clock });
  const now = clock.now().getTime();
  const ago = (ms) => {
    const seconds = Math.max(0, Math.round(ms / 1000));
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m`;
    return `${Math.floor(minutes / 60)}h`;
  };

  const lines = ['Stages:'];
  for (const stage of snap.stages) {
    const label = stage.stage;
    if (!stage.lease) {
      const bits = [stage.ready ? `${stage.ready} ready` : 'empty'];
      if (stage.delayed) bits.push(`${stage.delayed} delayed`);
      if (stage.dead) bits.push(`${stage.dead} dead`);
      const stalled = stage.stalled ? ' — STALLED: ready work but no live worker serves this stage' : '';
      lines.push(`${label}: ${bits.join(', ')}${stalled}`);
      continue;
    }
    const domain = stage.job?.site.domain ?? stage.lease.jobId;
    const state = stage.job?.stages[label];
    const progress = state
      ? `attempt ${state.attempts}${state.fallbackAttempts ? `, fallback ${state.recoveredBy ?? 'agent'} ${state.fallbackAttempts}` : ''}`
      : 'attempt ?';
    if (stage.stalled) {
      const held = stage.holder ? `last heartbeat ${ago(now - stage.holder.lastSeen)} ago` : 'no heartbeat on record';
      lines.push(`${label}: ${domain} — STALLED: lease held by ${stage.lease.owner}, ${held}`);
    } else {
      lines.push(`${label}: ${domain} — ${progress} — worker ${stage.lease.owner} (alive ${ago(now - stage.holder.lastSeen)} ago)`);
    }
  }

  lines.push('Next 5:');
  if (!snap.next.length) lines.push('(none)');
  snap.next.forEach((job, index) => {
    const stage = job.run.stages.find((row) => job.stages[row.id]?.status === 'queued') ?? job.run.stages[0];
    lines.push(`${index + 1}. ${job.site.domain} — ${job.priority} — ${job.run.id} — waiting for ${stage.id}`);
  });

  const t = snap.totals;
  lines.push(`Queue length: ${t.open} (${t.running} in a stage, ${t.waiting} waiting). Done ${t.done}. Blocked ${t.blocked}. Failed ${t.failed}. Cancelled ${t.cancelled}. Dead letters ${t.dead}.`);

  const alive = snap.workers.filter((worker) => worker.alive);
  const shown = alive.map((worker) => `${worker.owner} (stages ${worker.stages[0] ?? ''}…${worker.stages.at(-1) ?? ''})`).join(', ');
  lines.push(`Workers: ${alive.length} alive${shown ? ` (${shown})` : ''}.`);
  return lines.join('\n');
}
