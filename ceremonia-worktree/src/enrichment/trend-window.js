import { addDays, mondayOf } from '../triggers/time.js';

/**
 * The whole Monday-to-Sunday weeks inside a window. A trend row is keyed by
 * its week, so a row built from part of a week would replace the complete
 * one stored before it. `start` and `end` are the first Monday and the last
 * Sunday the trend reads; `edges` names the days at either end it leaves
 * out, or null where the window already starts on a Monday or ends on a
 * Sunday. With no whole week, `weeks` is empty and `start` is after `end`.
 * @param {string} windowStart
 * @param {string} windowEnd
 */
export function wholeWeeks(windowStart, windowEnd) {
  const start = mondayOf(windowStart) === windowStart ? windowStart : addDays(mondayOf(windowStart), 7);
  const end = addDays(mondayOf(addDays(windowEnd, 1)), -1);
  const weeks = [];
  for (let week = start; addDays(week, 6) <= end; week = addDays(week, 7)) weeks.push(week);
  return {
    start,
    end,
    weeks,
    edges: {
      start: start > windowStart ? [windowStart, [addDays(start, -1), windowEnd].sort()[0]] : null,
      end: end < windowEnd && end >= windowStart ? [addDays(end, 1), windowEnd] : null,
    },
  };
}

export const DEFAULT_OVERLAP_WEEKS = 1;
export const DEFAULT_BACKFILL_WEEKS = 8;

/** The last Sunday before today: the end of the latest whole week. */
export function lastWholeSunday(today) {
  return addDays(mondayOf(today), -1);
}

/**
 * Where each subject's weeks start on a next-weeks run. Every subject ends
 * on the last Sunday before today. A stored subject starts the week after
 * its latest stored week, moved back `overlapWeeks` weeks so the run
 * rereads them for late rows; a skipped run leaves a longer span, which
 * this run fills. A subject with nothing stored backfills `backfillWeeks`
 * whole weeks. A start after `end` means the subject is current.
 * @param {{today: string, overlapWeeks?: number, backfillWeeks?: number}} nextWeeks
 * @param {Array<{key: string, week: string}>} stored latest stored week per subject key
 * @returns {{end: string, backfill: string, startOf: (key: string) => string}}
 */
export function weekStarts({ today, overlapWeeks = DEFAULT_OVERLAP_WEEKS, backfillWeeks = DEFAULT_BACKFILL_WEEKS }, stored) {
  const end = lastWholeSunday(today);
  const backfill = addDays(end, 1 - 7 * backfillWeeks);
  const latest = new Map(stored.map((row) => [row.key, row.week]));
  return {
    end,
    backfill,
    startOf(key) {
      const week = latest.get(key);
      return week ? addDays(mondayOf(week), 7 * (1 - overlapWeeks)) : backfill;
    },
  };
}

/**
 * Items grouped by start week, earliest first, leaving out the items whose
 * start is after `end`.
 * @template T
 * @param {T[]} items
 * @param {(item: T) => string} startOf
 * @param {string} end
 * @returns {Array<[string, T[]]>}
 */
export function byStart(items, startOf, end) {
  /** @type {Map<string, T[]>} */
  const groups = new Map();
  for (const item of items) {
    const start = startOf(item);
    if (start > end) continue;
    groups.set(start, [...(groups.get(start) ?? []), item]);
  }
  return [...groups].sort(([a], [b]) => (a < b ? -1 : 1));
}
