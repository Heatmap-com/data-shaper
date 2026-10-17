import { randomUUID } from 'node:crypto';
import { mergeNotes, toDatasetRows } from './adapters/_lib/rows.js';
import { isNamingFresh } from './domain/naming-freshness.js';

/**
 * The pipeline: site source -> site_queue -> qualifier -> dataset adapters
 * -> analysis row. Single process, one site at a time, one idsite per query.
 * A failed site is recorded and the batch continues.
 *
 * IMPLEMENTATION-PLAN.md sections 1 and 5.
 *
 * @deprecated The v1 pipeline (plan R4.3), called only by src/index.js.
 * src/runner-ae.js is the schema-2 pipeline. This module is removed in
 * phase 5 with the v1 CLI.
 */

/**
 * @param {{qualifier: {config: {minHits?: number}}, datasets: object[]}} deps
 */
function batchMetadata(deps) {
  return {
    schema_version: 1,
    datasets: deps.datasets.map((d) => d.id),
    min_hits: deps.qualifier.config.minHits ?? null,
    volume_gate: 'page_hits',
  };
}

/**
 * Seven complete UTC days ending yesterday. The partial current day is
 * excluded; the Clock supplies today so tests never call Date.now().
 * @param {import('./ports/dataset.js').Clock} clock
 */
