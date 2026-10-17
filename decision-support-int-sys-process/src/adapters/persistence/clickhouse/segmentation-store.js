import { SHIPPED_SITE, latestDefinitions } from '../../../ports/persistence/segmentation-store.js';
import { clock } from './support.js';

/**
 * The SegmentationStore role over ClickHouse: ae_segmentation_definition.
 * @param {object} support the adapter's shared state from support.js
 * @returns {import('../../../ports/persistence/segmentation-store.js').SegmentationStore}
 */
export function createSegmentationStore({ client, database, log, timedWrite, run }) {
  return {
    /** Replaces each row on (idsite, segmentation, version); a later generated_at wins. */
    async writeSegmentationDefinitions(rows) {
      if (rows.length === 0) return;
      await timedWrite('ae_segmentation_definition', rows, () => client.insert({
        table: `${database}.ae_segmentation_definition`,
        format: 'JSONEachRow',
        values: rows.map((row) => ({
          idsite: row.idsite,
          segmentation: row.segmentation,
          version: row.version,
          kind: row.kind,
          stamp: row.stamp,
          definition: JSON.stringify(row.definition ?? {}),
          values: row.values ?? [],
          generated_at: clock.now(),
        })),
      }));
      log('writeSegmentationDefinitions', { rows: rows.length });
    },

    async readSegmentationDefinitions(idsite) {
      const rows = await run(client.query({
        query: `
          SELECT idsite, segmentation, version, kind, stamp, definition, \`values\`
            FROM ${database}.ae_segmentation_definition_current
           WHERE idsite IN ({idsite:UInt32}, {shipped:UInt32})`,
        query_params: { idsite, shipped: SHIPPED_SITE },
        format: 'JSONEachRow',
      }));
      return latestDefinitions(rows.map((row) => ({
        idsite: Number(row.idsite),
        segmentation: row.segmentation,
        version: Number(row.version),
        kind: row.kind,
        stamp: row.stamp,
        definition: typeof row.definition === 'string' ? JSON.parse(row.definition) : row.definition,
        values: [...(row.values ?? [])],
      })), idsite);
    },
  };
}
