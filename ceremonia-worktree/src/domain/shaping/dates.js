/** UTC calendar helpers over YYYY-MM-DD text. */

export const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** True when `iso` is a real calendar day written YYYY-MM-DD. */
export function isIsoDay(iso) {
  if (typeof iso !== 'string' || !ISO_DAY.test(iso)) return false;
  const date = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === iso;
}

/** @param {string} iso @param {number} days */
export function addDays(iso, days) {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** The first day of the month `months` after the month holding `iso`. @param {string} iso @param {number} months */
export function addMonths(iso, months) {
  const date = new Date(`${iso.slice(0, 7)}-01T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + months);
  return date.toISOString().slice(0, 10);
}

/** Whole days from `earlier` to `later`. */
export function dayDiff(later, earlier) {
  return Math.round((Date.parse(`${later}T00:00:00Z`) - Date.parse(`${earlier}T00:00:00Z`)) / 86400000);
}

/** 0 for Sunday through 6 for Saturday. */
export function weekday(iso) {
  return new Date(`${iso}T00:00:00Z`).getUTCDay();
}

/** Every day from `start` through `end`. */
export function eachDay(start, end) {
  const out = [];
  for (let day = start; day <= end; day = addDays(day, 1)) out.push(day);
  return out;
}
