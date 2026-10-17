import { randomUUID } from 'node:crypto';
import { CLAIM_TTL_MS, staleBeforeCh, clock, toIsoDate } from './support.js';

/**
 * The LandingPageStore role over ClickHouse: the v1 batch, its site queue, and the analysis and dataset rows.
 * @param {object} support the adapter's shared state from support.js
 * @returns {import('../../../ports/persistence/landing-page-store.js').LandingPageStore}
 */
export function createLandingPageStore({ client, database, log }) {
  return {
    /** @param {import('../../../ports/persistence.js').BatchSpec} batch */
    async createBatch(batch) {
      await client.insert({
        table: `${database}.landing_page_batch`,
        format: 'JSONEachRow',
        values: [
          {
            batch_id: batch.batchId,
            created_at: clock.now(),
            window_start: batch.windowStart,
            window_end: batch.windowEnd,
            site_source: batch.siteSource,
            qualifier: batch.qualifier,
            min_sessions: batch.minSessions,
            min_orders: batch.minOrders,
            min_share_of_home: batch.minShareOfHome,
            status: batch.status ?? 'running',
            sites_queued: batch.sitesQueued ?? 0,
            sites_qualified: batch.sitesQualified ?? 0,
            sites_skipped: batch.sitesSkipped ?? 0,
            sites_failed: batch.sitesFailed ?? 0,
            metadata: JSON.stringify(batch.metadata ?? {}),
          },
        ],
      });
    },

    /** @param {string} batchId @param {Array<{idsite: number, siteName: string}>} sites */
    async enqueue(batchId, sites) {
      if (sites.length === 0) return;
      const selects = sites
        .map(
          (_, i) =>
            `SELECT {idsite${i}:UInt32} AS idsite, {name${i}:String} AS site_name, {ts${i}:DateTime64(3)} AS ts`,
        )
        .join(' UNION ALL ');
      const params = { batchId };
      sites.forEach((s, i) => {
        params[`idsite${i}`] = s.idsite;
        params[`name${i}`] = s.siteName ?? '';
        params[`ts${i}`] = clock.now();
      });
      await client.command({
        query: `
          INSERT INTO ${database}.site_queue
              (batch_id, idsite, site_name, status, idsitehsr, landing_page_url, page_type, entry_sessions, orders, revenue, reason, claim_token, generated_at)
          SELECT {batchId:UUID}, n.idsite, n.site_name, 'queued', 0, '', '', 0, 0, 0, '', '', n.ts
          FROM (${selects}) n
          LEFT ANTI JOIN (
              SELECT idsite FROM ${database}.site_queue_current WHERE batch_id = {batchId:UUID}
          ) cur ON cur.idsite = n.idsite
        `,
        query_params: params,
      });
      log('enqueue', { batchId, sites: sites.length });
    },

    /**
     * Token-claimed for concurrent agents: the claim inserts a qualifying
     * row carrying a random token, then re-reads the current view. A
     * concurrent claimer with a newer generated_at wins; the loser backs
     * off and looks for another site. ClickHouse is not a lock manager;
     * the token only prevents duplicate work, writes stay idempotent.
     * Never claims awaiting_naming.
     * @param {string} batchId
     * @param {number} [claimTtlMs]
     * @returns {Promise<object[]>} 0 or 1 row
     */
    async claimNext(batchId, claimTtlMs = CLAIM_TTL_MS) {
      const candidates = await client
        .query({
          query: `
            SELECT idsite, site_name
              FROM ${database}.site_queue_current
             WHERE batch_id = {batchId:UUID}
               AND (status = 'queued'
                    OR (status IN ('qualifying', 'analyzing')
                        AND generated_at < {staleBefore:String}::DateTime64(3)))
             ORDER BY idsite
             LIMIT 1`,
          query_params: { batchId, staleBefore: staleBeforeCh(claimTtlMs) },
          format: 'JSONEachRow',
        })
        .then((r) => r.json());
      if (candidates.length === 0) return [];
      const row = candidates[0];
      const token = randomUUID();
      await client.insert({
        table: `${database}.site_queue`,
        format: 'JSONEachRow',
        values: [
          {
            batch_id: batchId,
            idsite: Number(row.idsite),
            site_name: row.site_name ?? '',
            status: 'qualifying',
            idsitehsr: 0,
            landing_page_url: '',
            page_type: '',
            entry_sessions: 0,
            orders: 0,
            revenue: 0,
            reason: '',
            claim_token: token,
            generated_at: clock.now(),
          },
        ],
      });
      const mine = await client
        .query({
          query: `
            SELECT claim_token
              FROM ${database}.site_queue_current
             WHERE batch_id = {batchId:UUID} AND idsite = {idsite:UInt32}`,
          query_params: { batchId, idsite: Number(row.idsite) },
          format: 'JSONEachRow',
        })
        .then((r) => r.json());
      if (String(mine[0]?.claim_token ?? '') !== token) return [];
      return [{ idsite: Number(row.idsite), site_name: row.site_name ?? '' }];
    },

    /** @param {import('../../../ports/persistence.js').QueueUpdate} update */
    async updateQueue(update) {
      const current = await client
        .query({
          query: `
            SELECT * FROM ${database}.site_queue_current
             WHERE batch_id = {batchId:UUID} AND idsite = {idsite:UInt32}`,
          query_params: { batchId: update.batchId, idsite: update.idsite },
          format: 'JSONEachRow',
        })
        .then((r) => r.json());
      const prev = current[0] ?? {};
      await client.insert({
        table: `${database}.site_queue`,
        format: 'JSONEachRow',
        values: [
          {
            batch_id: update.batchId,
            idsite: update.idsite,
            site_name: prev.site_name ?? '',
            status: update.status,
            idsitehsr: update.idsitehsr ?? Number(prev.idsitehsr ?? 0),
            landing_page_url: update.landingPageUrl ?? prev.landing_page_url ?? '',
            page_type: update.pageType ?? prev.page_type ?? '',
            entry_sessions: update.entrySessions ?? Number(prev.entry_sessions ?? 0),
            orders: update.orders ?? Number(prev.orders ?? 0),
            revenue: update.revenue ?? Number(prev.revenue ?? 0),
            reason: update.reason ?? prev.reason ?? '',
            claim_token: String(prev.claim_token ?? ''),
            generated_at: clock.now(),
          },
        ],
      });
    },

    /** @param {import('../../../ports/persistence.js').AnalysisRecord} record */
    async writeAnalysis(record) {
      await client.insert({
        table: `${database}.landing_page_analysis`,
        format: 'JSONEachRow',
        values: [
          {
            batch_id: record.batchId,
            idsite: record.idsite,
            idsitehsr: record.idsitehsr,
            landing_page_url: record.landingPageUrl,
            page_title: record.pageTitle,
            page_type: record.pageType,
            window_start: record.windowStart,
            window_end: record.windowEnd,
            entry_sessions: record.entrySessions,
            orders: record.orders,
            revenue: record.revenue,
            rps: record.rps,
            single_pageview_share: record.singlePageviewShare,
            scroll_reach_25: record.scrollReach25,
            scroll_reach_70: record.scrollReach70,
            desktop_rps: record.desktopRps,
            mobile_rps: record.mobileRps,
            mobile_to_desktop_rps: record.mobileToDesktopRps,
            bot_sessions_excluded: record.botSessionsExcluded,
            sessions_unfiltered: record.sessionsUnfiltered,
            orders_unfiltered: record.ordersUnfiltered,
            strategies_triggered: record.strategiesTriggered,
            strategies_below_floor: record.strategiesBelowFloor,
            strategies_blocked: record.strategiesBlocked,
            strategies_silent: record.strategiesSilent,
            status: record.status,
            metadata: JSON.stringify(record.metadata ?? {}),
            generated_at: clock.now(),
          },
        ],
      });
    },

    /** @param {import('../../../ports/dataset.js').DatasetRow[]} rows */
    async writeDataset(rows) {
      if (rows.length === 0) return;
      await client.insert({
        table: `${database}.landing_page_dataset`,
        format: 'JSONEachRow',
        values: rows.map((r) => ({
          batch_id: r.batchId,
          idsite: r.idsite,
          idsitehsr: r.idsitehsr,
          dataset_id: r.datasetId,
          bot_filter: r.botFilter ?? '',
          dim_week: r.dimWeek ?? null,
          dim_device: r.dimDevice ?? '',
          dim_referer: r.dimReferer ?? '',
          dim_selector: r.dimSelector ?? '',
          dim_extra: r.dimExtra ? JSON.stringify(r.dimExtra) : '',
          metrics: JSON.stringify(r.metrics ?? {}),
          row_key: r.rowKey,
          generated_at: clock.now(),
        })),
      });
      log('writeDataset', { rows: rows.length, dataset: rows[0]?.datasetId });
    },

    /** @param {string} batchId */
    async readBatch(batchId) {
      const rows = await client
        .query({
          query: `SELECT * FROM ${database}.landing_page_batch_current WHERE batch_id = {batchId:UUID}`,
          query_params: { batchId },
          format: 'JSONEachRow',
        })
        .then((r) => r.json());
      if (rows.length === 0) return null;
      const b = rows[0];
      return {
        batchId: b.batch_id,
        windowStart: toIsoDate(b.window_start),
        windowEnd: toIsoDate(b.window_end),
        siteSource: b.site_source,
        qualifier: b.qualifier,
        minSessions: Number(b.min_sessions),
        minOrders: Number(b.min_orders),
        minShareOfHome: Number(b.min_share_of_home),
        status: b.status,
        metadata: JSON.parse(b.metadata || '{}'),
      };
    },
  };
}
