import { appendRows, storedRowToCollected } from './adapters/_lib/rows.js';

export { storedRowToCollected };
import { loadCatalog } from './catalog/index.js';
import { missingRoleMethods } from './ports/persistence/index.js';
import { REPLAY_STORE } from './ports/persistence/replay-store.js';
import { catalogIdOf, isCard, isRequirements, isSubjectScoped } from './site-analysis/roles.js';
import {
  cardRow,
  descriptorStatusFrom,
  requirementRowsFrom,
  requirementStatusRow,
  toAeDatasetRows,
} from './site-analysis/rows.js';

/** @typedef {import('./ports/persistence/replay-store.js').ReplayStore} ReplayStore */
/** @typedef {{id: string, scope?: string, descriptor?: {replay?: import('./discover.js').ReplayMode, role?: string, catalogId?: string}}} ReplayAdapter */

/** @param {import('./discover.js').ReplayMode} mode */
const declares = (mode) => (/** @type {ReplayAdapter} */ adapter) => adapter.descriptor?.replay === mode;

/**
 * The plan each descriptor declares. `keep` rows are loaded as stored,
 * `restamp` rows take element classes from the current bindings, and
 * `recollect` datasets and descriptor sources run again. A requested id must
 * be restamped or recollected. Replay covers page and site datasets; a
 * subject dataset reruns with its profile's batch.
 *
 * @param {string[] | null | undefined} requested
 * @param {ReplayAdapter[]} discovered
 * @param {ReplayAdapter[]} [descriptorSources]
 * @returns {{restamp: string[], recollect: string[], keep: string[]}}
 */
export function resolveReplayPlan(requested, discovered, descriptorSources = []) {
  const datasets = discovered.filter((d) => !isSubjectScoped(d));
  const restamp = datasets.filter(declares('restamp')).map((d) => d.id);
  const recollect = [...datasets, ...descriptorSources].filter(declares('recollect')).map((d) => d.id);
  const keep = datasets.filter(declares('keep')).map((d) => d.id);
  if (!requested || requested.length === 0) return { restamp, recollect, keep };
  const allowed = new Set([...restamp, ...recollect]);
  for (const id of requested) {
    if (!allowed.has(id)) throw new Error(`replay refused dataset "${id}"`);
  }
  const want = new Set(requested);
  return {
    restamp: restamp.filter((id) => want.has(id)),
    recollect: recollect.filter((id) => want.has(id)),
    keep,
  };
}

/**
 * @param {object} persistence
 * @returns {ReplayStore}
 */
function replayStore(persistence) {
  const missing = missingRoleMethods(persistence ?? {}, { ReplayStore: REPLAY_STORE }).ReplayStore;
  if (missing) throw new Error(`replay: the persistence adapter lacks ${missing.join(', ')}`);
  return /** @type {ReplayStore} */ (persistence);
}

/**
 * @param {{dims: object, metrics: object}} row
 * @param {Map<string, string>} classBySelector
 */
export function restampElementClass(row, classBySelector) {
  const selector = String(row.dims?.selector ?? '');
  const next = classForSelector(selector, classBySelector);
  return { ...row, dims: { ...row.dims, element_class: next }, metrics: row.metrics };
}

/**
 * Exact binding wins. A click on a node inside the hero control, with no
 * binding of its own, takes `hero_cta` from that ancestor. Other classes
 * stay exact-match so an inner span does not inherit a nav link.
 * @param {string} selector
 * @param {Map<string, string>} classBySelector
 */
function classForSelector(selector, classBySelector) {
  if (!selector) return '';
  if (classBySelector.has(selector)) return classBySelector.get(selector) ?? '';
  let best = '';
  let bestLen = -1;
  for (const [bound, cls] of classBySelector) {
    if (cls !== 'hero_cta') continue;
    if (selector.startsWith(`${bound} > `) && bound.length > bestLen) {
      best = cls;
      bestLen = bound.length;
    }
  }
  return best;
}

