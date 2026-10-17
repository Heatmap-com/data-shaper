// Days of each week that fall inside the dataset's window. The stored trend tables
// don't record a window; everything except the flow datasets is assumed to follow
// the 30-day bundle window. coverageCheck tests that assumption.
const WHOLE_WEEK = new Set(['funnel', 'journeys', 'journey_summary', 'site_week']);

const DAY = 86400000;

function dayMs(iso) {
  return Date.parse(`${iso}T00:00:00Z`);
}

function isoOf(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function daysIn(week, start, end) {
  const from = dayMs(week);
  let n = 0;
  for (let i = 0; i < 7; i += 1) {
    const d = isoOf(from + i * DAY);
    if (d >= start && d <= end) n += 1;
  }
  return n;
}

function weeksOverlapping(start, end) {
  const startMs = dayMs(start);
  const dow = new Date(startMs).getUTCDay();
  const monday = startMs - (dow === 0 ? 6 : dow - 1) * DAY;
  const out = [];
  for (let t = monday; isoOf(t) <= end; t += 7 * DAY) {
    const week = isoOf(t);
    const days = daysIn(week, start, end);
    if (days > 0) out.push([week, days]);
  }
  return out;
}

export function weekCoverage(manifest, dataset) {
  const name = typeof dataset === 'string' ? dataset : dataset?.name;
  const columns = typeof dataset === 'string'
    ? (manifest.datasets?.[name]?.columns ?? (WHOLE_WEEK.has(name) ? ['week'] : null))
    : dataset?.columns;
  if (!name || !columns) return null;
  if (!columns.includes('week') && !columns.includes('dim_week')) return null;
  const window = WHOLE_WEEK.has(name) ? manifest.flows?.window : manifest.bundle?.window;
  if (!window?.start || !window?.end) return null;
  return new Map(weeksOverlapping(window.start, window.end));
}

function sum(rows, pred, field) {
  let n = 0;
  for (const r of rows) if (pred(r)) n += Number(r[field]) || 0;
  return n;
}

export function coverageCheck(manifest, rowsOf) {
  const coverage = weekCoverage(manifest, 'tag_trend');
  const tags = rowsOf('tag_trend') ?? [];
  const funnel = rowsOf('funnel') ?? [];
  const hasAll = tags.some((r) => r.tag_key === 'utm_source' && r.segment === 'all' && r.viewport_type === 'all');
  const weeks = [];
  let ok = true;
  for (const [week, days] of coverage ?? []) {
    const tagSessions = hasAll
      ? sum(tags, (r) => r.tag_key === 'utm_source' && r.segment === 'all' && r.viewport_type === 'all' && r.week === week, 'sessions')
      : sum(tags, (r) => r.tag_key === 'utm_source' && r.segment === 'traffic_source' && r.viewport_type === 'all' && r.week === week, 'sessions');
    const funnelSessions = sum(funnel, (r) => r.segment === 'all' && r.segment_value === 'all' && r.viewport_type === 'all' && r.week === week, 'sessions');
    const ratio = funnelSessions ? tagSessions / funnelSessions : null;
    if (days === 7) ok = ok && ratio >= 0.97 && ratio <= 1.03;
    else ok = ok && ratio < 0.95;
    weeks.push({ week, days, ratio });
  }
  return { ok: Boolean(coverage) && ok, weeks };
}

export function partialTip(days) {
  return `This table's data covers ${days} of the 7 days of this week. Compare its rates, not its totals.`;
}
