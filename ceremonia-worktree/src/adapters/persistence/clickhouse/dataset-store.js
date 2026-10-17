import { subjectColumns } from '../../_lib/subject-columns.js';
import { clock, INSERT_CHUNK, nowCh } from './support.js';

/**
 * The DatasetStore role over ClickHouse: dataset rows, analysis checkpoints, and the traffic exclusion model.
 * @param {object} support the adapter's shared state from support.js
 * @returns {import('../../../ports/persistence/dataset-store.js').DatasetStore}
 */
export function createDatasetStore({ client, database, log, timedWrite, run }) {
  return {
    /**
     * Rerun-safe on row_key: a second write of the same
     * (batch, idsite, idsitehsr, dataset_id, row_key) replaces.
     * @param {import('../../../ports/persistence.js').AeDatasetRow[]} rows
     */
    /**
     * Drops one site's rows for the named datasets. A class change produces
     * a new row_key, so the previous key has to be removed. mutations_sync
     * waits until the delete is visible to the next read.
     * @param {{batchId: string, idsite: number, idsitehsr?: number, subjectType?: string, subjectKey?: string, datasetIds: string[]}} spec
     */
    async deleteDatasetRows(spec) {
      if (!spec.datasetIds || spec.datasetIds.length === 0) return;
      const pageClause = Number.isFinite(spec.idsitehsr) ? ' AND idsitehsr = {idsitehsr:UInt64}' : '';
      const subjectClause = spec.subjectKey === undefined
        ? ''
        : ' AND subject_type = {subjectType:String} AND subject_key = {subjectKey:String}';
      await client.command({
        query: `ALTER TABLE ${database}.ae_dataset_row
          DELETE WHERE batch_id = {batchId:UUID}
            AND idsite = {idsite:UInt32}
            AND dataset_id IN {ids:Array(String)}${pageClause}${subjectClause}`,
        query_params: {
          batchId: spec.batchId,
          idsite: spec.idsite,
          ids: spec.datasetIds,
          idsitehsr: spec.idsitehsr,
          subjectType: spec.subjectType ?? 'page',
          subjectKey: spec.subjectKey,
        },
        clickhouse_settings: { mutations_sync: '2' },
      });
      log('deleteDatasetRows', { idsite: spec.idsite, datasets: spec.datasetIds.length });
    },

    async writeDatasetRows(rows) {
      if (rows.length === 0) return;
      // The ClickHouse client joins each insert into one string. A full
      // trigger-chain result (~1M rows) exceeds V8's max string length.
      for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
        const slice = rows.slice(i, i + INSERT_CHUNK);
        await timedWrite('ae_dataset_row', slice, () => client.insert({
          table: `${database}.ae_dataset_row`,
          format: 'JSONEachRow',
          values: slice.map((r) => ({
            batch_id: r.batchId,
            idsite: r.idsite,
            idsitehsr: r.idsitehsr,
            scope: r.scope ?? 'page',
            dataset_id: r.datasetId,
            bot_filter: r.botFilter ?? '',
            dim_week: r.dimWeek ?? null,
            dim_device: r.dimDevice ?? '',
            dim_source: r.dimSource ?? '',
            dim_returning: r.dimReturning ?? '',
            dim_selector: r.dimSelector ?? '',
            dim_element_class: r.dimElementClass ?? '',
            dim_surface: r.dimSurface ?? '',
            dim_tool: r.dimTool ?? '',
            dim_extra: r.dimExtra ? JSON.stringify(r.dimExtra) : '',
            metrics: JSON.stringify(r.metrics ?? {}),
            row_key: r.rowKey,
            generated_at: clock.now(),
            ...subjectColumns(r),
          })),
        }));
      }
      log('writeDatasetRows', { rows: rows.length, dataset: rows[0]?.datasetId });
    },

    /**
     * Marks one dataset finished for this batch, site, and page. A later
     * write of the same key replaces. Called only after that dataset's
     * rows have been inserted.
     * @param {import('../../../ports/persistence.js').AeAnalysisCheckpoint} row
     */
    async writeAnalysisCheckpoint(row) {
      await client.insert({
        table: `${database}.ae_analysis_checkpoint`,
        format: 'JSONEachRow',
        values: [{
          batch_id: row.batchId,
          idsite: row.idsite,
          idsitehsr: row.idsitehsr,
          dataset_id: row.datasetId,
          scope: row.scope ?? 'page',
          row_count: row.rowCount ?? 0,
          notes: row.notes ?? '{}',
          generated_at: clock.now(),
          ...subjectColumns(row),
        }],
      });
      log('writeAnalysisCheckpoint', { idsite: row.idsite, dataset: row.datasetId });
    },

    /**
     * Finished datasets for one site in a batch. The current view keeps
     * the latest version of each key.
     * @param {{batchId: string, idsite: number}} key
     */
    async readAnalysisCheckpoints(key) {
      const rows = await run(client.query({
        query: `
          SELECT idsitehsr, dataset_id, scope, row_count, notes, subject_type, subject_key
            FROM ${database}.ae_analysis_checkpoint_current
           WHERE batch_id = {batchId:UUID}
             AND idsite = {idsite:UInt32}`,
        query_params: { batchId: key.batchId, idsite: key.idsite },
        format: 'JSONEachRow',
      }));
      return rows.map((row) => ({
        idsitehsr: Number(row.idsitehsr),
        datasetId: String(row.dataset_id),
        scope: String(row.scope ?? 'page'),
        rowCount: Number(row.row_count ?? 0),
        notes: String(row.notes ?? '{}'),
        subjectType: String(row.subject_type ?? 'page'),
        subjectKey: String(row.subject_key ?? ''),
      }));
    },

    /**
     * Stored rows for one dataset on one page. idsitehsr 0 is site scope.
     * @param {{batchId: string, idsite: number, idsitehsr: number, datasetId: string}} key
     */
    async readDatasetRows(key) {
      const rows = await run(client.query({
        query: `
          SELECT batch_id, idsite, idsitehsr, scope, dataset_id, bot_filter,
                 dim_week, dim_device, dim_source, dim_returning, dim_selector,
                 dim_element_class, dim_surface, dim_tool, dim_extra, metrics,
                 row_key, generated_at, subject_type, subject_key
            FROM ${database}.ae_dataset_row_current
           WHERE batch_id = {batchId:UUID}
             AND idsite = {idsite:UInt32}
             AND idsitehsr = {idsitehsr:UInt64}
             AND dataset_id = {datasetId:String}`,
        query_params: {
          batchId: key.batchId,
          idsite: key.idsite,
          idsitehsr: key.idsitehsr,
          datasetId: key.datasetId,
        },
        format: 'JSONEachRow',
      }));
      return rows;
    },

    /**
     * Stored rows for one dataset of one subject of any type.
     * @param {{batchId: string, idsite: number, subjectType: string, subjectKey: string, datasetId: string}} key
     */
    async readSubjectDatasetRows(key) {
      return run(client.query({
        query: `
          SELECT batch_id, idsite, idsitehsr, scope, dataset_id, bot_filter,
                 dim_week, dim_device, dim_source, dim_returning, dim_selector,
                 dim_element_class, dim_surface, dim_tool, dim_extra, metrics,
                 row_key, generated_at, subject_type, subject_key
            FROM ${database}.ae_dataset_row_current
           WHERE batch_id = {batchId:UUID}
             AND idsite = {idsite:UInt32}
             AND subject_type = {subjectType:String}
             AND subject_key = {subjectKey:String}
             AND dataset_id = {datasetId:String}`,
        query_params: {
          batchId: key.batchId,
          idsite: key.idsite,
          subjectType: key.subjectType,
          subjectKey: key.subjectKey,
          datasetId: key.datasetId,
        },
        format: 'JSONEachRow',
      }));
    },

    /**
     * Appends one model version. model_id is in the sort key, so an
     * earlier build stays readable.
     * @param {object[]} rows
     */
    async writeTrafficExclusionModel(rows) {
      if (rows.length === 0) return;
      const generatedAt = nowCh();
      await timedWrite('ae_traffic_exclusion_model', rows, () => client.insert({
        table: `${database}.ae_traffic_exclusion_model`,
        format: 'JSONEachRow',
        values: rows.map((r) => ({
          model_id: r.modelId,
          idsite: r.idsite,
          adapter_id: r.adapterId,
          window_start: r.windowStart,
          window_end: r.windowEnd,
          rule_id: r.ruleId,
          pattern_key: r.patternKey,
          disposition: r.disposition,
          reason: r.reason,
          sessions: r.sessions,
          orders: r.orders,
          clicks: r.clicks,
          revenue: r.revenue,
          share: r.share,
          constants_json: r.constantsJson,
          detail_json: r.detailJson,
          generated_at: generatedAt,
        })),
      }));
      log('writeTrafficExclusionModel', { rows: rows.length, modelId: rows[0]?.modelId });
    },
  };
}
