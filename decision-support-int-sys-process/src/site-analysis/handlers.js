import { getBotContext } from '../adapters/_lib/bot-context.js';
import { mergeNotes } from '../adapters/_lib/rows.js';
import { pageSubject } from '../adapters/_lib/subject-candidates.js';
import { isPageShaped } from '../domain/subject-types.js';
import { TAXONOMY_VERSION } from '../domain/taxonomy.js';
import { createLiveDayRecords, createStoredDayRecords } from '../scan/day-records.js';
import { runPagePass, runSitePass } from '../scan/passes.js';
import { addDays } from '../triggers/time.js';
import { runTrafficExclusion } from '../traffic-exclusion/run.js';
import { checkpointKey, commitCollected, hydrateDataset, hydrateSubjectDataset, loadCheckpoints, writeCollected } from './checkpoints.js';
import { makeCtx, makePageCtx, qualifiedPage, subjectPage } from './context.js';
import { catalogIdOf, datasetGroups, isCard, isRequirements } from './roles.js';
import {
  analysisTallies,
  cardRow,
  descriptorStatusFrom,
  requirementRowsFrom,
  requirementStatusRow,
  siteAnalysisRow,
  subjectCardRow,
  withSubjects,
} from './rows.js';

/**
 * The schema-2 site analysis as stage handlers (data-capture-plan.md §9.2).
 * Each takes `{ site, window, pages, deps }` and returns a HandlerResult whose
 * facts the next handler reads. `runAeBatch` runs them in this order:
 *
 *   qualify -> captureGate -> collectDatasets(page) -> draftDescriptors
 *     -> collectDatasets(site) -> writeAnalysis
 *
 * A profile of subjects other than pages (experiments) runs
 *
 *   selectSubjects -> collectDatasets(subject) -> collectDatasets(site) -> writeAnalysis
 *
 * and its subject datasets run once per subject at idsitehsr 0, each row
 * carrying the subject key, under one checkpoint per dataset.
 *
 * The bot drafts between the two dataset scopes because descriptor-snapshot,
 * a site dataset, reads the descriptors it writes. Every finished dataset is
 * written at once with a checkpoint, so a handler started on its own (a
 * separate stage, or a resumed run) reloads earlier work from the store.
 * `state` carries that work in memory when the handlers run in one process.
 *
 * With `deps.dayScan`, the session reads go through the day scan. qualify
 * runs the site pass: every session of the window, a day at a time, into the
 * qualifier's and the selector's folders and those of the `pass: 'site'`
 * datasets. The page phase runs the page pass once over the targets, and each
 * page's datasets read its sessions from the pass (ctx.sessionSource). A
 * handler started without the passes in state runs the ones its unfinished
 * datasets need.
 *
 * With `deps.dayStore` ({store, overlapDays, keepDays}), the passes read
 * their days through the store (see day-records.js): a day older than
 * `overlapDays` full days before today is final and replays from the store,
 * and the days read live are stored, so the next window reads only its new
 * days. Before its first pass a site drops its days older than `keepDays`.
 *
 * @typedef {Object} AnalysisWindow the batch row
 * @property {string} batchId
 * @property {string} windowStart
 * @property {string} windowEnd
 * @property {object} [standards]
 * @property {number} [maxPagesPerSite]
 *
 * @typedef {Object} AnalysisSite
 * @property {number} idsite
 * @property {string} siteName
 * @property {import('../ports/qualifier.js').Qualification} [qualification] set once qualify passes
 *
 * @typedef {Object} AnalysisPage
 * @property {object} target the page target row
 * @property {import('../ports/qualifier.js').QualifiedPage} page
 * @property {boolean} [fresh] set by captureGate: the capture is complete on the current taxonomy
 *
 * @typedef {Object} SiteState
 * @property {Map<string, *>} batchNotes per-site memo shared by the qualifier and every dataset
 * @property {Map<string, object> | null} checkpoints
 * @property {Array<{target: object, page: object, ctx: object, notes: object}> | null} analyzed
 * @property {{siteNotes: object, descriptorStatus: string} | null} site
 * @property {Map<string, import('../ports/dataset.js').SessionFolder> | null} sitePass the folded site-pass datasets, by id
 * @property {Awaited<ReturnType<typeof runPagePass>> | null} pagePass
 * @property {Set<string>} [cursorsSaved] the day cursors this state wrote
 * @property {import('../scan/day-records.js').DayRecords} [dayRecords] the passes' days, with deps.dayStore
 * @property {import('../ports/subject.js').SubjectTarget[] | null} [subjects] the selected subjects other than pages
 * @property {Array<{subject: object, page: object, ctx: object}> | null} [subjectRuns] their datasets, once collected
 *
 * @typedef {Object} HandlerInput
 * @property {AnalysisSite} site
 * @property {AnalysisWindow} window
 * @property {AnalysisPage[]} [pages]
 * @property {object} deps persistence, qualifier, pageSelector, datasets, descriptorSources, gateway, logger, clock, dayScan, dayStore
 * @property {SiteState} [state]
 *
 * @typedef {import('../orchestrator/ports/stage-handler.js').HandlerResult} HandlerResult
 */

