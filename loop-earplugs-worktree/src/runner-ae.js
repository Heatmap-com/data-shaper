import { randomUUID } from 'node:crypto';
import { TAXONOMY_VERSION } from './domain/taxonomy.js';
import { emit } from './telemetry/span.js';
import { makeCtx } from './site-analysis/context.js';
import { LP_STEPS, runSiteSteps } from './site-analysis/steps.js';

/**
 * The schema-2 pipeline (data-capture-plan.md §9.2), Phase 3: up to
 * max_pages_per_site = 6 targets (primary + sisters + template members)
 * through the page selector, the capture gate per target, page datasets
 * per target, then the site-scope datasets once per site on a ctx
 * pre-seeded with the page datasets. Each finished dataset is written
 * immediately, with a checkpoint, so a restarted run loads it and does
 * not collect it again. Outputs to ae_dataset_row /
 * ae_requirement_status / ae_strategy_card / ae_page_analysis /
 * ae_site_analysis. Each site runs through the profile's steps
 * (src/site-analysis/steps.js) over the stage handlers in
 * src/site-analysis/handlers.js; this module creates the batch, runs the
 * claim loops, and records the counts.
 */

/**
 * Last windowDays complete UTC days ending yesterday (plan §9.2: the window
 * comes from ae_batch.window_days). The Clock supplies today so tests never
 * call Date.now().
 * @param {import('./ports/dataset.js').Clock} clock
 * @param {number} [windowDays]
 */
