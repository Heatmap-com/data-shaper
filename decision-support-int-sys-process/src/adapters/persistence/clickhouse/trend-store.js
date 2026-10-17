import { clock } from './support.js';

/**
 * The TrendStore role over ClickHouse: weekly trend rows, trend selectors, and the subjects already stored.
 * @param {object} support the adapter's shared state from support.js
 * @returns {import('../../../ports/persistence/trend-store.js').TrendStore}
 */
export function createTrendStore({ client, database, log, timedWrite, run }) {
  return {
    /**
     * Replaces on the trend identity: idsite, row type, keys, viewport,
     * segment, segment value, week, and idsitehsr. A later write of that
     * identity wins.
     * @param {import('../../../ports/persistence.js').AeTrendRow[]} rows
     */
    async writeTrendRows(rows) {
      if (rows.length === 0) return;
      await timedWrite('ae_trend_row', rows, () => client.insert({
        table: `${database}.ae_trend_row`,
        format: 'JSONEachRow',
        values: rows.map((r) => ({
          batch_id: r.batchId,
          idsite: r.idsite,
          idsitehsr: r.idsitehsr ?? 0,
          row_type: r.rowType,
          row_key: r.rowKey,
          row_key_1: r.rowKey1 ?? '',
          row_key_2: r.rowKey2 ?? '',
          segment: r.segment,
          segment_value: r.segmentValue,
          viewport_type: r.viewportType,
          week: r.week,
          sessions: r.sessions ?? 0,
          buyers: r.buyers ?? 0,
          orders: r.orders ?? 0,
          revenue: r.revenue ?? 0,
          clicks: r.clicks ?? 0,
          progressed: r.progressed ?? 0,
          metrics: JSON.stringify(r.metrics ?? {}),
          generated_at: clock.now(),
        })),
      }));
      log('writeTrendRows', { rows: rows.length, rowType: rows[0]?.rowType });
    },

    /**
     * Replaces on (idsite, idsitehsr). A later generated_at wins.
     * @param {import('../../../ports/persistence.js').AeTrendSelectorRow[]} rows
     */
    async writeTrendSelectors(rows) {
      if (rows.length === 0) return;
      await timedWrite('ae_trend_selector', rows, () => client.insert({
        table: `${database}.ae_trend_selector`,
        format: 'JSONEachRow',
        values: rows.map((r) => ({
          idsite: r.idsite,
          idsitehsr: r.idsitehsr,
          trend_selectors: r.trendSelectors ?? [],
          status: r.status,
          generated_at: clock.now(),
        })),
      }));
      log('writeTrendSelectors', { rows: rows.length });
    },

    /**
     * @param {number} idsite
     * @returns {Promise<import('../../../ports/persistence.js').AeTrendSelectorRow[]>}
     */
    async readTrendSelectors(idsite) {
      const rows = await run(client.query({
        query: `
          SELECT idsite, idsitehsr, trend_selectors, status
            FROM ${database}.ae_trend_selector_current
           WHERE idsite = {idsite:UInt32}`,
        query_params: { idsite },
        format: 'JSONEachRow',
      }));
      return rows.map((row) => ({
        idsite: Number(row.idsite),
        idsitehsr: Number(row.idsitehsr),
        trendSelectors: Array.isArray(row.trend_selectors) ? row.trend_selectors.map(String) : [],
        status: String(row.status ?? ''),
      }));
    },

    /**
     * Path and page subjects already stored for the site. The all/all
     * viewport total is the one row that names the subject.
     * @param {number} idsite
     */
    async readTrendSubjects(idsite) {
      const rows = await run(client.query({
        query: `
          SELECT row_key, row_key_1,
                 min(JSONExtractInt(metrics, 'rank')) AS rank
            FROM ${database}.ae_trend_row_current
           WHERE idsite = {idsite:UInt32}
             AND viewport_type = 'all'
             AND segment = 'all'
             AND segment_value = 'all'
             AND row_key IN ('path', 'url_path', 'page')
           GROUP BY row_key, row_key_1
           ORDER BY rank, row_key_1
           LIMIT 100`,
        query_params: { idsite },
        format: 'JSONEachRow',
      }));
      return {
        paths: rows.filter((row) => row.row_key === 'path').map((row) => String(row.row_key_1)),
        urlPaths: rows.filter((row) => row.row_key === 'url_path').map((row) => String(row.row_key_1)),
        pages: rows.filter((row) => row.row_key === 'page').map((row) => String(row.row_key_1)),
      };
    },

    /**
     * The latest stored week of each subject, from the all/all viewport
     * totals, ordered by row key, page, and subject.
     * @param {number} idsite
     */
    async readTrendWeeks(idsite) {
      const rows = await run(client.query({
        query: `
          SELECT row_key, row_key_1, idsitehsr, toString(max(week)) AS week
            FROM ${database}.ae_trend_row_current
           WHERE idsite = {idsite:UInt32}
             AND viewport_type = 'all'
             AND segment = 'all'
             AND segment_value = 'all'
             AND row_key IN ('path', 'url_path', 'page', 'selector')
           GROUP BY row_key, row_key_1, idsitehsr
           ORDER BY row_key, idsitehsr, row_key_1`,
        query_params: { idsite },
        format: 'JSONEachRow',
      }));
      return rows.map((row) => ({
        rowKey: String(row.row_key),
        rowKey1: String(row.row_key_1),
        idsitehsr: Number(row.idsitehsr),
        week: String(row.week),
      }));
    },

    async readTrendWeekRange(idsite, segment) {
      const subjects = await run(client.query({
        query: `
          SELECT row_key, row_key_1, row_key_2, idsitehsr, toString(min(week)) AS first, toString(max(week)) AS last
            FROM ${database}.ae_trend_row_current
           WHERE idsite = {idsite:UInt32}
             AND segment = {segment:String}
             AND row_key IN ('path', 'url_path', 'page', 'selector')
           GROUP BY row_key, row_key_1, row_key_2, idsitehsr
           ORDER BY row_key, idsitehsr, row_key_1, row_key_2`,
        query_params: { idsite, segment },
        format: 'JSONEachRow',
      }));
      const values = await run(client.query({
        query: `
          SELECT DISTINCT segment_value
            FROM ${database}.ae_trend_row_current
           WHERE idsite = {idsite:UInt32}
             AND segment = {segment:String}
           ORDER BY segment_value`,
        query_params: { idsite, segment },
        format: 'JSONEachRow',
      }));
      return {
        subjects: subjects.map((row) => ({
          rowKey: String(row.row_key),
          rowKey1: String(row.row_key_1),
          rowKey2: String(row.row_key_2),
          idsitehsr: Number(row.idsitehsr),
          first: String(row.first),
          last: String(row.last),
        })),
        values: values.map((row) => String(row.segment_value)),
      };
    },
  };
}
