/** @typedef {import('../persistence.js').AeBatchSpec} AeBatchSpec */
/** @typedef {import('../persistence.js').AePageTarget} AePageTarget */
/** @typedef {import('../persistence.js').AePageTargetUpdate} AePageTargetUpdate */
/** @typedef {import('../persistence.js').AeSiteUpdate} AeSiteUpdate */
/** @typedef {import('../subject.js').SubjectTarget} SubjectTarget */

/**
 * The schema-2 batch, its site queue, the page targets, and the subject targets.
 *
 * @typedef {Object} BatchStore
 * @property {(batch: AeBatchSpec) => Promise<void>} createBatch
 * @property {(batchId: string) => Promise<object | null>} getBatch current batch row or null
 * @property {(batchId: string, sites: Array<{idsite: number, siteName: string}>) => Promise<void>} enqueueSites idempotent on (batchId, idsite)
 * @property {(batchId: string, claimTtlMs?: number) => Promise<{idsite: number, siteName: string} | null>} claimNextSite
 * @property {(update: AeSiteUpdate) => Promise<void>} updateSite merges over the current row
 * @property {(batchId: string, idsite: number, targets: AePageTarget[]) => Promise<void>} writePageTargets
 * @property {(update: AePageTargetUpdate) => Promise<void>} updatePageTarget merges over the current row
 * @property {(batchId: string, idsite: number, targets: SubjectTarget[]) => Promise<void>} writeSubjectTargets replaces on (batch, idsite, subject type, subject key)
 * @property {(key: {batchId: string, idsite: number}) => Promise<Array<SubjectTarget & {status: string, reason: string}>>} readSubjectTargets the site's subjects, by type then key
 * @property {(update: {batchId: string, idsite: number, subjectType: string, subjectKey: string, status?: string, reason?: string}) => Promise<void>} updateSubjectTarget merges status and reason over the current row
 */

export const BATCH_STORE = Object.freeze([
  'createBatch',
  'getBatch',
  'enqueueSites',
  'claimNextSite',
  'updateSite',
  'writePageTargets',
  'updatePageTarget',
  'writeSubjectTargets',
  'readSubjectTargets',
  'updateSubjectTarget',
]);