/** @returns {SiteState} */
export function createSiteState() {
  return {
    batchNotes: new Map(),
    checkpoints: null,
    analyzed: null,
    site: null,
    sitePass: null,
    pagePass: null,
    subjects: null,
    subjectRuns: null,
  };
}

/**
 * @param {string} message
 * @param {object} facts
 * @returns {HandlerResult}
 */
const ok = (message, facts) => ({ status: 'ok', message, facts });

/**
 * Qualifies the site and selects its pages.
 * facts: `outcome` ('qualified' or 'skipped'), `qualification`, `pages`.
 * @param {HandlerInput} input
 * @returns {Promise<HandlerResult>}
 */
export async function qualify({ site, window, deps, state = createSiteState() }) {
  const { batchId } = window;
  const siteCtx = makeCtx(window, deps, state.batchNotes);
  await deps.persistence.updateSite({ batchId, idsite: site.idsite, siteName: site.siteName, status: 'selecting_pages' });

  const qualifierFolder = deps.dayScan ? deps.qualifier.open?.(site, siteCtx) : undefined;
  const selectorFolder = deps.dayScan ? deps.pageSelector.open?.(site, siteCtx) : undefined;
  if (deps.dayScan) {
    const ride = [['qualifier', qualifierFolder], ['page-selector', selectorFolder]].filter(([, folder]) => folder);
    await foldSitePass({ site, window, deps }, state, siteCtx, sitePassDatasets(deps.datasets), ride);
  }

  const qualification = qualifierFolder
    ? await qualifierFolder.finish(site, siteCtx)
    : await deps.qualifier.qualify(site, siteCtx);
  if (qualification.status !== 'qualified') {
    await deps.persistence.updateSite({
      batchId,
      idsite: site.idsite,
      status: qualification.status,
      reason: qualification.reason ?? '',
    });
    deps.logger.info({ batchId, idsite: site.idsite, status: qualification.status }, 'ae site skipped');
    return ok(`site ${qualification.status}`, { outcome: 'skipped', qualification, pages: [] });
  }

  const maxPages = maxPagesPerSite(window, deps);
  const selected = selectorFolder
    ? await selectorFolder.finish(site, qualification, siteCtx, { maxPages })
    : await deps.pageSelector.select(site, qualification, siteCtx, { maxPages });
  const targets = selected.slice(0, maxPages);
  const subjects = targets.map((target) => (target.subjectType ? target : pageSubject(target, deps.subjectType ?? 'page')));
  await deps.persistence.writePageTargets(batchId, site.idsite, targets);
  await deps.persistence.writeSubjectTargets(batchId, site.idsite, subjects);
  await deps.persistence.updateSite({
    batchId,
    idsite: site.idsite,
    status: 'selecting_pages',
    pagesSelected: targets.length,
    entrySessions: qualification.entrySessions ?? 0,
    orders: qualification.orders ?? 0,
    revenue: qualification.revenue ?? 0,
  });
  deps.logger.info({ batchId, idsite: site.idsite, pages: targets.length }, 'ae pages selected');
  const pages = targets.map((target, i) => ({ target, page: qualifiedPage(site, qualification, subjects[i]) }));
  return ok(`${targets.length} pages selected`, { outcome: 'qualified', qualification, pages });
}

/**
 * Selects the site's subjects other than pages with the profile's selector
 * and stores them. A site with none is skipped with the reason
 * `no_<subject type>s`, such as no_experiments.
 * facts: `outcome` ('selected' or 'skipped') and `subjects`.
 * @param {HandlerInput} input
 * @returns {Promise<HandlerResult>}
 */
export async function selectSubjects({ site, window, deps, state = createSiteState() }) {
  const { batchId } = window;
  if (!deps.subjectSelector) throw new Error('select-subjects needs deps.subjectSelector, the profile\'s selector');
  const subjectType = deps.subjectType ?? deps.subjectSelector.subjectType;
  await deps.persistence.updateSite({ batchId, idsite: site.idsite, siteName: site.siteName, status: 'selecting_pages' });
  const subjects = await deps.subjectSelector.select(site, null, makeCtx(window, deps, state.batchNotes));
  state.subjects = subjects;
  if (subjects.length === 0) {
    const reason = `no_${subjectType}s`;
    await deps.persistence.updateSite({ batchId, idsite: site.idsite, status: 'skipped', reason });
    deps.logger.info({ batchId, idsite: site.idsite, status: 'skipped', reason }, 'ae site skipped');
    return ok(`site skipped: ${reason}`, { outcome: 'skipped', subjects });
  }
  await deps.persistence.writeSubjectTargets(batchId, site.idsite, subjects);
  await deps.persistence.updateSite({ batchId, idsite: site.idsite, status: 'analyzing', pagesSelected: subjects.length });
  deps.logger.info({ batchId, idsite: site.idsite, subjectType, subjects: subjects.length }, 'ae subjects selected');
  return ok(`${subjects.length} ${subjectType} subjects selected`, { outcome: 'selected', subjects });
}

