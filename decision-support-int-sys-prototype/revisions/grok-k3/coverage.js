// Which weeks of a dataset are whole. Coverage comes from the manifest's windows, never from volume.
const DAY = 86400000;
const FLOW = new Set(['funnel', 'journeys', 'journey_summary']);
const INFERRED = new Set(['trend', 'tag_trend', 'experiment_rows', 'experiments-weekly']);

const toDate = (s) => new Date(`${s}T00:00:00Z`).getTime();
const iso = (t) => new Date(t).toISOString().slice(0, 10);
export const addDays = (s, n) => iso(toDate(s) + n * DAY);

export function datasetWindow(manifest, dataset, weeks = []) {
  if (FLOW.has(dataset) && manifest.flows?.window) return { ...manifest.flows.window, inferred: false };
  const w = manifest.bundle?.window;
  if (!w) return null;
  let start = w.start;
  const pre = manifest.bundle?.periods?.pre?.match(/\d{4}-\d{2}-\d{2}/)?.[0];
  if (pre && weeks.some((wk) => addDays(wk, 6) < w.start)) start = pre;
  return { start, end: w.end, inferred: INFERRED.has(dataset) };
}

// Map week -> { days, full, inferred }
export function weekCoverage(manifest, dataset, weeks) {
  const win = datasetWindow(manifest, dataset, weeks);
  const out = new Map();
  for (const wk of weeks) {
    if (!win) { out.set(wk, { days: 7, full: true, inferred: true }); continue; }
    let days = 0;
    for (let i = 0; i < 7; i += 1) {
      const d = addDays(wk, i);
      if (d >= win.start && d <= win.end) days += 1;
    }
    out.set(wk, { days, full: days === 7, inferred: win.inferred });
  }
  return out;
}

export function latestFull(cov, weeks) {
  for (let i = weeks.length - 1; i >= 0; i -= 1) if (cov.get(weeks[i])?.full) return weeks[i];
  return weeks[weeks.length - 1];
}

export function firstFull(cov, weeks) {
  return weeks.find((w) => cov.get(w)?.full) ?? weeks[0];
}

export function coverageLabel(c) {
  if (!c || c.full) return '';
  return `${c.days}/7 days${c.inferred ? ' (inferred)' : ''}`;
}

export function coverageTitle(c, dataset) {
  if (!c || c.full) return null;
  return c.inferred
    ? `This week has ${c.days} of 7 days in the bundle window. ${dataset} doesn't store its window, so this is inferred from the bundle's dates. Counts and money for it are not comparable with whole weeks.`
    : `This week has ${c.days} of 7 days in the data window. Counts and money for it are not comparable with whole weeks.`;
}
