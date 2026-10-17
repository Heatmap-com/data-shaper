/**
 * Charts are declared on the report stage that uses them:
 *
 *   "charts": { "sor-fig1-daily-orders": { "type": "daily-orders", "title": "Daily orders, {window}" } }
 *
 * The key is the file stem under the site's media directory. A site run drops a
 * chart with `null` and adds one with a new key. The chart-render stage draws
 * every chart its run declares, so the report stages after it find their figures.
 */

const STEM = /^[a-z0-9][a-z0-9-]*$/;

/**
 * @param {{ stages?: Array<{ id: string, charts?: Record<string, object | null> }> }} run
 * @returns {Array<{ file: string, stage: string, type: string, [param: string]: unknown }>}
 */
export function declaredCharts(run) {
  const charts = [];
  for (const stage of run?.stages ?? []) {
    for (const [stem, chart] of Object.entries(stage.charts ?? {})) {
      if (chart) charts.push({ ...chart, file: `${stem}.png`, stage: stage.id });
    }
  }
  return charts;
}

/** Problems with the charts a run declares, as sentences. */
export function chartProblems(run) {
  const problems = [];
  const owners = new Map();
  for (const stage of run?.stages ?? []) {
    if (stage.charts === undefined) continue;
    if (!stage.charts || typeof stage.charts !== 'object' || Array.isArray(stage.charts)) {
      problems.push(`stage ${stage.id}: charts must be an object of file stem to chart spec`);
      continue;
    }
    for (const [stem, chart] of Object.entries(stage.charts)) {
      if (chart === null) continue;
      if (!STEM.test(stem)) problems.push(`stage ${stage.id}: chart "${stem}" needs a lower-case file stem such as sor-fig1-daily-orders`);
      if (!chart || typeof chart !== 'object' || typeof chart.type !== 'string' || !chart.type) {
        problems.push(`stage ${stage.id}: chart "${stem}" needs a type`);
      }
      if (owners.has(stem)) problems.push(`stage ${stage.id}: chart "${stem}" is also declared by stage ${owners.get(stem)}`);
      else owners.set(stem, stage.id);
    }
  }
  return problems;
}
