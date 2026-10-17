import { loadCatalog } from '../catalog/index.js';

/**
 * @param {{batchId: string, windowStart: string, windowEnd: string, standards?: object}} window
 *   the batch row; supplies the window and the standards
 * @param {object} deps
 * @param {Map<string, *>} [batchNotes] shared per-site memo store; pass the
 * site's map so bot classification, urls, clicks and pageview sequences
 * are built once per site, not once per page
 * @returns {import('../ports/dataset.js').RunContext}
 */
export function makeCtx(window, deps, batchNotes = new Map()) {
  return {
    batchId: window.batchId,
    windowStart: window.windowStart,
    windowEnd: window.windowEnd,
    gateway: deps.gateway,
    persistence: deps.persistence ?? null,
    logger: deps.logger,
    clock: deps.clock,
    datasets: new Map(),
    batchNotes,
    pageTargets: [],
    pageDescriptor: null,
    storeDescriptor: null,
    changes: [],
    standards: window.standards ?? {},
    catalogs: deps.catalogs ?? loadCatalog(),
    sources: {},
    sites: deps.sites ?? {},
    elementNamesPath: deps.elementNamesPath ?? null,
    segmentations: deps.segmentations ?? null,
  };
}

/**
 * A fresh per-page context: datasets collects only this page's runs;
 * pageTargets carries the site's selected targets; §9.1's remaining fields
 * ride along unread until later phases. batchNotes stays shared with the
 * site ctx (see makeCtx); pageNotes holds the page's shared loads (clicks,
 * pageview sequences, session tags, viewport heights) until the page's
 * datasets finish.
 */
export function makePageCtx(window, deps, pageTargets, page, batchNotes) {
  const ctx = makeCtx(window, deps, batchNotes);
  ctx.pageTargets = pageTargets;
  ctx.page = page;
  ctx.pageNotes = new Map();
  return ctx;
}

/**
 * A subject other than a page as the page argument a subject dataset
 * collects with: the site at idsitehsr 0, with the subject's identity, so
 * its rows carry the subject key.
 * @param {{idsite: number, siteName: string}} site
 * @param {import('../ports/subject.js').SubjectTarget} subject
 */
export function subjectPage(site, subject) {
  return {
    idsite: site.idsite,
    idsitehsr: 0,
    siteName: site.siteName,
    subjectType: subject.subjectType,
    subjectKey: subject.subjectKey,
    label: subject.label,
    dims: subject.dims ?? {},
    evidence: subject.evidence ?? {},
  };
}

/**
 * The QualifiedPage shape the dataset adapters expect (v1 runner.js's
 * construction, rebuilt from the page target).
 * @param {{idsite: number, siteName: string}} site
 * @param {import('../ports/qualifier.js').Qualification} qualification
 * @param {object} target
 * @returns {import('../ports/qualifier.js').QualifiedPage}
 */
export function qualifiedPage(site, qualification, target) {
  const unfiltered = qualification.evidence?.unfiltered ?? { sessions: 0, orders: 0, revenue: 0 };
  // With one target (Phase 2 / primary-only) the target stats are the
  // qualification's; with several, each target carries its own.
  const entrySessions = target.entrySessions ?? qualification.entrySessions ?? 0;
  return {
    idsite: site.idsite,
    siteName: site.siteName,
    idsitehsr: Number(target.idsitehsr),
    url: target.url ?? qualification.url ?? '',
    pageTitle: target.pageTitle ?? qualification.evidence?.title ?? '',
    pageType: target.pageType ?? qualification.pageType ?? '',
    qualified: {
      entrySessions,
      orders: target.orders ?? qualification.orders ?? 0,
      revenue: target.revenue ?? qualification.revenue ?? 0,
    },
    unfiltered,
    botSessionsExcluded: Math.max(0, unfiltered.sessions - entrySessions),
    ...(target.subjectType && target.subjectType !== 'page' ? { subjectType: target.subjectType, subjectKey: target.subjectKey } : {}),
  };
}
