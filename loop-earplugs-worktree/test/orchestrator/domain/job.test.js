import { describe, expect, it } from 'vitest';
import { PRIORITY_RANK, createJob, messageFor, nextStage, queueName, windowFor } from '../../../src/orchestrator/domain/job.js';

const now = new Date('2026-10-13T09:30:00Z');
const resolved = {
  run: {
    id: 'full',
    defaults: {},
    pages: null,
    stages: [
      { id: 'naming', use: 'naming' },
      { id: 'analysis', use: 'analysis' },
    ],
  },
  refs: [{ ref: 'full', file: 'general/runs/full.run.json' }],
  hash: 'abc123',
};

function makeJob() {
  return createJob({
    id: 'job-1',
    site: { slug: 'sayii', domain: 'sayii.com', origin: 'https://sayii.com' },
    pages: [{ url: 'https://sayii.com/', role: 'home' }],
    window: { start: '2026-09-13', end: '2026-10-12' },
    priority: 'normal',
    resilience: 'standard',
    resolved,
    now,
  });
}

describe('createJob', () => {
  it('snapshots the run with provenance and one blank state per stage', () => {
    const job = makeJob();
    expect(job.id).toBe('job-1');
    expect(job.version).toBe(0);
    expect(job.status).toBe('queued');
    expect(job.run).toBe(resolved.run);
    expect(job.provenance).toEqual({ refs: resolved.refs, hash: 'abc123' });
    expect(Object.keys(job.stages)).toEqual(['naming', 'analysis']);
    expect(job.stages.naming).toEqual({
      status: 'pending', attempts: 0, fallbackAttempts: 0,
      startedAt: null, finishedAt: null, recoveredBy: null, note: null, lastError: null,
    });
    expect(job.createdAt).toBe('2026-10-13T09:30:00.000Z');
    expect(job.updatedAt).toBe(job.createdAt);
    expect(job.blocker).toBeNull();
  });
});

describe('queueName', () => {
  it('names the queue after the stage', () => {
    expect(queueName('naming')).toBe('stage:naming');
  });
});

describe('messageFor', () => {
  it('carries the job id, stage, rank, and dedupe key', () => {
    const job = makeJob();
    expect(messageFor(job, job.run.stages[0])).toEqual({
      jobId: 'job-1',
      priority: PRIORITY_RANK.normal,
      rankAt: Date.parse('2026-10-13T09:30:00.000Z'),
      dedupeKey: 'job-1:naming',
      payload: { stage: 'naming' },
    });
  });
});

describe('nextStage', () => {
  it('returns the following stage, then null', () => {
    const job = makeJob();
    expect(nextStage(job, 'naming')).toEqual({ id: 'analysis', use: 'analysis' });
    expect(nextStage(job, 'analysis')).toBeNull();
  });
});

describe('windowFor', () => {
  it('gives 13 Sep - 12 Oct for days:30 on 13 Oct 2026', () => {
    expect(windowFor({ days: 30 }, now)).toEqual({ start: '2026-09-13', end: '2026-10-12' });
  });

  it('defaults to 30 days ending yesterday', () => {
    expect(windowFor({}, now)).toEqual({ start: '2026-09-13', end: '2026-10-12' });
  });

  it('includes today when end is not yesterday', () => {
    expect(windowFor({ days: 7, end: 'today' }, now)).toEqual({ start: '2026-10-07', end: '2026-10-13' });
  });

  it('ends next-weeks on the last Sunday before today and starts at the overlap', () => {
    expect(windowFor({ mode: 'next-weeks' }, now)).toEqual({ mode: 'next-weeks', overlapWeeks: 1, start: '2026-09-28', end: '2026-10-11' });
    expect(windowFor({ mode: 'next-weeks', overlapWeeks: 0 }, now)).toEqual({ mode: 'next-weeks', overlapWeeks: 0, start: '2026-10-05', end: '2026-10-11' });
    expect(windowFor({ mode: 'next-weeks' }, new Date('2026-10-12T09:00:00Z')).end).toBe('2026-10-11');
    expect(windowFor({ mode: 'next-weeks' }, new Date('2026-10-18T09:00:00Z')).end).toBe('2026-10-11');
  });

  it('refuses an unknown mode and a fractional overlap', () => {
    expect(() => windowFor({ mode: 'weekly' }, now)).toThrow(/days or next-weeks/);
    expect(() => windowFor({ mode: 'next-weeks', overlapWeeks: 1.5 }, now)).toThrow(/whole number/);
  });
});
