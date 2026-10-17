import { deepFreeze } from '../freeze.js';
import { addDays, addMonths, dayDiff, isIsoDay, weekday } from './dates.js';

/**
 * The time structure of a shaped dataset. A row is keyed by its period, the
 * first day of the calendar span it covers. A session is a visit's rows in
 * one period, so on a day grain a visit that crosses midnight is two
 * sessions, and on the window grain it is one.
 *
 * `grain`     day, week, month, quarter, or window (one period: the whole window)
 * `weekStart` monday (as ae_trend_row) or sunday (as GA4 and Meta report weeks); week only
 * `partial`   flag (keep a period the window cuts, marked incomplete) or drop
 * `rolling`   trailing sums over that many days; day only
 * `compare`   previous: each measure beside its value one period earlier
 *
 * @typedef {'day' | 'week' | 'month' | 'quarter' | 'window'} Grain
 * @typedef {{grain: Grain, weekStart: 'monday' | 'sunday', partial: 'flag' | 'drop', rolling: number | null, compare: 'previous' | null}} PeriodSpec
 * @typedef {{start: string, end: string}} Window
 */

export const GRAINS = Object.freeze(['day', 'week', 'month', 'quarter', 'window']);
export const MAX_ROLLING_DAYS = 90;
const KEYS = new Set(['grain', 'weekStart', 'partial', 'rolling', 'compare']);

/**
 * Checks a period as written and returns it with defaults filled. Problems
 * come back as text; an unknown grain is reported apart, because it needs a
 * person to build, not a fix to the request.
 * @param {unknown} doc
 * @returns {{spec: Readonly<PeriodSpec> | null, problems: string[], unknownGrain: string | null}}
 */
export function checkPeriod(doc) {
  const problems = [];
  if (doc === undefined) doc = { grain: 'week' };
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { spec: null, problems: ['period must be an object'], unknownGrain: null };
  for (const key of Object.keys(doc)) if (!KEYS.has(key)) problems.push(`period has unknown key "${key}" (${[...KEYS].join(', ')})`);
  const grain = doc.grain ?? 'week';
  if (typeof grain !== 'string') return { spec: null, problems: [...problems, 'period.grain must be a string'], unknownGrain: null };
  if (!GRAINS.includes(grain)) return { spec: null, problems, unknownGrain: grain };
  const weekStart = doc.weekStart ?? 'monday';
  if (!['monday', 'sunday'].includes(weekStart)) problems.push('period.weekStart is monday or sunday');
  else if (doc.weekStart !== undefined && grain !== 'week') problems.push('period.weekStart applies to the week grain only');
  const partial = doc.partial ?? 'flag';
  if (!['flag', 'drop'].includes(partial)) problems.push('period.partial is flag or drop');
  const rolling = doc.rolling ?? null;
  if (rolling !== null) {
    if (grain !== 'day') problems.push('period.rolling needs the day grain');
    if (!Number.isInteger(rolling) || rolling < 2 || rolling > MAX_ROLLING_DAYS) problems.push(`period.rolling is a whole number of days from 2 to ${MAX_ROLLING_DAYS}`);
  }
  const compare = doc.compare ?? null;
  if (compare !== null && compare !== 'previous') problems.push('period.compare is "previous"');
  if (compare !== null && rolling !== null) problems.push('period.compare and period.rolling do not combine; a rolling day already reads its trailing days');
  if (problems.length > 0) return { spec: null, problems, unknownGrain: null };
  return { spec: deepFreeze({ grain, weekStart, partial, rolling, compare }), problems: [], unknownGrain: null };
}

/**
 * The days the query reads: the window, preceded by the lead-in that a
 * rolling sum or a previous-period comparison needs for the first period.
 * @param {PeriodSpec} spec
 * @param {Window} window
 * @returns {Window}
 */
export function queryWindow(spec, window) {
  if (spec.rolling) return { start: addDays(window.start, 1 - spec.rolling), end: window.end };
  if (spec.compare) return { start: previousStart(spec, window, periodOf(window.start, spec, window)), end: window.end };
  return { start: window.start, end: window.end };
}

/**
 * The period a day falls in, the JavaScript twin of periodSql. On the
 * window grain a day before the window is in the previous window.
 * @param {string} day
 * @param {PeriodSpec} spec
 * @param {Window} window
 */
