import { describe, expect, it } from 'vitest';
import { deepMerge, setPath } from '../../../src/orchestrator/domain/deep-merge.js';

describe('deepMerge', () => {
  it('merges objects by key', () => {
    expect(deepMerge({ a: 1, b: { c: 2, d: 3 } }, { b: { c: 9 } })).toEqual({ a: 1, b: { c: 9, d: 3 } });
  });

  it('replaces arrays and scalars', () => {
    expect(deepMerge({ list: [1, 2], n: 1 }, { list: [3], n: 2 })).toEqual({ list: [3], n: 2 });
  });

  it('deletes a key when the patch value is null', () => {
    expect(deepMerge({ a: 1, b: 2 }, { b: null })).toEqual({ a: 1 });
  });

  it('returns the patch when either side is not a plain object', () => {
    expect(deepMerge([1], { a: 1 })).toEqual({ a: 1 });
    expect(deepMerge({ a: 1 }, [1])).toEqual([1]);
    expect(deepMerge({ a: 1 }, undefined)).toEqual({ a: 1 });
  });

  it('does not mutate its inputs', () => {
    const base = { b: { c: 2 } };
    deepMerge(base, { b: { c: 9 } });
    expect(base.b.c).toBe(2);
  });
});

describe('setPath', () => {
  it('sets a dotted path, creating plain objects on the way', () => {
    expect(setPath({}, 'defaults.window.days', 14)).toEqual({ defaults: { window: { days: 14 } } });
  });

  it('addresses a stage in the list by id', () => {
    const run = { stages: [{ id: 'naming', params: {} }, { id: 'analysis' }] };
    const out = setPath(run, 'stages.analysis.params.windowDays', 14);
    expect(out.stages[1].params).toEqual({ windowDays: 14 });
    expect(out.stages[0].params).toEqual({});
    expect(run.stages[1].params).toBeUndefined();
  });

  it('addresses an array element by index', () => {
    expect(setPath({ list: ['a', 'b'] }, 'list.1', 'c')).toEqual({ list: ['a', 'c'] });
  });

  it('errors when the stage id is not in the list', () => {
    expect(() => setPath({ stages: [] }, 'stages.nope.params.x', 1)).toThrow(/--set: no stage nope/);
  });
});
