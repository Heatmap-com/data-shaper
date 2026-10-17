import { aeNow } from './support.js';

const SUBJECT_KEYS = ['path', 'url_path', 'page'];
const WEEK_KEYS = [...SUBJECT_KEYS, 'selector'];

/** @param {import('../../../ports/persistence.js').AeTrendRow} r */
function trendIdentity(r) {
  return [
    r.idsite, r.rowType, r.rowKey, r.rowKey1 ?? '', r.rowKey2 ?? '', r.viewportType,
    r.segment, r.segmentValue, r.week, r.idsitehsr ?? 0,
  ].join(':');
}

/** JSONExtractInt: an integer, or 0 when the field is absent or not a number. */
function rankOf(row) {
  const rank = Number(row.metrics?.rank);
  return Number.isFinite(rank) ? Math.trunc(rank) : 0;
}

/**
 * The TrendStore role over memory: weekly trend rows, trend selectors, and the subjects already stored.
 * @param {object} support the adapter's shared state from support.js
 * @returns {import('../../../ports/persistence/trend-store.js').TrendStore}
 */
export function createTrendStore({ store }) {
  return {
    /**
     * Replaces on the trend identity, including viewport_type.
     * @param {import('../../../ports/persistence.js').AeTrendRow[]} rows
     */
    async writeTrendRows(rows) {
      for (const row of rows) {
        store.trendRows.set(trendIdentity(row), { ...structuredClone(row), idsitehsr: row.idsitehsr ?? 0, generated_at: aeNow() });
      }
    },

    /**
     * Replaces on (idsite, idsitehsr).
     * @param {import('../../../ports/persistence.js').AeTrendSelectorRow[]} rows
     */
    async writeTrendSelectors(rows) {
      for (const row of rows) {
        store.trendSelectors.set(`${row.idsite}:${row.idsitehsr}`, {
          idsite: Number(row.idsite),
          idsitehsr: Number(row.idsitehsr),
          trendSelectors: [...(row.trendSelectors ?? [])].map(String),
          status: String(row.status ?? ''),
        });
      }
    },

    /** @param {number} idsite */
    async readTrendSelectors(idsite) {
      return [...store.trendSelectors.values()]
        .filter((row) => row.idsite === Number(idsite))
        .map((row) => structuredClone(row));
    },

    /**
     * Path and page subjects already stored for the site, from the all/all
     * viewport totals, lowest rank first, at most 100.
     * @param {number} idsite
     */
    async readTrendSubjects(idsite) {
      /** @type {Map<string, {rowKey: string, rowKey1: string, rank: number}>} */
      const subjects = new Map();
      for (const row of store.trendRows.values()) {
        if (Number(row.idsite) !== Number(idsite)) continue;
        if (row.viewportType !== 'all' || row.segment !== 'all' || row.segmentValue !== 'all') continue;
        if (!SUBJECT_KEYS.includes(row.rowKey)) continue;
        const key = `${row.rowKey}\u0000${row.rowKey1 ?? ''}`;
        const rank = rankOf(row);
        const seen = subjects.get(key);
        if (!seen || rank < seen.rank) subjects.set(key, { rowKey: row.rowKey, rowKey1: String(row.rowKey1 ?? ''), rank });
      }
      const ordered = [...subjects.values()]
        .sort((a, b) => a.rank - b.rank || (a.rowKey1 < b.rowKey1 ? -1 : a.rowKey1 > b.rowKey1 ? 1 : 0))
        .slice(0, 100);
      const of = (rowKey) => ordered.filter((s) => s.rowKey === rowKey).map((s) => s.rowKey1);
      return { paths: of('path'), urlPaths: of('url_path'), pages: of('page') };
    },

    /**
     * The latest stored week of each subject, from the all/all viewport
     * totals, ordered by row key, page, and subject.
     * @param {number} idsite
     */
    async readTrendWeeks(idsite) {
      /** @type {Map<string, import('../../../ports/persistence/trend-store.js').TrendWeek>} */
      const latest = new Map();
      for (const row of store.trendRows.values()) {
        if (Number(row.idsite) !== Number(idsite)) continue;
        if (row.viewportType !== 'all' || row.segment !== 'all' || row.segmentValue !== 'all') continue;
        if (!WEEK_KEYS.includes(row.rowKey)) continue;
        const subject = { rowKey: row.rowKey, rowKey1: String(row.rowKey1 ?? ''), idsitehsr: Number(row.idsitehsr ?? 0), week: String(row.week) };
        const key = `${subject.rowKey}\u0000${subject.idsitehsr}\u0000${subject.rowKey1}`;
        if ((latest.get(key)?.week ?? '') < subject.week) latest.set(key, subject);
      }
      const text = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
      return [...latest.values()].sort((a, b) => text(a.rowKey, b.rowKey) || a.idsitehsr - b.idsitehsr || text(a.rowKey1, b.rowKey1));
    },

    async readTrendWeekRange(idsite, segment) {
      /** @type {Map<string, {rowKey: string, rowKey1: string, rowKey2: string, idsitehsr: number, first: string, last: string}>} */
      const subjects = new Map();
      const values = new Set();
      for (const row of store.trendRows.values()) {
        if (Number(row.idsite) !== Number(idsite) || row.segment !== segment) continue;
        values.add(String(row.segmentValue));
        if (!WEEK_KEYS.includes(row.rowKey)) continue;
        const rowKey1 = String(row.rowKey1 ?? '');
        const rowKey2 = String(row.rowKey2 ?? '');
        const idsitehsr = Number(row.idsitehsr ?? 0);
        const week = String(row.week);
        const key = `${row.rowKey}\u0000${idsitehsr}\u0000${rowKey1}\u0000${rowKey2}`;
        const seen = subjects.get(key);
        if (!seen) subjects.set(key, { rowKey: row.rowKey, rowKey1, rowKey2, idsitehsr, first: week, last: week });
        else {
          if (week < seen.first) seen.first = week;
          if (week > seen.last) seen.last = week;
        }
      }
      const text = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
      return {
        subjects: [...subjects.values()].sort((a, b) => text(a.rowKey, b.rowKey) || a.idsitehsr - b.idsitehsr || text(a.rowKey1, b.rowKey1) || text(a.rowKey2, b.rowKey2)),
        values: [...values].sort(text),
      };
    },
  };
}
