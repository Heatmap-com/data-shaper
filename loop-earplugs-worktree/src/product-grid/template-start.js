/**
 * First day of a template from daily click counts on its container prefix.
 * A thin prefix of clicks, under 5 and under 1% of the prefix's clicks,
 * is a stray hit from the previous structure. The dense run after it is
 * the template. Carousel click position is not used.
 */

/**
 * @param {string} earlier
 * @param {string} later
 */
function daysBetween(earlier, later) {
  const ms = Date.parse(`${later}T00:00:00Z`) - Date.parse(`${earlier}T00:00:00Z`);
  return Math.round(ms / 86_400_000);
}

/**
 * First day the container prefix is in the click stream. A handful of clicks
 * separated from that run by a gap of at least seven days is the previous
 * template. A thin first day that continues into the next day is the start
 * of this template, not a stray.
 *
 * @param {Array<{date: string, clicks: number}>} daily
 * @returns {string | null}
 */
export function templateStartFromDaily(daily) {
  const days = daily
    .filter((row) => Number(row.clicks) > 0 && row.date)
    .map((row) => ({ date: String(row.date).slice(0, 10), clicks: Number(row.clicks) }))
    .sort((a, b) => a.date.localeCompare(b.date));
  if (days.length === 0) return null;
  const total = days.reduce((sum, row) => sum + row.clicks, 0);
  const strayLimit = Math.max(5, total * 0.01);
  let before = 0;
  let start = 0;
  for (let i = 0; i < days.length - 1; i++) {
    before += days[i].clicks;
    const gap = daysBetween(days[i].date, days[i + 1].date);
    if (gap >= 7 && before < strayLimit) {
      start = i + 1;
      before = 0;
      continue;
    }
    if (gap >= 7) break;
  }
  return days[start].date;
}
