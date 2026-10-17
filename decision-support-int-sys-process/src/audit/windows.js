/**
 * Shared audit windows. Every brand in a run uses these dates.
 *
 * Trend weeks are complete ISO weeks (Monday–Sunday) ending the last Sunday
 * before today. The snapshot is the trailing 28 complete UTC days ending
 * yesterday. The extended trend adds the prior 52 weeks so year-over-year
 * has a partner week inside the same pull.
 */

/** @param {string} iso @param {number} days */
export function addDays(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** @param {string} iso inclusive @param {string} end inclusive */
export function daysInclusive(iso, end) {
  const ms = Date.parse(`${end}T00:00:00Z`) - Date.parse(`${iso}T00:00:00Z`);
  return Math.round(ms / 86400000) + 1;
}

/**
 * @param {string} todayUtc YYYY-MM-DD
 */
export function auditWindows(todayUtc) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(todayUtc)) {
    throw new Error(`audit window expects YYYY-MM-DD, got ${todayUtc}`);
  }
  const yesterday = addDays(todayUtc, -1);
  const yesterdayDow = new Date(`${yesterday}T00:00:00Z`).getUTCDay();
  const trendEnd = addDays(yesterday, -yesterdayDow);
  const trendStart = addDays(trendEnd, -(52 * 7 - 1));
  const elementStart = addDays(trendEnd, -(26 * 7 - 1));
  const extendedStart = addDays(trendEnd, -(104 * 7 - 1));
  const snapshotEnd = yesterday;
  const snapshotStart = addDays(snapshotEnd, -27);
  const priorEnd = addDays(snapshotStart, -1);
  const priorStart = addDays(priorEnd, -27);
  const yoySnapshotEnd = addDays(snapshotEnd, -365);
  const yoySnapshotStart = addDays(snapshotStart, -365);
  return {
    today: todayUtc,
    yesterday,
    trendStart,
    trendEnd,
    elementStart,
    elementEnd: trendEnd,
    extendedStart,
    snapshotStart,
    snapshotEnd,
    priorStart,
    priorEnd,
    yoySnapshotStart,
    yoySnapshotEnd,
  };
}
