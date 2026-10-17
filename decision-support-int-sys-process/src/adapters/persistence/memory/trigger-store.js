import { triggerIdentity, triggerInRange } from './support.js';

/**
 * The TriggerStore role over memory: trigger definitions, hits, and chains.
 * @param {object} support the adapter's shared state from support.js
 * @returns {import('../../../ports/persistence/trigger-store.js').TriggerStore}
 */
export function createTriggerStore({ store }) {
  return {
    /**
     * Replaces definitions, that day's hits, and the chain rows on their
     * identity. A second write of the same identity overwrites the first.
     * @param {{definitions?: object[], hits?: object[], chains?: object[]}} batch
     */
    async writeTriggerBatch(batch) {
      for (const row of batch.definitions ?? []) {
        store.triggerDefinitions.set(`${row.idsite}:${row.key}:${row.version}`, {
          idsite: row.idsite,
          trigger_key: row.key,
          name: row.name,
          level: row.level,
          version: row.version,
          predicate: row.predicate,
          active: row.active !== false,
        });
      }
      for (const row of batch.hits ?? []) {
        store.triggerHits.set(triggerIdentity(row), { ...row });
      }
      for (const row of batch.chains ?? []) {
        store.triggerChains.set(triggerIdentity(row), { ...row });
      }
    },

    /** Latest definition per key. A site row wins over the idsite 0 default. */
    async readTriggerDefinitions(idsite) {
      /** @type {Map<string, object>} */
      const latest = new Map();
      for (const row of store.triggerDefinitions.values()) {
        if (Number(row.idsite) !== 0 && Number(row.idsite) !== Number(idsite)) continue;
        const key = row.trigger_key;
        const prev = latest.get(key);
        const specific = Number(row.idsite) === Number(idsite);
        const prevSpecific = prev && Number(prev.idsite) === Number(idsite);
        const newer = !prev || row.version >= prev.version;
        if (!prev || (specific && !prevSpecific) || (specific === prevSpecific && newer)) {
          latest.set(key, row);
        }
      }
      return [...latest.values()].map((row) => ({
        idsite: row.idsite,
        key: row.trigger_key,
        name: row.name,
        level: row.level,
        version: row.version,
        predicate: row.predicate,
        active: row.active !== false,
      }));
    },

    /** @param {{idsite: number, triggerKey?: string, start?: string, end?: string}} key */
    async readTriggerHits(key) {
      return [...store.triggerHits.values()]
        .filter((row) => triggerInRange(row, key))
        .map((row) => ({ ...row }));
    },

    /** @param {{idsite: number, triggerKey?: string, start?: string, end?: string}} key */
    async readTriggerChains(key) {
      return [...store.triggerChains.values()]
        .filter((row) => triggerInRange(row, key))
        .map((row) => ({ ...row }));
    },
  };
}
