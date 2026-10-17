import { clock } from './support.js';

/**
 * The SessionTagStore role over ClickHouse: session tag trend rows and the tag key selection.
 * @param {object} support the adapter's shared state from support.js
 * @returns {import('../../../ports/persistence/session-tag-store.js').SessionTagStore}
 */
export function createSessionTagStore({ client, database, log, timedWrite, run }) {
  return {
    /**
     * Replaces on (idsite, tag key, tag value, viewport, segment, segment
     * value, week). A later write of that identity wins.
     * @param {import('../../../ports/persistence.js').AeSessionTagTrendRow[]} rows
     */
    async writeTagTrendRows(rows) {
      if (rows.length === 0) return;
      await timedWrite('ae_session_tag_trend', rows, () => client.insert({
        table: `${database}.ae_session_tag_trend`,
        format: 'JSONEachRow',
        values: rows.map((r) => ({
          batch_id: r.batchId,
          idsite: r.idsite,
          tag_key: r.tagKey,
          tag_value: r.tagValue,
          viewport_type: r.viewportType,
          segment: r.segment,
          segment_value: r.segmentValue,
          week: r.week,
          sessions: r.sessions ?? 0,
          buyers: r.buyers ?? 0,
          orders: r.orders ?? 0,
          revenue: r.revenue ?? 0,
          progressed: r.progressed ?? 0,
          metrics: JSON.stringify(r.metrics ?? {}),
          generated_at: clock.now(),
        })),
      }));
      log('writeTagTrendRows', { rows: rows.length });
    },

    /**
     * Replaces on (idsite, tag_key). Every key of one run shares its batch_id.
     * @param {import('../../../ports/persistence.js').AeSessionTagSelectionRow[]} rows
     */
    async writeTagSelection(rows) {
      if (rows.length === 0) return;
      await timedWrite('ae_session_tag_selection', rows, () => client.insert({
        table: `${database}.ae_session_tag_selection`,
        format: 'JSONEachRow',
        values: rows.map((r) => ({
          batch_id: r.batchId,
          idsite: r.idsite,
          tag_key: r.tagKey,
          adapter_id: r.adapterId,
          family: r.family,
          status: r.status,
          reason: r.reason ?? '',
          window_start: r.windowStart,
          window_end: r.windowEnd,
          tagged_sessions: r.taggedSessions ?? 0,
          distinct_values: r.distinctValues ?? 0,
          rps_z: r.rpsZ ?? null,
          rps_spread: r.rpsSpread ?? null,
          aov_z: r.aovZ ?? null,
          aov_spread: r.aovSpread ?? null,
          trend_values: r.trendValues ?? [],
          metrics: JSON.stringify(r.metrics ?? {}),
          generated_at: clock.now(),
        })),
      }));
      log('writeTagSelection', { rows: rows.length });
    },

    /**
     * The selected keys of the site's latest selection batch, with their
     * trend values. Empty when the site has never been selected.
     * @param {number} idsite
     * @returns {Promise<Array<{tagKey: string, family: string, trendValues: string[]}>>}
     */
    async readTagSelection(idsite) {
      const rows = await run(client.query({
        query: `
          SELECT tag_key, family, trend_values
            FROM ${database}.ae_session_tag_selection_current
           WHERE idsite = {idsite:UInt32}
             AND status = 'selected'
             AND batch_id = (
               SELECT argMax(batch_id, generated_at)
                 FROM ${database}.ae_session_tag_selection_current
                WHERE idsite = {idsite:UInt32}
             )
           ORDER BY tag_key`,
        query_params: { idsite },
        format: 'JSONEachRow',
      }));
      return rows.map((row) => ({
        tagKey: String(row.tag_key),
        family: String(row.family ?? ''),
        trendValues: Array.isArray(row.trend_values) ? row.trend_values.map(String) : [],
      }));
    },

    /**
     * The latest stored week of each tag key, from the all/all viewport totals.
     * @param {number} idsite
     * @returns {Promise<Array<{tagKey: string, week: string}>>}
     */
    async readTagTrendWeeks(idsite) {
      const rows = await run(client.query({
        query: `
          SELECT tag_key, toString(max(week)) AS week
            FROM ${database}.ae_session_tag_trend_current
           WHERE idsite = {idsite:UInt32}
             AND viewport_type = 'all'
             AND segment = 'all'
             AND segment_value = 'all'
           GROUP BY tag_key
           ORDER BY tag_key`,
        query_params: { idsite },
        format: 'JSONEachRow',
      }));
      return rows.map((row) => ({ tagKey: String(row.tag_key), week: String(row.week) }));
    },

    async readTagTrendWeekRange(idsite, segment) {
      const keys = await run(client.query({
        query: `
          SELECT tag_key, toString(min(week)) AS first, toString(max(week)) AS last
            FROM ${database}.ae_session_tag_trend_current
           WHERE idsite = {idsite:UInt32}
             AND segment = {segment:String}
           GROUP BY tag_key
           ORDER BY tag_key`,
        query_params: { idsite, segment },
        format: 'JSONEachRow',
      }));
      const values = await run(client.query({
        query: `
          SELECT DISTINCT segment_value
            FROM ${database}.ae_session_tag_trend_current
           WHERE idsite = {idsite:UInt32}
             AND segment = {segment:String}
           ORDER BY segment_value`,
        query_params: { idsite, segment },
        format: 'JSONEachRow',
      }));
      return {
        keys: keys.map((row) => ({ tagKey: String(row.tag_key), first: String(row.first), last: String(row.last) })),
        values: values.map((row) => String(row.segment_value)),
      };
    },
  };
}
