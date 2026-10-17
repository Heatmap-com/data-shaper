import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discoverAdapterRoles, discoverAdapters, discoverDatasets, mountAdapters, selectAdapter } from '../src/discover.js';

let dir;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'discover-test-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const ADAPTER_A = `export const adapter = { id: 'a', ping: () => 'a' };\n`;
const ADAPTER_B = `export const adapter = { id: 'b', ping: () => 'b' };\n`;

/** @param {string} name @param {string} source @param {{id: string, purpose: string, data: string} | {adapters: object[]}} descriptor */
async function writeAdapter(name, source, descriptor) {
  await writeFile(path.join(dir, name), source);
  const descriptorName = name.replace(/\.js$/, '.descriptor.json');
  await writeFile(path.join(dir, descriptorName), `${JSON.stringify(descriptor, null, 2)}\n`);
}

/** @param {string} id */
function described(id) {
  return { id, purpose: `Answers ${id}.`, data: `One row per ${id}.` };
}

/** @param {string} id */
function dataset(id) {
  return { ...described(id), replay: 'keep' };
}

describe('discoverAdapters', () => {
  it('loads two adapters from a fixture directory and reads purpose from the descriptor', async () => {
    await writeAdapter('a.js', ADAPTER_A, described('a'));
    await writeAdapter('b.js', ADAPTER_B, described('b'));
    const adapters = await discoverAdapters(dir);
    expect(adapters.map((a) => a.id)).toEqual(['a', 'b']);
    expect(adapters[0].purpose).toBeUndefined();
    expect(adapters[0].descriptor).toEqual(described('a'));
  });

  it('a duplicate id throws and names the ids', async () => {
    await writeAdapter('one.js', ADAPTER_A, described('a'));
    await writeAdapter('two.js', ADAPTER_A, described('a'));
    await expect(discoverAdapters(dir)).rejects.toThrow(/duplicate adapter id "a"/);
  });

  it('a missing id throws', async () => {
    await writeFile(path.join(dir, 'broken.js'), `export const adapter = {};\n`);
    await expect(discoverAdapters(dir)).rejects.toThrow(/missing a string `id`/);
  });

  it('a missing export throws', async () => {
    await writeFile(path.join(dir, 'empty.js'), `export const nothing = 1;\n`);
    await expect(discoverAdapters(dir)).rejects.toThrow(/expected an exported `adapter`/);
  });

  it('ignores underscore files and test files', async () => {
    await writeAdapter('a.js', ADAPTER_A, described('a'));
    await writeFile(path.join(dir, '_helper.js'), `export const adapter = { id: 'helper' };\n`);
    await writeFile(path.join(dir, 'a.test.js'), `export const adapter = { id: 'test' };\n`);
    const adapters = await discoverAdapters(dir);
    expect(adapters.map((a) => a.id)).toEqual(['a']);
  });

  it('a dataset file added to the fixture appears with no edit to the loader', async () => {
    await writeAdapter('a.js', ADAPTER_A, described('a'));
    const before = await discoverAdapters(dir);
    expect(before.map((a) => a.id)).toEqual(['a']);
    await writeAdapter('c.js', `export const adapter = { id: 'c' };\n`, described('c'));
    const after = await discoverAdapters(dir);
    expect(after.map((a) => a.id)).toEqual(['a', 'c']);
  });

  it('a missing descriptor throws and names the file', async () => {
    await writeFile(path.join(dir, 'bare.js'), `export const adapter = { id: 'bare' };\n`);
    await expect(discoverAdapters(dir)).rejects.toThrow(/missing bare\.descriptor\.json/);
  });

  it('a purpose hardcoded on the adapter throws', async () => {
    await writeAdapter(
      'hard.js',
      `export const adapter = { id: 'hard', purpose: 'In the module.' };\n`,
      described('hard'),
    );
    await expect(discoverAdapters(dir)).rejects.toThrow(/hardcodes purpose or data/);
  });

  it('a descriptor without a purpose throws and names the adapter', async () => {
    await writeFile(path.join(dir, 'bare.js'), `export const adapter = { id: 'bare' };\n`);
    await writeFile(path.join(dir, 'bare.descriptor.json'), JSON.stringify({ id: 'bare', data: 'Rows.' }));
    await expect(discoverAdapters(dir)).rejects.toThrow(/"bare" is missing a human-readable purpose/);
  });

  it('discovers in filename order', async () => {
    await writeAdapter('z.js', `export const adapter = { id: 'z' };\n`, described('z'));
    await writeAdapter('m.js', `export const adapter = { id: 'm' };\n`, described('m'));
    const adapters = await discoverAdapters(dir);
    expect(adapters.map((a) => a.id)).toEqual(['m', 'z']);
  });
});

