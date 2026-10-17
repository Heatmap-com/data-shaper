import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { syntheticSources, writeSyntheticSources } from '../scripts/lib/synthetic-sources.mjs';
import { adapter as syntheticFile } from '../src/adapters/external-sources/synthetic-file.js';
import { shape } from '../src/application/commands/shape.js';
import { buildShape, readSources } from '../src/application/shaping/build.js';
import { planRequest } from '../src/application/shaping/plan.js';
import { createShapingRegistry } from '../src/application/shaping/registry.js';
import { siteAttributesSpec } from '../src/application/shaping/site-files.js';
import { loadAttributeCatalog } from '../src/catalog/attributes.js';
import { loadSourceKinds } from '../src/catalog/sources.js';
import { main } from '../src/cli.js';
import { loadQualityRegistry } from '../src/composition/quality.js';
import { loadShapingRegistry } from '../src/composition/shaping.js';
import { addDays, eachDay } from '../src/domain/shaping/dates.js';
import { shapeSql } from '../src/enrichment/shape-sql.js';
import { segmentationCheckSql } from '../src/enrichment/trend-sql.js';
import { queryBoundGaps } from '../src/governance/query-bounds.js';
import { hasClickHouseLocal } from './domain/clickhouse-local.js';
import { createLocalWarehouse } from './support/local-warehouse.js';
import { SHIPPED } from './support/segmentations.js';
import { FIRST_DAY, LAST_DAY, SHAPE_SITE, shapingRows } from './support/shaping-fixture.js';

const TODAY = '2026-10-14';
const ATTRIBUTES = loadAttributeCatalog();
const KINDS = loadSourceKinds(ATTRIBUTES);
const dirs = [];
const tempDir = (prefix) => {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};
afterAll(() => {
  process.exitCode = undefined;
  while (dirs.length > 0) rmSync(dirs.pop(), { recursive: true, force: true });
});

const SOURCES_DIR = tempDir('shape-sources-');
const SETS = syntheticSources({ from: FIRST_DAY, to: LAST_DAY });
writeSyntheticSources(SOURCES_DIR, SETS);

const TIER = { id: 'tier', kind: 'visit', label: 'Customer tier', purpose: 'Loyalty tier the tag sets.', data: 'custom_var_v2 at the first action, lowercased.', column: 'custom_var_v2', type: 'string', normalize: ['trim', 'lower'] };

/** A registry for the fixture site, with connections to `dir` for each source named. */
function registryFor({ dir = SOURCES_DIR, sources = ['meta_ads', 'ga4', 'site_catalog'], siteAttributes = [] } = {}) {
  return createShapingRegistry({
    attributes: ATTRIBUTES,
    kinds: KINDS,
    adapters: [syntheticFile],
    siteAttributes,
    siteSources: [{ slug: 'seven', idsite: SHAPE_SITE, connections: sources.map((source) => ({ source, adapter: 'synthetic-file', options: { dir } })) }],
  });
}

const subject = (rowKey, rowKey1, first, last) => ({ rowKey, rowKey1, rowKey2: '', idsitehsr: 0, first, last });
const STORED = [subject('path', 'plp > pdp', '2026-08-31', '2026-10-05'), subject('url_path', '/ > /products/a', '2026-08-31', '2026-10-05'), subject('page', '/', '2026-08-31', '2026-10-05')];

function depsFor(shaping = registryFor(), columns = ['custom_var_v2', 'config_device_type', 'location_city'], stored = STORED) {
  return { segmentations: SHIPPED, shaping, today: TODAY, database: 'ae', visitColumns: async () => new Set(columns), trendRange: async () => ({ subjects: stored, values: [] }) };
}

const request = (doc) => ({ id: 'q', question: 'What?', idsite: SHAPE_SITE, window: { start: '2026-09-07', end: '2026-09-27' }, measures: ['sessions'], ...doc });

