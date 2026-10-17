/** @typedef {import('../persistence.js').AeTrendRow} AeTrendRow */
/** @typedef {import('../persistence.js').AeTrendSelectorRow} AeTrendSelectorRow */

/**
 * Weekly trend rows, trend selectors, and the subjects already stored.
 *
 * @typedef {Object} TrendStore
 * @property {(rows: AeTrendRow[]) => Promise<void>} writeTrendRows idempotent on the trend identity, including viewport_type
 * @property {(rows: AeTrendSelectorRow[]) => Promise<void>} writeTrendSelectors idempotent on (idsite, idsitehsr)
 * @property {(idsite: number) => Promise<AeTrendSelectorRow[]>} readTrendSelectors current config rows for the site
 * @property {(idsite: number) => Promise<{paths: string[], urlPaths: string[], pages: string[]}>} readTrendSubjects template paths, URL paths, and pages already stored
 * @property {(idsite: number) => Promise<TrendWeek[]>} readTrendWeeks the latest stored week of each path, URL path, page, and selector
 * @property {(idsite: number, segment: string) => Promise<TrendSegmentRange>} readTrendWeekRange the first and last stored
 *   week of each subject's rows for one segmentation, and every value stored for it
 *
 * @typedef {Object} TrendWeek
 * @property {string} rowKey path, url_path, page, or selector
 * @property {string} rowKey1 the subject
 * @property {number} idsitehsr the page of a selector or page row, else 0
 * @property {string} week the Monday of the subject's latest stored week
 *
 * @typedef {Object} TrendSegmentRange
 * @property {Array<{rowKey: string, rowKey1: string, rowKey2: string, idsitehsr: number, first: string, last: string}>} subjects
 *   path, url_path, page, and selector subjects, ordered as readTrendWeeks orders them; a page's
 *   rowKey2 is its URL, part of the row identity
 * @property {string[]} values the distinct stored segment values, sorted
 */

export const TREND_STORE = Object.freeze([
  'writeTrendRows',
  'writeTrendSelectors',
  'readTrendSelectors',
  'readTrendSubjects',
  'readTrendWeeks',
  'readTrendWeekRange',
]);
