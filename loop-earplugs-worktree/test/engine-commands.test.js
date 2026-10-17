import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createMemoryAePersistence } from '../src/adapters/persistence/memory.js';
import { parseFlags } from '../src/application/commands/args.js';
import { COMMANDS, findCommand } from '../src/application/commands/index.js';
import { toolRegistryImport } from '../src/application/commands/imports.js';
import { main } from '../src/cli.js';

/**
 * The engine commands behind src/cli.js: flag parsing, the dispatch order
 * the old if-chain had, flag validation that fails before any connection,
 * and the tool-registry import run against a fake context.
 */

const SEED = JSON.parse(readFileSync(new URL('../src/catalog/tool-registry.seed.json', import.meta.url), 'utf8'));
const tempDirs = [];

afterEach(() => {
  process.exitCode = undefined;
  while (tempDirs.length > 0) rmSync(tempDirs.pop(), { recursive: true, force: true });
});

function tempJson(value) {
  const dir = mkdtempSync(path.join(tmpdir(), 'engine-commands-'));
  tempDirs.push(dir);
  const file = path.join(dir, 'input.json');
  writeFileSync(file, JSON.stringify(value));
  return file;
}

/** The part of the engine context the tool-registry import uses. */
function fakeContext({ existing = [] } = {}) {
  const memory = createMemoryAePersistence();
  const queries = [];
  const ensured = [];
  return {
    memory,
    queries,
    ensured,
    ctx: {
      injected: { persistence: memory.adapter, gateway: null },
      async ensure(...names) {
        ensured.push(...names);
      },
      persistence: () => memory.adapter,
      gateway: () => ({
        async query(sql, params, label) {
          queries.push({ params, label });
          return existing.filter((row) => row.idsite === params.idsite);
        },
      }),
    },
  };
}

describe('parseFlags', () => {
  it('reads values, bare flags, and a bare flag followed by another flag', () => {
    expect(parseFlags(['--run', '--batch', 'b1', '--dry-run'])).toEqual({ run: 'true', batch: 'b1', 'dry-run': 'true' });
  });
});

