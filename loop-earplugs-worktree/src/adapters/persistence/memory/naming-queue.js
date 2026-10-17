import { randomUUID } from 'node:crypto';
import { isElementClass, TAXONOMY_VERSION } from '../../../domain/taxonomy.js';
import { CLAIM_TTL_MS } from './support.js';

/**
 * The NamingQueue role over memory: the v1 naming queue and the page names it writes.
 * @param {object} support the adapter's shared state from support.js
 * @returns {import('../../../ports/persistence/naming-queue.js').NamingQueue}
 */
export function createNamingQueue({ store }) {
  return {
    /** @param {{idsite: number, idsitehsr: number}} key */
    async namingStatus(key) {
      return store.naming.get(`${key.idsite}:${key.idsitehsr}`) ?? null;
    },

    /** @param {{idsite: number, idsitehsr: number, url: string, pageType: string, reason: string}} job */
    async enqueueNaming(job) {
      store.namingQueue.set(`${job.idsite}:${job.idsitehsr}`, {
        ...job,
        status: 'queued',
        claimToken: '',
      });
    },

    /**
     * Claims the oldest queued naming job exclusively. A 'claiming' row is
     * reclaimable only after CLAIM_TTL_MS — live agents must not steal each
     * other's in-flight work; crashed claims must not block the page.
     * @param {number} [claimTtlMs]
     * @returns {Promise<object | null>}
     */
    async claimNaming(claimTtlMs = CLAIM_TTL_MS) {
      const staleBefore = Date.now() - claimTtlMs;
      const rows = [...store.namingQueue.values()]
        .filter((r) => r.status === 'queued' || (r.status === 'claiming' && (r.claimedAt ?? 0) <= staleBefore))
        .sort((a, b) => Number(a.idsite) - Number(b.idsite) || Number(a.idsitehsr) - Number(b.idsitehsr));
      const row = rows[0];
      if (!row) return null;
      const token = randomUUID();
      row.status = 'claiming';
      row.claimToken = token;
      row.claimedAt = Date.now();
      return {
        idsite: row.idsite,
        idsitehsr: row.idsitehsr,
        url: row.url ?? '',
        pageType: row.pageType ?? '',
        reason: row.reason ?? '',
        token,
      };
    },

    /** @param {{idsite: number, idsitehsr: number, reason: string}} failure */
    async failNaming(failure) {
      const row = store.namingQueue.get(`${failure.idsite}:${failure.idsitehsr}`);
      if (row) {
        row.status = 'failed';
        row.reason = failure.reason.slice(0, 2000);
        row.claimToken = '';
      }
    },

    /**
     * @param {{idsite: number, idsitehsr: number, url?: string, namedOn: string, names?: Array<{selector: string, element_class: string, name?: string}>}} done
     */
    async completeNaming(done) {
      const names = done.names ?? [];
      for (const name of names) {
        if (!isElementClass(name.element_class)) {
          throw new Error(`element_class "${name.element_class}" is not in taxonomy ${TAXONOMY_VERSION}`);
        }
      }
      store.naming.set(`${done.idsite}:${done.idsitehsr}`, {
        status: 'complete',
        taxonomyVersion: TAXONOMY_VERSION,
        namedOn: done.namedOn,
        url: done.url ?? '',
      });
      store.elementNames.set(`${done.idsite}:${done.idsitehsr}`, names.map((n) => ({ ...n })));
      const queued = store.namingQueue.get(`${done.idsite}:${done.idsitehsr}`);
      if (queued) queued.status = 'complete';
      for (const row of store.queue.values()) {
        if (row.idsite === done.idsite && row.idsitehsr === done.idsitehsr && row.status === 'awaiting_naming') {
          row.status = 'queued';
          row.reason = 'naming complete';
        }
      }
    },
  };
}
