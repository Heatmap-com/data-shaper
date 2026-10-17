/** @typedef {import('../persistence.js').AeExperimentAnalysisRow} AeExperimentAnalysisRow */
/** @typedef {import('../persistence.js').AeExperimentDescriptorRow} AeExperimentDescriptorRow */
/** @typedef {import('../persistence.js').AeExperimentRow} AeExperimentRow */
/** @typedef {import('../persistence.js').AeReviewVerdictRow} AeReviewVerdictRow */
/** @typedef {import('../persistence.js').AeToolRegistryRow} AeToolRegistryRow */

/**
 * Experiments, their descriptors and analysis rows, review verdicts, and the tool registry.
 *
 * @typedef {Object} GovernanceStore
 * @property {(rows: AeExperimentRow[]) => Promise<void>} writeExperiments idempotent on (idsite, experiment_id)
 * @property {(rows: AeExperimentDescriptorRow[]) => Promise<void>} writeExperimentDescriptors idempotent on (idsite, experiment_key, provenance)
 * @property {(idsite: number) => Promise<AeExperimentDescriptorRow[]>} readExperimentDescriptors latest per (experiment_key, provenance)
 * @property {(rows: AeExperimentAnalysisRow[]) => Promise<void>} writeExperimentRows idempotent on the experiment row identity; batch_id is not in it
 * @property {(rows: AeReviewVerdictRow[]) => Promise<void>} writeVerdicts idempotent on (idsite, subject_kind, subject_ref, verdict_kind, verdict_id)
 * @property {(rows: AeToolRegistryRow[]) => Promise<void>} writeToolRegistry idempotent replace on (idsite, tool)
 */

export const GOVERNANCE_STORE = Object.freeze([
  'writeExperiments',
  'writeExperimentDescriptors',
  'readExperimentDescriptors',
  'writeExperimentRows',
  'writeVerdicts',
  'writeToolRegistry',
]);