/**
 * Reloads a finished batch for one site, restamps element classes, and
 * recollects only the readers. Fact-table datasets are not collected.
 *
 * Page readers run per page, then the descriptor sources, then the site
 * readers, then requirement status with the site datasets in view, then the
 * site cards and the page cards. Each group runs in discovery order.
 *
 * @param {object} opts
 * @param {ReplayStore} opts.persistence
 * @param {object[]} [opts.datasets] discovered datasets
 * @param {object[]} [opts.descriptorSources] discovered descriptor sources
 */
export async function replaySite(opts) {
  const store = replayStore(opts.persistence);
  const datasets = opts.datasets ?? [];
  const plan = resolveReplayPlan(opts.datasetIds, datasets, opts.descriptorSources ?? []);
  const recollecting = new Set(plan.recollect);
  const replayed = datasets.filter((d) => recollecting.has(d.id));
  const readers = replayed.filter((d) => !isCard(d) && !isRequirements(d));
  const pageReaders = readers.filter((d) => d.scope !== 'site');
  const siteReaders = readers.filter((d) => d.scope === 'site');
  const requirementStatus = replayed.find(isRequirements);
  const siteCards = replayed.filter((d) => isCard(d) && d.scope === 'site');
  const pageCards = replayed.filter((d) => isCard(d) && d.scope !== 'site');
  const drafters = (opts.descriptorSources ?? []).filter((source) => recollecting.has(source.id));
  /** @type {Map<number, Map<string, object[]>>} */
  const byPage = new Map();
  for (const row of opts.stored ?? []) {
    if (!byPage.has(row.idsitehsr)) byPage.set(row.idsitehsr, new Map());
    const bucket = byPage.get(row.idsitehsr);
    if (!bucket.has(row.datasetId)) bucket.set(row.datasetId, []);
    bucket.get(row.datasetId).push(row);
  }

  /** @type {object[]} */
  const restamped = [];
  for (const [hsr, bucket] of byPage) {
    const classes = opts.bindings?.get(String(hsr)) ?? new Map();
    for (const id of plan.restamp) {
      const next = (bucket.get(id) ?? []).map((row) => restampElementClass(row, classes));
      bucket.set(id, next);
      for (const row of next) restamped.push({ ...row, idsitehsr: hsr, datasetId: id });
    }
  }

  await store.deleteDatasetRows({
    batchId: opts.batchId,
    idsite: opts.idsite,
    datasetIds: [...plan.restamp, ...replayed.map((d) => d.id)],
  });

  const restampAe = flattenAe(opts.batchId, opts.idsite, restamped);
  if (restampAe.length > 0) await store.writeDatasetRows(restampAe);

  const collectedIds = [];
  /** @type {import('./ports/persistence.js').AeDatasetRow[]} */
  const recollectAe = [];
  /** @type {import('./ports/persistence.js').AeRequirementStatusRow[]} */
  const requirementRows = [];
  /** @type {import('./ports/persistence.js').AeStrategyCardRow[]} */
  const cardRows = [];
  const siteBucket = byPage.get(0) ?? new Map();
  const siteCtx = makeReplayCtx(opts);
  seedCtx(siteCtx, siteBucket);

  const pages = (opts.pages ?? []).filter((page) => Number(page.idsitehsr) !== 0);
  for (const page of pages) {
    const ctx = makeReplayCtx(opts);
    ctx.page = page;
    seedCtx(ctx, byPage.get(Number(page.idsitehsr)) ?? new Map());
    for (const dataset of pageReaders) {
      await runCollect(dataset, page, ctx, 'page', opts, collectedIds, recollectAe, requirementRows, cardRows);
      siteCtx.datasets.set(dataset.id, ctx.datasets.get(dataset.id));
    }
    for (const source of drafters) {
      const drafted = await source.draft(page, ctx);
      collectedIds.push(source.id);
      if (drafted?.length > 0) await store.writeDescriptorRows(drafted);
    }
  }

  for (const page of pages) {
    const bucket = byPage.get(Number(page.idsitehsr));
    if (!bucket) continue;
    for (const [id, rows] of bucket) {
      if (!siteCtx.datasets.has(id)) siteCtx.datasets.set(id, collectedOf(id, rows));
    }
  }

  const sitePage = { idsite: opts.idsite, idsitehsr: 0, siteName: opts.siteName ?? '' };
  for (const dataset of siteReaders) {
    await runCollect(dataset, sitePage, siteCtx, 'site', opts, collectedIds, recollectAe, requirementRows, cardRows);
  }

  if (requirementStatus) {
    for (const page of pages) {
      const ctx = makeReplayCtx(opts);
      seedCtx(ctx, byPage.get(Number(page.idsitehsr)) ?? new Map());
      for (const [id, collected] of siteCtx.datasets) {
        if (id !== requirementStatus.id) ctx.datasets.set(id, collected);
      }
      await runCollect(requirementStatus, page, ctx, 'page', opts, collectedIds, recollectAe, requirementRows, cardRows);
    }
  }

  for (const dataset of siteCards) {
    await runCollect(dataset, sitePage, siteCtx, 'site', opts, collectedIds, recollectAe, requirementRows, cardRows);
  }
  for (const page of pages) {
    const ctx = makeReplayCtx(opts);
    seedCtx(ctx, byPage.get(Number(page.idsitehsr)) ?? new Map());
    for (const [id, collected] of siteCtx.datasets) ctx.datasets.set(id, collected);
    for (const dataset of pageCards) {
      await runCollect(dataset, page, ctx, 'page', opts, collectedIds, recollectAe, requirementRows, cardRows);
    }
  }

  if (recollectAe.length > 0) await store.writeDatasetRows(recollectAe);
  if (requirementRows.length > 0) await store.writeRequirementStatus(requirementRows);
  if (cardRows.length > 0) await store.writeCards(cardRows);

  const descriptorStatus = descriptorStatusFrom(siteCtx.datasets.get('descriptor-snapshot'));
  for (const page of pages) {
    const cards = cardRows.filter((c) => c.idsitehsr === Number(page.idsitehsr));
    const statusRows = requirementRows.filter((r) => r.idsitehsr === Number(page.idsitehsr));
    await store.writePageAnalysis({
      ...page,
      batchId: opts.batchId,
      descriptorStatus,
      requirementsAvailable: statusRows.filter((r) => r.status === 'available').length,
      requirementsMissing: statusRows.filter((r) => r.status !== 'available').length,
      cardsInclude: cards.filter((c) => c.verdict === 'include').length,
      cardsConditional: cards.filter((c) => c.verdict === 'conditional').length,
      cardsExclude: cards.filter((c) => c.verdict === 'exclude').length,
      cardsTriggered: cards.filter((c) => c.triggerState === 'triggered').length,
      cardsSilent: cards.filter((c) => c.triggerState === 'silent').length,
      cardsBelowFloor: cards.filter((c) => c.triggerState === 'below_floor').length,
      cardsBlocked: cards.filter((c) => c.triggerState === 'blocked' || c.verdict === 'blocked').length,
      status: 'analyzed',
    });
  }
  if (opts.siteAnalysis) {
    await store.writeSiteAnalysis({
      ...opts.siteAnalysis,
      descriptorStatus,
      requirementsAvailable: requirementRows.filter((r) => r.status === 'available').length,
      requirementsMissing: requirementRows.filter((r) => r.status !== 'available').length,
      cardsInclude: cardRows.filter((c) => c.verdict === 'include').length,
      cardsConditional: cardRows.filter((c) => c.verdict === 'conditional').length,
      cardsExclude: cardRows.filter((c) => c.verdict === 'exclude').length,
      cardsTriggered: cardRows.filter((c) => c.triggerState === 'triggered').length,
      cardsSilent: cardRows.filter((c) => c.triggerState === 'silent').length,
      cardsBelowFloor: cardRows.filter((c) => c.triggerState === 'below_floor').length,
      cardsBlocked: cardRows.filter((c) => c.triggerState === 'blocked' || c.verdict === 'blocked').length,
      status: 'analyzed',
    });
  }

  return {
    restamped: restampAe.length,
    recollected: recollectAe.length,
    collectedIds,
    kept: plan.keep.filter((id) => [...byPage.values()].some((bucket) => bucket.has(id))).sort(),
  };
}

