import { aeNow } from './support.js';

/**
 * The SessionTagStore role over memory: session tag trend rows and the tag key selection.
 * @param {object} support the adapter's shared state from support.js
 * @returns {import('../../../ports/persistence/session-tag-store.js').SessionTagStore}
 */
export function createSessionTagStore({ store }) {
  return {
    /**
     * Replaces on (idsite, tag key, tag value, viewport, segment, segment value, week).
     * @param {import('../../../ports/persistence.js').AeSessionTagTrendRow[]} rows
     */
    async writeTagTrendRows(rows) {
      for (const row of rows) {
        const key = [row.idsite, row.tagKey, row.tagValue, row.viewportType, row.segment, row.segmentValue, row.week].join(':');
        store.tagTrendRows.set(key, { ...structuredClone(row), generated_at: aeNow() });
      }
    },

    /**
     * Replaces on (idsite, tag_key). Every key of one run shares its batchId.
     * @param {import('../../../ports/persistence.js').AeSessionTagSelectionRow[]} rows
     */
    async writeTagSelection(rows) {
      for (const row of rows) {
        store.tagSelection.set(`${row.idsite}:${row.tagKey}`, { ...structuredClone(row), generated_at: aeNow() });
      }
    },

    /**
     * The selected keys of the site's latest selection batch, with their
     * trend values. Empty when the site has never been selected.
     * @param {number} idsite
     */
    async readTagSelection(idsite) {
      const rows = [...store.tagSelection.values()].filter((row) => Number(row.idsite) === Number(idsite));
      if (rows.length === 0) return [];
      const latest = rows.reduce((a, b) => (String(b.generated_at) > String(a.generated_at) ? b : a));
      return rows
        .filter((row) => row.batchId === latest.batchId && row.status === 'selected')
        .sort((a, b) => (a.tagKey < b.tagKey ? -1 : a.tagKey > b.tagKey ? 1 : 0))
        .map((row) => ({
          tagKey: String(row.tagKey),
          family: String(row.family ?? ''),
          trendValues: [...(row.trendValues ?? [])].map(String),
        }));
    },

    /**
     * The latest stored week of each tag key, from the all/all viewport totals.
     * @param {number} idsite
     */
    async readTagTrendWeeks(idsite) {
      /** @type {Map<string, string>} */
      const latest = new Map();
      for (const row of store.tagTrendRows.values()) {
        if (Number(row.idsite) !== Number(idsite)) continue;
        if (row.viewportType !== 'all' || row.segment !== 'all' || row.segmentValue !== 'all') continue;
        if ((latest.get(row.tagKey) ?? '') < String(row.week)) latest.set(row.tagKey, String(row.week));
      }
      return [...latest].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([tagKey, week]) => ({ tagKey, week }));
    },

    async readTagTrendWeekRange(idsite, segment) {
      /** @type {Map<string, {tagKey: string, first: string, last: string}>} */
      const keys = new Map();
      const values = new Set();
      for (const row of store.tagTrendRows.values()) {
        if (Number(row.idsite) !== Number(idsite) || row.segment !== segment) continue;
        values.add(String(row.segmentValue));
        const week = String(row.week);
        const seen = keys.get(row.tagKey);
        if (!seen) keys.set(row.tagKey, { tagKey: row.tagKey, first: week, last: week });
        else {
          if (week < seen.first) seen.first = week;
          if (week > seen.last) seen.last = week;
        }
      }
      const text = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
      return { keys: [...keys.values()].sort((a, b) => text(a.tagKey, b.tagKey)), values: [...values].sort(text) };
    },
  };
}