/**
 * A page is fresh when its capture is complete on the current taxonomy.
 * Anything else re-enters ae_capture_queue (naming + render, desktop +
 * mobile) with the staleness reason and the page waits; when every page
 * waits, the site waits too.
 * facts: `outcome` ('ready' or 'awaiting_capture') and `pages` with `fresh` set.
 * @param {HandlerInput} input
 * @returns {Promise<HandlerResult>}
 */
export async function captureGate({ site, window, pages = [], deps }) {
  const { batchId } = window;
  /** @type {AnalysisPage[]} */
  const gated = [];
  for (const entry of pages) {
    const { target } = entry;
    const { fresh, reason } = await captureIsFresh(deps.persistence, site.idsite, target.idsitehsr);
    gated.push({ ...entry, fresh });
    if (fresh) continue;
    await deps.persistence.enqueueCapture({
      idsite: site.idsite,
      idsitehsr: target.idsitehsr,
      url: target.url ?? '',
      pageType: target.pageType ?? '',
      want: ['naming', 'render'],
      deviceClasses: ['desktop', 'mobile'],
      reason,
    });
    await deps.persistence.updatePageTarget({
      batchId,
      idsite: site.idsite,
      idsitehsr: target.idsitehsr,
      status: 'awaiting_capture',
      reason: 'no fresh capture',
    });
  }
  if (!gated.some((entry) => entry.fresh)) {
    await deps.persistence.updateSite({ batchId, idsite: site.idsite, status: 'awaiting_capture', reason: 'pages awaiting capture' });
    deps.logger.info({ batchId, idsite: site.idsite }, 'ae site awaiting capture');
    return ok('pages awaiting capture', { outcome: 'awaiting_capture', pages: gated });
  }
  await deps.persistence.updateSite({ batchId, idsite: site.idsite, status: 'analyzing' });
  const freshCount = gated.filter((entry) => entry.fresh).length;
  return ok(`${freshCount} of ${gated.length} pages ready`, { outcome: 'ready', pages: gated });
}

/**
 * `scope: 'page'` runs the traffic exclusion model and the page datasets on
 * every fresh page. `scope: 'site'` runs the site datasets once, on a ctx that
 * holds every page dataset, then refreshes requirement status with the site
 * datasets in view, then the site cards and the page cards. `scope:
 * 'subject'` runs the subject datasets, then the subject cards, on every
 * selected subject other than a page.
 * facts: `scope` and the ids collected or resumed.
 * @param {HandlerInput & {scope: 'page' | 'site' | 'subject'}} input
 * @returns {Promise<HandlerResult>}
 */
export async function collectDatasets(input) {
  const state = input.state ?? createSiteState();
  if (input.scope === 'site') {
    await sitePhase(input, state);
    return ok('site datasets collected', { scope: 'site', datasets: datasetGroups(input.deps.datasets).site.map((d) => d.id) });
  }
  if (input.scope === 'subject') {
    const runs = await subjectPhase(input, state);
    return ok(`subject datasets collected on ${runs.length} subjects`, { scope: 'subject', subjects: runs.map((r) => r.subject.subjectKey) });
  }
  if (input.scope !== 'page') throw new Error(`collectDatasets: scope must be 'page', 'site', or 'subject', got "${input.scope}"`);
  const analyzed = await pagePhase(input, state);
  return ok(`page datasets collected on ${analyzed.length} pages`, { scope: 'page', pages: analyzed.map((a) => a.page.idsitehsr) });
}

/**
 * Each discovered descriptor source drafts descriptor fields for every
 * analyzed page from the page's datasets. A checkpoint per page and source
 * marks the draft done.
 * facts: `rows` drafted.
 * @param {HandlerInput} input
 * @returns {Promise<HandlerResult>}
 */
export async function draftDescriptors(input) {
  const state = input.state ?? createSiteState();
  const { site, window, deps } = input;
  const { batchId } = window;
  const analyzed = await pagePhase(input, state);
  let rows = 0;
  for (const { page, ctx } of analyzed) {
    for (const source of deps.descriptorSources ?? []) {
      if (state.checkpoints.has(checkpointKey(page.idsitehsr, source.id))) {
        deps.logger.info({ batchId, idsite: site.idsite, idsitehsr: page.idsitehsr }, 'ae descriptors resumed');
        continue;
      }
      const drafted = await source.draft(page, ctx);
      if (drafted.length > 0) {
        await deps.persistence.writeDescriptorRows(drafted);
        rows += drafted.length;
        deps.logger.info(
          { batchId, idsite: site.idsite, idsitehsr: page.idsitehsr, rows: drafted.length },
          'ae descriptors drafted',
        );
      }
      await deps.persistence.writeAnalysisCheckpoint({
        batchId,
        idsite: page.idsite,
        idsitehsr: page.idsitehsr,
        datasetId: source.id,
        scope: 'page',
        rowCount: drafted.length,
        notes: '{}',
      });
      state.checkpoints.set(checkpointKey(page.idsitehsr, source.id), { notes: '{}' });
    }
  }
  return ok(`${rows} descriptor rows drafted`, { rows });
}

/**
 * Writes one ae_page_analysis row per analyzed page and the site's
 * ae_site_analysis row from the stored requirement status and cards, then
 * marks the site analyzed.
 * facts: `outcome` ('analyzed') and `pagesAnalyzed`.
 * @param {HandlerInput} input
 * @returns {Promise<HandlerResult>}
 */