/**
 * Loads stored rows, bindings, and the page record, then replays one site.
 * @param {object} opts
 * @param {string} opts.database the database the ae_* tables live in
 */
export async function runReplay(opts) {
  if (!opts.database) throw new Error('replay: the run has no database name');
  const db = opts.database;
  const idsite = Number(opts.idsite);
  const params = { batchId: opts.batchId, idsite };
  const rawRows = await opts.gateway.query(
    `SELECT dataset_id, idsitehsr, scope, bot_filter, dim_week, dim_device, dim_source,
            dim_selector, dim_element_class, dim_extra, metrics, generated_at
       FROM ${db}.ae_dataset_row_current
      WHERE batch_id = {batchId:UUID}
        AND idsite = {idsite:UInt32}`,
    params,
    'replay:rows',
  );
  const bindingRows = await opts.gateway.query(
    `SELECT idsitehsr, selector, element_class
       FROM ${db}.ae_element_binding_current
      WHERE idsite = {idsite:UInt32}`,
    params,
    'replay:bindings',
  );
  const pageRows = await opts.gateway.query(
    `SELECT *
       FROM ${db}.ae_page_analysis_current
      WHERE batch_id = {batchId:UUID}
        AND idsite = {idsite:UInt32}`,
    params,
    'replay:pages',
  );
  const siteRows = await opts.gateway.query(
    `SELECT *
       FROM ${db}.ae_site_analysis_current
      WHERE batch_id = {batchId:UUID}
        AND idsite = {idsite:UInt32}`,
    params,
    'replay:site',
  );
  /** @type {Map<string, Map<string, string>>} */
  const bindings = new Map();
  for (const row of bindingRows) {
    const hsr = String(row.idsitehsr);
    if (!bindings.has(hsr)) bindings.set(hsr, new Map());
    if (row.selector && row.element_class) bindings.get(hsr).set(String(row.selector), String(row.element_class));
  }
  const keep = new Set(resolveReplayPlan(null, opts.datasets ?? []).keep);
  const keptBefore = {};
  for (const row of rawRows) {
    if (!keep.has(row.dataset_id)) continue;
    const stamp = String(row.generated_at ?? '');
    if (!keptBefore[row.dataset_id] || stamp > keptBefore[row.dataset_id]) keptBefore[row.dataset_id] = stamp;
  }
  const pages = pageRows.map(pageFromCh);
  const result = await replaySite({
    ...opts,
    idsite,
    stored: rawRows.map(storedRowToCollected),
    bindings,
    pages,
    siteAnalysis: siteRows[0] ? siteFromCh(siteRows[0]) : null,
    siteName: pages[0]?.pageTitle || '',
  });
  return { ...result, keptGeneratedAt: keptBefore };
}

