import { randomUUID } from 'node:crypto';
import { CLAIM_TTL_MS, keyOf } from './support.js';

/**
 * The LandingPageStore role over memory: the v1 batch, its site queue, and the analysis and dataset rows.
 * @param {object} support the adapter's shared state from support.js
 * @returns {import('../../../ports/persistence/landing-page-store.js').LandingPageStore}
 */
export function createLandingPageStore({ store }) {
  return {
    /** @param {import('../../../ports/persistence.js').BatchSpec} batch */
    async createBatch(batch) {
      const prev = store.batches.get(batch.batchId) ?? {};
      store.batches.set(keyOf.batch(batch), { ...prev, ...batch });
    },

    /** @param {string} batchId @param {Array<{idsite: number, siteName: string}>} sites */
    async enqueue(batchId, sites) {
      for (const site of sites) {
        const key = `${batchId}:${site.idsite}`;
        if (!store.queue.has(key)) {
          store.queue.set(key, {
            batchId,
            idsite: site.idsite,
            siteName: site.siteName,
            status: 'queued',
            idsitehsr: 0,
            landingPageUrl: '',
            pageType: '',
            entrySessions: 0,
            orders: 0,
            revenue: 0,
            reason: '',
          });
        }
      }
    },

    /**
     * Token-claimed for concurrent agents. 'queued' rows are always
     * claimable; 'qualifying'/'analyzing' rows only after CLAIM_TTL_MS so a
     * crashed worker's site is reclaimed but live agents never steal each
     * other's work. The claim inserts a qualifying row carrying a random
     * token, then re-reads the current view; a concurrent claimer with a
     * newer generated_at wins and the loser backs off. Never claims
     * awaiting_naming.
     * @param {string} batchId
     * @param {number} [claimTtlMs]
     * @returns {Promise<object[]>} 0 or 1 row
     */
    async claimNext(batchId, claimTtlMs = CLAIM_TTL_MS) {
      const staleBefore = Date.now() - claimTtlMs;
      const candidates = [...store.queue.values()]
        .filter((r) => r.batchId === batchId || r.batch_id === batchId)
        .filter(
          (r) =>
            r.status === 'queued' ||
            (['qualifying', 'analyzing'].includes(r.status) && (r.claimedAt ?? 0) <= staleBefore),
        )
        .sort((a, b) => Number(a.idsite) - Number(b.idsite));
      const row = candidates[0];
      if (!row) return [];
      const token = randomUUID();
      row.status = 'qualifying';
      row.claimToken = token;
      row.claimedAt = Date.now();
      return [{ idsite: row.idsite, site_name: row.siteName ?? '' }];
    },

    /** @param {import('../../../ports/persistence.js').QueueUpdate} update */
    async updateQueue(update) {
      const key = `${update.batchId}:${update.idsite}`;
      const row = store.queue.get(key);
      if (!row) throw new Error(`memory persistence: queue row ${key} not found`);
      const { batchId, idsite, ...fields } = update;
      Object.assign(row, fields);
      // Heartbeat: liveness of qualifying/analyzing is the last write,
      // mirroring the ClickHouse claim filter on generated_at.
      row.claimedAt = Date.now();
    },

    /** @param {import('../../../ports/persistence.js').AnalysisRecord} record */
    async writeAnalysis(record) {
      store.analyses.set(keyOf.analysis(record), { ...record });
    },

    /** @param {import('../../../ports/dataset.js').DatasetRow[]} rows */
    async writeDataset(rows) {
      for (const row of rows) {
        store.datasets.set(keyOf.dataset(row), { ...row });
      }
    },

    /** @param {string} batchId */
    readBatch(batchId) {
      return store.batches.get(batchId) ?? null;
    },
  };
}
