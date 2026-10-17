/** UTC date helpers. Weeks start Monday, matching ae_trend_row. */

/** @param {string} iso YYYY-MM-DD @param {number} days */
export function addDays(iso, days) {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** @param {string} later @param {string} earlier */
export function dayDiff(later, earlier) {
  const a = Date.parse(`${later}T00:00:00Z`);
  const b = Date.parse(`${earlier}T00:00:00Z`);
  return Math.round((a - b) / 86400000);
}

/** Monday of the week containing iso, as YYYY-MM-DD. @param {string} iso */
export function mondayOf(iso) {
  const date = new Date(`${iso}T00:00:00Z`);
  const offset = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - offset);
  return date.toISOString().slice(0, 10);
}

/**
 * Visit timestamp. The live column is text with a fractional suffix
 * (`2026-10-01 03:11:24.000000000`), which Date.parse rejects until the
 * fraction is removed.
 * @param {unknown} value
 * @returns {number | null} epoch ms
 */
export function parseVisitTime(value) {
  if (value == null || value === '') return null;
  const text = String(value).trim().replace(/\.\d+$/, '').replace(' ', 'T');
  const ms = Date.parse(text.endsWith('Z') ? text : `${text}Z`);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * @param {string} start inclusive
 * @param {string} end inclusive
 * @returns {string[]}
 */
export function eachDate(start, end) {
  /** @type {string[]} */
  const out = [];
  for (let day = start; day <= end; day = addDays(day, 1)) out.push(day);
  return out;
}