function makeReplayCtx(opts) {
  const pages = (opts.pages ?? []).filter((page) => Number(page.idsitehsr) !== 0);
  return {
    batchId: opts.batchId,
    windowStart: opts.pages?.[0]?.windowStart,
    windowEnd: opts.pages?.[0]?.windowEnd,
    gateway: opts.gateway,
    datasets: new Map(),
    batchNotes: new Map(),
    pageTargets: pages,
    standards: {},
    catalogs: opts.catalogs ?? loadCatalog(),
    logger: opts.logger,
    elementNamesPath: opts.elementNamesPath ?? null,
    segmentations: opts.segmentations ?? null,
  };
}

/** @param {object} ctx @param {Map<string, object[]>} bucket */
function seedCtx(ctx, bucket) {
  for (const [id, rows] of bucket) ctx.datasets.set(id, collectedOf(id, rows));
}

function collectedOf(id, rows) {
  return { id, rows: rows.map((row) => ({ dims: row.dims, metrics: row.metrics })) };
}

async function runCollect(dataset, page, ctx, scope, opts, collectedIds, recollectAe, requirementRows, cardRows) {
  const id = dataset.id;
  const collected = await dataset.collect(page, ctx);
  ctx.datasets.set(collected.id ?? id, collected);
  collectedIds.push(id);
  appendRows(recollectAe, toAeDatasetRows(opts.batchId, page, collected, scope));
  if (isRequirements(dataset)) {
    requirementRows.push(...requirementRowsFrom(opts.batchId, opts.idsite, page.idsitehsr, collected));
  } else if (Array.isArray(collected.requirements)) {
    for (const r of collected.requirements) {
      requirementRows.push(requirementStatusRow(opts.batchId, opts.idsite, page.idsitehsr, collected.id, r));
    }
  }
  if (isCard(dataset)) {
    const catalogId = catalogIdOf(dataset);
    for (const row of collected.rows ?? []) {
      cardRows.push(cardRow(opts.batchId, opts.idsite, page.idsitehsr, scope, catalogId, row));
    }
  }
}