export async function writeAnalysis(input) {
  const state = input.state ?? createSiteState();
  const { site, window, deps } = input;
  const { batchId, windowStart, windowEnd } = window;
  const { siteNotes, descriptorStatus } = await sitePhase(input, state);
  const analyzed = state.analyzed;
  const subjectRuns = isPageShaped(deps.subjectType ?? 'page') ? [] : await subjectPhase(input, state);

  const requirementRows = await deps.persistence.readRequirementStatus({ batchId, idsite: site.idsite });
  const cardRows = await deps.persistence.readCards({ batchId, idsite: site.idsite });

  for (const { target, page, notes } of analyzed) {
    const cards = cardRows.filter((c) => c.idsitehsr === page.idsitehsr);
    const statusRows = requirementRows.filter((r) => r.idsitehsr === page.idsitehsr);
    await deps.persistence.writePageAnalysis({
      batchId,
      idsite: site.idsite,
      idsitehsr: page.idsitehsr,
      url: page.url,
      pageTitle: page.pageTitle,
      pageType: page.pageType,
      templateFamily: target.templateFamily ?? '',
      role: target.role ?? 'primary',
      windowStart,
      windowEnd,
      entrySessions: page.qualified.entrySessions,
      orders: page.qualified.orders,
      revenue: page.qualified.revenue,
      rps: 0,
      cvr: 0,
      aov: 0,
      singlePageviewShare: 0,
      scrollReach25: 0,
      scrollReach70: 0,
      desktopRps: 0,
      mobileRps: 0,
      mobileToDesktopRps: 0,
      botSessionsExcluded: page.botSessionsExcluded,
      sessionsUnfiltered: page.unfiltered.sessions,
      ordersUnfiltered: page.unfiltered.orders,
      descriptorStatus,
      captureStatus: 'current',
      ...analysisTallies(statusRows, cards),
      status: 'analyzed',
      metadata: notes,
    });
  }

  for (const { subject } of subjectRuns) {
    await deps.persistence.updateSubjectTarget({
      batchId,
      idsite: site.idsite,
      subjectType: subject.subjectType,
      subjectKey: subject.subjectKey,
      status: 'analyzed',
    });
  }

  const siteRow = siteAnalysisRow(window, site, analyzed, requirementRows, cardRows, siteNotes, descriptorStatus);
  await deps.persistence.writeSiteAnalysis(withSubjects(siteRow, subjectRuns));
  const pagesAnalyzed = analyzed.length + subjectRuns.length;
  await deps.persistence.updateSite({ batchId, idsite: site.idsite, status: 'analyzed', pagesAnalyzed });
  deps.logger.info({ batchId, idsite: site.idsite }, 'ae site analyzed');
  return ok(`${pagesAnalyzed} subjects analyzed`, { outcome: 'analyzed', pagesAnalyzed });
}

/**
 * @param {AnalysisWindow} window
 * @param {object} deps
 */
function maxPagesPerSite(window, deps) {
  return Math.max(1, Number(deps.pageSelectorOpts?.maxPagesPerSite ?? deps.maxPagesPerSite ?? window.maxPagesPerSite ?? 6));
}

/**
 * A page's capture is fresh when a complete ae_page_capture row exists on the
 * engine's current taxonomy. The reason travels into ae_capture_queue: a row
 * on an older taxonomy_version re-captures for the taxonomy upgrade,
 * otherwise the page was never captured.
 * @param {import('../ports/persistence/capture-store.js').CaptureStore} persistence
 * @param {number} idsite
 * @param {number} idsitehsr
 * @returns {Promise<{fresh: boolean, reason: string}>}
 */
async function captureIsFresh(persistence, idsite, idsitehsr) {
  const capture = await persistence.captureStatus({ idsite, idsitehsr });
  if (capture && capture.status === 'complete' && capture.taxonomyVersion === TAXONOMY_VERSION) {
    return { fresh: true, reason: '' };
  }
  if (capture && capture.taxonomyVersion !== TAXONOMY_VERSION) {
    return { fresh: false, reason: 'taxonomy_upgrade' };
  }
  return { fresh: false, reason: 'no_capture' };
}

/**
 * The requirement rows a dataset declares beside its rows.
 * @param {string} batchId
 * @param {number} idsite
 * @param {number} idsitehsr
 * @param {{id: string, requirements?: object[]}} collected
 */
function declaredRequirements(batchId, idsite, idsitehsr, collected) {
  if (!Array.isArray(collected.requirements)) return [];
  return collected.requirements.map((r) => requirementStatusRow(batchId, idsite, idsitehsr, collected.id, r));
}

/**
 * @param {HandlerInput} input
 * @param {SiteState} state
 */
async function siteCheckpoints({ site, window, deps }, state) {
  state.checkpoints ??= await loadCheckpoints(deps.persistence, window.batchId, site.idsite);
  return state.checkpoints;
}

/**
 * The page phase, once per state: page datasets on every fresh page, each
 * loaded from its checkpoint when it already finished.
 * @param {HandlerInput} input
 * @param {SiteState} state
 */
