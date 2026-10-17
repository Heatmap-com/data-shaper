// Dataset contracts, coverage and compatibility. No DOM.

const DAY = 86400000;

export function parseDay(iso) {
  return Date.parse(`${iso}T00:00:00Z`);
}

export function formatDay(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]}`;
}

export function daysBetween(start, end) {
  if (!start || !end) return 0;
  const a = parseDay(start);
  const b = parseDay(end);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return 0;
  return Math.round((b - a) / DAY) + 1;
}

// Days of the Monday-start week that fall inside [start, end], inclusive.
export function daysInWeek(week, start, end) {
  if (!week || !start || !end) return 0;
  const from = Math.max(parseDay(week), parseDay(start));
  const to = Math.min(parseDay(week) + 6 * DAY, parseDay(end));
  if (to < from) return 0;
  return Math.round((to - from) / DAY) + 1;
}

function windowOf(manifest, key) {
  const w = manifest?.[key]?.window;
  if (!w) return null;
  return { start: w.start ?? w[0], end: w.end ?? w[1] };
}

const FLOW_DATASETS = new Set(['funnel', 'journeys', 'journey_summary']);
const INFERRED = new Set(['trend', 'tag_trend', 'experiment_rows']);

export function contractOf(views, name) {
  return views?.datasetContracts?.[name] ?? {
    availability: 'unknown',
    scope: 'unknown contract',
    keys: [],
  };
}

const FIELD_COLUMNS = {
  week: ['week', 'dim_week'],
  device: ['viewport_type', 'dim_device', 'dev_s', 'dev'],
  segment: ['segment'],
  segment_value: ['segment_value'],
  entry: ['entry'],
};

export function columnFor(columns, field) {
  const want = FIELD_COLUMNS[field] ?? [field];
  return want.find((c) => columns?.includes(c)) ?? null;
}

export function supports(views, name, field, columns) {
  const contract = contractOf(views, name);
  if (contract.forbid?.includes(field)) return false;
  if ((contract.forbidAggregateAcross ?? []).includes(field) && field !== 'segment') return false;
  return Boolean(columnFor(columns, field));
}

// Device crosses with one segment family on the flow datasets. Two families never cross.
export function crossable(name, fieldA, fieldB) {
  const flow = FLOW_DATASETS.has(name);
  const fields = new Set([fieldA, fieldB]);
  if (fields.has('device') && (fields.has('segment') || fields.has('entry'))) return flow;
  if (fields.has('segment') && fields.has('entry')) return flow;
  return false;
}

export function coverage(manifest, name) {
  const out = new Map();
  const weeks = manifest?.warehouse?.trendWeeks ?? [];
  let source = 'none';
  let window = null;
  if (FLOW_DATASETS.has(name)) {
    source = 'flows';
    window = windowOf(manifest, 'flows');
  } else if (INFERRED.has(name)) {
    source = 'inferred';
    window = windowOf(manifest, 'bundle');
  } else {
    const meta = manifest?.datasets?.[name];
    const cols = meta?.columns ?? [];
    if (meta?.source === 'bundle' && (cols.includes('week') || cols.includes('dim_week'))) {
      source = 'bundle';
      window = windowOf(manifest, 'bundle');
    }
  }
  for (const week of weeks) {
    if (!window) {
      out.set(week, { days: null, state: 'unverified-complete', source });
      continue;
    }
    const days = daysInWeek(week, window.start, window.end);
    let state = 'verified';
    if (source === 'inferred') state = days >= 7 ? 'unverified-complete' : 'partial-inferred';
    else state = days >= 7 ? 'verified' : 'partial';
    out.set(week, { days, state, source, window });
  }
  return out;
}

export function coverageLabel(info) {
  if (!info || info.state === 'verified') return '';
  if (info.state === 'unverified-complete') return 'Coverage unverified';
  const inferred = info.state === 'partial-inferred' ? ', inferred' : '';
  return `${info.days}/7 days${inferred}`;
}

function siteSessions(rows, week, kind) {
  const here = rows.filter((r) => r.week === week);
  if (kind === 'funnel') {
    return here.filter((r) => r.segment === 'all' && r.viewport_type === 'all')
      .reduce((s, r) => s + (Number(r.sessions) || 0), 0);
  }
  const all = here.filter((r) => r.tag_key === 'utm_source' && r.segment === 'all' && r.viewport_type === 'all');
  if (all.length) return all.reduce((s, r) => s + (Number(r.sessions) || 0), 0);
  return here.filter((r) => r.tag_key === 'utm_source' && r.segment === 'traffic_source' && r.viewport_type === 'all')
    .reduce((s, r) => s + (Number(r.sessions) || 0), 0);
}

export function compatibility(manifest, rowsOf, a, b) {
  const weeks = manifest?.warehouse?.trendWeeks ?? [];
  const rowsA = rowsOf(a) ?? [];
  const rowsB = rowsOf(b) ?? [];
  return weeks.map((week) => {
    const left = siteSessions(rowsA, week, a);
    const right = siteSessions(rowsB, week, b);
    const ratio = right ? left / right : null;
    const state = ratio !== null && ratio >= 0.97 && ratio <= 1.03 ? 'compatible' : 'incompatible';
    return { week, ratio, state, left, right };
  });
}

export function coverageSentence(manifest, rowsOf) {
  const bundle = windowOf(manifest, 'bundle');
  const weeks = manifest?.warehouse?.trendWeeks ?? [];
  if (!bundle) return 'Coverage unverified for Health and Acquisition.';
  const cov = coverage(manifest, 'tag_trend');
  const partial = weeks.filter((w) => {
    const info = cov.get(w);
    return info && info.days < 7;
  });
  const pairs = rowsOf ? compatibility(manifest, rowsOf, 'tag_trend', 'funnel') : [];
  const whole = pairs.filter((p) => p.state === 'compatible');
  const worst = whole.reduce((m, p) => Math.max(m, Math.abs((p.ratio ?? 1) - 1)), 0);
  const within = `${(worst * 100).toFixed(1)}%`;
  if (!partial.length) {
    return whole.length
      ? `Health and Acquisition cover ${formatDay(bundle.start)}–${formatDay(bundle.end)}. In whole weeks they agree with Funnels within ${within}.`
      : `Health and Acquisition cover ${formatDay(bundle.start)}–${formatDay(bundle.end)}.`;
  }
  const listed = partial.map((w) => {
    const info = cov.get(w);
    return `their ${formatDay(w)} week has ${info.days} of 7 days`;
  }).join(', and ');
  const agree = whole.length ? ` In whole weeks they agree within ${within}.` : '';
  return `Health and Acquisition tables cover ${formatDay(bundle.start)}–${formatDay(bundle.end)}, so ${listed} and can't be compared with Funnels or Journeys.${agree}`;
}

export function rankWindow(manifest) {
  const end = windowOf(manifest, 'flows')?.end;
  if (!end) return null;
  const start = new Date(parseDay(end) - 29 * DAY).toISOString().slice(0, 10);
  return { start, end, days: 30 };
}
