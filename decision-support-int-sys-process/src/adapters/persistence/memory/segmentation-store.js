import { latestDefinitions } from '../../../ports/persistence/segmentation-store.js';

/**
 * The SegmentationStore role over memory.
 * @param {object} support the adapter's shared state from support.js
 * @returns {import('../../../ports/persistence/segmentation-store.js').SegmentationStore}
 */
export function createSegmentationStore({ store }) {
  return {
    async writeSegmentationDefinitions(rows) {
      for (const row of rows) {
        store.segmentationDefinitions.set(`${row.idsite}:${row.segmentation}:${row.version}`, {
          idsite: Number(row.idsite),
          segmentation: row.segmentation,
          version: Number(row.version),
          kind: row.kind,
          stamp: row.stamp,
          definition: structuredClone(row.definition ?? {}),
          values: [...(row.values ?? [])],
        });
      }
    },

    async readSegmentationDefinitions(idsite) {
      return latestDefinitions([...store.segmentationDefinitions.values()], idsite).map((row) => structuredClone(row));
    },
  };
}
