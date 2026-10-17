import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { adaptersIn, discoverAdapterRoles } from '../src/discover.js';
import { createMemoryAePersistence } from '../src/adapters/persistence/memory.js';
import { createBatch, runBatch } from '../src/application/commands/batch.js';
import { loadCatalog } from '../src/catalog/index.js';
import { loadProfiles } from '../src/composition/registries.js';
import { SHIPPED } from './support/segmentations.js';
import { runSiteSteps } from '../src/site-analysis/steps.js';

/**
 * The experiment profile on the memory store: its selector chooses the
 * site's experiments by criteria, the subject datasets read each one out
 * and card it, and every row carries the experiment's subject key. A site
 * without partner tags is skipped with no_experiments.
 */

const roles = await discoverAdapterRoles(path.resolve('src/adapters'));
const datasets = adaptersIn(roles, 'datasets');
const subjectSelectors = adaptersIn(roles, 'subject-selectors');
const CATALOGS = Object.keys(loadCatalog().strategies);
const profiles = await loadProfiles(path.resolve('profiles'), CATALOGS);

const site = { idsite: 1, siteName: 'x' };
const EXP_A = 'exp:shoplift:exp-a';
const EXP_B = 'exp:shoplift:exp-b';

/** @param {string} start @param {number} n @param {object} row */
function days(start, n, row) {
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(`${start}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + i);
    return { day: d.toISOString().slice(0, 10), ...row };
  });
}

/** exp-a runs to the window end; exp-b ended a month before it, with more visits. */
const TAG_DAYS = [
  ...days('2026-10-01', 10, { partner: 'shoplift', experience_id: 'exp-a', variant_id: 'control', friendly_name: 'Hero Test', visits: 1000 }),
  ...days('2026-10-01', 10, { partner: 'shoplift', experience_id: 'exp-a', variant_id: 'sl-ABC', friendly_name: 'Big hero', visits: 1000 }),
  ...days('2026-08-20', 22, { partner: 'shoplift', experience_id: 'exp-b', variant_id: 'control', friendly_name: 'Cart Test', visits: 1000 }),
  ...days('2026-08-20', 22, { partner: 'shoplift', experience_id: 'exp-b', variant_id: 'sl-DEF', friendly_name: 'Drawer', visits: 1000 }),
];

/** Per chosen experiment: control 1000 sessions 50 buyers, variant 600 sessions 60 buyers (an SRM failure). */
function facts(count) {
  return Array.from({ length: count }, (_, exp) => [
    { exp, arm_index: 0, day: '2026-10-01', basis: 'assigned', viewport_type: 'all', segment: 'all', segment_value: 'all', sessions: 1000, buyers: 50, orders: 50, revenue: 5000, revenue_sq: 500_000, progressed: 120 },
    { exp, arm_index: 1, day: '2026-10-01', basis: 'assigned', viewport_type: 'all', segment: 'all', segment_value: 'all', sessions: 600, buyers: 60, orders: 60, revenue: 6000, revenue_sq: 600_000, progressed: 90 },
  ]).flat();
}

function gateway({ tagDays = TAG_DAYS } = {}) {
  const labels = [];
  return {
    labels,
    async columns(table) {
      const names = table === 'udp_partner_tags'
        ? ['experience_id', 'variant_id', 'friendly_name', 'partner', 'server_date', 'idvisit', 'idloghsr']
        : table === 'section_level_data'
          ? ['event_type', 'idvisit', 'idsitehsr', 'section_name', 'section_path', 'element_selector', 'server_date']
          : [];
      return names.map((name) => ({ name, type: 'String' }));
    },
    async query(_sql, params, label) {
      labels.push(label);
      switch (label) {
        case 'experiment:tag-days': return tagDays;
        case 'experiment:surface': return [];
        case 'experiment:registry': return [];
        case 'experiment:declared-table': return [{ n: 0 }];
        case 'experiment:facts': return facts(params.starts.length);
        case 'experiment:sections':
        case 'experiment:elements': return [];
        default: throw new Error(`unexpected query: ${label}`);
      }
    },
    async explain() { return 'plan'; },
  };
}

function engine(gw = gateway()) {
  const memory = createMemoryAePersistence();
  const ctx = {
    config: { profile: 'lp', elementNamesPath: null, agents: { analysis: 1 }, dayScan: false },
    logger: { info() {}, warn() {}, error() {} },
    clock: { todayUtc: () => '2026-10-11' },
    telemetry: null,
    profiles: async () => profiles,
    segmentations: async () => SHIPPED,
    select(role, id) {
      if (role === 'subject-selectors') return subjectSelectors.find((s) => s.id === id);
      if (role === 'site-sources') return { id: 'fixture-sites', async listSites() { return [site]; } };
      if (role === 'qualifiers') return { id: 'fixture-qualifier', async qualify() { throw new Error('the experiment profile runs no qualifier'); } };
      if (role === 'page-selectors') return { id: 'fixture-selector', async select() { return []; } };
      return null;
    },
    adapters: (role) => (role === 'datasets' ? datasets : []),
    async ensure() {},
    persistence: () => memory.adapter,
    gateway: () => gw,
  };
  return { ctx, memory, gw };
}

async function batchRun(flags, gw) {
  const { ctx, memory } = engine(gw);
  const created = await createBatch.run({ profile: 'experiment', ...flags }, ctx);
  const batchId = created.output.replace('batch_id: ', '');
  const ran = await runBatch.run({ batch: batchId }, ctx);
  return { batchId, counts: ran.output.counts, snap: memory.snapshot(), memory };
}

describe('the experiment profile', () => {
  it('selects the active experiment, reads it out, and cards it under its subject key', async () => {
    const { counts, snap } = await batchRun({});
    expect(counts).toMatchObject({ qualified: 1, skipped: 0, pagesAnalyzed: 1 });
    expect(snap.batches[0]).toMatchObject({ profile: 'experiment', subject_type: 'experiment', page_selector: 'active-experiments', catalogs: ['XP'] });
    expect(snap.subjectTargets.map((t) => [t.subject_type, t.subject_key, t.label, t.status])).toEqual([
      ['experiment', EXP_A, 'Hero Test', 'analyzed'],
    ]);
    expect(snap.pageTargets).toEqual([]);
    expect(snap.pageAnalyses).toEqual([]);
    expect(snap.captureQueue).toEqual([]);

    const readout = snap.datasetRows.filter((r) => r.dataset_id === 'experiment-readout');
    expect(readout.length).toBeGreaterThan(0);
    expect(readout.every((r) => r.subject_type === 'experiment' && r.subject_key === EXP_A && r.idsitehsr === 0 && r.scope === 'subject')).toBe(true);
    expect(snap.experimentRows.length).toBeGreaterThan(0);

    const cards = snap.strategyCards;
    expect(cards.map((c) => c.strategy_id).sort()).toEqual(['XP:A1', 'XP:A2', 'XP:A3', 'XP:A4']);
    expect(cards.every((c) => c.subject_key === EXP_A && c.segment_key === EXP_A && c.catalog_id === 'XP')).toBe(true);
    expect(cards.find((c) => c.strategy_id === 'XP:A1')).toMatchObject({ verdict: 'conditional', trigger_state: 'triggered' });

    expect(snap.analysisCheckpoints.map((c) => [c.dataset_id, c.idsitehsr, c.scope]).sort()).toEqual([
      ['cards-xp', 0, 'subject'],
      ['experiment-readout', 0, 'subject'],
    ]);
    const siteRow = snap.siteAnalyses[0];
    expect(siteRow.status).toBe('analyzed');
    expect(JSON.parse(siteRow.metadata).subjects).toEqual([{ type: 'experiment', key: EXP_A, status: 'analyzed' }]);
  });

  it('keeps each experiment apart when the criteria choose two', async () => {
    const { counts, snap } = await batchRun({ select: '{"state": "all"}' });
    expect(counts.pagesAnalyzed).toBe(2);
    expect(snap.subjectTargets.map((t) => t.subject_key)).toEqual([EXP_B, EXP_A]);
    const keys = new Set(snap.datasetRows.filter((r) => r.dataset_id === 'experiment-readout').map((r) => r.subject_key));
    expect(keys).toEqual(new Set([EXP_A, EXP_B]));
    expect(snap.strategyCards).toHaveLength(8);
    expect(new Set(snap.strategyCards.map((c) => c.segment_key))).toEqual(new Set([EXP_A, EXP_B]));
  });

  it('chooses one experiment by key, ended or not', async () => {
    const { snap } = await batchRun({ select: '{"state": "ended", "experiment": "shoplift:exp-b"}' });
    expect(snap.subjectTargets.map((t) => [t.subject_key, t.label])).toEqual([[EXP_B, 'Cart Test']]);
    expect(JSON.parse(snap.subjectTargets[0].dims)).toEqual({ state: 'ended', partner: 'shoplift' });
  });

  it('skips a site without partner tags as no_experiments', async () => {
    const { counts, snap } = await batchRun({}, gateway({ tagDays: [] }));
    expect(counts).toMatchObject({ skipped: 1, failed: 0, pagesAnalyzed: 0 });
    expect(snap.siteQueue[0]).toMatchObject({ status: 'skipped', reason: 'no_experiments' });
    expect(snap.subjectTargets).toEqual([]);
    expect(snap.datasetRows).toEqual([]);
  });

  it('resumes the subject datasets from their checkpoints', async () => {
    const gw = gateway();
    const { batchId, snap, memory } = await batchRun({ select: '{"state": "all"}' }, gw);
    const batch = await memory.adapter.getBatch(batchId);
    const profile = profiles.get('experiment');
    const selector = subjectSelectors.find((s) => s.id === 'active-experiments');
    const deps = {
      persistence: memory.adapter,
      gateway: gw,
      logger: { info() {}, warn() {}, error() {} },
      clock: { todayUtc: () => '2026-10-11' },
      datasets: datasets.filter((d) => profile.datasets.include.includes(d.id)),
      subjectSelector: { id: selector.id, select: (s, q, c) => selector.select(s, q, c, { state: 'all' }) },
      subjectType: 'experiment',
    };
    gw.labels.length = 0;
    const run = await runSiteSteps(profile.steps, { site, window: batch, deps });
    expect(run.outcome).toBe('analyzed');
    expect(gw.labels).not.toContain('experiment:facts');
    const again = memory.snapshot();
    expect(again.datasetRows).toEqual(snap.datasetRows);
    expect(again.strategyCards.map((c) => c.card_json)).toEqual(snap.strategyCards.map((c) => c.card_json));
  });
});