async function pagePhase(input, state) {
  if (state.analyzed) return state.analyzed;
  const { site, window, pages = [], deps } = input;
  const { batchId, windowStart, windowEnd } = window;
  const checkpoints = await siteCheckpoints(input, state);
  if (deps.trafficExclusion && isPageShaped(deps.subjectType ?? 'page') && !checkpoints.has(checkpointKey(0, 'traffic-exclusion'))) {
    await runTrafficExclusion({
      idsite: site.idsite,
      windowStart,
      windowEnd,
      adapter: deps.trafficExclusion,
      gateway: deps.gateway,
      persistence: deps.persistence,
      logger: deps.logger,
    });
    await deps.persistence.writeAnalysisCheckpoint({
      batchId,
      idsite: site.idsite,
      idsitehsr: 0,
      datasetId: 'traffic-exclusion',
      scope: 'site',
      rowCount: 0,
      notes: '{}',
    });
    checkpoints.set(checkpointKey(0, 'traffic-exclusion'), { notes: '{}' });
  }

  const targets = pages.map((entry) => entry.target);
  const pageDatasets = datasetGroups(deps.datasets).page;
  if (deps.dayScan) await ensurePasses(input, state);
  /** @type {Array<{target: object, page: object, ctx: object, notes: object}>} */
  const analyzed = [];
  for (const { target, page } of pages.filter((entry) => entry.fresh)) {
    const ctx = makePageCtx(window, deps, targets, page, state.batchNotes);
    if (state.pagePass) ctx.sessionSource = state.pagePass.sourceFor(page.idsitehsr);
    /** @type {object} */
    const notes = { qualifier: site.qualification?.evidence ?? {} };
    for (const dataset of pageDatasets) {
      // The requirements dataset is committed by the refresh in the site
      // phase, after site datasets exist. A checkpoint means that refresh
      // already finished.
      const resumed = checkpoints.get(checkpointKey(page.idsitehsr, dataset.id));
      const holdForRefresh = isRequirements(dataset) && !resumed;
      const collected = resumed
        ? await hydrateDataset(deps.persistence, batchId, page, dataset.id, resumed)
        : await collectOne(dataset, page, ctx, state);
      ctx.datasets.set(collected.id, collected);
      if (!resumed && !holdForRefresh) {
        const side = declaredRequirements(batchId, site.idsite, page.idsitehsr, collected);
        await commitCollected(deps.persistence, batchId, page, collected, 'page', { requirementRows: side });
        checkpoints.set(checkpointKey(page.idsitehsr, collected.id), { notes: JSON.stringify(collected.notes ?? {}) });
      }
      mergeNotes(notes, collected);
      deps.logger.info(
        { batchId, idsite: site.idsite, dataset: collected.id, rows: collected.rows?.length ?? 0, resumed: Boolean(resumed) },
        resumed ? 'ae dataset resumed' : 'ae dataset collected',
      );
    }
    ctx.pageNotes.clear();
    analyzed.push({ target, page, ctx, notes });
  }
  state.analyzed = analyzed;
  return analyzed;
}

/**
 * The selected subjects other than pages: from state, else as stored.
 * @param {HandlerInput} input
 * @param {SiteState} state
 */
async function subjectsOf({ site, window, deps }, state) {
  state.subjects ??= (await deps.persistence.readSubjectTargets({ batchId: window.batchId, idsite: site.idsite }))
    .filter((subject) => subject.subjectType === deps.subjectType);
  return state.subjects;
}

/**
 * The subject phase, once per state: each subject dataset, then each
 * subject card dataset, on every subject. Each runs on all the subjects
 * before one checkpoint at idsitehsr 0 marks it done; without that
 * checkpoint, its rows from an unfinished attempt are deleted first.
 * @param {HandlerInput} input
 * @param {SiteState} state
 */
async function subjectPhase(input, state) {
  if (state.subjectRuns) return state.subjectRuns;
  const { site, window, deps } = input;
  const { batchId } = window;
  const checkpoints = await siteCheckpoints(input, state);
  const subjects = await subjectsOf(input, state);
  const groups = datasetGroups(deps.datasets);
  const runs = subjects.map((subject) => {
    const ctx = makeCtx(window, deps, state.batchNotes);
    ctx.subjects = subjects;
    ctx.subject = subject;
    return { subject, page: subjectPage(site, subject), ctx };
  });
  for (const dataset of [...groups.subject, ...groups.subjectCards]) {
    const resumed = checkpoints.get(checkpointKey(0, dataset.id));
    if (!resumed) {
      await deps.persistence.deleteDatasetRows({ batchId, idsite: site.idsite, datasetIds: [dataset.id], idsitehsr: 0 });
    }
    let rowCount = 0;
    for (const run of runs) {
      const collected = resumed
        ? await hydrateSubjectDataset(deps.persistence, batchId, run.page, dataset.id)
        : await dataset.collect(run.page, run.ctx);
      run.ctx.datasets.set(collected.id, collected);
      rowCount += collected.rows?.length ?? 0;
      if (!resumed) {
        const side = isCard(dataset)
          ? { cardRows: collected.rows.map((row) => subjectCardRow(batchId, site.idsite, catalogIdOf(dataset), run.subject, row)) }
          : {};
        await writeCollected(deps.persistence, batchId, run.page, collected, 'subject', side);
      }
    }
    if (!resumed) {
      const notes = JSON.stringify({ subjects: runs.length });
      await deps.persistence.writeAnalysisCheckpoint({
        batchId,
        idsite: site.idsite,
        idsitehsr: 0,
        datasetId: dataset.id,
        scope: 'subject',
        rowCount,
        notes,
      });
      checkpoints.set(checkpointKey(0, dataset.id), { notes });
    }
    deps.logger.info(
      { batchId, idsite: site.idsite, dataset: dataset.id, subjects: runs.length, rows: rowCount, resumed: Boolean(resumed) },
      resumed ? 'ae subject dataset resumed' : 'ae subject dataset collected',
    );
  }
  state.subjectRuns = runs;
  return runs;
}