describe('discoverDatasets', () => {
  const DEP_A = `export const adapter = { id: 'a', dependsOn: [], collect: async () => ({ id: 'a', rows: [] }) };\n`;
  const DEP_B = `export const adapter = { id: 'b', dependsOn: ['a'], collect: async () => ({ id: 'b', rows: [] }) };\n`;

  it('topologically sorts on dependsOn regardless of filename order', async () => {
    await writeAdapter('b.js', DEP_B, dataset('b'));
    await writeAdapter('a.js', DEP_A, dataset('a'));
    const datasets = await discoverDatasets(dir);
    expect(datasets.map((d) => d.id)).toEqual(['a', 'b']);
  });

  it('a missing dependency fails startup and names the ids', async () => {
    await writeAdapter('b.js', DEP_B, dataset('b'));
    await expect(discoverDatasets(dir)).rejects.toThrow(/"b" depends on missing dataset "a"/);
  });

  it('a cycle fails startup and names the ids', async () => {
    await writeAdapter('a.js', `export const adapter = { id: 'a', dependsOn: ['b'] };\n`, dataset('a'));
    await writeAdapter('b.js', DEP_B, dataset('b'));
    await expect(discoverDatasets(dir)).rejects.toThrow(/dependency cycle: (a -> b -> a|b -> a -> b)/);
  });

  it('a dataset descriptor without a replay mode fails startup and names the id', async () => {
    await writeAdapter('a.js', DEP_A, described('a'));
    await expect(discoverDatasets(dir)).rejects.toThrow(/without a replay mode in their descriptor: a/);
  });

  it('a replay mode outside keep, restamp, and recollect fails startup', async () => {
    await writeAdapter('a.js', DEP_A, { ...described('a'), replay: 'skip' });
    await expect(discoverDatasets(dir)).rejects.toThrow(/"a" has replay "skip"; expected one of keep, restamp, recollect/);
  });

  it('a card descriptor without a catalogId fails startup', async () => {
    await writeAdapter('a.js', DEP_A, { ...dataset('a'), role: 'card' });
    await expect(discoverDatasets(dir)).rejects.toThrow(/card adapter "a" is missing a catalogId/);
  });

  it('a role outside card and requirements fails startup', async () => {
    await writeAdapter('a.js', DEP_A, { ...dataset('a'), role: 'gate' });
    await expect(discoverDatasets(dir)).rejects.toThrow(/"a" has role "gate"; expected one of card, requirements/);
  });

  it('carries the replay mode onto the descriptor', async () => {
    await writeAdapter('a.js', DEP_A, { ...described('a'), replay: 'restamp' });
    const [a] = await discoverDatasets(dir);
    expect(a.descriptor).toEqual({ ...described('a'), replay: 'restamp' });
  });
});

describe('mountAdapters', () => {
  it('logs each adapter with its purpose', () => {
    /** @type {Array<object>} */
    const lines = [];
    mountAdapters(
      { info(fields, message) { lines.push({ fields, message }); } },
      [{
        role: 'importance',
        adapters: [{
          id: 'buttons-and-links',
          descriptor: { id: 'buttons-and-links', purpose: 'Treats every button and every link as important.', data: 'One element per control.' },
        }],
      }],
    );
    expect(lines).toEqual([
      {
        fields: {
          role: 'importance',
          id: 'buttons-and-links',
          purpose: 'Treats every button and every link as important.',
          data: 'One element per control.',
        },
        message: 'mounted importance adapter buttons-and-links: Treats every button and every link as important.',
      },
    ]);
  });

  it('discovers every adapter role, including a folder added without a loader edit', async () => {
    const roles = await discoverAdapterRoles(path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/adapters'));
    const names = roles.map((role) => role.role);
    expect(names).toEqual(expect.arrayContaining([
      'datasets', 'descriptor-sources', 'importance', 'page-selectors', 'persistence', 'qualifiers', 'session-tag-selectors', 'site-sources', 'telemetry',
    ]));
    const importance = roles.find((role) => role.role === 'importance');
    expect(importance.adapters.map((adapter) => adapter.id)).toContain('buttons-and-links');
    for (const role of roles) {
      for (const adapter of role.adapters) {
        expect(adapter.purpose, adapter.id).toBeUndefined();
        expect(adapter.descriptor.purpose.length, adapter.id).toBeGreaterThan(0);
        expect(adapter.descriptor.data.length, adapter.id).toBeGreaterThan(0);
      }
    }
  });

  it('names each card dataset after its catalog and holds one requirements dataset', async () => {
    const roles = await discoverAdapterRoles(path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/adapters'));
    const datasets = roles.find((role) => role.role === 'datasets').adapters;
    const cards = datasets.filter((d) => d.descriptor.role === 'card');
    expect(cards.map((d) => d.descriptor.catalogId).sort()).toEqual(['FN', 'JR', 'LP', 'PG', 'PI', 'PO', 'QZ', 'TD', 'TG', 'TI', 'XP']);
    for (const card of cards) expect(card.id).toBe(`cards-${card.descriptor.catalogId.toLowerCase()}`);
    expect(datasets.filter((d) => d.descriptor.role === 'requirements').map((d) => d.id)).toEqual(['requirement-status']);
  });
});

describe('selectAdapter', () => {
  const adapters = [{ id: 'x' }, { id: 'y' }];

  it('selects by env value', () => {
    expect(selectAdapter(adapters, 'y', 'TEST_ENV').id).toBe('y');
  });

  it('an unknown id fails and prints the discovered ids', () => {
    expect(() => selectAdapter(adapters, 'nope', 'TEST_ENV')).toThrow(/unknown TEST_ENV="nope"; discovered ids: x, y/);
  });

  it('an unset env fails and prints the discovered ids', () => {
    expect(() => selectAdapter(adapters, undefined, 'TEST_ENV')).toThrow(/TEST_ENV is not set; discovered ids: x, y/);
  });
});
