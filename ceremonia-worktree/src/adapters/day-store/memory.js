import { entryKeyText, toEntry } from './_entry.js';

/**
 * The day store in process memory. Entries are copied in and out, so a
 * reader that changes its rows leaves the store as written.
 * @returns {import('../../ports/day-store.js').DayStore & {size: () => number}}
 */
export function createMemoryDayStore() {
  /** @type {Map<string, import('../../ports/day-store.js').DayEntry>} */
  const entries = new Map();
  return {
    id: 'memory',
    async read(key) {
      const entry = entries.get(entryKeyText(key));
      return entry ? structuredClone(entry) : null;
    },
    async write(entry) {
      entries.set(entryKeyText(entry), structuredClone(toEntry(entry)));
    },
    async prune({ idsite, before }) {
      let dropped = 0;
      for (const [id, entry] of entries) {
        if (entry.idsite === idsite && entry.day < before) {
          entries.delete(id);
          dropped += 1;
        }
      }
      return dropped;
    },
    size: () => entries.size,
  };
}

export const adapter = {
  id: 'memory',
  create: createMemoryDayStore,
};
