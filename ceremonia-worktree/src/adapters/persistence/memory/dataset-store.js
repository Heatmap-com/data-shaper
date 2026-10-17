import { subjectColumns } from '../../_lib/subject-columns.js';
import { aeNow } from './support.js';

/**
 * The DatasetStore role over memory: dataset rows, analysis checkpoints, and the traffic exclusion model.
 * @param {object} support the adapter's shared state from support.js
 * @returns {import('../../../ports/persistence/dataset-store.js').DatasetStore}
 */
export function createDatasetStore({ store }) {
  return {
    /**
     * @param {import('../../../ports/persistence.js').AeDatasetRow[]} rows
     */
    /**
     * @param {{batchId: string, idsite: number, idsitehsr?: number, subjectType?: string, subjectKey?: string, datasetIds: string[]}} spec
     */
    async deleteDatasetRows(spec) {
      const ids = new Set(spec.datasetIds ?? []);
      const pageScoped = Number.isFinite(spec.idsitehsr);
      const subjectScoped = spec.subjectKey !== undefined;
      for (const [key, row] of store.datasetRows) {
        if (row.batch_id !== spec.batchId || row.idsite !== spec.idsite || !ids.has(row.dataset_id)) continue;
        if (pageScoped && Number(row.idsitehsr) !== Number(spec.idsitehsr)) continue;
        if (subjectScoped && (row.subject_type !== (spec.subjectType ?? 'page') || row.subject_key !== spec.subjectKey)) continue;
        store.datasetRows.delete(key);
      }
    },

    async writeDatasetRows(rows) {
      const undated = rows.find((r) => r.dimWeek != null && !/^\d{4}-\d{2}-\d{2}/.test(String(r.dimWeek)));
      if (undated) throw new Error(`dim_week is a date column; ${undated.datasetId} wrote "${undated.dimWeek}"`);
      for (const r of rows) {
        store.datasetRows.set(
          `${r.batchId}:${r.idsite}:${r.idsitehsr}:${r.datasetId}:${r.rowKey}`,
          {
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
            generated_at: aeNow(),
            ...subjectColumns(r),
          },
        );
      }
    },

    /** @param {import('../../../ports/persistence.js').AeAnalysisCheckpoint} row */
    async writeAnalysisCheckpoint(row) {
      store.analysisCheckpoints.set(
        `${row.batchId}:${row.idsite}:${row.idsitehsr}:${row.datasetId}`,
        {
          batch_id: row.batchId,
          idsite: row.idsite,
          idsitehsr: row.idsitehsr,
          dataset_id: row.datasetId,
          scope: row.scope ?? 'page',
          row_count: row.rowCount ?? 0,
          notes: row.notes ?? '{}',
          generated_at: aeNow(),
          ...subjectColumns(row),
        },
      );
    },

    /** @param {{batchId: string, idsite: number}} key */
    async readAnalysisCheckpoints(key) {
      const out = [];
      for (const row of store.analysisCheckpoints.values()) {
        if (row.batch_id !== key.batchId || row.idsite !== key.idsite) continue;
        out.push({
          idsitehsr: Number(row.idsitehsr),
          datasetId: row.dataset_id,
          scope: row.scope ?? 'page',
          rowCount: Number(row.row_count ?? 0),
          notes: row.notes ?? '{}',
          subjectType: row.subject_type,
          subjectKey: row.subject_key,
        });
      }
      return out;
    },

    /** @param {{batchId: string, idsite: number, idsitehsr: number, datasetId: string}} key */
    async readDatasetRows(key) {
      const out = [];
      for (const row of store.datasetRows.values()) {
        if (row.batch_id !== key.batchId || row.idsite !== key.idsite) continue;
        if (Number(row.idsitehsr) !== Number(key.idsitehsr) || row.dataset_id !== key.datasetId) continue;
        out.push(row);
      }
      return out;
    },

    /** @param {{batchId: string, idsite: number, subjectType: string, subjectKey: string, datasetId: string}} key */
    async readSubjectDatasetRows(key) {
      return [...store.datasetRows.values()].filter((row) => row.batch_id === key.batchId
        && row.idsite === key.idsite
        && row.subject_type === key.subjectType
        && row.subject_key === key.subjectKey
        && row.dataset_id === key.datasetId);
    },

    /** Keeps every model version. A new modelId does not replace an earlier one. */
    async writeTrafficExclusionModel(rows) {
      for (const row of rows) {
        store.trafficExclusionModels.set(`${row.modelId}:${row.ruleId}:${row.patternKey}`, { ...row });
      }
    },
  };
}