describe('planning a request', () => {
  const plan = (doc, deps = depsFor()) => planRequest(request(doc), deps);

  it('is ready when the vocabulary, the connections, and the columns are there', async () => {
    const answer = await plan({ by: ['utm_campaign'], measures: ['sessions', 'meta_ads.spend'], segmentations: ['channel'] });
    expect(answer).toMatchObject({ status: 'ready', level: 'declare', reasons: [], needs: [] });
    expect(answer.plan).toMatchObject({ queryKeys: ['utm_campaign'], sources: ['meta_ads'], lookupSources: [], queryWindow: { start: '2026-09-07', end: '2026-09-27' } });
    expect(answer.notes).toEqual(expect.arrayContaining([expect.stringMatching(/meta_ads measures sit on segment all only/), expect.stringMatching(/Meta's attribution/)]));
  });

  it('names each thing a person must add, and at what level', async () => {
    const answer = await plan({ by: ['loyalty_tier'], segmentations: ['return_intent', 'tiktok'], measures: ['sessions', 'bounce_rate', 'tiktok.spend'], period: { grain: 'cohort' } });
    expect(answer.status).toBe('needs_person');
    expect(answer.needs.map((need) => [need.name, need.level])).toEqual([['period.grain cohort', 'extend']]);
    const rest = await plan({ by: ['loyalty_tier'], segmentations: ['return_intent', 'tiktok'], measures: ['sessions', 'bounce_rate', 'tiktok.spend'] });
    expect(rest.needs.map((need) => [need.name, need.level])).toEqual([
      ['attribute loyalty_tier', 'declare'],
      ['segmentation return_intent', 'extend'],
      ['segmentation tiktok', 'declare'],
      ['measure bounce_rate', 'extend'],
      ['measure tiktok.spend', 'extend'],
    ]);
    expect(rest.needs[0].change).toContain('orchestration/sites/seven/attributes.json');
    expect(rest.needs[3].change).toMatch(/a new session measure is an aggregate in SESSION_MEASURES/);
  });

  it('is invalid when a condition reads a lookup, or a comparison would read a cut period', async () => {
    expect(await plan({ filter: { field: 'site_catalog.product_type', eq: 'shirts' } })).toMatchObject({ status: 'invalid', reasons: [expect.stringMatching(/lookup attribute keys rows after the query/)] });
    expect(await plan({ period: { grain: 'month', compare: 'previous' } })).toMatchObject({ status: 'invalid', reasons: [expect.stringMatching(/period.compare reads whole periods, and the window cuts 2026-09-01/)] });
    expect(await plan({ segmentations: [{ id: 'channel', label: 'L', purpose: 'P', data: 'D', rules: [], fallback: 'x' }] })).toMatchObject({ status: 'invalid', reasons: [expect.stringMatching(/already defined/)] });
  });

  it('is blocked on missing data, never guessed', async () => {
    expect(await plan({ window: { start: '2026-10-01', end: TODAY } })).toMatchObject({ status: 'blocked', reasons: [expect.stringMatching(/last whole day is 2026-10-13/)] });
    expect(await plan({ by: ['device'], measures: ['meta_ads.spend'] })).toMatchObject({ status: 'blocked', reasons: [expect.stringMatching(/meta_ads measures cannot be split by device: meta_ads rows are keyed by day and utm_campaign/)] });
    expect(await plan({ measures: ['meta_ads.spend'], filter: { field: 'country', eq: 'us' } })).toMatchObject({ status: 'blocked', reasons: [expect.stringMatching(/cannot be filtered on country/)] });
    expect(await plan({ measures: ['ga4.sessions'] }, depsFor(registryFor({ sources: ['meta_ads'] })))).toMatchObject({ status: 'blocked', reasons: [expect.stringMatching(/no ga4 connection; add one to orchestration\/sites\/seven\/sources.json/)] });
    expect(await plan({ by: ['region'] })).toMatchObject({ status: 'blocked', reasons: ['udp_hsrce_visits has no column location_region on this warehouse, so region cannot be read'] });
    expect(await plan({ window: { start: '2025-01-01', end: '2026-09-30' } })).toMatchObject({ status: 'blocked', reasons: [expect.stringMatching(/at most 400/)] });
  });

  it('splits a source by a lookup over its key', async () => {
    expect((await plan({ by: ['site_catalog.product_type'], measures: ['sessions'] })).plan).toMatchObject({ queryKeys: ['landing_path'], lookupSources: ['site_catalog'] });
  });

  it('reads stored trend rows for a page question the trend row holds, and names a new grain otherwise', async () => {
    const read = await plan({ subject: 'pages', by: ['device'], segmentations: ['returning'], measures: ['sessions', 'orders'] });
    expect(read).toMatchObject({ status: 'read', level: 'read', read: { table: 'ae.ae_trend_row_current' } });
    expect(read.read.sql).toContain("row_type = 'page'");
    expect(read.read.sql).toContain("segment IN ('all', 'returning')");
    const grain = await plan({ subject: 'journeys', by: ['utm_campaign'], period: { grain: 'day' } });
    expect(grain).toMatchObject({ status: 'needs_person', needs: [{ level: 'new_grain' }] });
    expect(grain.needs[0].change).toMatch(/Monday weeks; the trend row keys a subject by device only/);
  });

  it('blocks a read the stored trend rows do not hold, naming the trend run that stores them', async () => {
    const weeks = { subject: 'journeys', window: { start: '2026-09-28', end: '2026-10-11' } };
    expect(await plan(weeks, depsFor(registryFor(), undefined, []))).toMatchObject({
      status: 'blocked',
      reasons: [`ae_trend_row holds no journey rows for idsite ${SHAPE_SITE} in the weeks 2026-09-28 through 2026-10-11. The trend job stores them, and writes ae_trend_row: node src/cli.js --trend --sites ${SHAPE_SITE} --window-start 2026-09-28 --window-end 2026-10-11`],
    });
    const elsewhere = await plan(weeks, depsFor(registryFor(), undefined, [subject('path', 'plp > pdp', '2026-08-03', '2026-08-24'), subject('page', '/', '2026-09-28', '2026-10-05')]));
    expect(elsewhere).toMatchObject({ status: 'blocked', reasons: [expect.stringMatching(/no journey rows .*; its journeys rows run 2026-08-03 through 2026-08-24\. The trend job/)] });
    const partial = await plan({ ...weeks, window: { start: '2026-09-28', end: '2026-10-18' } });
    expect(partial).toMatchObject({ status: 'read', notes: expect.arrayContaining([
      `the stored rows cover the weeks of 2026-08-31 through 2026-10-05; the other weeks read no rows until the trend job runs over them: node src/cli.js --trend --sites ${SHAPE_SITE} --window-start 2026-09-28 --window-end 2026-10-18`,
      expect.stringMatching(/^a journey row is one whole-session page sequence among the 2 the trend chose by revenue/),
    ]) });
    expect(await plan(weeks, { ...depsFor(), trendRange: async () => { throw new Error('no table ae.ae_trend_row_current'); } })).toMatchObject({
      status: 'blocked',
      reasons: ['the stored trend rows cannot be read: no table ae.ae_trend_row_current'],
    });
  });
});

describe('the example request set', () => {
  it('plans as the skill describes it', async () => {
    const { requests } = JSON.parse(readFileSync(new URL('../examples/shaping/vip-call-requests.json', import.meta.url), 'utf8'));
    const shaping = createShapingRegistry({
      attributes: ATTRIBUTES,
      kinds: KINDS,
      adapters: [syntheticFile],
      siteSources: [{ slug: 'vip', idsite: requests[0].idsite, connections: ['meta_ads', 'ga4', 'site_catalog'].map((source) => ({ source, adapter: 'synthetic-file', options: { dir: SOURCES_DIR } })) }],
    });
    const answers = [];
    for (const doc of requests) answers.push(await planRequest(doc, depsFor(shaping)));
    expect(answers.map((a) => [a.id, a.status, a.reasons])).toEqual([
      ['funnel_by_channel', 'ready', []],
      ['meta_campaign_payback', 'ready', []],
      ['meta_daily_trend', 'ready', []],
      ['landing_product_type', 'ready', []],
      ['ga4_reconciliation', 'ready', []],
      ['money_paths', 'read', []],
      ['new_visitor_cohorts', 'needs_person', []],
    ]);
  });
});

describe('reading sources', () => {
  const ready = async (doc, shaping) => (await planRequest(request(doc), depsFor(shaping))).plan;

  it('blocks a source that does not cover the days the query reads, unless the request allows it', async () => {
    const dir = tempDir('shape-stale-');
    writeSyntheticSources(dir, { meta_ads: SETS.meta_ads.filter((row) => row.date <= '2026-09-20') });
    const shaping = registryFor({ dir, sources: ['meta_ads'] });
    const blocked = await readSources(await ready({ measures: ['meta_ads.spend'] }, shaping), shaping);
    expect(blocked.reasons).toEqual([expect.stringMatching(/meta_ads covers 2026-08-24 to 2026-09-20; the query reads 2026-09-07 to 2026-09-27, so 7 days are missing \(2026-09-21 to 2026-09-27\)\. Refresh the connection/)]);
    const allowed = await readSources(await ready({ measures: ['meta_ads.spend'], sources: { meta_ads: { partial: 'allow' } } }, shaping), shaping);
    expect(allowed.reasons).toEqual([]);
    expect(allowed.notes).toEqual([expect.stringMatching(/the request allows it, and those days read 0/)]);
  });

  it('blocks rows that are not rows of the kind, and a file that is not there', async () => {
    const dir = tempDir('shape-bad-');
    writeSyntheticSources(dir, { meta_ads: [...SETS.meta_ads, { date: 'yesterday', campaign_name: 'x', spend: 1 }] });
    const shaping = registryFor({ dir, sources: ['meta_ads', 'ga4'] });
    const bad = await readSources(await ready({ measures: ['meta_ads.spend', 'ga4.sessions'] }, shaping), shaping);
    expect(bad.reasons).toEqual([
      expect.stringMatching(/meta_ads: 1 rows are not Meta Ads rows \(row \d+: date "yesterday" is not a day\)/),
      expect.stringMatching(/ga4: the fetch failed: ENOENT/),
    ]);
  });

  it('notes a catalog that lists a path twice', async () => {
    const dir = tempDir('shape-catalog-');
    writeSyntheticSources(dir, { site_catalog: [...SETS.site_catalog, { path: '/products/linen-shirt', product_type: 'tops', collection: 'x', price_band: 'y' }] });
    const shaping = registryFor({ dir, sources: ['site_catalog'] });
    const read = await readSources(await ready({ by: ['site_catalog.product_type'] }, shaping), shaping);
    expect(read.notes).toEqual(['site_catalog lists 1 keys twice with different values; the first row of each is used']);
    expect(read.lookups.get('site_catalog').get('/products/linen-shirt').product_type).toBe('shirts');
  });
});

describe('the shaped query', () => {
  it('bounds every fact read by site and day', async () => {
    const shaping = registryFor({ siteAttributes: [siteAttributesSpec({ idsite: SHAPE_SITE, attributes: [TIER] }, 'seven', 'test')] });
    const answer = await planRequest(request({ by: ['landing_template', 'tier'], segmentations: ['rager', 'channel'], filter: { field: 'landing_page', gt: 0 }, period: { grain: 'window', compare: 'previous' } }), depsFor(shaping));
    expect(answer.status).toBe('ready');
    for (const group of answer.plan.groups) {
      const sql = shapeSql({ attributes: answer.plan.attributes, queryKeys: answer.plan.queryKeys, filter: answer.plan.filter, period: answer.plan.period }, group);
      expect(queryBoundGaps(sql)).toEqual([]);
      expect(sql).toContain('LIMIT {cellLimit:UInt32}');
    }
  });
});

describe.skipIf(!hasClickHouseLocal())('building shaped datasets', () => {
  const warehouse = createLocalWarehouse(shapingRows());
  const build = async (doc, { shaping = registryFor(), gateway = warehouse } = {}) => {
    const answer = await planRequest(request(doc), { ...depsFor(shaping), visitColumns: async () => new Set((await gateway.columns('udp_hsrce_visits')).map((c) => c.name)) });
    expect(answer.status, JSON.stringify([answer.reasons, answer.needs])).toBe('ready');
    const sources = await readSources(answer.plan, shaping);
    expect(sources.reasons).toEqual([]);
    const built = await buildShape(answer.plan, sources, { gateway, kinds: shaping.kinds });
    expect(built.status, JSON.stringify(built.reasons)).toBe('built');
    return { answer, built };
  };
  const all = (built) => built.cells.filter((cell) => cell.segment === 'all');
  const sum = (cells, name) => cells.reduce((acc, cell) => acc + (cell.m[name] ?? 0), 0);

  it('matches --segmentation-check on a Monday week', async () => {
    const week = { start: '2026-09-07', end: '2026-09-13' };
    const { built } = await build({ window: week, segmentations: ['channel', 'returning'], measures: ['sessions', 'orders', 'revenue'] });
    for (const id of ['channel', 'returning']) {
      const expected = await warehouse.query(segmentationCheckSql(SHIPPED.forSite(SHAPE_SITE).get(id)), { idsite: SHAPE_SITE, w0: week.start, w1: week.end }, 'trend:segmentation-check');
      const got = built.cells.filter((cell) => cell.segment === id || cell.segment === 'all');
      const key = (row) => `${row.segment}/${row.segment_value ?? row.value}`;
      const pick = (row, m = row) => [Number(m.sessions), Number(m.orders), Number(Number(m.revenue).toFixed(2))];
      expect(Object.fromEntries(got.map((cell) => [key(cell), pick(cell, cell.m)]))).toEqual(Object.fromEntries(expected.filter((row) => Number(row.sessions) > 0).map((row) => [key(row), pick(row)])));
    }
  }, 60_000);

  it('joins Meta spend onto campaigns, keeping every dollar', async () => {
    const window = { start: FIRST_DAY, end: LAST_DAY };
    const { built } = await build({ window, by: ['utm_campaign'], measures: ['sessions', 'revenue', 'meta_ads.spend', 'roas'], derived: [{ id: 'roas', label: 'ROAS', data: 'Revenue over spend.', ratio: ['revenue', 'meta_ads.spend'] }] });
    const spend = SETS.meta_ads.reduce((acc, row) => acc + row.spend, 0);
    expect(sum(built.cells, 'meta_ads.spend')).toBeCloseTo(spend, 6);
    expect(built.totals['meta_ads.spend']).toBeCloseTo(spend, 6);
    const prospecting = all(built).filter((cell) => cell.keys[0] === 'prospecting');
    expect(prospecting).toHaveLength(6);
    expect(prospecting.every((cell) => cell.m.sessions === 0 && cell.m['meta_ads.spend'] > 0 && cell.m.roas === 0)).toBe(true);
    const untagged = all(built).filter((cell) => cell.keys[0] === '');
    expect(untagged.every((cell) => cell.m['meta_ads.spend'] === 0 && cell.m.roas === null)).toBe(true);
    const { built: total } = await build({ window, measures: ['sessions'] });
    expect(sum(built.cells, 'sessions')).toBe(sum(total.cells, 'sessions'));
  }, 60_000);

  it('reconciles GA4 sources and mediums onto the tracker\'s, on segment all only', async () => {
    const { built } = await build({ window: { start: FIRST_DAY, end: LAST_DAY }, by: ['source_or_referrer', 'utm_medium'], segmentations: ['returning'], measures: ['sessions', 'ga4.sessions'] });
    const keyed = new Map(all(built).map((cell) => [`${cell.period}|${cell.keys.join('|')}`, cell]));
    expect(keyed.get('2026-08-24|google|cpc').m['ga4.sessions']).toBeGreaterThan(0);
    expect(keyed.get('2026-08-24||').m['ga4.sessions']).toBeGreaterThan(0);
    expect(built.cells.filter((cell) => cell.segment === 'returning').every((cell) => cell.m['ga4.sessions'] === null)).toBe(true);
    expect(sum(built.cells, 'ga4.sessions')).toBe(SETS.ga4.reduce((acc, row) => acc + row.sessions, 0));
  }, 60_000);

  it('rolls day sums that equal the day grain summed', async () => {
    const window = { start: '2026-09-07', end: '2026-09-20' };
    const { built: daily } = await build({ window: { start: addDays(window.start, -6), end: window.end }, period: { grain: 'day' }, measures: ['sessions', 'meta_ads.spend'] });
    const { built: rolling } = await build({ window, period: { grain: 'day', rolling: 7 }, measures: ['sessions', 'meta_ads.spend', 'conversion_rate'] });
    const byDay = new Map(daily.cells.map((cell) => [cell.period, cell.m]));
    expect(rolling.cells.map((cell) => cell.period)).toEqual(eachDay(window.start, window.end));
    for (const cell of rolling.cells) {
      const span = eachDay(addDays(cell.period, -6), cell.period);
      expect(cell.m.sessions).toBe(span.reduce((acc, day) => acc + (byDay.get(day)?.sessions ?? 0), 0));
      expect(cell.m['meta_ads.spend']).toBeCloseTo(span.reduce((acc, day) => acc + (byDay.get(day)?.['meta_ads.spend'] ?? 0), 0), 6);
      expect(cell.m.conversion_rate).toBeCloseTo(cell.m.buyers / cell.m.sessions, 9);
    }
  }, 60_000);

  it('counts a visit across midnight once a week and once a day', async () => {
    const week = { start: '2026-09-07', end: '2026-09-13' };
    const { built: weekly } = await build({ window: week, measures: ['sessions'] });
    const { built: daily } = await build({ window: week, period: { grain: 'day' }, measures: ['sessions'] });
    const visits = new Set(shapingRows().udp_hsrce_visits.filter((v) => v.server_date >= week.start && v.server_date <= week.end).map((v) => v.idvisit));
    const visitDays = new Set(shapingRows().udp_hsrce_visits.filter((v) => v.server_date >= week.start && v.server_date <= week.end).map((v) => `${v.idvisit}|${v.server_date}`));
    expect(sum(weekly.cells, 'sessions')).toBe(visits.size);
    expect(sum(daily.cells, 'sessions')).toBe(visitDays.size);
    expect(visitDays.size).toBeGreaterThan(visits.size);
  }, 60_000);

  it('compares a window with the one before, and a Sunday week with its own days', async () => {
    const window = { start: '2026-09-21', end: '2026-10-04' };
    const { built } = await build({ window, period: { grain: 'window', compare: 'previous' }, measures: ['sessions', 'revenue', 'aov'] });
    const { built: before } = await build({ window: { start: '2026-09-07', end: '2026-09-20' }, period: { grain: 'window' }, measures: ['sessions', 'revenue', 'aov'] });
    const [now] = built.cells;
    expect(built.cells).toHaveLength(1);
    expect(now.m).toMatchObject({ sessions_previous: before.cells[0].m.sessions, revenue_previous: before.cells[0].m.revenue, aov_previous: before.cells[0].m.aov });
    expect(now.m.sessions_change).toBeCloseTo(now.m.sessions / now.m.sessions_previous - 1, 9);
    const { built: sunday } = await build({ window: { start: '2026-09-06', end: '2026-09-26' }, period: { grain: 'week', weekStart: 'sunday' }, measures: ['sessions'] });
    expect(sunday.cells.map((cell) => cell.period).sort()).toEqual(['2026-09-06', '2026-09-13', '2026-09-20']);
  }, 60_000);

  it('sorts sessions by the catalog of the page they landed on, ranked', async () => {
    const { answer, built } = await build({ window: { start: FIRST_DAY, end: LAST_DAY }, period: { grain: 'window' }, by: ['site_catalog.product_type'], measures: ['sessions', 'revenue'], rank: { by: 'revenue', limit: 2 } });
    const keys = built.cells.map((cell) => cell.keys[0]);
    expect(keys).toHaveLength(3);
    expect(keys).toContain('(other)');
    expect(built.folded).toBe(2);
    const { built: full } = await build({ window: { start: FIRST_DAY, end: LAST_DAY }, period: { grain: 'window' }, by: ['site_catalog.product_type', 'landing_path'], measures: ['sessions'] });
    const paths = new Map(full.cells.map((cell) => [cell.keys[1], cell.keys[0]]));
    expect(Object.fromEntries(paths)).toEqual({ '/': '(home)', '/products/linen-shirt': 'shirts', '/collections/summer': '(collection)', '/pages/lookbook': '(unmatched)' });
    expect(answer.plan.lookupSources).toEqual(['site_catalog']);
  }, 60_000);

  it('follows each landing page to the two pages after it, a repeated page as one step', async () => {
    const rows = shapingRows();
    const day = '2026-09-08';
    const base = rows.udp_hsrce_visits.find((v) => v.idvisit === 5001);
    rows.udp_hsrce_visits.push({ ...base, idvisit: 9001, server_date: day, visit_first_action_time: `${day} 10:00:00` }, { ...base, idvisit: 9002, server_date: day, visit_first_action_time: `${day} 11:00:00` });
    [72, 72, 99, 73, 72, 75].forEach((idsitehsr, i) => rows.udp_hsrce_pageviews.push({ idsite: SHAPE_SITE, idvisit: 9001, idloghsr: 90_000 + i, idsitehsr, server_date: day, server_time: `${day} 10:0${i}:00` }));
    const { built } = await build({ window: { start: FIRST_DAY, end: LAST_DAY }, period: { grain: 'window' }, by: ['landing_path', 'next_path', 'third_path'], measures: ['sessions'] }, { gateway: createLocalWarehouse(rows) });

    const urls = new Map(rows.site_hsr.map((p) => [p.idsitehsr, new URL(p.screenshot_url).pathname.toLowerCase().replace(/(.)\/+$/, '$1')]));
    const views = new Map();
    for (const pv of rows.udp_hsrce_pageviews) {
      if (!urls.has(pv.idsitehsr)) continue;
      views.set(pv.idvisit, [...(views.get(pv.idvisit) ?? []), pv]);
    }
    const expected = new Map();
    for (const idvisit of new Set(rows.udp_hsrce_visits.map((v) => v.idvisit))) {
      const seen = (views.get(idvisit) ?? []).sort((a, b) => (a.server_time < b.server_time ? -1 : a.server_time > b.server_time ? 1 : a.idloghsr - b.idloghsr));
      const steps = seen.map((pv) => pv.idsitehsr).filter((hsr, i, all) => i === 0 || hsr !== all[i - 1]);
      const at = (i) => (steps.length === 0 ? '(unknown)' : i < steps.length ? urls.get(steps[i]) : '(exit)');
      const key = [at(0), at(1), at(2)].join('|');
      expected.set(key, (expected.get(key) ?? 0) + 1);
    }
    const got = new Map(all(built).map((cell) => [cell.keys.join('|'), cell.m.sessions]));
    expect(Object.fromEntries(got)).toEqual(Object.fromEntries(expected));
    expect(got.get('/products/linen-shirt|/collections/summer|/products/linen-shirt')).toBe(1);
    expect(got.get('(unknown)|(unknown)|(unknown)')).toBe(1);
    expect([...got.keys()].some((key) => key.endsWith('|(exit)|(exit)'))).toBe(true);
  }, 60_000);

  it('reads a site attribute and a warehouse column only where the warehouse has it', async () => {
    const rows = shapingRows();
    rows.udp_hsrce_visits = rows.udp_hsrce_visits.map((v) => ({ ...v, custom_var_v2: Number(v.idvisit) % 2 ? ' Gold' : 'silver ' }));
    const regional = createLocalWarehouse(rows, { udp_hsrce_visits: { location_region: 'Nullable(String)', custom_var_v2: 'Nullable(String)' } });
    const shaping = registryFor({ siteAttributes: [siteAttributesSpec({ idsite: SHAPE_SITE, attributes: [TIER] }, 'seven', 'test')] });
    const { built } = await build({ period: { grain: 'window' }, by: ['region', 'tier'], filter: { field: 'tier', eq: 'gold' }, measures: ['sessions'] }, { shaping, gateway: regional });
    expect(new Set(built.cells.map((cell) => cell.keys[1]))).toEqual(new Set(['gold']));
    expect(new Set(built.cells.map((cell) => cell.keys[0]))).toEqual(new Set(['ny', 'on', 'ldn']));
  }, 60_000);
});

describe.skipIf(!hasClickHouseLocal())('--shape', () => {
  const warehouse = createLocalWarehouse(shapingRows());
  const ctxFor = (shaping = registryFor()) => ({
    segmentations: async () => SHIPPED,
    shaping: async () => shaping,
    quality: () => loadQualityRegistry({ ORCHESTRATION_ROOT: tempDir('shape-root-') }),
    gateway: () => warehouse,
    persistence: () => ({ readTrendWeekRange: async () => ({ subjects: STORED, values: [] }) }),
    clock: { todayUtc: () => TODAY },
    database: 'ae',
  });
  const requestsFile = (requests) => {
    const file = path.join(tempDir('shape-requests-'), 'requests.json');
    writeFileSync(file, JSON.stringify({ requests }));
    return file;
  };

  it('answers a request set: built folders, and why the rest are not', async () => {
    const out = path.join(tempDir('shape-out-'), 'shapes');
    const file = requestsFile([
      request({ id: 'campaign_weeks', question: 'Which campaigns pay back their spend?', by: ['utm_campaign'], segmentations: ['returning'], measures: ['sessions', 'revenue', 'meta_ads.spend'], floor: { sessions: 5 } }),
      request({ id: 'region', question: 'By region?', by: ['region'] }),
      request({ id: 'tier', question: 'By tier?', by: ['loyalty_tier'] }),
      request({ id: 'pages', question: 'Pages by device', subject: 'pages', by: ['device'] }),
    ]);
    const result = await shape.run({ shape: file, out }, ctxFor());
    expect(result.ok, result.errors?.join('; ')).toBe(true);
    expect(result.output.split('\n')).toEqual([
      expect.stringMatching(/^campaign_weeks: built: \d+ rows in /),
      'region: blocked: udp_hsrce_visits has no column location_region on this warehouse, so region cannot be read',
      'tier: needs person: attribute loyalty_tier (declare)',
      'pages: read: read ae.ae_trend_row_current',
      `answer: ${path.join(out, 'ANSWER.md')}`,
    ]);
    const csv = readFileSync(path.join(out, 'campaign_weeks', 'data.csv'), 'utf8').split('\n');
    expect(csv[0]).toBe('period,period_end,period_complete,segment,segment_value,utm_campaign,sessions,revenue,meta_ads.spend,below_floor');
    expect(csv[1]).toMatch(/^2026-09-07,2026-09-13,1,all,all,brand,\d+,[\d.]+,[\d.]+,[01]$/);
    const dataset = JSON.parse(readFileSync(path.join(out, 'campaign_weeks', 'dataset.json'), 'utf8'));
    expect(dataset.columns.map((column) => column.name)).toEqual(csv[0].split(','));
    expect(dataset.rows.filter((row) => row.segment === 'returning').every((row) => row['meta_ads.spend'] === null)).toBe(true);
    expect(dataset.sources).toEqual([expect.objectContaining({ id: 'meta_ads', role: 'facts', rejected: 0 })]);
    const doc = readFileSync(path.join(out, 'campaign_weeks', 'DATA.md'), 'utf8');
    expect(doc).toContain('One row per period, (segment, segment value) and utm campaign.');
    expect(doc).toContain('| `meta_ads.spend` | Ad spend summed over the period\'s days, in the account currency. On segment all only. |');
    expect(doc).toMatch(/Conservation: meta_ads.spend totals [\d.]+ in the source rows/);
    const answer = readFileSync(path.join(out, 'ANSWER.md'), 'utf8');
    expect(answer).toContain('4 requests from `requests.json`, answered 2026-10-14: 1 built, 1 already stored: read it, 1 blocked, 1 needs a person.');
    expect(JSON.parse(readFileSync(path.join(out, 'answer.json'), 'utf8')).map((a) => [a.id, a.status])).toEqual([['campaign_weeks', 'built'], ['region', 'blocked'], ['tier', 'needs_person'], ['pages', 'read']]);
  }, 120_000);

  it('plans without building, and exits 1 on an invalid request', async () => {
    const queries = warehouse.calls.length;
    const result = await shape.run({ shape: requestsFile([request({ id: 'a' }), request({ id: 'a' }), { id: 'b' }]), plan: 'true' }, ctxFor());
    expect(warehouse.calls.length).toBe(queries);
    expect(result).toMatchObject({ ok: false, exitCode: 1 });
    expect(result.output.split('\n')[0]).toBe('a: ready: 1 queries over 2026-09-07 to 2026-09-27');
    expect(result.errors).toEqual([expect.stringMatching(/^a: invalid: id a is used by an earlier request/), expect.stringMatching(/^b: invalid: question must be/)]);
  });

  it('exits 2 on a usage error', async () => {
    expect(await shape.run({ shape: 'true' }, ctxFor())).toMatchObject({ ok: false, exitCode: 2 });
    expect(await shape.run({ shape: 'x.json' }, ctxFor())).toMatchObject({ ok: false, exitCode: 2 });
    await main(['--shape', 'x.json']);
    expect(process.exitCode).toBe(2);
  });
});

describe('site source files', () => {
  it('resolve a relative dir against the site folder and fetch through the adapter', async () => {
    const root = tempDir('shape-root-');
    const site = path.join(root, 'sites', 'seven');
    mkdirSync(site, { recursive: true });
    writeSyntheticSources(path.join(site, 'synthetic'), { meta_ads: SETS.meta_ads.slice(0, 8) });
    writeFileSync(path.join(site, 'sources.json'), JSON.stringify({ idsite: SHAPE_SITE, connections: { meta_ads: { adapter: 'synthetic-file', dir: 'synthetic' } } }));
    writeFileSync(path.join(site, 'attributes.json'), JSON.stringify({ idsite: SHAPE_SITE, attributes: [TIER] }));
    const shaping = await loadShapingRegistry({ ORCHESTRATION_ROOT: root });
    expect(shaping.forSite(SHAPE_SITE).attributes.get('tier')).toMatchObject({ kind: 'visit', column: 'custom_var_v2' });
    const got = await shaping.fetch(SHAPE_SITE, 'meta_ads', { start: FIRST_DAY, end: FIRST_DAY });
    expect(got.rows).toHaveLength(4);
    expect(got.coverage).toEqual({ start: FIRST_DAY, end: addDays(FIRST_DAY, 1) });
  });

  it('refuse an unknown kind, an unknown adapter, and a non-visit site attribute', async () => {
    const make = (files) => {
      const root = tempDir('shape-root-');
      const site = path.join(root, 'sites', 'seven');
      mkdirSync(site, { recursive: true });
      for (const [name, doc] of Object.entries(files)) writeFileSync(path.join(site, name), JSON.stringify(doc));
      return loadShapingRegistry({ ORCHESTRATION_ROOT: root });
    };
    await expect(make({ 'sources.json': { idsite: 7, connections: { tiktok: { adapter: 'synthetic-file' } } } })).rejects.toThrow(/unknown source kind "tiktok"/);
    await expect(make({ 'sources.json': { idsite: 7, connections: { ga4: { adapter: 'bigquery' } } } })).rejects.toThrow(/unknown adapter "bigquery"/);
    await expect(make({ 'attributes.json': { idsite: 7, attributes: [{ ...TIER, kind: 'entry', property: 'path' }] } })).rejects.toThrow(/kind must be one of visit/);
  });
});
