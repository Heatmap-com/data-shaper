import { beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { createRunResolver } from '../../src/orchestrator/application/resolve-run.js';
import { createFsDescriptorSource } from '../../src/orchestrator/adapters/descriptors/fs.js';
import { DescriptorError } from '../../src/orchestrator/domain/errors.js';

const root = path.join(import.meta.dirname, 'fixtures', 'descriptors');
const descriptors = createFsDescriptorSource({ root });
const resolver = createRunResolver({ descriptors });

let site;
beforeAll(async () => {
  site = await descriptors.site('sayii');
});

const ids = ({ run }) => run.stages.map((stage) => stage.id);

describe('resolve-run selection', () => {
  it('uses the general run for an explicit general: ref, even when the site has its own', async () => {
    const resolved = await resolver.resolve({ site, ref: 'general:full' });
    expect(ids(resolved)).toEqual(['naming', 'analysis']);
    expect(resolved.refs.map((ref) => ref.ref)).toEqual(['full']);
  });

  it('uses the site run for an explicit site: ref', async () => {
    const resolved = await resolver.resolve({ site, ref: 'site:full' });
    expect(ids(resolved)).toEqual(['naming']);
    expect(resolved.refs.map((ref) => ref.ref)).toEqual(['full', 'full']);
    const naming = resolved.run.stages[0];
    expect(naming.params).toEqual({ seedTimeoutMs: 1200000 });
  });

  it('errors for an explicit site: ref that does not exist', async () => {
    await expect(resolver.resolve({ site, ref: 'site:nope' })).rejects.toThrow(DescriptorError);
    await expect(resolver.resolve({ site, ref: 'site:nope' })).rejects.toThrow(/no run descriptor site:nope for sayii/);
  });

  it('prefers the site run for a bare name', async () => {
    const resolved = await resolver.resolve({ site, ref: 'full' });
    expect(ids(resolved)).toEqual(['naming']);
  });

  it('falls back to the general run for a bare name the site does not have', async () => {
    const resolved = await resolver.resolve({ site, ref: 'default' });
    expect(ids(resolved)).toEqual(['naming', 'analysis']);
    expect(resolved.refs).toHaveLength(1);
  });

  it('reads an explicit .json file with its own extends chain', async () => {
    const file = path.join(import.meta.dirname, 'fixtures', 'file-level.run.json');
    const resolved = await resolver.resolve({ site, ref: file });
    expect(resolved.run.id).toBe('file-level');
    expect(ids(resolved)).toEqual(['naming', 'analysis']);
    expect(resolved.run.stages[0].params).toEqual({ seedTimeoutMs: 60000 });
    expect(resolved.refs.map((ref) => ref.ref)).toEqual(['full', 'file-level']);
  });

  it('errors on an extends cycle', async () => {
    await expect(resolver.resolve({ site, ref: 'general:loop-a' })).rejects.toThrow(/run extends cycle/);
  });

  it('errors when the extends chain is more than 8 deep', async () => {
    await expect(resolver.resolve({ site, ref: 'general:chain-1' })).rejects.toThrow(/run extends more than 8 deep/);
  });

  it('applies --set as the last layer, including setPath into stages.<id>.params', async () => {
    const resolved = await resolver.resolve({
      site,
      ref: 'general:full',
      sets: [['stages.naming.params.seedTimeoutMs', 14], ['defaults.priority', 'high']],
    });
    expect(resolved.run.stages[0].params).toEqual({ seedTimeoutMs: 14 });
    expect(resolved.run.defaults.priority).toBe('high');
  });

  it('applies the site stage params over the run, and --set over the site', async () => {
    const withParams = { ...site, stageParams: { naming: { seedTimeoutMs: 5, profile: 'pdp' } } };
    const bySite = await resolver.resolve({ site: withParams, ref: 'general:full' });
    expect(bySite.run.stages[0].params).toMatchObject({ seedTimeoutMs: 5, profile: 'pdp' });
    const bySet = await resolver.resolve({ site: withParams, ref: 'general:full', sets: [['stages.naming.params.seedTimeoutMs', 14]] });
    expect(bySet.run.stages[0].params).toMatchObject({ seedTimeoutMs: 14, profile: 'pdp' });
  });

  it('reads the site profile as the analysis stage profile, under its stage params', async () => {
    const resolved = await resolver.resolve({ site: { ...site, profile: 'pdp' }, ref: 'general:full' });
    expect(resolved.run.stages.find((entry) => entry.id === 'analysis').params).toMatchObject({ profile: 'pdp' });
    const both = await resolver.resolve({ site: { ...site, profile: 'pdp', stageParams: { analysis: { profile: 'quiz' } } }, ref: 'general:full' });
    expect(both.run.stages.find((entry) => entry.id === 'analysis').params).toMatchObject({ profile: 'quiz' });
  });

  it('leaves a run without the stage as it is', async () => {
    const plain = await resolver.resolve({ site, ref: 'general:full' });
    const other = await resolver.resolve({ site: { ...site, stageParams: { trend: { days: 7 } } }, ref: 'general:full' });
    expect(other.run).toEqual(plain.run);
  });

  it('snapshots provenance with a stable hash', async () => {
    const one = await resolver.resolve({ site, ref: 'general:full' });
    const two = await resolver.resolve({ site, ref: 'general:full' });
    expect(one.hash).toBe(two.hash);
    expect(one.hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
