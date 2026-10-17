import { beforeAll, describe, expect, it } from 'vitest';
import { adapter as campaignCoverage } from '../../src/adapters/datasets/campaign-coverage.js';
import { adapter as campaignWeekly } from '../../src/adapters/datasets/campaign-weekly.js';
import { adapter as experimentsWeekly } from '../../src/adapters/datasets/experiments-weekly.js';
import { adapter as journeyWeekly } from '../../src/adapters/datasets/journey-weekly.js';
import { adapter as navNextPage } from '../../src/adapters/datasets/nav-next-page.js';
import { adapter as pageSegmentWeekly } from '../../src/adapters/datasets/page-segment-weekly.js';
import { adapter as selectorWeekly } from '../../src/adapters/datasets/selector-weekly.js';
import { adapter as viewportWeekly } from '../../src/adapters/datasets/viewport-weekly.js';
import { runSitePass } from '../../src/scan/passes.js';
import { makeCtx, makePageCtx } from '../../src/site-analysis/context.js';
import { createLocalWarehouse } from '../support/local-warehouse.js';
import { BOT, IDSITE, warehouseRows } from '../support/site-fixture.js';

/**
 * The datasets that read the per-page loads (pageview sequences, session
 * tags, viewport heights, clicks) and the partner-tag scan, over
 * `clickhouse local`. Recorded on the site-wide loads; the page-scoped
 * loads and the partner-tag folder reproduce the snapshot.
 */

const window = { batchId: 'b', windowStart: '2026-09-08', windowEnd: '2026-09-14', standards: {} };
const PAGE_DATASETS = [campaignCoverage, campaignWeekly, viewportWeekly, pageSegmentWeekly, journeyWeekly, selectorWeekly, navNextPage];
const logger = { info() {}, warn() {}, error() {} };

/** @param {object} result */
function settled(result) {
  const byJson = (a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b));
  return { rows: [...result.rows].sort(byJson), notes: result.notes ?? {}, requirements: result.requirements ?? [] };
}

function localGateway() {
  const warehouse = createLocalWarehouse(warehouseRows());
  const gateway = {
    calls: warehouse.calls,
    columns: warehouse.columns,
    async query(sql, params, label) {
      if (sql.includes('journey_events.')) {
        warehouse.calls.push(label);
        return label === 'element-binding' ? ['s0', 's1', 's2'].map((selector) => ({ selector, element_class: 'cta', name: selector })) : [];
      }
      return warehouse.query(sql, params, label);
    },
  };
  return gateway;
}

async function collectAll() {
  const gateway = localGateway();
  const deps = { gateway, logger, catalogs: [] };
  const batchNotes = new Map([[`bot:${IDSITE}`, Promise.resolve(BOT)]]);
  const out = {};
  for (const idsitehsr of [12, 15]) {
    const page = { idsite: IDSITE, idsitehsr, siteName: 'one', url: '', pageTitle: '', pageType: '' };
    const ctx = makePageCtx(window, deps, [], page, batchNotes);
    for (const dataset of PAGE_DATASETS) {
      const result = await dataset.collect(page, ctx);
      ctx.datasets.set(result.id, result);
      out[`${idsitehsr}:${result.id}`] = settled(result);
    }
  }
  const siteCtx = makeCtx(window, deps, batchNotes);
  out['0:experiments-weekly'] = settled(await experimentsWeekly.collect({ idsite: IDSITE, idsitehsr: 0, siteName: 'one' }, siteCtx));
  return { out, labels: gateway.calls };
}

describe('per-page loads', () => {
  let run;
  beforeAll(async () => {
    run = await collectAll();
  }, 240_000);

  it('produce the rows recorded on the site-wide loads', () => {
    for (const [key, result] of Object.entries(run.out)) {
      expect(result, key).toMatchSnapshot(key);
    }
  });

  it('experiments-weekly folds the same rows on the site pass', async () => {
    const gateway = localGateway();
    const ctx = makeCtx(window, { gateway, logger, catalogs: [] }, new Map([[`bot:${IDSITE}`, Promise.resolve(BOT)]]));
    const sitePage = { idsite: IDSITE, idsitehsr: 0, siteName: 'one' };
    const folder = await experimentsWeekly.open(sitePage, ctx);
    expect(folder.partnerTags).toBe(true);
    await runSitePass({ gateway, idsite: IDSITE, window, bot: BOT, folders: [folder] });
    expect(settled(await folder.finish(sitePage, ctx))).toEqual(run.out['0:experiments-weekly']);
    expect(gateway.calls).not.toContain('experiments-weekly:partner-tags');
    expect(gateway.calls.filter((label) => label.startsWith('sessions:'))).toEqual([]);
  }, 120_000);

  it('cover every dataset with rows', () => {
    const empty = Object.entries(run.out).filter(([, result]) => result.rows.length === 0).map(([key]) => key);
    expect(empty).toEqual([]);
  });
});
