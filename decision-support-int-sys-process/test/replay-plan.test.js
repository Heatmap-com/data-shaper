import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { adaptersIn, discoverAdapterRoles } from '../src/discover.js';
import { replaySite, resolveReplayPlan } from '../src/replay.js';

/**
 * Characterization of the replay plan over the discovered datasets: which
 * datasets are restamped, deleted, and recollected, in what order the
 * readers run, and what the result reports as kept.
 */

const adaptersDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'adapters');
const roles = await discoverAdapterRoles(adaptersDir);
const discovered = adaptersIn(roles, 'datasets');
const botDraft = adaptersIn(roles, 'descriptor-sources').find((source) => source.id === 'bot-draft');

const PAGE = { idsite: 9, idsitehsr: 5, url: 'https://shop.test/', windowStart: '2026-09-10', windowEnd: '2026-10-09', templateFamily: '' };
const BATCH = '9bbe0ed1-184c-469a-9f56-cae8426b94c2';

function stubs(calls) {
  return discovered.map((dataset) => ({
    id: dataset.id,
    scope: dataset.scope,
    dependsOn: dataset.dependsOn,
    descriptor: dataset.descriptor,
    async collect(page) {
      calls.push(`${dataset.id}@${page.idsitehsr}`);
      return { id: dataset.id, rows: [] };
    },
  }));
}

function recordingStore(log) {
  return {
    async deleteDatasetRows(spec) { log.push(['delete', [...spec.datasetIds].sort()]); },
    async writeDatasetRows(rows) { log.push(['writeDatasetRows', [...new Set(rows.map((r) => r.datasetId))].sort()]); },
    async writeDescriptorRows(rows) { log.push(['writeDescriptorRows', rows.length]); },
    async writeRequirementStatus(rows) { log.push(['writeRequirementStatus', rows.length]); },
    async writeCards(rows) { log.push(['writeCards', rows.length]); },
    async writePageAnalysis(row) { log.push(['writePageAnalysis', row.idsitehsr]); },
    async writeSiteAnalysis(row) { log.push(['writeSiteAnalysis', row.idsite]); },
  };
}

async function replay(datasetIds) {
  const calls = [];
  const log = [];
  const draft = async (page) => {
    calls.push(`bot-draft@${page.idsitehsr}`);
    return [];
  };
  const stored = discovered.map((dataset) => ({
    datasetId: dataset.id,
    idsitehsr: dataset.scope === 'site' ? 0 : PAGE.idsitehsr,
    scope: dataset.scope ?? 'page',
    dims: { selector: '#a', element_class: '' },
    metrics: { sessions: 1 },
    generatedAt: '2026-10-10 12:00:00.000',
  }));
  const result = await replaySite({
    batchId: BATCH,
    idsite: PAGE.idsite,
    datasetIds,
    stored,
    bindings: new Map([[String(PAGE.idsitehsr), new Map([['#a', 'hero_cta']])]]),
    datasets: stubs(calls),
    descriptorSources: [{ ...botDraft, draft }],
    draft,
    pages: [PAGE],
    siteAnalysis: { batchId: BATCH, idsite: PAGE.idsite },
    persistence: recordingStore(log),
    catalogs: { strategies: {} },
  });
  return { calls, log, result: { ...result, kept: [...result.kept].sort() } };
}

describe('replay plan characterization', () => {
  it('derives the full plan from the discovered datasets', () => {
    const plan = resolveReplayPlan(null, discovered, [botDraft]);
    expect({ restamp: [...plan.restamp].sort(), recollect: [...plan.recollect].sort() }).toMatchSnapshot();
  });

  it('runs the full replay in its phase order', async () => {
    expect(await replay(null)).toMatchSnapshot();
  });

  it('runs a requested subset', async () => {
    expect(await replay(['rage-clicks', 'structural-screen', 'cards-lp'])).toMatchSnapshot();
  });

  it('refuses a kept dataset and an unknown one', () => {
    expect(() => resolveReplayPlan(['journey-weekly'], discovered)).toThrow(/refused/);
    expect(() => resolveReplayPlan(['no-such-dataset'], discovered)).toThrow(/refused/);
  });
});
