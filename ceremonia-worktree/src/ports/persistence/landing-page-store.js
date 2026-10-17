/** @typedef {import('../persistence.js').AnalysisRecord} AnalysisRecord */
/** @typedef {import('../persistence.js').BatchSpec} BatchSpec */
/** @typedef {import('../persistence.js').DatasetRow} DatasetRow */
/** @typedef {import('../persistence.js').QueueUpdate} QueueUpdate */

/**
 * The v1 batch, its site queue, and the analysis and dataset rows.
 *
 * @typedef {Object} LandingPageStore
 * @property {(batch: BatchSpec) => Promise<void>} createBatch idempotent upsert; re-called with status/counts when the batch finishes
 * @property {(batchId: string, sites: object[]) => Promise<void>} enqueue
 * @property {(batchId: string) => Promise<object[]>} claimNext 0 or 1 row; never claims awaiting_naming
 * @property {(row: QueueUpdate) => Promise<void>} updateQueue
 * @property {(row: AnalysisRecord) => Promise<void>} writeAnalysis
 * @property {(rows: DatasetRow[]) => Promise<void>} writeDataset
 * @property {(batchId: string) => Promise<object | null>} readBatch current batch row or null; `--resume` reads it
 */

export const LANDING_PAGE_STORE = Object.freeze([
  'createBatch',
  'enqueue',
  'claimNext',
  'updateQueue',
  'writeAnalysis',
  'writeDataset',
  'readBatch',
]);
