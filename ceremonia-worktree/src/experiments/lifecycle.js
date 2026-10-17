/**
 * When an experiment ran, from its daily assigned visits.
 *
 * Last-seen is not the end. A partner keeps tagging cached assignments for
 * weeks after a test stops: on 5769 "Cart Drawer Counter" ran 14-17
 * September at 350-425k visits a day, then tagged 17,500 on the 18th and
 * single or double digits until 11 October. The active period is the
 * first through the last day at or above ACTIVE_SHARE of the peak day.
 */

export const ACTIVE_SHARE = 0.1;
export const RECENT_DAYS = 14;
export const MIN_VISITS = 200;

/**
 * @typedef {Object} Lifecycle
 * @property {string} status running | recent | ended | trace
 * @property {string | null} observedStart first active day
 * @property {string | null} observedEnd last active day
 * @property {string | null} firstSeen
 * @property {string | null} lastSeen
 * @property {number} peakDailyVisits
 * @property {number} activeDays days at or above the active threshold
 * @property {number} activeVisits visits on days from observedStart to observedEnd
 * @property {number} tailVisits visits after observedEnd
 * @property {number} visits
 * @property {boolean} startedBeforeScan the first scanned day is active, so the real start is earlier
 */

/**
 * @param {Map<string, number>} daily day -> assigned visits
 * @param {{windowEnd: string, scanStart: string, activeShare?: number, recentDays?: number, minVisits?: number}} opts
 * @returns {Lifecycle}
 */
export function lifecycle(daily, opts) {
  const activeShare = opts.activeShare ?? ACTIVE_SHARE;
  const recentDays = opts.recentDays ?? RECENT_DAYS;
  const minVisits = opts.minVisits ?? MIN_VISITS;
  const days = [...daily.entries()].filter(([, v]) => v > 0).sort((a, b) => a[0].localeCompare(b[0]));
  const visits = days.reduce((sum, [, v]) => sum + v, 0);
  const empty = {
    status: 'trace',
    observedStart: null,
    observedEnd: null,
    firstSeen: days[0]?.[0] ?? null,
    lastSeen: days.at(-1)?.[0] ?? null,
    peakDailyVisits: days.reduce((max, [, v]) => Math.max(max, v), 0),
    activeDays: 0,
    activeVisits: 0,
    tailVisits: 0,
    visits,
    startedBeforeScan: false,
  };
  if (days.length === 0) return empty;

  const peak = empty.peakDailyVisits;
  const threshold = peak * activeShare;
  const active = days.filter(([, v]) => v >= threshold);
  const observedStart = active[0][0];
  const observedEnd = active.at(-1)[0];
  const activeVisits = days.filter(([d]) => d >= observedStart && d <= observedEnd).reduce((sum, [, v]) => sum + v, 0);
  const tailVisits = days.filter(([d]) => d > observedEnd).reduce((sum, [, v]) => sum + v, 0);

  const sinceEnd = daysBetween(observedEnd, opts.windowEnd);
  const status = visits < minVisits ? 'trace' : sinceEnd <= 1 ? 'running' : sinceEnd <= recentDays ? 'recent' : 'ended';
  return {
    ...empty,
    status,
    observedStart,
    observedEnd,
    activeDays: active.length,
    activeVisits,
    tailVisits,
    startedBeforeScan: observedStart <= opts.scanStart,
  };
}

/** @param {string} iso YYYY-MM-DD @param {number} n */
export function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Whole days from a to b. @param {string} a @param {string} b */
export function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}
