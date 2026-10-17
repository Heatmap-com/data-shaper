import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { discoverDatasets } from '../../src/discover.js';
import { datasetGroups } from '../../src/site-analysis/roles.js';

/**
 * The page pass serves a page dataset its page's entry sessions (or, with
 * `sessions: 'viewed'`, the sessions that viewed the page) where the window
 * query returned every session of the site. That is the same result only
 * when the dataset reads nothing else from the other sessions. Each page
 * dataset here gets window-shaped rows whose other sessions throw on any
 * field but the two a dataset filters by.
 */

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'adapters', 'datasets');
const PAGE = { idsite: 7, idsitehsr: 12, url: 'https://x.com/products/a', pageType: 'product', siteName: 'x', qualified: {}, unfiltered: {} };
const FILTER_FIELDS = new Set(['idvisit', 'entryHsr']);

function session(idvisit, entryHsr) {
  return {
    idvisit, firstDate: '2026-09-08', week: '2026-09-07', device: 1, referer: 2, returning: 0, entryHsr,
    country: 'us', browser: 'CH', utmSource: '', pageviews: 2, cappedMs: 1000, sawProduct: true,
    sawAtc: false, sawCheckout: false, sawPurchase: false, orders: 0, revenue: 0, tier: null, rescued: false,
    scrollMax: 50, landingPageviews: 1, pageCappedMs: 500,
  };
}

/** A row whose fields beyond the filter fields throw when read. */
function poisoned(row, datasetId) {
  return new Proxy(row, {
    get(target, prop) {
      if (typeof prop === 'symbol' || FILTER_FIELDS.has(prop)) return target[prop];
      throw new Error(`${datasetId} read "${String(prop)}" of a session off the page`);
    },
    ownKeys() {
      throw new Error(`${datasetId} copied a session off the page`);
    },
  });
}

describe('page datasets on the page pass', async () => {
  const datasets = datasetGroups(await discoverDatasets(root)).page.filter((d) => d.pass !== 'site');

  it.each(datasets.map((d) => [d.id, d]))('%s reads only its page\'s sessions', async (id, dataset) => {
    // Visits 1..3 entered on the page; visit 4 viewed it after entering
    // elsewhere (kept for 'viewed' datasets); visits 5..6 never touched it.
    const viewedIds = dataset.sessions === 'viewed' ? new Set(['1', '2', '3', '4']) : new Set(['1', '2', '3']);
    const all = [session('1', '12'), session('2', '12'), session('3', '12'), session('4', '11'), session('5', '11'), session('6', '0')];
    const rows = all.map((row) => (viewedIds.has(row.idvisit) ? row : poisoned(row, id)));
    const ctx = {
      batchId: '00000000-0000-0000-0000-000000000001',
      windowStart: '2026-09-07',
      windowEnd: '2026-09-20',
      gateway: { async query() { return []; }, async columns() { return []; } },
      batchNotes: new Map([['bot:7', Promise.resolve({ tierOf: () => null, notes: {} })]]),
      logger: { info() {}, warn() {} },
      datasets: new Map(),
      pageTargets: [],
      persistence: null,
      sessionSource: { rows: async () => rows },
    };
    const outcome = await dataset.collect(PAGE, ctx).then(() => 'ok', (err) => String(err.message));
    expect(outcome).not.toMatch(/off the page/);
  });
});