/**
 * The site phase, once per state. The site ctx is pre-seeded with the page
 * datasets (keyed by dataset id, later pages overwriting earlier ones), so a
 * site adapter can read page outputs; later site adapters read earlier site
 * outputs the same way. Rows are written with scope 'site' and idsitehsr 0.
 * @param {HandlerInput} input
 * @param {SiteState} state
 */
async function sitePhase(input, state) {
  if (state.site) return state.site;
  const analyzed = await pagePhase(input, state);
  const { site, window, pages = [], deps } = input;
  const { batchId } = window;
  const checkpoints = state.checkpoints;
  const groups = datasetGroups(deps.datasets);
  const sitePage = { idsite: site.idsite, idsitehsr: 0, siteName: site.siteName };

  const siteRunCtx = makeCtx(window, deps, state.batchNotes);
  siteRunCtx.pageTargets = pages.map((entry) => entry.target);
  for (const { ctx } of analyzed) {
    for (const [id, collected] of ctx.datasets) siteRunCtx.datasets.set(id, collected);
  }
  /** @type {object} */
  const siteNotes = {};
  /** @type {Map<string, object>} datasets collected in the site phase, fed to the cards */
  const siteCollected = new Map();
  for (const dataset of groups.site) {
    const resumed = checkpoints.get(checkpointKey(0, dataset.id));
    const datasetCtx = dataset.sessions === 'targets' && state.pagePass
      ? { ...siteRunCtx, sessionSource: state.pagePass.targetsSource() }
      : siteRunCtx;
    const collected = resumed
      ? await hydrateDataset(deps.persistence, batchId, sitePage, dataset.id, resumed)
      : await collectOne(dataset, sitePage, datasetCtx, state);
    siteRunCtx.datasets.set(collected.id, collected);
    siteCollected.set(collected.id, collected);
    if (!resumed) {
      const side = declaredRequirements(batchId, site.idsite, 0, collected);
      await commitCollected(deps.persistence, batchId, sitePage, collected, 'site', { requirementRows: side });
      checkpoints.set(checkpointKey(0, collected.id), { notes: JSON.stringify(collected.notes ?? {}) });
    }
    mergeNotes(siteNotes, collected);
    deps.logger.info(
      { batchId, idsite: site.idsite, dataset: collected.id, rows: collected.rows?.length ?? 0, scope: 'site', resumed: Boolean(resumed) },
      resumed ? 'ae site dataset resumed' : 'ae site dataset collected',
    );
  }

  if (groups.requirements) {
    await refreshRequirements(input, state, groups.requirements, siteRunCtx);
  }

  const descriptorStatus = descriptorStatusFrom(siteCollected.get('descriptor-snapshot'));

  for (const dataset of groups.siteCards) {
    const resumed = checkpoints.get(checkpointKey(0, dataset.id));
    const collected = resumed
      ? await hydrateDataset(deps.persistence, batchId, sitePage, dataset.id, resumed)
      : await dataset.collect(sitePage, siteRunCtx);
    siteRunCtx.datasets.set(collected.id, collected);
    if (!resumed) {
      const catalogId = catalogIdOf(dataset);
      const cards = collected.rows.map((row) => cardRow(batchId, site.idsite, 0, 'site', catalogId, row));
      await commitCollected(deps.persistence, batchId, sitePage, collected, 'site', { cardRows: cards });
      checkpoints.set(checkpointKey(0, collected.id), { notes: '{}' });
    }
    deps.logger.info(
      { batchId, idsite: site.idsite, dataset: collected.id, rows: collected.rows?.length ?? 0, scope: 'site', resumed: Boolean(resumed) },
      resumed ? 'ae site cards resumed' : 'ae site cards collected',
    );
  }

  // Page cards run last, per page, with this page's datasets plus every
  // site dataset in view, so the gates are evaluated from real inputs.
  for (const { page, ctx } of analyzed) {
    const cardCtx = { ...ctx, datasets: new Map([...siteCollected, ...ctx.datasets]) };
    for (const dataset of groups.pageCards) {
      const resumed = checkpoints.get(checkpointKey(page.idsitehsr, dataset.id));
      const collected = resumed
        ? await hydrateDataset(deps.persistence, batchId, page, dataset.id, resumed)
        : await dataset.collect(page, cardCtx);
      cardCtx.datasets.set(collected.id, collected);
      if (!resumed) {
        const scope = dataset.scope ?? 'page';
        const catalogId = catalogIdOf(dataset);
        const cards = collected.rows.map((row) => cardRow(batchId, site.idsite, page.idsitehsr, scope, catalogId, row));
        await commitCollected(deps.persistence, batchId, page, collected, scope, { cardRows: cards });
        checkpoints.set(checkpointKey(page.idsitehsr, collected.id), { notes: '{}' });
      }
      deps.logger.info(
        { batchId, idsite: site.idsite, dataset: collected.id, rows: collected.rows?.length ?? 0, resumed: Boolean(resumed) },
        resumed ? 'ae cards resumed' : 'ae cards collected',
      );
    }
  }

  state.site = { siteNotes, descriptorStatus };
  state.sitePass = null;
  state.pagePass = null;
  if (deps.dayScan) await clearCursors(input, state);
  return state.site;
}