export function computeWindow(clock) {
  const today = clock.todayUtc();
  const end = new Date(`${today}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() - 1);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 6);
  return { windowStart: start.toISOString().slice(0, 10), windowEnd: end.toISOString().slice(0, 10) };
}

/**
 * @param {object} deps
 * @param {object} deps.persistence
 * @param {object} deps.qualifier
 * @param {object[]} deps.datasets topologically sorted
 * @param {object} deps.logger
 * @param {import('./ports/dataset.js').Clock} deps.clock
 * @param {import('./ports/dataset.js').RunContext['gateway']} deps.gateway
 * @param {string} deps.siteSourceId
 * @param {{windowStart: string, windowEnd: string}} [deps.window] defaults to the last 7 complete days
 */
export async function createBatch(deps) {
  const { windowStart, windowEnd } = deps.window ?? computeWindow(deps.clock);
  const batchId = randomUUID();
  await deps.persistence.createBatch({
    batchId,
    windowStart,
    windowEnd,
    siteSource: deps.siteSourceId,
    qualifier: deps.qualifier.id,
    minSessions: deps.qualifier.config.minSessions,
    minOrders: deps.qualifier.config.minOrders,
    minShareOfHome: deps.qualifier.config.minShareOfHome,
    status: 'running',
    metadata: batchMetadata(deps),
  });
  return { batchId, windowStart, windowEnd };
}

/**
 * Runs (or resumes) a batch until the queue is drained.
 *
 * @param {string} batchId
 * @param {object} deps
 * @param {object} deps.persistence
 * @param {object} deps.siteSource
 * @param {object} deps.qualifier
 * @param {object[]} deps.datasets
 * @param {object} deps.logger
 * @param {import('./ports/dataset.js').Clock} deps.clock
 * @param {import('./ports/dataset.js').RunContext['gateway']} deps.gateway
 * @param {string} deps.siteSourceId
 * @param {{windowStart: string, windowEnd: string}} deps.window
 * @param {number} [deps.agentCount] concurrent analysis claim loops; defaults to 1
 * @param {number} [deps.claimTtlMs] reclaim claims older than this (crashed workers); defaults to the adapter value
 */
export async function runBatch(batchId, deps) {
  const { windowStart, windowEnd } = deps.window ?? deps;
  const counts = { queued: 0, qualified: 0, skipped: 0, failed: 0 };

  const sites = await deps.siteSource.listSites(makeCtx(batchId, windowStart, windowEnd, deps));
  await deps.persistence.enqueue(batchId, sites);
  counts.queued = sites.length;
  const agentCount = Math.max(1, Number(deps.agentCount ?? 1));
  deps.logger.info({ batchId, windowStart, windowEnd, sites: sites.length, agents: agentCount }, 'batch started');

  /**
   * One claim loop. Claims are token-exclusive, so agents never process the
   * same site; counts increments are synchronous and race-free.
   */
  async function agent(agentIndex) {
    for (;;) {
      const claimed = await deps.persistence.claimNext(batchId, deps.claimTtlMs);
      if (claimed.length === 0) return;
      const siteRow = claimed[0];
      const site = { idsite: Number(siteRow.idsite), siteName: siteRow.site_name ?? siteRow.siteName ?? '' };
      try {
        await processSite(batchId, site, deps, counts);
      } catch (err) {
        counts.failed += 1;
        const reason = err instanceof Error ? err.message : String(err);
        deps.logger.error({ batchId, idsite: site.idsite, agent: agentIndex, err }, 'site failed');
        await deps.persistence.updateQueue({ batchId, idsite: site.idsite, status: 'failed', reason });
      }
    }
  }

  await Promise.all(Array.from({ length: agentCount }, (_, i) => agent(i)));

  const columnChecks = {};
  if (deps.columnChecks) {
    for (const [key, value] of deps.columnChecks) columnChecks[key] = await value;
  }

  await deps.persistence.createBatch({
    batchId,
    windowStart,
    windowEnd,
    siteSource: deps.siteSourceId,
    qualifier: deps.qualifier.id,
    minSessions: deps.qualifier.config.minSessions,
    minOrders: deps.qualifier.config.minOrders,
    minShareOfHome: deps.qualifier.config.minShareOfHome,
    status: 'complete',
    sitesQueued: counts.queued,
    sitesQualified: counts.qualified,
    sitesSkipped: counts.skipped,
    sitesFailed: counts.failed,
    metadata: { ...batchMetadata(deps), column_checks: columnChecks },
  });
  deps.logger.info({ batchId, ...counts }, 'batch complete');
  return counts;
}

/**
 * @param {string} batchId
 * @param {{idsite: number, siteName: string}} site
 * @param {object} deps
 * @param {{qualified: number, skipped: number, failed: number}} counts
 */
async function processSite(batchId, site, deps, counts) {
  const { windowStart, windowEnd } = deps.window ?? deps;
  const ctx = makeCtx(batchId, windowStart, windowEnd, deps);
  const qualification = await deps.qualifier.qualify(site, ctx);
  await deps.persistence.updateQueue({
    batchId,
    idsite: site.idsite,
    status: qualification.status,
    idsitehsr: qualification.idsitehsr ?? 0,
    landingPageUrl: qualification.url ?? '',
    pageType: qualification.pageType ?? '',
    entrySessions: qualification.entrySessions ?? 0,
    orders: qualification.orders ?? 0,
    revenue: qualification.revenue ?? 0,
    reason: qualification.reason ?? '',
  });
  if (qualification.status !== 'qualified') {
    counts.skipped += 1;
    deps.logger.info({ batchId, idsite: site.idsite, status: qualification.status }, 'site skipped');
    return;
  }

  const naming = await deps.persistence.namingStatus({
    idsite: site.idsite,
    idsitehsr: qualification.idsitehsr,
  });
  const freshness = isNamingFresh(naming, deps.clock.todayUtc());
  if (!freshness.fresh) {
    await deps.persistence.enqueueNaming({
      idsite: site.idsite,
      idsitehsr: qualification.idsitehsr,
      url: qualification.url ?? '',
      pageType: qualification.pageType ?? '',
      reason: freshness.reason,
    });
    await deps.persistence.updateQueue({
      batchId,
      idsite: site.idsite,
      status: 'awaiting_naming',
      idsitehsr: qualification.idsitehsr,
      landingPageUrl: qualification.url ?? '',
      pageType: qualification.pageType ?? '',
      reason: freshness.reason,
    });
    counts.awaitingNaming = (counts.awaitingNaming ?? 0) + 1;
    deps.logger.info({ batchId, idsite: site.idsite, reason: freshness.reason }, 'page queued for naming');
    return;
  }

  const evidence = qualification.evidence ?? {};
  const unfiltered = evidence.unfiltered ?? { sessions: 0, orders: 0, revenue: 0 };
  /** @type {import('./ports/qualifier.js').QualifiedPage} */
  const page = {
    idsite: site.idsite,
    siteName: site.siteName,
    idsitehsr: qualification.idsitehsr,
    url: qualification.url,
    pageTitle: evidence.title ?? '',
    pageType: qualification.pageType,
    qualified: {
      entrySessions: qualification.entrySessions,
      orders: qualification.orders,
      revenue: qualification.revenue,
    },
    unfiltered,
    botSessionsExcluded: unfiltered.sessions - qualification.entrySessions,
  };

  await deps.persistence.updateQueue({ batchId, idsite: site.idsite, status: 'analyzing' });

  /** @type {object} */
  const notes = { qualifier: evidence };
  /** @type {Object<string, *>} */
  let analysisPatch = {};
  for (const dataset of deps.datasets) {
    const collected = await dataset.collect(page, ctx);
    ctx.datasets.set(collected.id, collected);
    const rows = toDatasetRows(batchId, page, collected);
    if (rows.length > 0) await deps.persistence.writeDataset(rows);
    mergeNotes(notes, collected);
    if (collected.analysis) analysisPatch = { ...analysisPatch, ...collected.analysis };
    deps.logger.info({ batchId, idsite: site.idsite, dataset: collected.id, rows: rows.length }, 'dataset collected');
  }

  await deps.persistence.writeAnalysis({
    batchId,
    idsite: page.idsite,
    idsitehsr: page.idsitehsr,
    landingPageUrl: page.url,
    pageTitle: page.pageTitle,
    pageType: page.pageType,
    windowStart,
    windowEnd,
    entrySessions: page.qualified.entrySessions,
    orders: page.qualified.orders,
    revenue: page.qualified.revenue,
    sessionsUnfiltered: unfiltered.sessions,
    ordersUnfiltered: unfiltered.orders,
    botSessionsExcluded: page.botSessionsExcluded,
    status: 'analyzed',
    metadata: notes,
    ...defaultAnalysisPatch(),
    ...analysisPatch,
  });
  await deps.persistence.updateQueue({ batchId, idsite: site.idsite, status: 'analyzed' });
  counts.qualified += 1;
  deps.logger.info({ batchId, idsite: site.idsite }, 'site analyzed');
  collectColumnChecks(ctx, deps);
}

/**
 * Column-check notes (keys `check:*` on ctx.batchNotes) are promised values;
 * they are gathered here and awaited when the batch finishes, then written
 * into the batch metadata per IMPLEMENTATION-PLAN.md section 7.
 * @param {import('./ports/dataset.js').RunContext} ctx
 * @param {object} deps
 */
function collectColumnChecks(ctx, deps) {
  if (!deps.columnChecks) deps.columnChecks = new Map();
  for (const [key, value] of ctx.batchNotes) {
    if (key.startsWith('check:') && !deps.columnChecks.has(key)) deps.columnChecks.set(key, value);
  }
}

/**
 * @param {string} batchId
 * @param {string} windowStart
 * @param {string} windowEnd
 * @param {object} deps
 * @returns {import('./ports/dataset.js').RunContext}
 */
function makeCtx(batchId, windowStart, windowEnd, deps) {
  return {
    batchId,
    windowStart,
    windowEnd,
    gateway: deps.gateway,
    logger: deps.logger,
    clock: deps.clock,
    datasets: new Map(),
    batchNotes: new Map(),
    sites: deps.sites ?? {},
    elementNamesPath: deps.elementNamesPath ?? null,
    segmentations: deps.segmentations ?? null,
  };
}

function defaultAnalysisPatch() {
  return {
    rps: 0,
    singlePageviewShare: 0,
    scrollReach25: 0,
    scrollReach70: 0,
    desktopRps: 0,
    mobileRps: 0,
    mobileToDesktopRps: 0,
    strategiesTriggered: 0,
    strategiesBelowFloor: 0,
    strategiesBlocked: 0,
    strategiesSilent: 0,
  };
}
