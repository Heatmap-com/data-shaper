import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { LeaseLostError } from '../../ports/queue.js';

// vite (vitest) cannot resolve the experimental `node:sqlite` builtin, so load it through require
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  queue TEXT NOT NULL,
  job_id TEXT NOT NULL,
  dedupe_key TEXT,
  priority INTEGER NOT NULL,
  rank_at INTEGER NOT NULL,
  payload TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('ready', 'leased', 'done', 'dead')),
  deliveries INTEGER NOT NULL DEFAULT 0,
  available_at INTEGER NOT NULL,
  lease_token TEXT,
  lease_owner TEXT,
  lease_expires_at INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS messages_open_dedupe ON messages(queue, dedupe_key)
  WHERE dedupe_key IS NOT NULL AND state IN ('ready', 'leased');
CREATE INDEX IF NOT EXISTS messages_next ON messages(queue, state, priority, rank_at, available_at);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  domain TEXT NOT NULL,
  status TEXT NOT NULL,
  version INTEGER NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_domain ON jobs(domain, status);
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  type TEXT NOT NULL,
  stage TEXT,
  body TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_job ON events(job_id, seq);
CREATE TABLE IF NOT EXISTS workers (
  owner TEXT PRIMARY KEY,
  pid INTEGER NOT NULL,
  host TEXT NOT NULL,
  stages TEXT NOT NULL,
  last_seen INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS resource_slots (
  resource TEXT NOT NULL,
  slot INTEGER NOT NULL,
  token TEXT NOT NULL,
  owner TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (resource, slot)
);
`;

const OPEN = new Set(['queued', 'running']);

export function createStore({ path: file, root, clock = { now: () => new Date() } }) {
  const full = path.resolve(root ?? process.cwd(), file);
  mkdirSync(path.dirname(full), { recursive: true });
  const db = new DatabaseSync(full);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;');
  db.exec(SCHEMA);
  const now = () => clock.now().getTime();

  const tx = (fn) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const value = fn();
      db.exec('COMMIT');
      return value;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  };

  const sql = {
    insert: db.prepare(`INSERT OR IGNORE INTO messages
      (id, queue, job_id, dedupe_key, priority, rank_at, payload, state, deliveries, available_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'ready', 0, ?, ?, ?)`),
    deadOverdue: db.prepare(`UPDATE messages SET state = 'dead', last_error = 'lease expired ' || deliveries || ' times', lease_token = NULL, updated_at = ?
      WHERE queue = ? AND state = 'leased' AND lease_expires_at < ? AND deliveries >= ?`),
    reclaim: db.prepare(`UPDATE messages SET state = 'ready', lease_token = NULL, lease_owner = NULL, lease_expires_at = NULL,
      last_error = 'lease expired', updated_at = ? WHERE queue = ? AND state = 'leased' AND lease_expires_at < ?`),
    inFlight: db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE queue = ? AND state = 'leased'`),
    next: db.prepare(`SELECT * FROM messages WHERE queue = ? AND state = 'ready' AND available_at <= ?
      ORDER BY priority, rank_at, created_at LIMIT 1`),
    lease: db.prepare(`UPDATE messages SET state = 'leased', deliveries = deliveries + 1, lease_token = ?, lease_owner = ?,
      lease_expires_at = ?, updated_at = ? WHERE id = ? AND state = 'ready'`),
    extend: db.prepare(`UPDATE messages SET lease_expires_at = ?, updated_at = ? WHERE id = ? AND lease_token = ? AND state = 'leased'`),
    settle: db.prepare(`UPDATE messages SET state = ?, available_at = ?, last_error = COALESCE(?, last_error),
      lease_token = NULL, lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ? AND lease_token = ? AND state = 'leased'`),
    revive: db.prepare(`UPDATE messages SET state = 'ready', deliveries = 0, available_at = ?, updated_at = ? WHERE id = ? AND state = 'dead'`),
    stats: db.prepare(`SELECT queue,
        SUM(state = 'ready' AND available_at <= ?) AS ready,
        SUM(state = 'ready' AND available_at > ?) AS delayed,
        SUM(state = 'leased') AS leased,
        SUM(state = 'dead') AS dead
      FROM messages GROUP BY queue ORDER BY queue`),
    leases: db.prepare(`SELECT queue, job_id, lease_owner, lease_expires_at, deliveries FROM messages WHERE state = 'leased'`),
    peek: db.prepare(`SELECT * FROM messages WHERE queue = ? AND state = 'ready' ORDER BY priority, rank_at, created_at LIMIT ?`),
    dead: db.prepare(`SELECT * FROM messages WHERE state = 'dead' AND (? IS NULL OR queue = ?) ORDER BY updated_at DESC`),
    reprioritize: db.prepare(`UPDATE messages SET priority = ?, updated_at = ? WHERE job_id = ? AND state IN ('ready', 'leased')`),
    discard: db.prepare(`UPDATE messages SET state = 'done', last_error = ?, updated_at = ? WHERE job_id = ? AND state = 'ready'`),
    purge: db.prepare(`DELETE FROM messages WHERE job_id = ? AND state IN ('done', 'dead')`),
    jobRemove: db.prepare(`DELETE FROM jobs WHERE id = ?`),
    eventRemove: db.prepare(`DELETE FROM events WHERE job_id = ?`),
    jobGet: db.prepare(`SELECT body, version FROM jobs WHERE id = ?`),
    jobInsert: db.prepare(`INSERT INTO jobs (id, domain, status, version, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`),
    jobPut: db.prepare(`UPDATE jobs SET status = ?, version = ?, body = ?, updated_at = ? WHERE id = ? AND version = ?`),
    jobList: db.prepare(`SELECT body FROM jobs ORDER BY created_at`),
    jobOpen: db.prepare(`SELECT body FROM jobs WHERE domain = ? AND status IN ('queued', 'running')`),
    eventAdd: db.prepare(`INSERT INTO events (job_id, at, type, stage, body) VALUES (?, ?, ?, ?, ?)`),
    eventTail: db.prepare(`SELECT body FROM events WHERE job_id = ? ORDER BY seq DESC LIMIT ?`),
    workerBeat: db.prepare(`INSERT INTO workers (owner, pid, host, stages, last_seen) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(owner) DO UPDATE SET last_seen = excluded.last_seen, stages = excluded.stages`),
    workerRemove: db.prepare(`DELETE FROM workers WHERE owner = ?`),
    workerList: db.prepare(`SELECT * FROM workers`),
    slotClear: db.prepare(`DELETE FROM resource_slots WHERE resource = ? AND expires_at < ?`),
    slotUsed: db.prepare(`SELECT slot FROM resource_slots WHERE resource = ?`),
    slotTake: db.prepare(`INSERT INTO resource_slots (resource, slot, token, owner, expires_at) VALUES (?, ?, ?, ?, ?)`),
    slotRenew: db.prepare(`UPDATE resource_slots SET expires_at = ? WHERE resource = ? AND token = ?`),
    slotFree: db.prepare(`DELETE FROM resource_slots WHERE resource = ? AND token = ?`),
  };

  function enqueueSync(queue, request, at) {
    const id = randomUUID();
    const { changes } = sql.insert.run(
      id, queue, request.jobId, request.dedupeKey ?? null, request.priority, request.rankAt,
      JSON.stringify(request.payload ?? {}), at + (request.delayMs ?? 0), at, at,
    );
    return { id, deduped: changes === 0 };
  }

  function settleSync(lease, state, delayMs, error) {
    const at = now();
    const { changes } = sql.settle.run(state, at + delayMs, error ?? null, at, lease.message.id, lease.token);
    if (changes === 0) throw new LeaseLostError(lease.message.id);
  }

  const toMessage = (row) => ({
    id: row.id, queue: row.queue, jobId: row.job_id, priority: row.priority, rankAt: row.rank_at,
    payload: JSON.parse(row.payload), deliveries: row.deliveries, lastError: row.last_error,
  });

  /** @type {import('../../ports/queue.js').StageQueuePort} */
  const queue = {
    async enqueue(name, request) {
      return tx(() => enqueueSync(name, request, now()));
    },
    async reserve(name, { leaseMs, owner, maxInFlight = Infinity, maxDeliveries = 5 }) {
      return tx(() => {
        const at = now();
        sql.deadOverdue.run(at, name, at, maxDeliveries);
        sql.reclaim.run(at, name, at);
        if (sql.inFlight.get(name).n >= maxInFlight) return null;
        const row = sql.next.get(name, at);
        if (!row) return null;
        const token = randomUUID();
        const expiresAt = at + leaseMs;
        sql.lease.run(token, owner, expiresAt, at, row.id);
        return { token, owner, expiresAt, message: toMessage({ ...row, deliveries: row.deliveries + 1 }) };
      });
    },
    async extend(lease, leaseMs) {
      const at = now();
      const { changes } = sql.extend.run(at + leaseMs, at, lease.message.id, lease.token);
      if (changes === 0) throw new LeaseLostError(lease.message.id);
      return { ...lease, expiresAt: at + leaseMs };
    },
    async ack(lease) {
      tx(() => settleSync(lease, 'done', 0, null));
    },
    async release(lease, { delayMs, reason }) {
      tx(() => settleSync(lease, 'ready', delayMs, reason));
    },
    async forward(lease, next, request) {
      return tx(() => {
        settleSync(lease, 'done', 0, null);
        return enqueueSync(next, request, now());
      });
    },
    async deadLetter(lease, reason) {
      tx(() => settleSync(lease, 'dead', 0, reason));
    },
    async revive(id) {
      const at = now();
      if (sql.revive.run(at, at, id).changes === 0) throw new Error(`no dead message ${id}`);
    },
    async stats() {
      const at = now();
      const leases = sql.leases.all();
      return sql.stats.all(at, at).map((row) => ({
        queue: row.queue, ready: row.ready, delayed: row.delayed, leased: row.leased, dead: row.dead,
        leases: leases.filter((lease) => lease.queue === row.queue).map((lease) => ({
          jobId: lease.job_id, owner: lease.lease_owner, expiresAt: lease.lease_expires_at, deliveries: lease.deliveries,
        })),
      }));
    },
    async peekReady(name, limit) {
      return sql.peek.all(name, limit).map(toMessage);
    },
    async listDead(name = null) {
      return sql.dead.all(name, name).map(toMessage);
    },
    async reprioritize(jobId, priority) {
      return Number(sql.reprioritize.run(priority, now(), jobId).changes);
    },
    async discard(jobId, reason) {
      return Number(sql.discard.run(reason, now(), jobId).changes);
    },
    async purge(jobId) {
      return Number(sql.purge.run(jobId).changes);
    },
  };

  /** @type {import('../../ports/job-store.js').JobStorePort} */
  const jobs = {
    async create(job) {
      const at = now();
      sql.jobInsert.run(job.id, job.site.domain, job.status, 0, JSON.stringify(job), at, at);
      return job;
    },
    async get(id) {
      const row = sql.jobGet.get(id);
      return row ? JSON.parse(row.body) : null;
    },
    async update(id, mutate) {
      return tx(() => {
        const row = sql.jobGet.get(id);
        if (!row) throw new Error(`no job ${id}`);
        const draft = JSON.parse(row.body);
        const next = mutate(draft) ?? draft;
        next.version = row.version + 1;
        next.updatedAt = clock.now().toISOString();
        const { changes } = sql.jobPut.run(next.status, next.version, JSON.stringify(next), now(), id, row.version);
        if (changes === 0) throw new Error(`job ${id} changed underneath this update`);
        return next;
      });
    },
    async list({ status } = {}) {
      const all = sql.jobList.all().map((row) => JSON.parse(row.body));
      return status ? all.filter((job) => status.includes(job.status)) : all;
    },
    async findOpenByDomain(domain) {
      return sql.jobOpen.all(domain).map((row) => JSON.parse(row.body)).filter((job) => OPEN.has(job.status));
    },
    async remove(id) {
      return sql.jobRemove.run(id).changes > 0;
    },
  };

  const events = {
    async append(jobId, event) {
      sql.eventAdd.run(jobId, now(), event.type, event.stage ?? null, JSON.stringify(event));
    },
    async tail(jobId, limit = 20) {
      return sql.eventTail.all(jobId, limit).map((row) => JSON.parse(row.body)).reverse();
    },
    async remove(jobId) {
      return Number(sql.eventRemove.run(jobId).changes);
    },
  };

  const workers = {
    async heartbeat({ owner, pid, host, stages }) {
      sql.workerBeat.run(owner, pid, host, JSON.stringify(stages), now());
    },
    async remove(owner) {
      sql.workerRemove.run(owner);
    },
    async list() {
      return sql.workerList.all().map((row) => ({ owner: row.owner, pid: row.pid, host: row.host, stages: JSON.parse(row.stages), lastSeen: row.last_seen }));
    },
  };

  const resources = {
    async tryAcquire(resource, capacity, owner, leaseMs) {
      return tx(() => {
        const at = now();
        sql.slotClear.run(resource, at);
        const used = new Set(sql.slotUsed.all(resource).map((row) => row.slot));
        for (let slot = 0; slot < capacity; slot += 1) {
          if (used.has(slot)) continue;
          const token = randomUUID();
          sql.slotTake.run(resource, slot, token, owner, at + leaseMs);
          return { slot, token };
        }
        return null;
      });
    },
    async renew(resource, token, leaseMs) {
      return sql.slotRenew.run(now() + leaseMs, resource, token).changes > 0;
    },
    async release(resource, token) {
      sql.slotFree.run(resource, token);
    },
  };

  return { queue, jobs, events, workers, resources, close: () => db.close() };
}
