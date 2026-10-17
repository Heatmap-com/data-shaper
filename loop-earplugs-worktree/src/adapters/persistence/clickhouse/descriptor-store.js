import { clock } from './support.js';

/**
 * The DescriptorStore role over ClickHouse: page and store descriptors and the change log.
 * @param {object} support the adapter's shared state from support.js
 * @returns {import('../../../ports/persistence/descriptor-store.js').DescriptorStore}
 */
export function createDescriptorStore({ client, database, log, run, insertChangeRows }) {
  return {
    /**
     * Current page descriptor rows for one template and device class,
     * latest per field_path (the _current view collapses on the ORDER BY
     * key). Rows carry raw ae_page_descriptor columns.
     * @param {{idsite: number, template_key: string, device_class?: string}} key
     */
    async readPageDescriptor(key) {
      return run(
        client.query({
          query: `
            SELECT *
              FROM ${database}.ae_page_descriptor_current
             WHERE idsite = {idsite:UInt32} AND template_key = {templateKey:String} AND device_class = {deviceClass:String}
             ORDER BY field_path`,
          query_params: {
            idsite: key.idsite,
            templateKey: key.template_key,
            deviceClass: key.device_class ?? 'all',
          },
          format: 'JSONEachRow',
        }),
      );
    },

    /**
     * Current store descriptor rows for a site, latest per field_path.
     * @param {{idsite: number}} key
     */
    async readStoreDescriptor(key) {
      return run(
        client.query({
          query: `
            SELECT *
              FROM ${database}.ae_store_descriptor_current
             WHERE idsite = {idsite:UInt32}
             ORDER BY field_path`,
          query_params: { idsite: key.idsite },
          format: 'JSONEachRow',
        }),
      );
    },

    /**
     * Rows with a template_key land in ae_page_descriptor; rows without in
     * ae_store_descriptor.
     * @param {import('../../../ports/persistence.js').AeDescriptorRow[]} rows
     */
    async writeDescriptorRows(rows) {
      const pageRows = rows.filter((r) => r.template_key !== undefined);
      const storeRows = rows.filter((r) => r.template_key === undefined);
      if (pageRows.length > 0) {
        await client.insert({
          table: `${database}.ae_page_descriptor`,
          format: 'JSONEachRow',
          values: pageRows.map((r) => ({
            idsite: r.idsite,
            template_key: r.template_key,
            device_class: r.device_class ?? 'all',
            field_path: r.field_path,
            value_json: r.value_json ?? 'null',
            provenance: r.provenance ?? '',
            confidence: r.confidence ?? '',
            human_confirmed_by: r.human_confirmed_by ?? '',
            owner: r.owner ?? '',
            captured_at: r.captured_at ?? clock.now(),
            expires_at: r.expires_at ?? '',
            invalidated_by: r.invalidated_by ?? '',
            descriptor_version: r.descriptor_version ?? 1,
            generated_at: clock.now(),
          })),
        });
      }
      if (storeRows.length > 0) {
        await client.insert({
          table: `${database}.ae_store_descriptor`,
          format: 'JSONEachRow',
          values: storeRows.map((r) => ({
            idsite: r.idsite,
            field_path: r.field_path,
            value_json: r.value_json ?? 'null',
            provenance: r.provenance ?? '',
            confidence: r.confidence ?? '',
            human_confirmed_by: r.human_confirmed_by ?? '',
            owner: r.owner ?? '',
            captured_at: r.captured_at ?? clock.now(),
            expires_at: r.expires_at ?? '',
            invalidated_by: r.invalidated_by ?? '',
            descriptor_version: r.descriptor_version ?? 1,
            generated_at: clock.now(),
          })),
        });
      }
    },

    /**
     * Change log rows with effective_at inside [fromIso, toIso].
     * @param {number} idsite
     * @param {string} fromIso
     * @param {string} toIso
     */
    async readChanges(idsite, fromIso, toIso) {
      return run(
        client.query({
          query: `
            SELECT *
              FROM ${database}.ae_change_log_current
             WHERE idsite = {idsite:UInt32}
               AND effective_at >= {fromIso:String}::DateTime64(3)
               AND effective_at <= {toIso:String}::DateTime64(3)
             ORDER BY effective_at, change_id`,
          query_params: { idsite, fromIso, toIso },
          format: 'JSONEachRow',
        }),
      );
    },

    /** @param {import('../../../ports/persistence.js').AeChangeRow[]} rows */
    async writeChanges(rows) {
      await insertChangeRows(rows);
    },
  };
}
