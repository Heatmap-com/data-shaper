import { describe, expect, it } from 'vitest';
import { replaySite, resolveReplayPlan } from '../src/replay.js';

const anchor = 'main#MainContent > div:nth-child(1) > div > div > a';

/** @param {'keep' | 'restamp' | 'recollect'} replay */
const plan = (replay) => ({ descriptor: { replay } });

/** A replay store whose unlisted writes are no-ops. */
function store(overrides = {}) {
  return {
    async deleteDatasetRows() {},
    async writeDatasetRows() {},
    async writeDescriptorRows() {},
    async writeRequirementStatus() {},
    async writeCards() {},
    async writePageAnalysis() {},
    async writeSiteAnalysis() {},
    ...overrides,
  };
}

describe('replay', () => {
  it('refuses a dataset whose query already succeeded', () => {
    expect(() => resolveReplayPlan(['journey-weekly'], [{ id: 'journey-weekly', ...plan('keep') }])).toThrow(/refused/);
  });

  it('refuses a persistence adapter that lacks a replay write', async () => {
    const partial = store();
    delete partial.writeCards;
    await expect(replaySite({ batchId: 'b', idsite: 1, persistence: partial })).rejects.toThrow(/lacks writeCards/);
  });

  it('restamps a click row and does not recollect a kept dataset', async () => {
    const calls = [];
    const written = [];
    const deleted = [];
    const stored = [
      {
        datasetId: 'journey-weekly',
        idsitehsr: 5,
        scope: 'page',
        dims: { week: '2026-09-14', device: 'desktop' },
        metrics: { sessions: 10 },
        generatedAt: '2026-10-10 12:00:00.000',
      },
      {
        datasetId: 'selector-weekly',
        idsitehsr: 5,
        scope: 'page',
        dims: {
          week: '2026-09-14',
          selector: anchor,
          device: 'desktop',
          bot_filter: 'exclude_confirmed',
          element_class: '',
          element_id: 'old',
        },
        metrics: { clicks: 40, clicking_sessions: 12 },
        generatedAt: '2026-10-10 12:00:00.000',
      },
    ];
    const datasets = [
      {
        id: 'journey-weekly',
        ...plan('keep'),
        async collect() {
          calls.push('journey-weekly');
          return { id: 'journey-weekly', rows: [] };
        },
      },
      {
        id: 'selector-weekly',
        ...plan('restamp'),
        async collect() {
          calls.push('selector-weekly');
          return { id: 'selector-weekly', rows: [] };
        },
      },
      {
        id: 'strategy-triggers',
        scope: 'page',
        ...plan('recollect'),
        async collect(_page, ctx) {
          calls.push('strategy-triggers');
          const row = ctx.datasets.get('selector-weekly').rows[0];
          return {
            id: 'strategy-triggers',
            rows: [{
              dims: { strategy_id: 'B4', element_class: row.dims.element_class },
              metrics: { clicks: row.metrics.clicks, verdict: 'silent', trigger_state: 'silent' },
            }],
          };
        },
      },
    ];
    await replaySite({
      batchId: '9bbe0ed1-184c-469a-9f56-cae8426b94c2',
      idsite: 5795,
      datasetIds: ['selector-weekly', 'strategy-triggers'],
      stored,
      bindings: new Map([['5', new Map([[anchor, 'hero_cta']])]]),
      datasets,
      pages: [{ idsite: 5795, idsitehsr: 5, url: 'https://dvf.com', windowStart: '2026-09-10', windowEnd: '2026-10-09' }],
      persistence: store({
        async deleteDatasetRows(spec) { deleted.push(spec); },
        async writeDatasetRows(rows) { written.push(...rows); },
      }),
      catalogs: { strategies: {} },
    });
    expect(calls).toEqual(['strategy-triggers']);
    expect(deleted[0].datasetIds).toContain('selector-weekly');
    expect(deleted[0].datasetIds).not.toContain('journey-weekly');
    const stamped = written.find((row) => row.datasetId === 'selector-weekly');
    expect(stamped.dimElementClass).toBe('hero_cta');
    expect(stamped.metrics.clicks).toBe(40);
  });

  it('gives a click inside the hero control the hero class and leaves other inner nodes alone', async () => {
    const written = [];
    const image = `${anchor} > div > picture > img`;
    const span = 'header > nav > a > span';
    await replaySite({
      batchId: '9bbe0ed1-184c-469a-9f56-cae8426b94c2',
      idsite: 5795,
      datasetIds: ['selector-weekly'],
      stored: [
        row(image, 318),
        row(span, 20),
      ],
      bindings: new Map([[
        '5',
        new Map([
          [anchor, 'hero_cta'],
          ['header > nav > a', 'nav_link'],
        ]),
      ]]),
      datasets: [{ id: 'selector-weekly', ...plan('restamp') }],
      pages: [],
      persistence: store({
        async writeDatasetRows(rows) { written.push(...rows); },
      }),
      catalogs: { strategies: {} },
    });
    const bySel = Object.fromEntries(written.map((r) => [r.dimSelector, r.dimElementClass]));
    expect(bySel[image]).toBe('hero_cta');
    expect(bySel[span]).toBe('');
    expect(written.find((r) => r.dimSelector === image).metrics.clicks).toBe(318);
  });

  it('gives the descriptor snapshot the replayed page', async () => {
    let targets = null;
    await replaySite({
      batchId: '9bbe0ed1-184c-469a-9f56-cae8426b94c2',
      idsite: 5795,
      datasetIds: ['descriptor-snapshot'],
      stored: [],
      bindings: new Map(),
      datasets: [{
        id: 'descriptor-snapshot',
        scope: 'site',
        ...plan('recollect'),
        async collect(_page, ctx) {
          targets = ctx.pageTargets;
          return { id: 'descriptor-snapshot', rows: [] };
        },
      }],
      pages: [{ idsite: 5795, idsitehsr: 51247422, url: 'https://dvf.com', templateFamily: '' }],
      persistence: store(),
      catalogs: { strategies: {} },
    });
    expect(targets.map((page) => page.idsitehsr)).toEqual([51247422]);
  });
});

function row(selector, clicks) {
  return {
    datasetId: 'selector-weekly',
    idsitehsr: 5,
    scope: 'page',
    dims: { selector, element_class: '', week: '2026-09-14', device: 'desktop', bot_filter: 'exclude_confirmed' },
    metrics: { clicks },
  };
}
