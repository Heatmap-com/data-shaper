import { describe, expect, it } from 'vitest';
import { createStore } from '../../src/orchestrator/adapters/queue/memory.js';
import { createGovernor } from '../../src/orchestrator/application/governor.js';
import { capacityOf, capacityProblem } from '../../src/orchestrator/domain/capacity.js';
import { sleep } from '../../src/orchestrator/application/util.js';

const capacity = { chromium: { limit: 1, scope: 'machine' }, 'clickhouse-heavy': 1 };

function governors() {
  const { resources } = createStore();
  const on = (host) => createGovernor({ resources, capacity, leaseMs: 2000, sleep, pollMs: 10, host });
  return { a: on('mac-a'), b: on('mac-b'), a2: on('mac-a') };
}

async function overlaps(first, second, resource) {
  let release;
  const holding = new Promise((resolve) => { release = resolve; });
  let entered;
  const inside = new Promise((resolve) => { entered = resolve; });
  const one = first.withResources([resource], 'w1', undefined, async () => { entered(); await holding; });
  await inside;
  let secondRan = false;
  const two = second.withResources([resource], 'w2', undefined, async () => { secondRan = true; });
  await new Promise((resolve) => setTimeout(resolve, 60));
  const concurrent = secondRan;
  release();
  await Promise.all([one, two]);
  return concurrent;
}

describe('governor resource scope', () => {
  it('reads a number as a cluster-wide limit and an object as written', () => {
    expect(capacityOf(2)).toEqual({ limit: 2, scope: 'cluster' });
    expect(capacityOf({ limit: 1, scope: 'machine' })).toEqual({ limit: 1, scope: 'machine' });
    expect(capacityOf(undefined)).toEqual({ limit: 0, scope: 'cluster' });
  });

  it('names a misspelled scope and a bad limit', () => {
    expect(capacityProblem({ limit: 1, scope: 'machnie' })).toBe('has scope "machnie"; use machine or cluster');
    expect(capacityProblem(0)).toMatch(/whole-number limit/);
    expect(capacityProblem({ scope: 'machine' })).toMatch(/whole-number limit/);
    expect(capacityProblem(1.5)).toMatch(/whole-number limit/);
    expect(capacityProblem(undefined)).toBe('has no capacity');
    expect(capacityProblem({ limit: 2, scope: 'machine' })).toBeNull();
  });

  it('refuses to lease a resource whose scope is misspelled', async () => {
    const { resources } = createStore();
    const governor = createGovernor({ resources, capacity: { chromium: { limit: 1, scope: 'machnie' } }, leaseMs: 2000, sleep, pollMs: 10 });
    await expect(governor.withResources(['chromium'], 'w', null, async () => 'ran')).rejects.toThrow('resource "chromium" has scope "machnie"');
  });

  it('gives each machine its own chromium slot', async () => {
    const { a, b } = governors();
    expect(await overlaps(a, b, 'chromium')).toBe(true);
  });

  it('serializes chromium on one machine', async () => {
    const { a, a2 } = governors();
    expect(await overlaps(a, a2, 'chromium')).toBe(false);
  });

  it('serializes clickhouse-heavy across machines', async () => {
    const { a, b } = governors();
    expect(await overlaps(a, b, 'clickhouse-heavy')).toBe(false);
  });
});