export function computeAeWindow(clock, windowDays = 30) {
  const today = clock.todayUtc();
  const end = new Date(`${today}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() - 1);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (windowDays - 1));
  return { windowStart: start.toISOString().slice(0, 10), windowEnd: end.toISOString().slice(0, 10) };
}

/**
 * @param {object} deps
 * @param {object} deps.persistence AePersistencePort
 * @param {number} [deps.windowDays] default 30
 * @param {string[]} [deps.catalogs] catalog ids in play
 * @param {object} [deps.standards] floors and constants per catalog
 * @param {string} [deps.siteSourceId]
 * @param {string} [deps.qualifierId]
 * @param {string} [deps.pageSelectorId]
 * @param {number} [deps.maxPagesPerSite] default 6 (Phase 3)
 * @param {string} [deps.profile] execution profile id
 * @param {string} [deps.subjectType] the profile's subject type
 * @param {object} [deps.metadata] merged over `{schema_version: 2}`
 * @param {import('./ports/dataset.js').Clock} deps.clock
 * @param {object} [deps.logger]
 * @returns {Promise<{batchId: string, windowStart: string, windowEnd: string}>}
 */
export async function createAeBatch(deps) {
  const windowDays = deps.windowDays ?? 30;
  const { windowStart, windowEnd } = computeAeWindow(deps.clock, windowDays);
  const batchId = randomUUID();
  await deps.persistence.createBatch({
    batchId,
    windowStart,
    windowEnd,
    windowDays,
    catalogs: deps.catalogs ?? [],
    standards: deps.standards ?? {},
    siteSource: deps.siteSourceId ?? '',
    qualifier: deps.qualifierId ?? '',
    pageSelector: deps.pageSelectorId ?? '',
    profile: deps.profile ?? '',
    subjectType: deps.subjectType ?? '',
    maxPagesPerSite: deps.maxPagesPerSite ?? 6,
    taxonomyVersion: TAXONOMY_VERSION,
    status: 'running',
    metadata: { schema_version: 2, ...(deps.metadata ?? {}) },
  });
  deps.logger?.info?.({ batchId, windowStart, windowEnd }, 'ae batch created');
  return { batchId, windowStart, windowEnd };
}

/**
 * Runs (or resumes) a schema-2 batch until the queue is drained.
 *
 * @param {string} batchId
 * @param {object} deps
 * @param {object} deps.persistence
 * @param {object} deps.siteSource
 * @param {object} deps.qualifier
 * @param {import('./ports/page-selector.js').PageSelectorPort} deps.pageSelector
 * @param {object[]} deps.datasets topologically sorted
 * @param {object[]} [deps.descriptorSources] discovered descriptor sources; each drafts per analyzed page
 * @param {object} deps.logger
 * @param {import('./ports/dataset.js').Clock} deps.clock
 * @param {import('./ports/dataset.js').RunContext['gateway']} deps.gateway
 * @param {number} [deps.agentCount] concurrent claim loops; defaults to 1
 * @param {object} [deps.pageSelectorOpts] `{maxPagesPerSite}` passed to the
 *   page selector; defaults to 6 (Phase 3; the cutover/parity runs pass 1)
 * @param {number} [deps.maxPagesPerSite] back-compat alias for
 *   pageSelectorOpts.maxPagesPerSite
 * @param {number} [deps.claimTtlMs] reclaim claims older than this
 * @param {string[]} [deps.steps] the profile's steps; the landing-page steps by default
 * @param {string} [deps.subjectType] the subject type of the targets the selector writes
 * @returns {Promise<object>} counts
 */
export async function runAeBatch(batchId, deps) {
  const batch = await deps.persistence.getBatch(batchId);
  if (!batch) throw new Error(`ae batch ${batchId} not found`);
  const { windowStart, windowEnd } = batch;
  const counts = { queued: 0, qualified: 0, skipped: 0, failed: 0, awaitingCapture: 0, pagesAnalyzed: 0 };
  const agentCount = Math.max(1, Number(deps.agentCount ?? 1));

  const batchStarted = Date.now();
  const sites = await deps.siteSource.listSites(makeCtx(batch, deps));
  await deps.persistence.enqueueSites(batchId, sites);
  counts.queued = sites.length;
  deps.logger.info({ batchId, windowStart, windowEnd, sites: sites.length, agents: agentCount }, 'ae batch started');

  /** One claim loop; claims are token-exclusive so agents never collide. */
  async function agent(agentIndex) {
    for (;;) {
      const claimed = await deps.persistence.claimNextSite(batchId, deps.claimTtlMs);
      if (!claimed) return;
      const site = { idsite: Number(claimed.idsite), siteName: claimed.siteName ?? '' };
      const siteStarted = Date.now();
      try {
        await analyzeSite(batch, site, deps, counts);
        emit(deps.telemetry, { name: 'site', durationMs: Date.now() - siteStarted, ok: true, attrs: { batchId, idsite: site.idsite } });
      } catch (err) {
        counts.failed += 1;
        const reason = err instanceof Error ? err.message : String(err);
        emit(deps.telemetry, { name: 'site', durationMs: Date.now() - siteStarted, ok: false, attrs: { batchId, idsite: site.idsite, error: reason } });
        deps.logger.error({ batchId, idsite: site.idsite, agent: agentIndex, err }, 'ae site failed');
        await deps.persistence.updateSite({ batchId, idsite: site.idsite, status: 'failed', reason });
      }
    }
  }

  await Promise.all(Array.from({ length: agentCount }, (_, i) => agent(i)));

  // The finish upsert preserves the spec fields (catalogs, standards,
  // versions) by re-reading the batch row first.
  const current = await deps.persistence.getBatch(batchId);
  await deps.persistence.createBatch({
    batchId,
    windowStart,
    windowEnd,
    windowDays: batch.windowDays,
    catalogs: batch.catalogs ?? current?.catalogs ?? [],
    standards: batch.standards ?? current?.standards ?? {},
    siteSource: batch.siteSource ?? current?.siteSource ?? '',
    qualifier: batch.qualifier ?? current?.qualifier ?? '',
    pageSelector: batch.pageSelector ?? current?.pageSelector ?? '',
    profile: batch.profile ?? current?.profile ?? '',
    subjectType: batch.subjectType ?? current?.subjectType ?? '',
    maxPagesPerSite: batch.maxPagesPerSite ?? 6,
    catalogVersion: batch.catalogVersion ?? current?.catalogVersion ?? '',
    requirementRegistryVersion: batch.requirementRegistryVersion ?? current?.requirementRegistryVersion ?? '',
    taxonomyVersion: batch.taxonomyVersion ?? current?.taxonomyVersion ?? TAXONOMY_VERSION,
    status: 'complete',
    sitesQueued: counts.queued,
    sitesAnalyzed: counts.qualified,
    sitesSkipped: counts.skipped,
    sitesFailed: counts.failed,
    pagesAnalyzed: counts.pagesAnalyzed,
    metadata: { schema_version: 2, ...(batch.metadata ?? {}) },
  });
  deps.logger.info({ batchId, ...counts }, 'ae batch complete');
  emit(deps.telemetry, {
    name: 'batch',
    durationMs: Date.now() - batchStarted,
    ok: counts.failed === 0,
    attrs: { batchId, sites: counts.queued, failed: counts.failed, pages: counts.pagesAnalyzed },
  });
  return counts;
}

/**
 * One site through the profile's steps (the landing-page steps when the
 * deps name none). The steps share one in-memory state, so nothing
 * finished is read back from the store.
 * @param {object} batch
 * @param {{idsite: number, siteName: string}} site
 * @param {object} deps
 * @param {object} counts
 */
async function analyzeSite(batch, site, deps, counts) {
  const run = await runSiteSteps(deps.steps ?? LP_STEPS, { site, window: batch, deps });
  if (run.outcome === 'skipped') counts.skipped += 1;
  else if (run.outcome === 'awaitingCapture') counts.awaitingCapture += 1;
  else {
    counts.pagesAnalyzed += run.pagesAnalyzed;
    counts.qualified += 1;
  }
}
