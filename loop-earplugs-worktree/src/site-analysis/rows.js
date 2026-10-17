import { toDatasetRows } from '../adapters/_lib/rows.js';

/**
 * @param {string} batchId
 * @param {object} page
 * @param {{id: string, rows: Array}} dataset
 * @param {'page' | 'site'} [scope]
 * @returns {import('../ports/persistence.js').AeDatasetRow[]}
 */
export function toAeDatasetRows(batchId, page, dataset, scope = 'page') {
  // toDatasetRows flattens {dims, metrics}; the ae row renames dimReferer to
  // dimSource and pins the dataset's scope ('page' per target, 'site' with
  // idsitehsr 0).
  return toDatasetRows(batchId, page, dataset).map((row) => ({
    batchId: row.batchId,
    idsite: row.idsite,
    idsitehsr: row.idsitehsr,
    scope,
    datasetId: row.datasetId,
    botFilter: row.botFilter,
    dimWeek: row.dimWeek,
    dimDevice: row.dimDevice,
    dimSource: row.dimReferer,
    dimSelector: row.dimSelector,
    dimElementClass: row.dimElementClass ?? '',
    dimExtra: row.dimExtra,
    metrics: row.metrics,
    rowKey: row.rowKey,
    ...subjectOf(row),
  }));
}

/**
 * The subject fields a row of a subject other than a page carries; none
 * for a page, whose rows take the page defaults.
 * @param {{subjectType?: string, subjectKey?: string}} page
 */
export function subjectOf(page) {
  return page.subjectType && page.subjectType !== 'page' ? { subjectType: page.subjectType, subjectKey: page.subjectKey } : {};
}

/**
 * One ae_requirement_status row for an explicit requirement a dataset
 * emitted (collected.requirements), page- or site-scoped by the caller.
 * @param {string} batchId
 * @param {number} idsite
 * @param {number} idsitehsr 0 for site-scope
 * @param {string} datasetId
 * @param {{key: string, status: string, rowCount?: number, detail?: string}} r
 * @returns {import('../ports/persistence.js').AeRequirementStatusRow}
 */
export function requirementStatusRow(batchId, idsite, idsitehsr, datasetId, r) {
  return {
    batchId,
    idsite,
    idsitehsr,
    requirementKey: r.key,
    status: r.status,
    datasetId,
    source: '',
    rowCount: r.rowCount ?? 0,
    detail: r.detail ?? '',
  };
}

/**
 * The ae_requirement_status rows of a requirements dataset's output: one per
 * registry code it read.
 * @param {string} batchId
 * @param {number} idsite
 * @param {number} idsitehsr
 * @param {{id: string, rows?: Array<{dims: object, metrics: object}>}} collected
 * @returns {import('../ports/persistence.js').AeRequirementStatusRow[]}
 */
export function requirementRowsFrom(batchId, idsite, idsitehsr, collected) {
  return (collected.rows ?? []).map((row) => ({
    batchId,
    idsite,
    idsitehsr,
    requirementKey: row.dims.requirement_key,
    status: row.metrics.status,
    datasetId: collected.id,
    source: '',
    rowCount: row.metrics.row_count ?? 0,
    detail: row.metrics.detail ?? '',
  }));
}

/**
 * The card columns are floats. A rule's threshold is often a phrase
 * ('step >= 5pp'); that phrase stays in card_json and the column stays empty.
 * @param {unknown} value
 * @returns {number | null}
 */
function finiteOrNull(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return null;
}

/**
 * One ae_strategy_card row from a card dataset's output row.
 * @param {string} batchId
 * @param {number} idsite
 * @param {number} idsitehsr 0 for site-scope cards
 * @param {string} scope
 * @param {string} catalogId
 * @param {{dims: object, metrics: object}} row
 * @returns {import('../ports/persistence.js').AeStrategyCardRow}
 */
export function cardRow(batchId, idsite, idsitehsr, scope, catalogId, row) {
  return {
    batchId,
    idsite,
    idsitehsr,
    catalogId,
    strategyId: row.dims.strategy_id,
    segmentKey: row.dims.segment_key ?? 'all',
    scope,
    verdict: row.metrics.verdict,
    triggerState: row.metrics.trigger_state ?? '',
    triggerEvaluated: row.metrics.trigger_evaluated === 1,
    missingRequirements: row.metrics.missing_requirements ?? [],
    gateFailed: row.metrics.gate_failed ?? '',
    floorStandard: row.metrics.floor_standard ?? catalogId,
    metric: row.metrics.metric ?? '',
    value: finiteOrNull(row.metrics.value),
    threshold: finiteOrNull(row.metrics.threshold),
    cardJson: JSON.stringify(row),
  };
}

