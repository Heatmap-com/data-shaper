import { describe, expect, it } from 'vitest';
import { applyRunLayer, normalizeEntry, resolveStage } from '../../src/orchestrator/domain/run-descriptor.js';
import { DescriptorError } from '../../src/orchestrator/domain/errors.js';
import { createRunResolver } from '../../src/orchestrator/application/resolve-run.js';

const layer = (run, body) => applyRunLayer(run, body, 'test');

describe('normalizeEntry', () => {
  it('normalizes the string shorthand', () => {
    expect(normalizeEntry('naming')).toEqual({ use: 'naming', id: 'naming', enabled: true });
  });

  it('keeps an explicit id and enabled flag', () => {
    expect(normalizeEntry({ use: 'naming', id: 'naming-2', enabled: false }))
      .toEqual({ use: 'naming', id: 'naming-2', enabled: false });
  });

  it('rejects an entry without use', () => {
    expect(() => normalizeEntry({ id: 'x' })).toThrow(DescriptorError);
  });
});

describe('applyRunLayer', () => {
  it('applies layers root first, later layers win on scalars', () => {
    let run = { stages: [] };
    run = layer(run, { id: 'base', description: 'root' });
    run = layer(run, { id: 'over', description: 'leaf' });
    expect(run.id).toBe('over');
    expect(run.description).toBe('leaf');
  });

  it('deep-merges top-level objects by key', () => {
    let run = { stages: [] };
    run = layer(run, { defaults: { window: { days: 30 }, priority: 'normal' } });
    run = layer(run, { defaults: { window: { days: 7 } } });
    expect(run.defaults).toEqual({ window: { days: 7 }, priority: 'normal' });
  });

  it('replaces arrays and scalars instead of merging them', () => {
    let run = { stages: [] };
    run = layer(run, { defaults: { tags: ['a', 'b'], days: 30 } });
    run = layer(run, { defaults: { tags: ['c'], days: 7 } });
    expect(run.defaults).toEqual({ tags: ['c'], days: 7 });
  });

  it('deletes a key when the patch value is null', () => {
    let run = { stages: [] };
    run = layer(run, { defaults: { window: { days: 30 }, priority: 'normal' } });
    run = layer(run, { defaults: { priority: null } });
    expect(run.defaults).toEqual({ window: { days: 30 } });
  });

  it('replaces the whole stage list when a layer carries stages', () => {
    let run = { stages: [] };
    run = layer(run, { stages: ['naming', 'analysis'] });
    run = layer(run, { stages: ['bundle'] });
    expect(run.stages.map((entry) => entry.id)).toEqual(['bundle']);
  });

  it('applies remove, then patch, then insert, in that order', () => {
    let run = { stages: [] };
    run = layer(run, { stages: ['naming', 'analysis', 'bundle'] });
    run = layer(run, {
      remove: ['bundle'],
      patch: { naming: { params: { seedTimeoutMs: 1 } } },
      insert: [{ after: 'naming', stage: { use: 'remote-enhance' } }],
    });
    expect(run.stages.map((entry) => entry.id)).toEqual(['naming', 'remote-enhance', 'analysis']);
    expect(run.stages[0].params).toEqual({ seedTimeoutMs: 1 });
  });

  it('inserts before an anchor', () => {
    let run = { stages: [] };
    run = layer(run, { stages: ['naming', 'analysis'] });
    run = layer(run, { insert: [{ before: 'analysis', stage: 'bundle' }] });
    expect(run.stages.map((entry) => entry.id)).toEqual(['naming', 'bundle', 'analysis']);
  });

  it('errors when remove names a missing stage', () => {
    const run = layer({ stages: [] }, { stages: ['naming'] });
    expect(() => layer(run, { remove: ['bundle'] })).toThrow(/remove names no stage "bundle"/);
  });

  it('errors when patch names a missing stage', () => {
    const run = layer({ stages: [] }, { stages: ['naming'] });
    expect(() => layer(run, { patch: { bundle: {} } })).toThrow(/patch names no stage "bundle"/);
  });

  it('errors when insert names a missing anchor', () => {
    const run = layer({ stages: [] }, { stages: ['naming'] });
    expect(() => layer(run, { insert: [{ after: 'bundle', stage: 'x' }] })).toThrow(/insert anchor "bundle" is not in the run/);
  });

  it('keeps an enabled:false entry so a later layer can turn it back on', () => {
    let run = { stages: [] };
    run = layer(run, { stages: ['naming', 'analysis'] });
    run = layer(run, { patch: { analysis: { enabled: false } } });
    expect(run.stages.map((entry) => entry.id)).toEqual(['naming', 'analysis']);
    expect(run.stages[1].enabled).toBe(false);
    run = layer(run, { patch: { analysis: { enabled: true } } });
    expect(run.stages[1].enabled).toBe(true);
  });

  it('errors on a duplicate stage id', () => {
    expect(() => layer({ stages: [] }, { stages: ['naming', { use: 'analysis', id: 'naming' }] }))
      .toThrow(/stage id "naming" appears twice/);
  });
});

describe('resolveStage', () => {
  it('deep-merges the entry over its library descriptor', () => {
    const library = { id: 'naming', label: 'Name', retry: { maxAttempts: 2 }, params: { a: 1 } };
    const entry = { use: 'naming', id: 'naming', enabled: true, params: { b: 2 } };
    expect(resolveStage(library, entry)).toEqual({
      id: 'naming', use: 'naming', label: 'Name', retry: { maxAttempts: 2 }, params: { a: 1, b: 2 },
    });
  });
});

describe('enabled:false at the end of resolution', () => {
  const resolver = createRunResolver({
    descriptors: {
      run: async (scope, name) => ({
        base: { body: { id: 'base', stages: ['naming', 'analysis'] }, file: 'mem/base.run.json' },
        over: { body: { id: 'over', extends: 'base', patch: { analysis: { enabled: false } } }, file: 'mem/over.run.json' },
      })[name] ?? null,
      runFile: async () => { throw new Error('unused'); },
      stage: async (id) => ({ id }),
    },
  });

  it('drops disabled entries after the last layer', async () => {
    const { run } = await resolver.resolve({ site: { slug: 'sayii' }, ref: 'general:over' });
    expect(run.stages.map((stage) => stage.id)).toEqual(['naming']);
  });
});
