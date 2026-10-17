import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { qualityDecide } from '../../src/application/commands/quality-decide.js';
import { shape } from '../../src/application/commands/shape.js';
import { createShapingRegistry } from '../../src/application/shaping/registry.js';
import { loadAttributeCatalog } from '../../src/catalog/attributes.js';
import { loadSourceKinds } from '../../src/catalog/sources.js';
import { loadQualityRegistry } from '../../src/composition/quality.js';
import { checkPeriod } from '../../src/domain/shaping/period.js';
import { qualityOrdersSql } from '../../src/enrichment/quality-sql.js';
import { queryBoundGaps } from '../../src/governance/query-bounds.js';
import { addDays } from '../../src/domain/shaping/dates.js';
import { hasClickHouseLocal } from '../domain/clickhouse-local.js';
import { createLocalWarehouse } from '../support/local-warehouse.js';
import { SHIPPED } from '../support/segmentations.js';
import { FIRST_DAY, LAST_DAY, SHAPE_SITE, shapingRows } from '../support/shaping-fixture.js';

const TODAY = '2026-10-14';
const ATTRIBUTES = loadAttributeCatalog();
const dirs = [];
const tempDir = (prefix) => {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};
afterAll(() => {
  while (dirs.length > 0) rmSync(dirs.pop(), { recursive: true, force: true });
});

const DEAD = 30;
const WHALES = [['w1', 5003, 0], ['w2', 5008, 2]];

/** The shaping fixture with two $2,000 orders and 30 sessions of a 0x0 viewport that never buy. */
function suspectRows() {
  const rows = shapingRows();
  for (const [idorder, idvisit, day] of WHALES) rows.udp_conversions.push({ idsite: SHAPE_SITE, idvisit, server_date: addDays(FIRST_DAY, day), idorder, revenue: 2000 });
  for (let k = 0; k < DEAD; k += 1) {
    const date = addDays(FIRST_DAY, k);
    const idvisit = 9000 + k;
    rows.udp_hsrce_visits.push({
      idsite: SHAPE_SITE, idvisit, server_date: date, visit_first_action_time: `${date} 10:30:00`, config_id: `d${k}`, config_device_type: 1,
      referer_type: 1, visitor_returning: false, location_country: 'us', location_city: 'x', config_resolution: '0x0',
      config_browser_name: 'CH', config_browser_version: '120', custom_var_k5: null, custom_var_v1: null, custom_var_v4: null, referer_name: '',
    });
    rows.udp_hsrce_pageviews.push({ idsite: SHAPE_SITE, idvisit, idloghsr: 90_000 - k, idsitehsr: 71, server_date: date, server_time: `${date} 10:30:00` });
  }
  return rows;
}

describe('the quality order read', () => {
  it('bounds every fact read by site and day', () => {
    expect(queryBoundGaps(qualityOrdersSql(checkPeriod({ grain: 'window' }).spec))).toEqual([]);
  });
});

