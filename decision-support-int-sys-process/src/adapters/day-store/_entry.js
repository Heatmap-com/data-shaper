/**
 * What the day-store adapters share: the entry's identity and its checked
 * shape.
 */

const KINDS = new Set(['day', 'page-facts']);
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** @param {import('../../ports/day-store.js').DayEntryKey} key */
export function checkKey(key) {
  if (!Number.isInteger(key.idsite) || key.idsite <= 0) throw new Error(`day store: idsite ${key.idsite} is not a positive integer`);
  if (!KINDS.has(key.kind)) throw new Error(`day store: unknown kind ${key.kind}`);
  if (typeof key.key !== 'string' || !/^[0-9]*$/.test(key.key)) throw new Error(`day store: key ${key.key} is not '' or an idsitehsr`);
  if (!DATE.test(key.day)) throw new Error(`day store: day ${key.day} is not YYYY-MM-DD`);
  return key;
}

/** @param {import('../../ports/day-store.js').DayEntryKey} key */
export function entryKeyText(key) {
  checkKey(key);
  return `${key.idsite}|${key.kind}|${key.key}|${key.day}`;
}

/**
 * @param {import('../../ports/day-store.js').DayEntry} entry
 * @returns {import('../../ports/day-store.js').DayEntry}
 */
export function toEntry(entry) {
  checkKey(entry);
  if (!Number.isInteger(entry.version)) throw new Error('day store: version is not an integer');
  if (!Array.isArray(entry.rows)) throw new Error('day store: rows is not an array');
  return {
    idsite: entry.idsite,
    kind: entry.kind,
    key: entry.key,
    day: entry.day,
    version: entry.version,
    final: Boolean(entry.final),
    shape: entry.shape ? { events: [...entry.shape.events], partnerTags: Boolean(entry.shape.partnerTags) } : null,
    rows: entry.rows,
  };
}