/**
 * One ae_strategy_card row for a subject other than a page. Its cards sit at
 * idsitehsr 0 beside every other subject's, so the segment key leads with
 * the subject key.
 * @param {string} batchId
 * @param {number} idsite
 * @param {string} catalogId
 * @param {{subjectKey: string}} subject
 * @param {{dims: object, metrics: object}} row
 */
export function subjectCardRow(batchId, idsite, catalogId, subject, row) {
  const segment = row.dims.segment_key;
  const segmentKey = !segment || segment === 'all' ? subject.subjectKey : `${subject.subjectKey}|${segment}`;
  return cardRow(batchId, idsite, 0, 'subject', catalogId, { ...row, dims: { ...row.dims, segment_key: segmentKey } });
}

/**
 * The site analysis row with the analyzed subjects other than pages: their
 * list in the metadata, and analyzed when any subject was.
 * @param {import('../ports/persistence.js').AeSiteAnalysisRow} row
 * @param {Array<{subject: {subjectType: string, subjectKey: string}}>} runs
 */
export function withSubjects(row, runs) {
  if (runs.length === 0) return row;
  return {
    ...row,
    status: 'analyzed',
    metadata: { ...row.metadata, subjects: runs.map(({ subject }) => ({ type: subject.subjectType, key: subject.subjectKey, status: 'analyzed' })) },
  };
}

/**
 * Snapshot rows are current, low-confidence (unknown), or absent.
 * @param {{rows?: object[]} | undefined} collected
 */
export function descriptorStatusFrom(collected) {
  const rows = collected?.rows ?? [];
  if (rows.length === 0) return 'missing';
  if (rows.some((row) => row.metrics?.status === 'current')) return 'current';
  return 'partial';
}

/**
 * The requirement and card tallies the page and site analysis rows carry.
 * @param {import('../ports/persistence.js').AeRequirementStatusRow[]} requirementRows
 * @param {import('../ports/persistence.js').AeStrategyCardRow[]} cardRows
 */
export function analysisTallies(requirementRows, cardRows) {
  return {
    requirementsAvailable: requirementRows.filter((r) => r.status === 'available').length,
    requirementsMissing: requirementRows.filter((r) => r.status !== 'available').length,
    cardsInclude: cardRows.filter((c) => c.verdict === 'include').length,
    cardsConditional: cardRows.filter((c) => c.verdict === 'conditional').length,
    cardsExclude: cardRows.filter((c) => c.verdict === 'exclude').length,
    cardsTriggered: cardRows.filter((c) => c.triggerState === 'triggered').length,
    cardsSilent: cardRows.filter((c) => c.triggerState === 'silent').length,
    cardsBelowFloor: cardRows.filter((c) => c.triggerState === 'below_floor').length,
    cardsBlocked: cardRows.filter((c) => c.triggerState === 'blocked' || c.verdict === 'blocked').length,
  };
}

/**
 * @param {{batchId: string, windowStart: string, windowEnd: string}} window
 * @param {{idsite: number}} site
 * @param {Array<{page: {qualified: {entrySessions?: number, orders?: number, revenue?: number}}}>} analyzed
 * @param {import('../ports/persistence.js').AeRequirementStatusRow[]} requirementRows
 * @param {import('../ports/persistence.js').AeStrategyCardRow[]} cardRows
 * @param {object} [siteNotes] merged site-dataset notes for the metadata
 * @param {string} [descriptorStatus]
 * @returns {import('../ports/persistence.js').AeSiteAnalysisRow}
 */
export function siteAnalysisRow(window, site, analyzed, requirementRows, cardRows, siteNotes = {}, descriptorStatus = 'missing') {
  const sessions = analyzed.reduce((sum, a) => sum + (a.page.qualified.entrySessions ?? 0), 0);
  const orders = analyzed.reduce((sum, a) => sum + (a.page.qualified.orders ?? 0), 0);
  const revenue = analyzed.reduce((sum, a) => sum + (a.page.qualified.revenue ?? 0), 0);
  return {
    batchId: window.batchId,
    idsite: site.idsite,
    windowStart: window.windowStart,
    windowEnd: window.windowEnd,
    sessions,
    orders,
    revenue,
    rps: 0,
    cvr: 0,
    aov: 0,
    ppEligibleShare: null,
    ppRenderedShare: null,
    reconciliationMin: null,
    descriptorStatus,
    sourcesConnected: [],
    sourcesMissing: [],
    toolsInstalled: [],
    ...analysisTallies(requirementRows, cardRows),
    status: analyzed.length > 0 ? 'analyzed' : 'partial',
    metadata: { pages_analyzed: analyzed.length, ...siteNotes },
  };
}
