import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { adaptersIn, discoverAdapterRoles } from '../src/discover.js';
import { createMemoryAePersistence } from '../src/adapters/persistence/memory.js';
import { createBatch, runBatch } from '../src/application/commands/batch.js';
import { loadCatalog } from '../src/catalog/index.js';
import { loadProfiles } from '../src/composition/registries.js';
import { SHIPPED } from './support/segmentations.js';
import { parseProfile } from '../src/domain/profile.js';

/**
 * The batch commands under a profile, on the memory store: `lp` stores the
 * rows a batch without --profile stores, `pdp` selects product pages
 * through its subject selector and keeps only its catalogs' cards, and a
 * criteria or profile mismatch fails before the batch runs.
 */

const roles = await discoverAdapterRoles(path.resolve('src/adapters'));
const requirementStatus = adaptersIn(roles, 'datasets').find((d) => d.id === 'requirement-status');
const subjectSelectors = adaptersIn(roles, 'subject-selectors');
const CATALOGS = Object.keys(loadCatalog().strategies);
const shipped = await loadProfiles(path.resolve('profiles'), CATALOGS);

const WEEK = '2026-09-28';
const PAGES = [
  { hsr: 222, url: 'https://x.com/pages/lp', title: 'LP', sessions: 500 },
  { hsr: 555, url: 'https://x.com/products/a', title: 'A', sessions: 300 },
  { hsr: 666, url: 'https://x.com/collections/c', title: 'C', sessions: 200 },
  { hsr: 888, url: 'https://x.com/products/b', title: 'B', sessions: 100 },
  { hsr: 777, url: 'https://x.com/pages/skin-quiz', title: 'Skin quiz', sessions: 80 },
  { hsr: 444, url: 'https://x.com/pages/find-your-fit', title: 'Fit finder', sessions: 60 },
  { hsr: 999, url: 'https://x.com/products/tiny', title: 'Tiny', sessions: 10 },
];
const site = { idsite: 1, siteName: 'x' };
const qualification = {
  status: 'qualified', idsitehsr: 222, url: 'https://x.com/pages/lp', pageType: 'content',
  entrySessions: 500, orders: 0, revenue: 0, evidence: { title: 'LP', unfiltered: { sessions: 520, orders: 0, revenue: 0 } },
};
const lpTargets = [
  { idsitehsr: 222, url: 'https://x.com/pages/lp', pageTitle: 'LP', pageType: 'content', role: 'primary', selectionReason: 'qualifier choice', entrySessions: 500, orders: 0, revenue: 0 },
];

function gateway() {
  let visit = 0;
  const sessions = PAGES.flatMap((page) => Array.from({ length: page.sessions }, () => {
    visit += 1;
    return {
      idvisit: String(visit), first_date: WEEK, week: WEEK, device: 1, referer: 2, returning: 0, entry_hsr: String(page.hsr),
      country: 'us', browser: 'Chrome', fp_hash: 'fp1', utm_source: '', pageviews: 2, capped_ms: 20000,
      saw_product: 0, saw_atc: 0, saw_checkout: 0, saw_purchase: 0, orders: 0, revenue: 0,
    };
  }));
  return {
    async query(_sql, _params, label) {
      if (label === 'sessions:entry') return sessions;
      if (label === 'urls:site-hsr-pages') return PAGES.map((p) => ({ hsr: String(p.hsr), url: p.url, title: p.title }));
      if (label.startsWith('bot:')) return [];
      throw new Error(`unexpected query: ${label}`);
    },
    async explain() { return 'plan'; },
    async columns() { return []; },
  };
}

const card = (strategy) => ({ dims: { strategy_id: strategy, segment_key: 'all' }, metrics: { verdict: 'include', trigger_state: 'triggered', trigger_evaluated: 1 } });

