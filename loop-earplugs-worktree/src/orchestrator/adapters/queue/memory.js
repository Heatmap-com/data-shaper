import { randomUUID } from 'node:crypto';
import { LeaseLostError } from '../../ports/queue.js';

const OPEN = new Set(['queued', 'running']);

/** The five ports over Maps, with the same lease, dedupe, delay, dead-letter, and in-flight rules as the SQLite store. */
export function createStore({ clock = { now: () => new Date() } } = {}) {
  const now = () => clock.now().getTime();
  /** @type {Map<string, object>} message id -> row */
  const messages = new Map();
  /** @type {Map<string, {job: object, createdAt: number}>} */
  const jobsById = new Map();
  /** @type {Map<string, object[]>} */
  const eventsByJob = new Map();
  /** @type {Map<string, {owner: string, pid: number, host: string, stages: string[], lastSeen: number}>} */
  const workersByOwner = new Map();
  /** @type {Map<string, Map<number, {token: string, owner: string, expiresAt: number}>>} resource -> slot -> lease */
  const slotsByResource = new Map();
  /** @type {Map<string, Promise>} serializes update() per job */
  const jobLocks = new Map();

  const toMessage = (row) => ({
    id: row.id, queue: row.queue, jobId: row.jobId, priority: row.priority, rankAt: row.rankAt,
    payload: structuredClone(row.payload), deliveries: row.deliveries, lastError: row.lastError,
  });

  function enqueueSync(name, request, at) {
    if (request.dedupeKey !== undefined && request.dedupeKey !== null) {
      const open = [...messages.values()].some((row) => row.queue === name
        && row.dedupeKey === request.dedupeKey && (row.state === 'ready' || row.state === 'leased'));
      if (open) return { id: randomUUID(), deduped: true };
    }
    const row = {
      id: randomUUID(), queue: name, jobId: request.jobId, dedupeKey: request.dedupeKey ?? null,
      priority: request.priority, rankAt: request.rankAt, payload: structuredClone(request.payload ?? {}),
      state: 'ready', deliveries: 0, availableAt: at + (request.delayMs ?? 0),
      leaseToken: null, leaseOwner: null, leaseExpiresAt: null, lastError: null, createdAt: at, updatedAt: at,
    };
    messages.set(row.id, row);
    return { id: row.id, deduped: false };
  }

  function settleSync(lease, state, delayMs, error) {
    const row = messages.get(lease.message.id);
    if (!row || row.state !== 'leased' || row.leaseToken !== lease.token) throw new LeaseLostError(lease.message.id);
    const at = now();
    row.state = state;
    row.availableAt = at + delayMs;
    row.lastError = error ?? row.lastError;
    row.leaseToken = null;
    row.leaseOwner = null;
    row.leaseExpiresAt = null;
    row.updatedAt = at;
  }

  /** @type {import('../../ports/queue.js').StageQueuePort} */
  const queue = {
    async enqueue(name, request) {
      return enqueueSync(name, request, now());
    },
    async reserve(name, { leaseMs, owner, maxInFlight = Infinity, maxDeliveries = 5 }) {
      const at = now();
      for (const row of messages.values()) {
        if (row.queue !== name || row.state !== 'leased' || row.leaseExpiresAt >= at) continue;
        if (row.deliveries >= maxDeliveries) {
          row.state = 'dead';
          row.lastError = `lease expired ${row.deliveries} times`;
          row.leaseToken = null;
        } else {
          row.state = 'ready';
          row.leaseToken = null;
          row.leaseOwner = null;
          row.leaseExpiresAt = null;
          row.lastError = 'lease expired';
        }
        row.updatedAt = at;
      }
      const inFlight = [...messages.values()].filter((row) => row.queue === name && row.state === 'leased').length;
      if (inFlight >= maxInFlight) return null;
      const next = [...messages.values()]
        .filter((row) => row.queue === name && row.state === 'ready' && row.availableAt <= at)
        .sort((a, b) => a.priority - b.priority || a.rankAt - b.rankAt || a.createdAt - b.createdAt)[0];
      if (!next) return null;
      const token = randomUUID();
      const expiresAt = at + leaseMs;
      next.state = 'leased';
      next.deliveries += 1;
      next.leaseToken = token;
      next.leaseOwner = owner;
      next.leaseExpiresAt = expiresAt;
      next.updatedAt = at;
      return { token, owner, expiresAt, message: toMessage(next) };
    },
    async extend(lease, leaseMs) {
      const row = messages.get(lease.message.id);
      if (!row || row.state !== 'leased' || row.leaseToken !== lease.token) throw new LeaseLostError(lease.message.id);
      const expiresAt = now() + leaseMs;
      row.leaseExpiresAt = expiresAt;
      row.updatedAt = now();
      return { ...lease, expiresAt };
    },
    async ack(lease) {
      settleSync(lease, 'done', 0, null);
    },
    async release(lease, { delayMs, reason }) {
      settleSync(lease, 'ready', delayMs, reason);
    },
    async forward(lease, next, request) {
      settleSync(lease, 'done', 0, null);
      return enqueueSync(next, request, now());
    },
    async deadLetter(lease, reason) {
      settleSync(lease, 'dead', 0, reason);
    },
    async revive(id) {
      const row = messages.get(id);
      if (!row || row.state !== 'dead') throw new Error(`no dead message ${id}`);
      const at = now();
      row.state = 'ready';
      row.deliveries = 0;
      row.availableAt = at;
      row.updatedAt = at;
    },
    async stats() {
      const at = now();
      const names = [...new Set([...messages.values()].map((row) => row.queue))].sort();
      return names.map((name) => {
        const rows = [...messages.values()].filter((row) => row.queue === name);
        return {
          queue: name,
          ready: rows.filter((row) => row.state === 'ready' && row.availableAt <= at).length,
          delayed: rows.filter((row) => row.state === 'ready' && row.availableAt > at).length,
          leased: rows.filter((row) => row.state === 'leased').length,
          dead: rows.filter((row) => row.state === 'dead').length,
          leases: rows.filter((row) => row.state === 'leased').map((row) => ({
            jobId: row.jobId, owner: row.leaseOwner, expiresAt: row.leaseExpiresAt, deliveries: row.deliveries,
          })),
        };
      });
    },
    async peekReady(name, limit) {
      return [...messages.values()]
        .filter((row) => row.queue === name && row.state === 'ready')
        .sort((a, b) => a.priority - b.priority || a.rankAt - b.rankAt || a.createdAt - b.createdAt)
        .slice(0, limit)
        .map(toMessage);
    },
    async listDead(name = null) {
      return [...messages.values()]
        .filter((row) => row.state === 'dead' && (name === null || row.queue === name))
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map(toMessage);
    },
    async reprioritize(jobId, priority) {
      const rows = [...messages.values()].filter((row) => row.jobId === jobId && (row.state === 'ready' || row.state === 'leased'));
      for (const row of rows) Object.assign(row, { priority, updatedAt: now() });
      return rows.length;
    },
    async discard(jobId, reason) {
      const rows = [...messages.values()].filter((row) => row.jobId === jobId && row.state === 'ready');
      for (const row of rows) Object.assign(row, { state: 'done', lastError: reason, updatedAt: now() });
      return rows.length;
    },
    async purge(jobId) {
      const rows = [...messages.values()].filter((row) => row.jobId === jobId && (row.state === 'done' || row.state === 'dead'));
      for (const row of rows) messages.delete(row.id);
      return rows.length;
    },
  };

  /** @type {import('../../ports/job-store.js').JobStorePort} */
  const jobs = {
    async create(job) {
      if (jobsById.has(job.id)) throw new Error(`job ${job.id} already exists`);
      jobsById.set(job.id, { job: structuredClone(job), createdAt: now() });
      return job;
    },
    async get(id) {
      const entry = jobsById.get(id);
      return entry ? structuredClone(entry.job) : null;
    },
    async update(id, mutate) {
      const run = (jobLocks.get(id) ?? Promise.resolve()).then(() => {
        const entry = jobsById.get(id);
        if (!entry) throw new Error(`no job ${id}`);
        const draft = structuredClone(entry.job);
        const next = mutate(draft) ?? draft;
        next.version = entry.job.version + 1;
        next.updatedAt = clock.now().toISOString();
        entry.job = structuredClone(next);
        return next;
      });
      jobLocks.set(id, run.catch(() => {}));
      return run;
    },
    async list({ status } = {}) {
      const all = [...jobsById.values()]
        .sort((a, b) => a.createdAt - b.createdAt)
        .map((entry) => structuredClone(entry.job));
      return status ? all.filter((job) => status.includes(job.status)) : all;
    },
    async findOpenByDomain(domain) {
      return [...jobsById.values()]
        .map((entry) => entry.job)
        .filter((job) => job.site.domain === domain && OPEN.has(job.status))
        .map((job) => structuredClone(job));
    },
    async remove(id) {
      return jobsById.delete(id);
    },
  };

  const events = {
    async append(jobId, event) {
      const list = eventsByJob.get(jobId) ?? [];
      list.push(structuredClone(event));
      eventsByJob.set(jobId, list);
    },
    async tail(jobId, limit = 20) {
      return (eventsByJob.get(jobId) ?? []).slice(-limit).map((event) => structuredClone(event));
    },
    async remove(jobId) {
      const count = eventsByJob.get(jobId)?.length ?? 0;
      eventsByJob.delete(jobId);
      return count;
    },
  };

  const workers = {
    async heartbeat({ owner, pid, host, stages }) {
      workersByOwner.set(owner, { owner, pid, host, stages: [...stages], lastSeen: now() });
    },
    async remove(owner) {
      workersByOwner.delete(owner);
    },
    async list() {
      return [...workersByOwner.values()].map((worker) => ({ ...worker, stages: [...worker.stages] }));
    },
  };

  const resources = {
    async tryAcquire(resource, capacity, owner, leaseMs) {
      const at = now();
      const slots = slotsByResource.get(resource) ?? new Map();
      for (const [slot, lease] of [...slots]) if (lease.expiresAt < at) slots.delete(slot);
      slotsByResource.set(resource, slots);
      for (let slot = 0; slot < capacity; slot += 1) {
        if (slots.has(slot)) continue;
        const token = randomUUID();
        slots.set(slot, { token, owner, expiresAt: at + leaseMs });
        return { slot, token };
      }
      return null;
    },
    async renew(resource, token, leaseMs) {
      const slots = slotsByResource.get(resource);
      const lease = slots && [...slots.values()].find((row) => row.token === token);
      if (!lease) return false;
      lease.expiresAt = now() + leaseMs;
      return true;
    },
    async release(resource, token) {
      const slots = slotsByResource.get(resource);
      if (!slots) return;
      for (const [slot, lease] of [...slots]) if (lease.token === token) slots.delete(slot);
    },
  };

  return { queue, jobs, events, workers, resources, close: () => {} };
}