/**
 * Empties the day cursors the passes saved, once nothing reads them.
 * @param {HandlerInput} input
 * @param {SiteState} state
 */
async function clearCursors(input, state) {
  const checkpoints = await siteCheckpoints(input, state);
  for (const datasetId of [SITE_CURSOR, PAGE_CURSOR]) {
    const key = checkpointKey(0, datasetId);
    if (!state.cursorsSaved?.has(datasetId) && !checkpoints.get(key)?.notes) continue;
    await cursorStore(input, state, datasetId).save('');
    checkpoints.set(key, { notes: '' });
  }
}

/**
 * A `pass: 'site'` dataset finishes from its site-pass folder when the pass
 * folded it; every other dataset collects.
 * @param {object} dataset
 * @param {object} page
 * @param {object} ctx
 * @param {SiteState} state
 */
function collectOne(dataset, page, ctx, state) {
  const folder = dataset.pass === 'site' ? state.sitePass?.get(dataset.id) : undefined;
  return folder ? folder.finish(page, ctx) : dataset.collect(page, ctx);
}

/** @param {object[]} datasets */
function sitePassDatasets(datasets) {
  return datasets.filter((dataset) => dataset.pass === 'site' && typeof dataset.open === 'function');
}

/**
 * Runs the site pass and keeps the datasets' folders in state. `ride` are
 * named folders read by the caller (the qualifier's and the selector's).
 * @param {{site: AnalysisSite, window: AnalysisWindow, deps: object}} input
 * @param {SiteState} state
 * @param {object} ctx
 * @param {object[]} datasets
 * @param {Array<[string, {fold: Function}]>} [ride]
 */
async function foldSitePass(input, state, ctx, datasets, ride = []) {
  const { site, window, deps } = input;
  const sitePage = { idsite: site.idsite, idsitehsr: 0, siteName: site.siteName };
  const folders = new Map();
  for (const dataset of datasets) folders.set(dataset.id, await dataset.open(sitePage, ctx));
  if (folders.size + ride.length === 0) return;
  const bot = await getBotContext(ctx, site.idsite);
  const named = [...ride, ...folders];
  const stats = await runSitePass({
    gateway: deps.gateway,
    idsite: site.idsite,
    records: await dayRecordsOf(input, state),
    window,
    bot,
    folders: named.map(([, folder]) => folder),
    names: named.map(([name]) => name),
    cursor: cursorStore(input, state, SITE_CURSOR),
    logger: deps.logger,
  });
  state.sitePass ??= new Map();
  for (const [id, folder] of folders) {
    folder.settle?.();
    state.sitePass.set(id, folder);
  }
  deps.logger.info(
    {
      batchId: window.batchId,
      idsite: site.idsite,
      days: stats.days,
      resumedAfter: stats.resumedAfter,
      queries: stats.queries,
      ...(stats.records ? { records: stats.records } : {}),
      lanes: stats.lanes,
      datasets: [...folders.keys()],
    },
    'ae site pass',
  );
}

/**
 * The passes' days from `deps.dayStore`, or undefined for the live queries.
 * One source per state, so the page pass replays the site pass's live reads.
 * @param {HandlerInput} input
 * @param {SiteState} state
 */
async function dayRecordsOf(input, state) {
  const { site, deps } = input;
  if (!deps.dayStore) return undefined;
  if (state.dayRecords) return state.dayRecords;
  const { store, overlapDays, keepDays } = deps.dayStore;
  const today = deps.clock.todayUtc();
  if (keepDays) {
    const pruned = await store.prune({ idsite: site.idsite, before: addDays(today, -keepDays) });
    if (pruned > 0) deps.logger.info({ idsite: site.idsite, pruned, keepDays }, 'day store pruned');
  }
  state.dayRecords = createStoredDayRecords({
    live: createLiveDayRecords({ gateway: deps.gateway, idsite: site.idsite }),
    store,
    idsite: site.idsite,
    finalThrough: addDays(today, -(overlapDays + 1)),
  });
  return state.dayRecords;
}

const SITE_CURSOR = 'day-scan:site';
const PAGE_CURSOR = 'day-scan:page';

/**
 * A pass's day cursor, kept as an analysis checkpoint at idsitehsr 0. The
 * site phase empties it once the site's datasets are stored.
 * @param {HandlerInput} input
 * @param {SiteState} state
 * @param {string} datasetId
 * @returns {import('../scan/passes.js').CursorStore}
 */
