import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createMemoryAePersistence } from '../src/adapters/persistence/memory.js';
import { segmentationCheck } from '../src/application/commands/segmentation-check.js';
import { main } from '../src/cli.js';
import { hasClickHouseLocal } from './domain/clickhouse-local.js';
import { createLocalWarehouse } from './support/local-warehouse.js';
import { variedWarehouseRows } from './support/segmentation-fixture.js';
import { SHIPPED, withSites } from './support/segmentations.js';
import { IDSITE } from './support/site-fixture.js';

const WEEK = '2026-09-07';
const GOOGLE_PAID = { value: 'google_paid', when: { all: [{ field: 'referer_type', in: [2, 6] }, { field: 'utm_medium', eq: 'cpc' }] } };
const dirs = [];

afterEach(() => {
  process.exitCode = undefined;
  while (dirs.length > 0) rmSync(dirs.pop(), { recursive: true, force: true });
});

function file(value) {
  const dir = mkdtempSync(path.join(tmpdir(), 'segmentation-check-'));
  dirs.push(dir);
  const name = path.join(dir, 'segmentations.json');
  writeFileSync(name, JSON.stringify(value));
  return name;
}

/** The context the check reads: the registry, a swap for one site file, the gateway, and the stored versions. */
function contextFor(gateway, persistence = createMemoryAePersistence().adapter) {
  const labels = [];
  return {
    labels,
    ctx: {
      segmentations: async () => SHIPPED,
      segmentationsWith: async (site) => withSites([site]),
      registries: { segmentations: async () => [] },
      gateway: () => ({
        async query(sql, params, label) {
          labels.push(label);
          return gateway.query(sql, params, label);
        },
      }),
      persistence: () => persistence,
    },
  };
}

describe.skipIf(!hasClickHouseLocal())('--segmentation-check', () => {
  const gateway = createLocalWarehouse(variedWarehouseRows());

  it('passes each shipped declared segmentation on the fixture and writes nothing', async () => {
    const { adapter: persistence, snapshot } = createMemoryAePersistence();
    for (const id of ['traffic_source', 'channel', 'returning', 'buyer', 'rager']) {
      const { ctx, labels } = contextFor(gateway, persistence);
      const result = await segmentationCheck.run({ 'segmentation-check': 'true', sites: String(IDSITE), week: WEEK, segmentation: id }, ctx);
      expect(result.ok, `${id}: ${result.errors?.join('; ')}`).toBe(true);
      expect(result.output).toContain(`${id}: version 1, nothing stored`);
      expect(result.output).toMatch(/partition: (\d+) of \1 sessions/);
      expect(labels).toEqual(['trend:segmentation-check']);
    }
    expect(snapshot().segmentationDefinitions ?? []).toEqual([]);
  }, 60_000);

  it('checks a site file override and reports the version it would get', async () => {
    const { adapter: persistence } = createMemoryAePersistence();
    const shipped = SHIPPED.forSite(IDSITE).get('channel');
    await persistence.writeSegmentationDefinitions([{ idsite: IDSITE, segmentation: 'channel', version: 1, kind: 'declared', stamp: shipped.stamp({}), definition: {}, values: [...shipped.values] }]);
    const { ctx } = contextFor(gateway, persistence);
    const flags = { 'segmentation-check': 'true', sites: String(IDSITE), week: WEEK, 'segmentation-file': file({ idsite: IDSITE, overrides: { channel: { prepend: [GOOGLE_PAID] } } }) };
    const result = await segmentationCheck.run(flags, ctx);
    expect(result.ok, result.errors?.join('; ')).toBe(true);
    expect(result.output).toContain('channel: version 2 would replace stored version 1');
    expect(result.output).toMatch(/google_paid\s+\d+/);
  }, 60_000);

  it('checks one declaration as the site\'s new one', async () => {
    const { ctx } = contextFor(gateway);
    const declaration = { id: 'paid_search', label: 'Paid search', purpose: 'P', data: 'D', rules: [GOOGLE_PAID], fallback: 'unpaid' };
    const result = await segmentationCheck.run({ 'segmentation-check': 'true', sites: String(IDSITE), week: WEEK, 'segmentation-file': file(declaration) }, ctx);
    expect(result.ok, result.errors?.join('; ')).toBe(true);
    expect(result.output).toMatch(/paid_search: version 1, nothing stored/);
  }, 60_000);

  it('fails with exit 1 on an override that puts every session in one value', async () => {
    const { ctx } = contextFor(gateway);
    const everything = { value: 'direct', when: { field: 'referer_type', ne: 99 } };
    const flags = { 'segmentation-check': 'true', sites: String(IDSITE), week: WEEK, 'segmentation-file': file({ idsite: IDSITE, overrides: { channel: { prepend: [everything] } } }) };
    const result = await segmentationCheck.run(flags, ctx);
    expect(result).toMatchObject({ ok: false, exitCode: 1 });
    expect(result.errors).toEqual([expect.stringMatching(/channel: direct holds 100\.0% of sessions/)]);
    expect(result.output).toContain('channel:');
  }, 60_000);
});

describe('--segmentation-check validation', () => {
  const run = (flags) => segmentationCheck.run({ 'segmentation-check': 'true', ...flags }, contextFor({ query: async () => { throw new Error('no query'); } }).ctx);

  it('exits 2 on a usage error and 1 on a bad declaration, before any query', async () => {
    expect(await run({ sites: '1', week: WEEK })).toMatchObject({ ok: false, exitCode: 2, errors: [expect.stringMatching(/one of --segmentation <id> or --segmentation-file/), expect.any(String)] });
    expect(await run({ sites: '1', week: '2026-09-08', segmentation: 'channel' })).toMatchObject({ exitCode: 2, errors: [expect.stringMatching(/not a Monday/), expect.any(String)] });
    expect(await run({ week: WEEK, segmentation: 'channel' })).toMatchObject({ exitCode: 2 });
    expect(await run({ sites: '1', week: WEEK, segmentation: 'tiktok' })).toMatchObject({ exitCode: 1, errors: [expect.stringMatching(/unknown segmentation "tiktok"/)] });
    const bad = file({ idsite: 1, overrides: { channel: { prepend: [{ value: 'x', when: { field: 'nope', eq: 1 } }] } } });
    expect(await run({ sites: '1', week: WEEK, 'segmentation-file': bad })).toMatchObject({ exitCode: 1, errors: [expect.stringMatching(/nope/)] });
    const other = file({ idsite: 2, overrides: {} });
    expect(await run({ sites: '1', week: WEEK, 'segmentation-file': other })).toMatchObject({ exitCode: 1, errors: [expect.stringMatching(/idsite 2 is not --sites 1/)] });
  });

  it('sets the process exit code the command gives', async () => {
    await main(['--segmentation-check', '--sites', '1', '--week', WEEK]);
    expect(process.exitCode).toBe(2);
  });
});
