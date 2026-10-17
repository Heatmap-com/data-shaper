import { randomUUID } from 'node:crypto';
import { isElementClass, TAXONOMY_VERSION } from '../../../domain/taxonomy.js';
import { CLAIM_TTL_MS, staleBeforeCh, clock, toIsoDate } from './support.js';

/**
 * The NamingQueue role over ClickHouse: the v1 naming queue and the page names it writes.
 * @param {object} support the adapter's shared state from support.js
 * @returns {import('../../../ports/persistence/naming-queue.js').NamingQueue}
 */
export function createNamingQueue({ client, database, log }) {
  return {
    /** @param {{idsite: number, idsitehsr: number}} key */
    async namingStatus(key) {
      const rows = await client
        .query({
          query: `
            SELECT status, taxonomy_version, named_on
              FROM ${database}.page_naming_current
             WHERE idsite = {idsite:UInt32} AND idsitehsr = {idsitehsr:UInt64}`,
          query_params: { idsite: key.idsite, idsitehsr: key.idsitehsr },
          format: 'JSONEachRow',
        })
        .then((r) => r.json());
      if (rows.length === 0) return null;
      const row = rows[0];
      return {
        status: row.status,
        taxonomyVersion: row.taxonomy_version,
        namedOn: toIsoDate(row.named_on),
      };
    },

    /** @param {{idsite: number, idsitehsr: number, url: string, pageType: string, reason: string}} job */
    async enqueueNaming(job) {
      const today = new Date().toISOString().slice(0, 10);
      await client.insert({
        table: `${database}.naming_queue`,
        format: 'JSONEachRow',
        values: [
          {
            idsite: job.idsite,
            idsitehsr: job.idsitehsr,
            landing_page_url: job.url ?? '',
            page_type: job.pageType ?? '',
            status: 'queued',
            reason: job.reason ?? '',
            requested_on: today,
            claim_token: '',
            generated_at: clock.now(),
          },
        ],
      });
      log('enqueueNaming', { idsite: job.idsite, idsitehsr: job.idsitehsr });
    },

    /**
     * Naming-queue claim for the naming consumer. Claims the oldest
     * queued (or stale claiming) row exclusively by token.
     * @param {number} [claimTtlMs]
     * @returns {Promise<object | null>}
     */
    async claimNaming(claimTtlMs = CLAIM_TTL_MS) {
      const candidates = await client
        .query({
          query: `
            SELECT idsite, idsitehsr, landing_page_url, page_type, reason, toString(requested_on) AS requested_on
              FROM ${database}.naming_queue_current
             WHERE status = 'queued'
                OR (status = 'claiming'
                    AND generated_at < {staleBefore:String}::DateTime64(3))
             ORDER BY requested_on, idsite, idsitehsr
             LIMIT 1`,
          query_params: { staleBefore: staleBeforeCh(claimTtlMs) },
          format: 'JSONEachRow',
        })
        .then((r) => r.json());
      if (candidates.length === 0) return null;
      const row = candidates[0];
      const token = randomUUID();
      await client.insert({
        table: `${database}.naming_queue`,
        format: 'JSONEachRow',
        values: [
          {
            idsite: Number(row.idsite),
            idsitehsr: Number(row.idsitehsr),
            landing_page_url: row.landing_page_url ?? '',
            page_type: row.page_type ?? '',
            status: 'claiming',
            reason: row.reason ?? '',
            requested_on: toIsoDate(row.requested_on),
            claim_token: token,
            generated_at: clock.now(),
          },
        ],
      });
      const mine = await client
        .query({
          query: `
            SELECT claim_token
              FROM ${database}.naming_queue_current
             WHERE idsite = {idsite:UInt32} AND idsitehsr = {idsitehsr:UInt64}`,
          query_params: { idsite: Number(row.idsite), idsitehsr: Number(row.idsitehsr) },
          format: 'JSONEachRow',
        })
        .then((r) => r.json());
      if (String(mine[0]?.claim_token ?? '') !== token) return null;
      return {
        idsite: Number(row.idsite),
        idsitehsr: Number(row.idsitehsr),
        url: row.landing_page_url ?? '',
        pageType: row.page_type ?? '',
        reason: row.reason ?? '',
        token,
      };
    },

    /** @param {{idsite: number, idsitehsr: number, reason: string}} failure */
    async failNaming(failure) {
      const current = await client
        .query({
          query: `
            SELECT landing_page_url, page_type, requested_on
              FROM ${database}.naming_queue_current
             WHERE idsite = {idsite:UInt32} AND idsitehsr = {idsitehsr:UInt64}`,
          query_params: { idsite: failure.idsite, idsitehsr: failure.idsitehsr },
          format: 'JSONEachRow',
        })
        .then((r) => r.json());
      const prev = current[0] ?? {};
      await client.insert({
        table: `${database}.naming_queue`,
        format: 'JSONEachRow',
        values: [
          {
            idsite: failure.idsite,
            idsitehsr: failure.idsitehsr,
            landing_page_url: prev.landing_page_url ?? '',
            page_type: prev.page_type ?? '',
            status: 'failed',
            reason: failure.reason.slice(0, 2000),
            requested_on: toIsoDate(prev.requested_on),
            claim_token: '',
            generated_at: clock.now(),
          },
        ],
      });
    },

    /**
     * Marks the page named and puts awaiting_naming site_queue rows back
     * on the analysis queue.
     * @param {{idsite: number, idsitehsr: number, url?: string, namedOn: string, names?: Array<{selector: string, element_class: string, name?: string}>}} done
     */
    async completeNaming(done) {
      const names = done.names ?? [];
      for (const name of names) {
        if (!isElementClass(name.element_class)) {
          throw new Error(`element_class "${name.element_class}" is not in taxonomy ${TAXONOMY_VERSION}`);
        }
      }
      await client.insert({
        table: `${database}.page_naming`,
        format: 'JSONEachRow',
        values: [
          {
            idsite: done.idsite,
            idsitehsr: done.idsitehsr,
            landing_page_url: done.url ?? '',
            status: 'complete',
            taxonomy_version: TAXONOMY_VERSION,
            named_on: done.namedOn,
            coverage: JSON.stringify({ named_selectors: names.length }),
            generated_at: clock.now(),
          },
        ],
      });
      if (names.length > 0) {
        await client.insert({
          table: `${database}.page_element_name`,
          format: 'JSONEachRow',
          values: names.map((name) => ({
            idsite: done.idsite,
            idsitehsr: done.idsitehsr,
            selector: name.selector,
            element_class: name.element_class,
            name: name.name ?? '',
            named_on: done.namedOn,
            generated_at: clock.now(),
          })),
        });
      }
      await client.insert({
        table: `${database}.naming_queue`,
        format: 'JSONEachRow',
        values: [
          {
            idsite: done.idsite,
            idsitehsr: done.idsitehsr,
            landing_page_url: done.url ?? '',
            page_type: '',
            status: 'complete',
            reason: '',
            requested_on: done.namedOn,
            generated_at: clock.now(),
          },
        ],
      });
      const waiting = await client
        .query({
          query: `
            SELECT batch_id, idsite, site_name, idsitehsr, landing_page_url, page_type,
                   entry_sessions, orders, revenue
              FROM ${database}.site_queue_current
             WHERE idsite = {idsite:UInt32}
               AND idsitehsr = {idsitehsr:UInt64}
               AND status = 'awaiting_naming'`,
          query_params: { idsite: done.idsite, idsitehsr: done.idsitehsr },
          format: 'JSONEachRow',
        })
        .then((r) => r.json());
      if (waiting.length > 0) {
        await client.insert({
          table: `${database}.site_queue`,
          format: 'JSONEachRow',
          values: waiting.map((row) => ({
            batch_id: row.batch_id,
            idsite: Number(row.idsite),
            site_name: row.site_name ?? '',
            status: 'queued',
            idsitehsr: Number(row.idsitehsr),
            landing_page_url: row.landing_page_url ?? '',
            page_type: row.page_type ?? '',
            entry_sessions: Number(row.entry_sessions ?? 0),
            orders: Number(row.orders ?? 0),
            revenue: Number(row.revenue ?? 0),
            reason: 'naming complete',
            claim_token: '',
            generated_at: clock.now(),
          })),
        });
      }
      log('completeNaming', { idsite: done.idsite, idsitehsr: done.idsitehsr, requeued: waiting.length });
    },
  };
}