describe('command dispatch', () => {
  const pick = (argv) => findCommand(parseFlags(argv))?.flag ?? null;

  it('keeps the old precedence: replay and run before batch creation', () => {
    expect(pick(['--replay', '--batch', 'b1', '--sites', '1'])).toBe('replay');
    expect(pick(['--run', '--batch', 'b1'])).toBe('run');
    expect(pick(['--batch', '--sites', '1,2'])).toBe('batch');
    expect(pick(['--descriptor-import', 'f.json', '--audit'])).toBe('descriptor-import');
    expect(pick(['--sites', '1'])).toBeNull();
  });

  it('every command has a distinct flag and a usage line', () => {
    const flags = COMMANDS.map((command) => command.flag);
    expect(new Set(flags).size).toBe(flags.length);
    for (const command of COMMANDS) expect(command.usage).toContain(`--${command.flag}`);
  });

  it('main rejects an argv with no command, naming every usage', async () => {
    await expect(main(['--sites', '1'])).rejects.toThrow(/usage: node src\/cli\.js \(--descriptor-import/);
  });

  it('main rejects bad trend and run flags before any database work', async () => {
    const deps = { telemetry: { close: async () => {} } };
    await expect(main(['--trend', '--sites', '1,2'], deps)).rejects.toThrow('--trend requires --sites with one idsite');
    await expect(main(['--tag-trend', '--sites', '1', '--window-start', '2026-10-09', '--window-end', '2026-10-01'], deps)).rejects.toThrow(
      '--window-start must be on or before --window-end',
    );
    await expect(main(['--trend', '--sites', '1', '--next-weeks', '--window-start', '2026-10-01'], deps)).rejects.toThrow(
      '--trend takes --next-weeks or --window-start and --window-end, not both',
    );
    await expect(main(['--tag-trend', '--sites', '1', '--next-weeks', '--overlap-weeks', '-1'], deps)).rejects.toThrow(
      '--overlap-weeks must be a whole number',
    );
    await expect(main(['--run'], deps)).rejects.toThrow('--run requires --batch <batch_id>');
    await expect(main(['--batch', '--catalogs', 'NOPE'], deps)).rejects.toThrow(/unknown catalogs: NOPE/);
  });

  it('main rejects an unknown or misplaced segmentation before any database work', async () => {
    const deps = { telemetry: { close: async () => {} }, client: { query: () => { throw new Error('no query expected'); } } };
    const span = ['--window-start', '2026-09-07', '--window-end', '2026-09-20'];
    await expect(main(['--trend', '--sites', '1', ...span, '--segmentations', 'buyer,tiktok'], deps)).rejects.toThrow(
      /--trend --segmentations: idsite 1: unknown segmentation "tiktok" \(buyer, channel, link_channel, rager, returning, traffic_source, return_intent\)/,
    );
    await expect(main(['--trend', '--sites', '1', ...span, '--segmentations'], deps)).rejects.toThrow('--trend --segmentations needs a list of ids');
    await expect(main(['--tag-trend', '--sites', '1', ...span, '--segmentations', 'channel,channel'], deps)).rejects.toThrow(/channel is selected twice/);
  });

  it('main rejects a bad site segmentation file before any database work', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'engine-commands-'));
    tempDirs.push(root);
    mkdirSync(path.join(root, 'sites', 'alpha'), { recursive: true });
    writeFileSync(path.join(root, 'sites', 'alpha', 'segmentations.json'), JSON.stringify({ idsite: 1, overrides: { channel: { remove: ['nope'] } } }));
    const previous = process.env.ORCHESTRATION_ROOT;
    process.env.ORCHESTRATION_ROOT = root;
    try {
      const deps = { telemetry: { close: async () => {} }, client: { query: () => { throw new Error('no query expected'); } } };
      await expect(main(['--trend', '--sites', '1', '--window-start', '2026-09-07', '--window-end', '2026-09-20'], deps)).rejects.toThrow(
        /sites\/alpha\/segmentations.json: override of channel: .*nope/,
      );
    } finally {
      if (previous === undefined) delete process.env.ORCHESTRATION_ROOT;
      else process.env.ORCHESTRATION_ROOT = previous;
    }
  });
});

describe('--tool-registry-import', () => {
  it('validates against the current registry and reports a dry run without writing', async () => {
    const { ctx, memory, queries, ensured } = fakeContext();
    const result = await toolRegistryImport.run({ 'tool-registry-import': tempJson(SEED), 'dry-run': 'true' }, ctx);
    expect(result.ok).toBe(true);
    expect(result.output).toMatchObject({ rows: SEED.length, existing: 0, dry_run: true });
    expect(ensured).toEqual(['ae', 'v1']);
    expect(queries.map((q) => q.label)).toEqual([...new Set(SEED.map((r) => r.idsite))].map(() => 'tool-registry-import:existing'));
    expect(memory.snapshot().toolRegistry).toEqual([]);
  });

  it('writes the rows', async () => {
    const { ctx, memory } = fakeContext();
    const result = await toolRegistryImport.run({ 'tool-registry-import': tempJson(SEED) }, ctx);
    expect(result.output).toMatchObject({ rows: SEED.length, written: SEED.length });
    expect(memory.snapshot().toolRegistry).toHaveLength(SEED.length);
  });

  it('refuses a row that collides with a seeded row', async () => {
    const changed = { ...SEED[0], vendor: `${SEED[0].vendor} Changed` };
    const { ctx, memory } = fakeContext({ existing: [SEED[0]] });
    await expect(toolRegistryImport.run({ 'tool-registry-import': tempJson([changed]) }, ctx)).rejects.toThrow();
    expect(memory.snapshot().toolRegistry).toEqual([]);
  });
});
