/** @typedef {import('../persistence.js').AePageAnalysisRow} AePageAnalysisRow */
/** @typedef {import('../persistence.js').AeRequirementStatusRow} AeRequirementStatusRow */
/** @typedef {import('../persistence.js').AeSiteAnalysisRow} AeSiteAnalysisRow */
/** @typedef {import('../persistence.js').AeStrategyCardRow} AeStrategyCardRow */

/**
 * Requirement status, strategy cards, and the page and site analysis rows.
 *
 * @typedef {Object} CardAnalysisStore
 * @property {(key: {batchId: string, idsite: number}) => Promise<Array<{idsitehsr: number, status: string}>>} readRequirementStatus
 * @property {(key: {batchId: string, idsite: number}) => Promise<Array<{idsitehsr: number, verdict: string, triggerState: string}>>} readCards
 * @property {(rows: AeRequirementStatusRow[]) => Promise<void>} writeRequirementStatus
 * @property {(rows: AeStrategyCardRow[]) => Promise<void>} writeCards
 * @property {(row: AePageAnalysisRow) => Promise<void>} writePageAnalysis
 * @property {(row: AeSiteAnalysisRow) => Promise<void>} writeSiteAnalysis
 * @property {(key: {idsite: number, strategyId: string, n: number}) => Promise<object[]>} cardHistory latest n cards across batches, generated_at desc
 */

export const CARD_ANALYSIS_STORE = Object.freeze([
  'readRequirementStatus',
  'readCards',
  'writeRequirementStatus',
  'writeCards',
  'writePageAnalysis',
  'writeSiteAnalysis',
  'cardHistory',
]);