function datasets() {
  return [
    {
      id: 'fixture-page', dependsOn: [], scope: 'page', provides: [], descriptor: { id: 'fixture-page', replay: 'keep' },
      async collect(page) {
        return { id: 'fixture-page', rows: [{ dims: { week: WEEK }, metrics: { sessions: page.qualified.entrySessions } }], requirements: [{ key: 'H98', status: 'available', rowCount: 1 }] };
      },
    },
    {
      id: 'ad-creative', dependsOn: [], scope: 'page', provides: [], descriptor: { id: 'ad-creative', replay: 'keep' },
      async collect() { return { id: 'ad-creative', rows: [] }; },
    },
    { ...requirementStatus, dependsOn: [] },
    {
      id: 'fixture-site', dependsOn: [], scope: 'site', provides: [], descriptor: { id: 'fixture-site', replay: 'keep' },
      async collect(_page, ctx) {
        return { id: 'fixture-site', rows: [{ dims: { week: WEEK }, metrics: { pages: ctx.datasets.size } }] };
      },
    },
    {
      id: 'cards-pi', dependsOn: [], scope: 'page', provides: [], descriptor: { id: 'cards-pi', replay: 'recollect', role: 'card', catalogId: 'PI' },
      async collect(page) { return { id: 'cards-pi', rows: [card(`PI:${page.idsitehsr}`)] }; },
    },
    {
      id: 'cards-lp', dependsOn: [], scope: 'site', provides: [], descriptor: { id: 'cards-lp', replay: 'recollect', role: 'card', catalogId: 'LP' },
      async collect() { return { id: 'cards-lp', rows: [card('LP:S1')] }; },
    },
    {
      id: 'cards-qz', dependsOn: [], scope: 'page', provides: [], descriptor: { id: 'cards-qz', replay: 'recollect', role: 'card', catalogId: 'QZ' },
      async collect(page) { return { id: 'cards-qz', rows: [card(`QZ:${page.idsitehsr}`)] }; },
    },
  ];
}

/** The engine context the batch commands read, over one memory store. */
async function engine({ profiles = shipped } = {}) {
  const memory = createMemoryAePersistence();
  for (const page of PAGES) {
    await memory.adapter.completeCapture({ idsite: 1, idsitehsr: page.hsr, url: page.url, capturedOn: '2026-10-03', bindings: [] });
  }
  await memory.adapter.writeDescriptorRows([
    { idsite: 1, template_key: 'url:444', device_class: 'all', field_path: 'p12.tools', value_json: '["Fit finder quiz"]', provenance: 'dom', confidence: 'high' },
  ]);
  const ensured = [];
  const fixtures = {
    'site-sources': { id: 'fixture-sites', async listSites() { return [site]; } },
    qualifiers: { id: 'fixture-qualifier', async qualify() { return qualification; } },
    'page-selectors': { id: 'fixture-selector', async select() { return lpTargets; } },
    'traffic-exclusion': null,
  };
  const ctx = {
    config: { profile: 'lp', elementNamesPath: null, agents: { analysis: 1 }, dayScan: false },
    logger: { info() {}, warn() {}, error() {} },
    clock: { todayUtc: () => '2026-10-03' },
    telemetry: null,
    profiles: async () => profiles,
    segmentations: async () => SHIPPED,
    select(role, id) {
      if (role === 'subject-selectors') return subjectSelectors.find((s) => s.id === id);
      return fixtures[role];
    },
    adapters: (role) => (role === 'datasets' ? datasets() : []),
    async ensure(...names) { ensured.push(...names); },
    persistence: () => memory.adapter,
    gateway,
  };
  return { ctx, memory, ensured };
}

const TIME = /^\d{4}-\d\d-\d\d[ T]\d\d:\d\d/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The stored rows with the batch id, times, and claim tokens masked. */
function stored(snapshot, batchId) {
  const scrub = (value) => {
    if (value === batchId) return '<batch>';
    if (typeof value === 'string' && TIME.test(value)) return '<time>';
    if (typeof value === 'string' && UUID.test(value)) return '<uuid>';
    if (Array.isArray(value)) return value.map(scrub);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, k === 'claim_token' || k === 'claimedAt' ? '<claim>' : scrub(v)]));
    }
    return value;
  };
  return Object.fromEntries(Object.entries(snapshot).map(([name, rows]) => [
    name,
    scrub(rows).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  ]));
}