describe.skipIf(!hasClickHouseLocal())('--shape with data-quality screens', () => {
  const warehouse = createLocalWarehouse(suspectRows());
  const root = tempDir('quality-root-');
  mkdirSync(path.join(root, 'sites', 'seven'), { recursive: true });
  writeFileSync(path.join(root, 'sites', 'seven', 'site.json'), JSON.stringify({ slug: 'seven', idsite: SHAPE_SITE }));
  writeFileSync(path.join(root, 'sites', 'seven', 'quality.json'), JSON.stringify({
    idsite: SHAPE_SITE,
    rules: { dead_resolution: { method: { params: { minSessions: 10, minSiteBuyers: 5 } } } },
  }));
  const shaping = createShapingRegistry({ attributes: ATTRIBUTES, kinds: loadSourceKinds(ATTRIBUTES), adapters: [] });
  const ctx = () => ({
    segmentations: async () => SHIPPED,
    shaping: async () => shaping,
    quality: () => loadQualityRegistry({ ORCHESTRATION_ROOT: root }),
    gateway: () => warehouse,
    persistence: () => ({ readTrendWeekRange: async () => ({ subjects: [], values: [] }) }),
    clock: { todayUtc: () => TODAY },
    database: 'ae',
  });
  const file = path.join(tempDir('quality-requests-'), 'requests.json');
  writeFileSync(file, JSON.stringify({ requests: [{ id: 'totals', question: 'How did the store do?', idsite: SHAPE_SITE, window: { start: FIRST_DAY, end: LAST_DAY }, period: { grain: 'window' }, measures: ['sessions', 'orders', 'revenue'] }] }));

  const build = async () => {
    const out = path.join(tempDir('quality-out-'), 'shapes');
    const result = await shape.run({ shape: file, out }, ctx());
    expect(result.ok, result.errors?.join('; ')).toBe(true);
    const folder = path.join(out, 'totals');
    const dataset = JSON.parse(readFileSync(path.join(folder, 'dataset.json'), 'utf8'));
    const all = dataset.rows.find((row) => (row.segment ?? 'all') === 'all');
    return { out, folder, result, all, ledger: JSON.parse(readFileSync(path.join(folder, 'quality.json'), 'utf8')), doc: readFileSync(path.join(folder, 'QUALITY.md'), 'utf8') };
  };
  const decide = async (flags) => {
    const result = await qualityDecide.run(flags, ctx());
    expect(result.ok, result.errors?.join('; ')).toBe(true);
    return result;
  };
  const byScreen = (ledger, id) => ledger.findings.filter((f) => f.screen === id);

  let first;
  it('builds everything, flags the whales and the 0x0 sessions, and asks', async () => {
    first = await build();
    expect(first.result.output).toMatch(/^totals: built: 1 rows in .*; quality: 2 findings, 2 waiting for you/);
    const [whale] = byScreen(first.ledger, 'whale_orders');
    expect(whale).toMatchObject({ status: 'awaiting_decision', disposition: 'include', proposed: 'exclude', members: ['order:w1', 'order:w2'] });
    expect(whale.question).toMatch(/^2 orders sit above /);
    const [dead] = byScreen(first.ledger, 'dead_resolution');
    expect(dead).toMatchObject({ status: 'awaiting_decision', members: ['group:resolution=0x0'] });
    expect(dead.question).toContain(`You have ${DEAD} sessions with a resolution of 0x0`);
    expect(first.ledger.exclusions).toEqual({ orders: [], visits: [], conditions: [] });
    expect(first.doc).toContain('## Waiting for you (2)');
    expect(first.doc).toContain('`method.params.minSessions` = `10` from sites/seven/quality.json');
    expect(readFileSync(path.join(first.out, 'ANSWER.md'), 'utf8')).toContain('### Waiting for you');
    expect(readFileSync(path.join(first.folder, 'DATA.md'), 'utf8')).toContain('Nothing is excluded');
  }, 120_000);

  it('excludes what a person decides on the next build, and the checks still hold', async () => {
    const from = path.join(first.folder, 'quality.json');
    const [whale] = byScreen(first.ledger, 'whale_orders');
    const [dead] = byScreen(first.ledger, 'dead_resolution');
    const said = await decide({ 'quality-decide': whale.id, from, exclude: 'true', by: 'kenn', note: 'two wholesale orders' });
    expect(said.output).toMatch(/^exclude: 2 members of q_\w+ in every dataset of the site; recorded in /);
    await decide({ 'quality-decide': dead.id, from, exclude: 'true', by: 'kenn', note: 'a 0x0 viewport is not a person' });
    const stored = JSON.parse(readFileSync(path.join(root, 'sites', 'seven', 'quality-decisions.json'), 'utf8'));
    expect(stored.decisions.map((d) => [d.rule, d.decision, d.members])).toEqual([['whale_orders', 'exclude', ['order:w1', 'order:w2']], ['dead_resolution', 'exclude', ['group:resolution=0x0']]]);

    const second = await build();
    expect(second.ledger.findings.map((f) => [f.screen, f.status, f.disposition])).toEqual([['dead_resolution', 'decided', 'exclude'], ['whale_orders', 'decided', 'exclude']]);
    expect(second.ledger.exclusions).toEqual({ orders: ['w1', 'w2'], visits: [], conditions: [{ field: 'resolution', in: ['0x0'] }] });
    expect(second.all.sessions).toBe(first.all.sessions - DEAD);
    expect(second.all.orders).toBe(first.all.orders - 2);
    expect(second.all.revenue).toBeCloseTo(first.all.revenue - 4000, 6);
    expect(second.doc).toContain('## Decided (2)');
    expect(readFileSync(path.join(second.folder, 'DATA.md'), 'utf8')).toContain('Every number here leaves out 2 orders; every session with resolution in "0x0".');
  }, 120_000);

  it('screens again under new constants a person gives, for one dataset', async () => {
    const from = path.join(first.folder, 'quality.json');
    const [whale] = byScreen(first.ledger, 'whale_orders');
    await decide({ 'quality-decide': whale.id, from, reprocess: '{"method":{"params":{"k":100}}}', 'dataset-only': 'true', by: 'kenn', note: 'only flag orders far past wholesale' });
    const third = await build();
    expect(byScreen(third.ledger, 'whale_orders')).toEqual([]);
    expect(third.ledger.screens.find((s) => s.id === 'whale_orders').method.params.k).toBe(100);
    expect(third.all.orders).toBe(first.all.orders);
    expect(third.all.sessions).toBe(first.all.sessions - DEAD);
    expect(third.doc).toMatch(/whale_orders: `method.params.k` = `100` from decision of 2026-10-14 by kenn, dataset totals/);
  }, 120_000);

  it('refuses a decision on a finding the file does not hold, or a patch that does not resolve', async () => {
    const from = path.join(first.folder, 'quality.json');
    const [whale] = byScreen(first.ledger, 'whale_orders');
    expect(await qualityDecide.run({ 'quality-decide': 'q_000000000000', from, exclude: 'true', by: 'k', note: 'n' }, ctx())).toMatchObject({ ok: false, exitCode: 1 });
    expect(await qualityDecide.run({ 'quality-decide': whale.id, from, reprocess: '{"method":{"params":{"kk":1}}}', by: 'k', note: 'n' }, ctx())).toMatchObject({ ok: false, errors: [expect.stringMatching(/does not resolve: .*kk/)] });
    expect(await qualityDecide.run({ 'quality-decide': whale.id, from, exclude: 'true', include: 'true', by: 'k', note: 'n' }, ctx())).toMatchObject({ ok: false, exitCode: 2 });
  });

  it('builds without screening when asked', async () => {
    const out = path.join(tempDir('quality-out-'), 'shapes');
    const result = await shape.run({ shape: file, out, 'no-quality': 'true' }, ctx());
    expect(result.ok).toBe(true);
    expect(result.output).not.toContain('quality:');
  }, 120_000);
});