export function periodOf(day, spec, window) {
  switch (spec.grain) {
    case 'day':
      return day;
    case 'week': {
      const offset = spec.weekStart === 'sunday' ? weekday(day) : (weekday(day) + 6) % 7;
      return addDays(day, -offset);
    }
    case 'month':
      return `${day.slice(0, 7)}-01`;
    case 'quarter': {
      const month = Number(day.slice(5, 7));
      return `${day.slice(0, 4)}-${String(month - ((month - 1) % 3)).padStart(2, '0')}-01`;
    }
    case 'window':
      return day >= window.start ? window.start : previousStart(spec, window, window.start);
    default:
      throw new Error(`unknown grain ${spec.grain}`);
  }
}

/**
 * The ClickHouse expression of the period a Date falls in. On the window
 * grain it reads the {s0:Date} and {ps0:Date} parameters periodParams binds.
 * @param {string} dateExpr a Date expression
 * @param {PeriodSpec} spec
 */
export function periodSql(dateExpr, spec) {
  switch (spec.grain) {
    case 'day':
      return `toDate(${dateExpr})`;
    case 'week':
      return spec.weekStart === 'sunday' ? `toStartOfWeek(${dateExpr}, 0)` : `toMonday(${dateExpr})`;
    case 'month':
      return `toStartOfMonth(${dateExpr})`;
    case 'quarter':
      return `toStartOfQuarter(${dateExpr})`;
    case 'window':
      return spec.compare
        ? `if(${dateExpr} >= {s0:Date}, {s0:Date}, {ps0:Date})`
        : '{s0:Date}';
    default:
      throw new Error(`unknown grain ${spec.grain}`);
  }
}

/** The parameters periodSql reads. @param {PeriodSpec} spec @param {Window} window */
export function periodParams(spec, window) {
  if (spec.grain !== 'window') return {};
  return spec.compare ? { s0: window.start, ps0: previousStart(spec, window, window.start) } : { s0: window.start };
}

/** The last day of the period that starts on `start`. */
export function periodEnd(start, spec, window) {
  switch (spec.grain) {
    case 'day':
      return start;
    case 'week':
      return addDays(start, 6);
    case 'month':
      return addDays(addMonths(start, 1), -1);
    case 'quarter':
      return addDays(addMonths(start, 3), -1);
    case 'window':
      return start === window.start ? window.end : addDays(window.start, -1);
    default:
      throw new Error(`unknown grain ${spec.grain}`);
  }
}

/** The start of the period before the one that starts on `start`. */
export function previousStart(spec, window, start) {
  switch (spec.grain) {
    case 'day':
      return addDays(start, -1);
    case 'week':
      return addDays(start, -7);
    case 'month':
      return addMonths(start, -1);
    case 'quarter':
      return addMonths(start, -3);
    case 'window':
      return addDays(window.start, -(dayDiff(window.end, window.start) + 1));
    default:
      throw new Error(`unknown grain ${spec.grain}`);
  }
}

/**
 * The periods a window reports, in order, each with its natural span and
 * whether the window holds all of it. With `partial: drop`, the cut ones
 * are left out.
 * @param {PeriodSpec} spec
 * @param {Window} window
 * @returns {Array<{start: string, end: string, complete: boolean}>}
 */
export function periodsIn(spec, window) {
  const out = [];
  let start = periodOf(window.start, spec, window);
  while (start <= window.end) {
    const end = periodEnd(start, spec, window);
    const complete = start >= window.start && end <= window.end;
    if (complete || spec.partial === 'flag') out.push({ start, end, complete });
    start = addDays(end, 1);
  }
  return out;
}

/** The problems with a window as written: both ends real days, start on or before end. */
export function checkWindow(window) {
  if (!window || typeof window !== 'object' || Array.isArray(window)) return ['window must be { start, end }'];
  const problems = [];
  for (const key of Object.keys(window)) if (key !== 'start' && key !== 'end') problems.push(`window has unknown key "${key}"`);
  if (!isIsoDay(window.start) || !isIsoDay(window.end)) problems.push('window.start and window.end are days written YYYY-MM-DD');
  else if (window.start > window.end) problems.push('window.start is after window.end');
  return problems;
}
