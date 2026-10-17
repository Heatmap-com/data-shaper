/** @typedef {import('./dataset-store.js').DatasetStore} DatasetStore */
/** @typedef {import('./descriptor-store.js').DescriptorStore} DescriptorStore */
/** @typedef {import('./card-analysis-store.js').CardAnalysisStore} CardAnalysisStore */

/**
 * The writes a replay makes: it deletes and rewrites the replayed dataset
 * rows, writes drafted descriptor rows, and rewrites the requirement status,
 * cards, and page and site analysis rows.
 *
 * @typedef {Pick<DatasetStore, 'deleteDatasetRows' | 'writeDatasetRows'>
 *   & Pick<DescriptorStore, 'writeDescriptorRows'>
 *   & Pick<CardAnalysisStore, 'writeRequirementStatus' | 'writeCards' | 'writePageAnalysis' | 'writeSiteAnalysis'>} ReplayStore
 */

export const REPLAY_STORE = Object.freeze([
  'deleteDatasetRows',
  'writeDatasetRows',
  'writeDescriptorRows',
  'writeRequirementStatus',
  'writeCards',
  'writePageAnalysis',
  'writeSiteAnalysis',
]);