function cursorStore(input, state, datasetId) {
  const { site, window, deps } = input;
  return {
    async load() {
      const checkpoints = await siteCheckpoints(input, state);
      return checkpoints.get(checkpointKey(0, datasetId))?.notes || null;
    },
    async save(text) {
      (state.cursorsSaved ??= new Set()).add(datasetId);
      await deps.persistence.writeAnalysisCheckpoint({
        batchId: window.batchId,
        idsite: site.idsite,
        idsitehsr: 0,
        datasetId,
        scope: 'site',
        rowCount: 0,
        notes: text,
      });
    },
  };
}

/**
 * The passes the unfinished datasets need, when state lacks them: the site
 * pass for `pass: 'site'` datasets not yet checkpointed on every fresh page
 * (or on the site), and the page pass over every target when a page dataset
 * or a `sessions: 'targets'` site dataset is unfinished.
 * @param {HandlerInput} input
 * @param {SiteState} state
 */
async function ensurePasses(input, state) {
  const { site, window, pages = [], deps } = input;
  const checkpoints = state.checkpoints;
  const fresh = pages.filter((entry) => entry.fresh).map((entry) => entry.page.idsitehsr);
  const groups = datasetGroups(deps.datasets);
  const unfinished = (dataset) => (groups.site.includes(dataset)
    ? !checkpoints.has(checkpointKey(0, dataset.id))
    : fresh.some((idsitehsr) => !checkpoints.has(checkpointKey(idsitehsr, dataset.id))));
  const ctx = makeCtx(window, deps, state.batchNotes);

  const folds = sitePassDatasets(deps.datasets).filter((dataset) => !state.sitePass?.has(dataset.id) && unfinished(dataset));
  if (folds.length > 0) await foldSitePass(input, state, ctx, folds);

  if (state.pagePass || pages.length === 0) return;
  const readsPages = groups.page.some((dataset) => dataset.pass !== 'site' && !isRequirements(dataset) && unfinished(dataset))
    || groups.site.some((dataset) => dataset.sessions === 'targets' && unfinished(dataset));
  if (!readsPages) return;
  const bot = await getBotContext(ctx, site.idsite);
  state.pagePass = await runPagePass({
    gateway: deps.gateway,
    idsite: site.idsite,
    records: await dayRecordsOf(input, state),
    window,
    bot,
    pages: pages.map((entry) => Number(entry.target.idsitehsr)),
    viewed: groups.page.some((dataset) => dataset.sessions === 'viewed'),
    cursor: cursorStore(input, state, PAGE_CURSOR),
    logger: deps.logger,
  });
  const { stats } = state.pagePass;
  deps.logger.info(
    {
      batchId: window.batchId,
      idsite: site.idsite,
      days: stats.days,
      resumedAfter: stats.resumedAfter,
      queries: stats.queries,
      ...(stats.records ? { records: stats.records } : {}),
      lanes: stats.lanes,
      pages: pages.length,
    },
    'ae page pass',
  );
}

/**
 * The page-phase requirements reading ran before the site datasets existed.
 * This replaces it with a reading of the full set, and the cards see that
 * reading. Its checkpoint is written here, so a resume that died before this
 * step still refreshes.
 * @param {HandlerInput} input
 * @param {SiteState} state
 * @param {object} requirements the requirements dataset
 * @param {object} siteRunCtx
 */
async function refreshRequirements({ site, window, deps }, state, requirements, siteRunCtx) {
  const { batchId } = window;
  const checkpoints = state.checkpoints;
  for (const { page, ctx } of state.analyzed) {
    const resumed = checkpoints.get(checkpointKey(page.idsitehsr, requirements.id));
    if (resumed) {
      const collected = await hydrateDataset(deps.persistence, batchId, page, requirements.id, resumed);
      ctx.datasets.set(collected.id, collected);
      siteRunCtx.datasets.set(collected.id, collected);
      deps.logger.info(
        { batchId, idsite: site.idsite, dataset: collected.id, rows: collected.rows.length, resumed: true },
        'ae requirement status resumed',
      );
      continue;
    }
    const full = { ...ctx, datasets: new Map(siteRunCtx.datasets) };
    for (const [id, collected] of ctx.datasets) {
      if (id !== requirements.id) full.datasets.set(id, collected);
    }
    const collected = await requirements.collect(page, full);
    ctx.datasets.set(collected.id, collected);
    siteRunCtx.datasets.set(collected.id, collected);
    await deps.persistence.deleteDatasetRows({
      batchId,
      idsite: site.idsite,
      datasetIds: [requirements.id],
      idsitehsr: page.idsitehsr,
    });
    const side = requirementRowsFrom(batchId, site.idsite, page.idsitehsr, collected);
    await commitCollected(deps.persistence, batchId, page, collected, 'page', { requirementRows: side });
    checkpoints.set(checkpointKey(page.idsitehsr, requirements.id), { notes: '{}' });
    deps.logger.info(
      { batchId, idsite: site.idsite, dataset: collected.id, rows: collected.rows.length },
      'ae requirement status refreshed',
    );
  }
}