async function batchRun(flags) {
  const { ctx, memory } = await engine();
  const created = await createBatch.run(flags, ctx);
  const batchId = created.output.replace('batch_id: ', '');
  const ran = await runBatch.run({ batch: batchId }, ctx);
  return { batchId, counts: ran.output.counts, rows: stored(memory.snapshot(), batchId), memory };
}

describe('batch commands under a profile', () => {
  it('--profile lp stores the rows a batch without --profile stores', async () => {
    const plain = await batchRun({});
    const lp = await batchRun({ profile: 'lp' });
    expect(lp.rows).toEqual(plain.rows);
    expect(plain.counts).toMatchObject({ queued: 1, qualified: 1, pagesAnalyzed: 1 });
    expect(plain.rows.batches[0]).toMatchObject({ profile: 'lp', subject_type: 'page', page_selector: 'fixture-selector' });
    expect(plain.rows.subjectTargets.map((t) => [t.subject_type, t.subject_key, t.label]))
      .toEqual([['page', '222', 'https://x.com/pages/lp']]);
    expect(plain.rows.strategyCards.map((c) => c.strategy_id).sort()).toEqual(['LP:S1', 'PI:222']);
    expect(plain.rows.analysisCheckpoints.map((c) => c.dataset_id)).toContain('ad-creative');
  });

  it('pdp selects product pages by kind and keeps only its catalogs\' cards', async () => {
    const { batchId, counts, rows } = await batchRun({ profile: 'pdp' });
    expect(counts).toMatchObject({ qualified: 1, pagesAnalyzed: 2 });
    expect(rows.pageTargets.map((t) => t.idsitehsr)).toEqual([555, 888]);
    expect(rows.subjectTargets.map((t) => [t.subject_key, t.selection_reason])).toEqual([
      ['555', 'product page by entry sessions (300 exclude_confirmed sessions)'],
      ['888', 'product page by entry sessions (100 exclude_confirmed sessions)'],
    ]);
    expect(rows.strategyCards.map((c) => c.strategy_id)).toEqual(['PI:555', 'PI:888']);
    expect(rows.analysisCheckpoints.map((c) => c.dataset_id)).not.toContain('ad-creative');
    expect(rows.batches[0]).toMatchObject({ profile: 'pdp', subject_type: 'page', page_selector: 'page-by-kind', catalogs: ['PI', 'PG'] });
    expect(JSON.parse(rows.batches[0].metadata).criteria).toEqual({ kinds: ['product'], minEntrySessions: 100 });
    expect(batchId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('--select overrides the profile criteria', async () => {
    const { rows } = await batchRun({ profile: 'pdp', select: '{"minEntrySessions": 300}' });
    expect(rows.pageTargets.map((t) => t.idsitehsr)).toEqual([555]);
    expect(JSON.parse(rows.batches[0].metadata).criteria).toEqual({ kinds: ['product'], minEntrySessions: 300 });
  });

  it('collection runs the general page catalog over collection pages', async () => {
    const { rows } = await batchRun({ profile: 'collection' });
    expect(rows.pageTargets.map((t) => t.idsitehsr)).toEqual([666]);
    expect(rows.strategyCards).toEqual([]);
    expect(rows.batches[0].catalogs).toEqual(['PO']);
  });

  it('quiz selects quiz pages by URL, then by descriptor, as quiz subjects', async () => {
    const { counts, rows } = await batchRun({ profile: 'quiz' });
    expect(counts).toMatchObject({ qualified: 1, pagesAnalyzed: 2 });
    expect(rows.batches[0]).toMatchObject({ profile: 'quiz', subject_type: 'quiz', page_selector: 'quiz-pages', catalogs: ['PI', 'QZ'] });
    expect(rows.subjectTargets.map((t) => [t.subject_type, t.subject_key, t.selection_reason])).toEqual([
      ['quiz', '444', 'descriptor p12.tools names "quiz" (60 exclude_confirmed sessions)'],
      ['quiz', '777', 'URL holds "quiz" (80 exclude_confirmed sessions)'],
    ]);
    expect(rows.strategyCards.map((c) => c.strategy_id).sort()).toEqual(['PI:444', 'PI:777', 'QZ:444', 'QZ:777']);
    const subjectRows = rows.datasetRows.filter((r) => r.idsitehsr > 0);
    expect(new Set(subjectRows.map((r) => `${r.subject_type}:${r.subject_key}`))).toEqual(new Set(['quiz:444', 'quiz:777']));
    expect(new Set(rows.datasetRows.filter((r) => r.idsitehsr === 0).map((r) => r.subject_key))).toEqual(new Set(['']));
    expect(rows.analysisCheckpoints.map((c) => c.dataset_id)).not.toContain('ad-creative');
  });

  it('lp leaves the quiz catalog to the quiz profile', async () => {
    const { rows } = await batchRun({ profile: 'lp' });
    expect(rows.batches[0].catalogs).toEqual(['LP', 'PG', 'PI', 'PO', 'TD', 'TG', 'TI']);
    expect(rows.strategyCards.map((c) => c.strategy_id)).not.toContain('QZ:222');
  });

  it('refuses criteria outside the selector schema before anything is written', async () => {
    const { ctx, memory, ensured } = await engine();
    await expect(createBatch.run({ profile: 'pdp', select: '{"kind": "product"}' }, ctx))
      .rejects.toThrow(/profile "pdp": invalid criteria: .*kind.*; criteria schema: \{"type":"object"/);
    await expect(createBatch.run({ select: '{"kinds": ["product"]}' }, ctx)).rejects.toThrow(/profile "lp": invalid criteria/);
    await expect(createBatch.run({ profile: 'pdp', select: '{nope' }, ctx)).rejects.toThrow(/--select is not JSON/);
    await expect(createBatch.run({ profile: 'pdp', catalogs: 'LP' }, ctx)).rejects.toThrow(/catalogs LP are outside profile "pdp": PI, PG/);
    await expect(createBatch.run({ profile: 'quizzes' }, ctx)).rejects.toThrow(/unknown profile "quizzes"; profiles: collection, experiment, funnel, journey, lp, pdp, quiz/);
    expect(ensured).toEqual([]);
    expect(memory.snapshot().batches).toEqual([]);
  });

  it('refuses to run a batch whose profile changed after it was created', async () => {
    const { ctx } = await engine();
    const created = await createBatch.run({ profile: 'pdp' }, ctx);
    const batchId = created.output.replace('batch_id: ', '');
    const edited = parseProfile({
      id: 'pdp', subject_type: 'page', label: 'Product detail pages',
      selector: { use: 'page-by-kind', criteria: { kinds: ['product'] } },
      datasets: { include: ['provides'], exclude: ['ad-creative'] }, catalogs: ['PI'],
      steps: ['qualify', 'capture-gate', 'page-datasets', 'descriptors', 'site-datasets', 'analysis'],
    }, { file: 'pdp.profile.json', catalogIds: CATALOGS });
    ctx.profiles = async () => new Map([...shipped, ['pdp', edited]]);
    await expect(runBatch.run({ batch: batchId }, ctx)).rejects.toThrow(/profile "pdp" changed after batch .* was created/);
  });

  it('runs a batch from before profiles as lp', async () => {
    const { ctx, memory } = await engine();
    await memory.adapter.createBatch({ batchId: '00000000-0000-4000-8000-000000000001', windowStart: '2026-09-26', windowEnd: '2026-10-02', status: 'running' });
    const ran = await runBatch.run({ batch: '00000000-0000-4000-8000-000000000001' }, ctx);
    expect(ran.output.counts).toMatchObject({ qualified: 1, pagesAnalyzed: 1 });
  });
});
