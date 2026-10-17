import { describe, expect, it } from 'vitest';
import { LeaseLostError } from '../../src/orchestrator/ports/queue.js';

/**
 * Every port method of a store adapter: queue, jobs, events, workers, resources.
 * @param {string} name
 * @param {(clock) => Promise<{queue: import('../../src/orchestrator/ports/queue.js').StageQueuePort, jobs, events, workers, resources}>} open
 */
export function describeQueueContract(name, open) {
  const msg = (jobId, extra = {}) => ({ jobId, priority: 2, rankAt: 1, payload: { stage: 'naming' }, ...extra });
  const clockAt = (ms) => { const clock = { t: ms, now: () => new Date(clock.t) }; return clock; };
  const job = (id, extra = {}) => ({ id, version: 0, status: 'queued', site: { slug: 'shop', domain: 'shop.example' }, stages: {}, ...extra });

  describe(`${name} queue contract`, () => {
    it('reserves by priority, then rank, and hides a leased message', async () => {
      const clock = clockAt(1000);
      const { queue } = await open(clock);
      await queue.enqueue('stage:naming', msg('a', { priority: 2, rankAt: 1 }));
      await queue.enqueue('stage:naming', msg('b', { priority: 1, rankAt: 5 }));
      const first = await queue.reserve('stage:naming', { leaseMs: 1000, owner: 'w1' });
      expect(first.message.jobId).toBe('b');
      const second = await queue.reserve('stage:naming', { leaseMs: 1000, owner: 'w2' });
      expect(second.message.jobId).toBe('a');
      expect(await queue.reserve('stage:naming', { leaseMs: 1000, owner: 'w3' })).toBeNull();
    });

    it('redelivers after the lease expires and counts the delivery', async () => {
      const clock = clockAt(1000);
      const { queue } = await open(clock);
      await queue.enqueue('stage:naming', msg('a'));
      const lease = await queue.reserve('stage:naming', { leaseMs: 1000, owner: 'w1' });
      clock.t += 1001;
      const again = await queue.reserve('stage:naming', { leaseMs: 1000, owner: 'w2' });
      expect(again.message.deliveries).toBe(2);
      await expect(queue.ack(lease)).rejects.toBeInstanceOf(LeaseLostError);
    });

    it('extends a held lease and refuses to extend a lost one', async () => {
      const clock = clockAt(1000);
      const { queue } = await open(clock);
      await queue.enqueue('stage:naming', msg('a'));
      const lease = await queue.reserve('stage:naming', { leaseMs: 1000, owner: 'w1' });
      clock.t += 900;
      const extended = await queue.extend(lease, 1000);
      expect(extended.expiresAt).toBe(2900);
      clock.t += 900;
      expect(await queue.reserve('stage:naming', { leaseMs: 1000, owner: 'w2' })).toBeNull();
      clock.t += 1000;
      await queue.reserve('stage:naming', { leaseMs: 1000, owner: 'w2' });
      await expect(queue.extend(extended, 1000)).rejects.toBeInstanceOf(LeaseLostError);
    });

    it('respects maxInFlight across owners', async () => {
      const { queue } = await open(clockAt(1000));
      await queue.enqueue('stage:naming', msg('a'));
      await queue.enqueue('stage:naming', msg('b'));
      await queue.reserve('stage:naming', { leaseMs: 1000, owner: 'w1', maxInFlight: 1 });
      expect(await queue.reserve('stage:naming', { leaseMs: 1000, owner: 'w2', maxInFlight: 1 })).toBeNull();
    });

    it('forwards atomically and drops a duplicate open message', async () => {
      const { queue } = await open(clockAt(1000));
      await queue.enqueue('stage:naming', msg('a', { dedupeKey: 'a:naming' }));
      expect((await queue.enqueue('stage:naming', msg('a', { dedupeKey: 'a:naming' }))).deduped).toBe(true);
      const lease = await queue.reserve('stage:naming', { leaseMs: 1000, owner: 'w1' });
      await queue.forward(lease, 'stage:analysis', msg('a', { dedupeKey: 'a:analysis', payload: { stage: 'analysis' } }));
      const [stats] = (await queue.stats()).filter((row) => row.queue === 'stage:analysis');
      expect(stats.ready).toBe(1);
      expect((await queue.stats()).find((row) => row.queue === 'stage:naming').ready).toBe(0);
    });

    it('delays a released message and dead-letters a poison one', async () => {
      const clock = clockAt(1000);
      const { queue } = await open(clock);
      await queue.enqueue('stage:naming', msg('a'));
      const lease = await queue.reserve('stage:naming', { leaseMs: 1000, owner: 'w1' });
      await queue.release(lease, { delayMs: 5000, reason: 'transient' });
      expect((await queue.stats())[0]).toMatchObject({ ready: 0, delayed: 1 });
      expect(await queue.reserve('stage:naming', { leaseMs: 1000, owner: 'w1' })).toBeNull();
      clock.t += 5000;
      for (let i = 0; i < 3; i += 1) {
        await queue.reserve('stage:naming', { leaseMs: 10, owner: 'w1', maxDeliveries: 3 });
        clock.t += 11;
      }
      expect(await queue.reserve('stage:naming', { leaseMs: 10, owner: 'w1', maxDeliveries: 3 })).toBeNull();
      expect((await queue.listDead()).map((row) => row.jobId)).toEqual(['a']);
    });

    it('dead-letters on request and revives a dead message once', async () => {
      const { queue } = await open(clockAt(1000));
      await queue.enqueue('stage:naming', msg('a'));
      const lease = await queue.reserve('stage:naming', { leaseMs: 1000, owner: 'w1' });
      await queue.deadLetter(lease, 'defect');
      const [dead] = await queue.listDead('stage:naming');
      expect(dead.lastError).toBe('defect');
      expect(await queue.listDead('stage:other')).toEqual([]);
      await queue.revive(dead.id);
      await expect(queue.revive(dead.id)).rejects.toThrow(/no dead message/);
      const again = await queue.reserve('stage:naming', { leaseMs: 1000, owner: 'w1' });
      expect(again.message.deliveries).toBe(1);
    });

    it('peeks ready messages in delivery order and reports leases in stats', async () => {
      const { queue } = await open(clockAt(1000));
      await queue.enqueue('stage:naming', msg('low', { priority: 3 }));
      await queue.enqueue('stage:naming', msg('high', { priority: 1 }));
      await queue.enqueue('stage:naming', msg('held', { priority: 0 }));
      await queue.reserve('stage:naming', { leaseMs: 1000, owner: 'w1' });
      expect((await queue.peekReady('stage:naming', 5)).map((row) => row.jobId)).toEqual(['high', 'low']);
      const [stats] = await queue.stats();
      expect(stats.leases).toEqual([expect.objectContaining({ jobId: 'held', owner: 'w1', deliveries: 1 })]);
    });

    it('reprioritizes a job so it overtakes earlier work', async () => {
      const { queue } = await open(clockAt(1000));
      await queue.enqueue('stage:naming', msg('first', { priority: 2, rankAt: 1 }));
      await queue.enqueue('stage:naming', msg('second', { priority: 2, rankAt: 2 }));
      expect(await queue.reprioritize('second', 0)).toBe(1);
      expect(await queue.reprioritize('nobody', 0)).toBe(0);
      const lease = await queue.reserve('stage:naming', { leaseMs: 1000, owner: 'w1' });
      expect(lease.message).toMatchObject({ jobId: 'second', priority: 0 });
    });

    it('discards ready messages, frees the dedupe key, and purges settled ones', async () => {
      const { queue } = await open(clockAt(1000));
      await queue.enqueue('stage:naming', msg('a', { dedupeKey: 'a:naming' }));
      await queue.enqueue('stage:analysis', msg('a', { dedupeKey: 'a:analysis' }));
      await queue.reserve('stage:analysis', { leaseMs: 1000, owner: 'w1' });
      expect(await queue.discard('a', 'cancelled')).toBe(1);
      expect(await queue.reserve('stage:naming', { leaseMs: 1000, owner: 'w1' })).toBeNull();
      expect((await queue.enqueue('stage:naming', msg('a', { dedupeKey: 'a:naming' }))).deduped).toBe(false);
      expect(await queue.purge('a')).toBe(1);
      expect((await queue.stats()).find((row) => row.queue === 'stage:analysis').leased).toBe(1);
    });
  });

  describe(`${name} job store contract`, () => {
    it('creates, reads, and versions a job', async () => {
      const { jobs } = await open(clockAt(1000));
      await jobs.create(job('j1'));
      await expect(jobs.create(job('j1'))).rejects.toThrow();
      const updated = await jobs.update('j1', (draft) => { draft.status = 'running'; });
      expect(updated).toMatchObject({ status: 'running', version: 1 });
      expect(await jobs.get('j1')).toMatchObject({ status: 'running', version: 1 });
      expect(await jobs.get('missing')).toBeNull();
      await expect(jobs.update('missing', () => {})).rejects.toThrow(/no job/);
    });

    it('serializes concurrent updates to one job', async () => {
      const { jobs } = await open(clockAt(1000));
      await jobs.create(job('j1', { count: 0 }));
      await Promise.all(Array.from({ length: 5 }, () => jobs.update('j1', (draft) => { draft.count += 1; })));
      expect(await jobs.get('j1')).toMatchObject({ count: 5, version: 5 });
    });

    it('lists oldest first, filters by status, finds open jobs by domain, and removes', async () => {
      const clock = clockAt(1000);
      const { jobs } = await open(clock);
      await jobs.create(job('old', { status: 'done' }));
      clock.t += 10;
      await jobs.create(job('new'));
      expect((await jobs.list()).map((row) => row.id)).toEqual(['old', 'new']);
      expect((await jobs.list({ status: ['done'] })).map((row) => row.id)).toEqual(['old']);
      expect((await jobs.findOpenByDomain('shop.example')).map((row) => row.id)).toEqual(['new']);
      expect(await jobs.findOpenByDomain('other.example')).toEqual([]);
      expect(await jobs.remove('old')).toBe(true);
      expect(await jobs.remove('old')).toBe(false);
      expect((await jobs.list()).map((row) => row.id)).toEqual(['new']);
    });
  });

  describe(`${name} event, worker, and resource contract`, () => {
    it('appends events, tails the latest in order, and removes them', async () => {
      const { events } = await open(clockAt(1000));
      for (const type of ['a', 'b', 'c']) await events.append('j1', { type });
      await events.append('j2', { type: 'other' });
      expect((await events.tail('j1', 2)).map((event) => event.type)).toEqual(['b', 'c']);
      expect(await events.remove('j1')).toBe(3);
      expect(await events.tail('j1')).toEqual([]);
      expect(await events.tail('j2')).toHaveLength(1);
    });

    it('records worker heartbeats and forgets a removed worker', async () => {
      const clock = clockAt(1000);
      const { workers } = await open(clock);
      await workers.heartbeat({ owner: 'h:1', pid: 1, host: 'h', stages: ['naming'] });
      clock.t += 500;
      await workers.heartbeat({ owner: 'h:1', pid: 1, host: 'h', stages: ['naming', 'analysis'] });
      expect(await workers.list()).toEqual([{ owner: 'h:1', pid: 1, host: 'h', stages: ['naming', 'analysis'], lastSeen: 1500 }]);
      await workers.remove('h:1');
      expect(await workers.list()).toEqual([]);
    });

    it('grants resource slots up to capacity, renews, releases, and reclaims expired slots', async () => {
      const clock = clockAt(1000);
      const { resources } = await open(clock);
      const a = await resources.tryAcquire('chromium', 2, 'w1', 1000);
      const b = await resources.tryAcquire('chromium', 2, 'w2', 1000);
      expect([a.slot, b.slot]).toEqual([0, 1]);
      expect(await resources.tryAcquire('chromium', 2, 'w3', 1000)).toBeNull();
      await resources.release('chromium', a.token);
      expect((await resources.tryAcquire('chromium', 2, 'w3', 1000)).slot).toBe(0);
      expect(await resources.renew('chromium', b.token, 5000)).toBe(true);
      expect(await resources.renew('chromium', 'stale', 5000)).toBe(false);
      clock.t += 1500;
      expect((await resources.tryAcquire('chromium', 2, 'w4', 1000)).slot).toBe(0);
      expect(await resources.tryAcquire('chromium', 2, 'w5', 1000)).toBeNull();
    });
  });
}
