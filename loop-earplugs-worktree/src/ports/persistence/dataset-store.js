/** @typedef {import('../persistence.js').AeAnalysisCheckpoint} AeAnalysisCheckpoint */
/** @typedef {import('../persistence.js').AeDatasetRow} AeDatasetRow */

/**
 * Dataset rows, analysis checkpoints, and the traffic exclusion model.
 *
 * @typedef {Object} DatasetStore
 * @property {(spec: {batchId: string, idsite: number, idsitehsr?: number, subjectType?: string, subjectKey?: string, datasetIds: string[]}) => Promise<void>} deleteDatasetRows removes the site's (or one page's, or one subject's) stored rows for the named datasets before a replay rewrites them
 * @property {(rows: AeDatasetRow[]) => Promise<void>} writeDatasetRows idempotent on row_key
 * @property {(row: AeAnalysisCheckpoint) => Promise<void>} writeAnalysisCheckpoint replaces on (batch, idsite, idsitehsr, dataset_id); written after the dataset rows
 * @property {(key: {batchId: string, idsite: number}) => Promise<AeAnalysisCheckpoint[]>} readAnalysisCheckpoints finished datasets for the site
 * @property {(key: {batchId: string, idsite: number, idsitehsr: number, datasetId: string}) => Promise<object[]>} readDatasetRows stored rows for one dataset
 * @property {(key: {batchId: string, idsite: number, subjectType: string, subjectKey: string, datasetId: string}) => Promise<object[]>} readSubjectDatasetRows stored rows for one dataset of one subject of any type
 * @property {(rows: object[]) => Promise<void>} writeTrafficExclusionModel appends one model version; model_id keeps earlier versions
 */

export const DATASET_STORE = Object.freeze([
  'deleteDatasetRows',
  'writeDatasetRows',
  'writeAnalysisCheckpoint',
  'readAnalysisCheckpoints',
  'readDatasetRows',
  'readSubjectDatasetRows',
  'writeTrafficExclusionModel',
]);