function flattenAe(batchId, idsite, rows) {
  /** @type {import('./ports/persistence.js').AeDatasetRow[]} */
  const out = [];
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.idsitehsr}:${row.datasetId}:${row.scope ?? 'page'}`;
    if (!groups.has(key)) groups.set(key, { idsitehsr: row.idsitehsr, datasetId: row.datasetId, scope: row.scope ?? 'page', rows: [] });
    groups.get(key).rows.push({ dims: row.dims, metrics: row.metrics });
  }
  for (const group of groups.values()) {
    appendRows(out, toAeDatasetRows(
      batchId,
      { idsite, idsitehsr: group.idsitehsr },
      { id: group.datasetId, rows: group.rows },
      group.scope,
    ));
  }
  return out;
}

function pageFromCh(row) {
  return {
    idsite: Number(row.idsite),
    idsitehsr: Number(row.idsitehsr),
    url: row.url ?? '',
    pageTitle: row.page_title ?? '',
    pageType: row.page_type ?? '',
    templateFamily: row.template_family ?? '',
    role: row.role ?? 'primary',
    windowStart: String(row.window_start ?? '').slice(0, 10),
    windowEnd: String(row.window_end ?? '').slice(0, 10),
    entrySessions: Number(row.entry_sessions ?? 0),
    orders: Number(row.orders ?? 0),
    revenue: Number(row.revenue ?? 0),
    rps: Number(row.rps ?? 0),
    cvr: Number(row.cvr ?? 0),
    aov: Number(row.aov ?? 0),
    singlePageviewShare: Number(row.single_pageview_share ?? 0),
    scrollReach25: Number(row.scroll_reach_25 ?? 0),
    scrollReach70: Number(row.scroll_reach_70 ?? 0),
    desktopRps: Number(row.desktop_rps ?? 0),
    mobileRps: Number(row.mobile_rps ?? 0),
    mobileToDesktopRps: Number(row.mobile_to_desktop_rps ?? 0),
    botSessionsExcluded: Number(row.bot_sessions_excluded ?? 0),
    sessionsUnfiltered: Number(row.sessions_unfiltered ?? 0),
    ordersUnfiltered: Number(row.orders_unfiltered ?? 0),
    captureStatus: row.capture_status ?? 'current',
    qualified: {
      entrySessions: Number(row.entry_sessions ?? 0),
      orders: Number(row.orders ?? 0),
      revenue: Number(row.revenue ?? 0),
    },
  };
}

function parseObject(value) {
  if (value && typeof value === 'object') return { ...value };
  if (typeof value !== 'string' || value === '') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function siteFromCh(row) {
  return {
    batchId: row.batch_id,
    idsite: Number(row.idsite),
    windowStart: String(row.window_start ?? '').slice(0, 10),
    windowEnd: String(row.window_end ?? '').slice(0, 10),
    sessions: Number(row.sessions ?? 0),
    orders: Number(row.orders ?? 0),
    revenue: Number(row.revenue ?? 0),
    rps: Number(row.rps ?? 0),
    cvr: Number(row.cvr ?? 0),
    aov: Number(row.aov ?? 0),
    ppEligibleShare: row.pp_eligible_share ?? null,
    ppRenderedShare: row.pp_rendered_share ?? null,
    reconciliationMin: row.reconciliation_min ?? null,
    descriptorStatus: row.descriptor_status ?? '',
    sourcesConnected: row.sources_connected ?? [],
    sourcesMissing: row.sources_missing ?? [],
    toolsInstalled: row.tools_installed ?? [],
    status: row.status ?? 'analyzed',
    metadata: parseObject(row.metadata),
  };
}
