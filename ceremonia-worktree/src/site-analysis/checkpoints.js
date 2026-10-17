import { collectedFromStored } from '../adapters/_lib/rows.js';
import { subjectOf, toAeDatasetRows } from './rows.js';

/**
 * @param {number} idsitehsr 0 for site-scope work
 * @param {string} datasetId
 */
export function checkpointKey(idsitehsr, datasetId) {
  return `${idsitehsr}:${datasetId}`;
}

/**
 * The site's finished datasets, keyed by checkpointKey.
 * @param {import('../ports/persistence/dataset-store.js').DatasetStore} persistence
 * @param {string} batchId
 * @param {number} idsite
 * @returns {Promise<Map<string, object>>}
 */
export async function loadCheckpoints(persistence, batchId, idsite) {
  const map = new Map();
  const rows = await persistence.readAnalysisCheckpoints({ batchId, idsite });
  for (const row of rows) map.set(checkpointKey(row.idsitehsr, row.datasetId), row);
  return map;
}

/**
 * @param {object} checkpoint
 */
function notesFromCheckpoint(checkpoint) {
  try {
    const parsed = JSON.parse(checkpoint?.notes ?? '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * A finished dataset, read back from its stored rows and checkpoint notes.
 * @param {import('../ports/persistence/dataset-store.js').DatasetStore} persistence
 * @param {string} batchId
 * @param {{idsite: number, idsitehsr: number}} page
 * @param {string} datasetId
 * @param {object} checkpoint
 */
export async function hydrateDataset(persistence, batchId, page, datasetId, checkpoint) {
  const raw = await persistence.readDatasetRows({
    batchId,
    idsite: page.idsite,
    idsitehsr: page.idsitehsr,
    datasetId,
  });
  return collectedFromStored(datasetId, raw, notesFromCheckpoint(checkpoint));
}

/**
 * A subject's finished dataset, read back from its stored rows.
 * @param {import('../ports/persistence/dataset-store.js').DatasetStore} persistence
 * @param {string} batchId
 * @param {{idsite: number, subjectType: string, subjectKey: string}} subject
 * @param {string} datasetId
 */
export async function hydrateSubjectDataset(persistence, batchId, subject, datasetId) {
  const raw = await persistence.readSubjectDatasetRows({
    batchId,
    idsite: subject.idsite,
    subjectType: subject.subjectType,
    subjectKey: subject.subjectKey,
    datasetId,
  });
  return collectedFromStored(datasetId, raw, {});
}

/**
 * Writes one dataset's rows and its requirement and card rows, without a
 * checkpoint. A step that writes several subjects' rows under one
 * checkpoint writes that checkpoint once they are all stored.
 * @param {import('../ports/persistence/dataset-store.js').DatasetStore
 *   & Pick<import('../ports/persistence/card-analysis-store.js').CardAnalysisStore, 'writeRequirementStatus' | 'writeCards'>} persistence
 * @param {string} batchId
 * @param {{idsite: number, idsitehsr: number}} page
 * @param {{id: string, rows?: object[], notes?: object}} collected
 * @param {string} scope
 * @param {{requirementRows?: object[], cardRows?: object[]}} [side]
 */
export async function writeCollected(persistence, batchId, page, collected, scope, side = {}) {
  const subject = subjectOf(page);
  const rows = toAeDatasetRows(batchId, page, collected, scope);
  if (rows.length > 0) await persistence.writeDatasetRows(rows);
  if (side.requirementRows?.length > 0) await persistence.writeRequirementStatus(side.requirementRows.map((r) => ({ ...r, ...subject })));
  if (side.cardRows?.length > 0) await persistence.writeCards(side.cardRows.map((r) => ({ ...r, ...subject })));
}

/**
 * Writes one dataset, then its checkpoint. The checkpoint is the resume
 * mark, so it is written after the rows.
 * @param {import('../ports/persistence/dataset-store.js').DatasetStore
 *   & Pick<import('../ports/persistence/card-analysis-store.js').CardAnalysisStore, 'writeRequirementStatus' | 'writeCards'>} persistence
 * @param {string} batchId
 * @param {{idsite: number, idsitehsr: number}} page
 * @param {{id: string, rows?: object[], notes?: object}} collected
 * @param {string} scope
 * @param {{requirementRows?: object[], cardRows?: object[]}} [side]
 */
export async function commitCollected(persistence, batchId, page, collected, scope, side = {}) {
  const subject = subjectOf(page);
  await writeCollected(persistence, batchId, page, collected, scope, side);
  await persistence.writeAnalysisCheckpoint({
    batchId,
    idsite: page.idsite,
    idsitehsr: page.idsitehsr,
    datasetId: collected.id,
    scope,
    rowCount: collected.rows?.length ?? 0,
    notes: JSON.stringify(collected.notes ?? {}),
    ...subject,
  });
}
