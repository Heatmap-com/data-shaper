/** @typedef {import('../persistence.js').AeSessionTagSelectionRow} AeSessionTagSelectionRow */
/** @typedef {import('../persistence.js').AeSessionTagTrendRow} AeSessionTagTrendRow */

/**
 * Session tag trend rows and the tag key selection.
 *
 * @typedef {Object} SessionTagStore
 * @property {(rows: AeSessionTagTrendRow[]) => Promise<void>} writeTagTrendRows idempotent on the tag trend identity
 * @property {(rows: AeSessionTagSelectionRow[]) => Promise<void>} writeTagSelection idempotent on (idsite, tag_key)
 * @property {(idsite: number) => Promise<Array<{tagKey: string, family: string, trendValues: string[]}>>} readTagSelection selected keys of the site's latest selection
 * @property {(idsite: number) => Promise<Array<{tagKey: string, week: string}>>} readTagTrendWeeks the latest stored week of each tag key
 * @property {(idsite: number, segment: string) => Promise<{keys: Array<{tagKey: string, first: string, last: string}>, values: string[]}>} readTagTrendWeekRange
 *   the first and last stored week of each tag key's rows for one segmentation, and every value stored for it, sorted
 */

export const SESSION_TAG_STORE = Object.freeze([
  'writeTagTrendRows',
  'writeTagSelection',
  'readTagSelection',
  'readTagTrendWeeks',
  'readTagTrendWeekRange',
]);
