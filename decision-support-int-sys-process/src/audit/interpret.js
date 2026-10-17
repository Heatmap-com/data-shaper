import { addDays } from './windows.js';
import { mixRateDecomposition, round4 } from './stats.js';

const DIMS = new Set([
  'week', 'device', 'returning', 'channel', 'template', 'element_class', 'element_name',
  'step', 'path', 'next_template', 'band', 'position', 'page', 'partner', 'experience',
  'variant', 'utm_source', 'utm_medium', 'utm_campaign', 'measure', 'checkout_step',
  'entry_template', 'filter_name',
]);

/**
 * One dataset row per aggregated ClickHouse row. Known columns become
 * dimensions. Everything else is a metric.
 * @param {string} queryId
 * @param {object[]} rows
 * @param {object} [extraDims]
 */
export function interpretAcquisition(queryId, rows, extraDims = {}) {
  return (rows ?? []).map((row) => {
    /** @type {Record<string, string | number | null>} */
    const dims = { query: queryId, ...extraDims };
    /** @type {Record<string, number | string | null>} */
    const metrics = {};
    for (const [key, value] of Object.entries(row ?? {})) {
      if (DIMS.has(key)) dims[key] = dimValue(key, value);
      else metrics[key] = metricValue(value);
    }
    return { dims, metrics };
  });
}

/**
 * Copy rows onto the plan id for that template.
 * @param {Array<{dims: object, metrics: object}>} rows
 * @param {Record<string, string>} byTemplate
 */
export function fanOutByTemplate(rows, byTemplate) {
  /** @type {Array<{dims: object, metrics: object}>} */
  const out = [];
  for (const row of rows) {
    const query = byTemplate[String(row.dims.template ?? '')];
    if (!query) continue;
    out.push({ dims: { ...row.dims, query }, metrics: { ...row.metrics } });
  }
  return out;
}

/**
 * F13 from the F1 pull. Revenue and order share, and CR, by week and visitor type.
 * @param {Array<{dims: object, metrics: object}>} f1Rows
 * @param {{trendStart: string, trendEnd: string}} windows
 */
export function returningRows(f1Rows, windows) {
  const cells = segmentWeeks(f1Rows, windows, (row) => `${row.dims.week}|${row.dims.returning}`);
  /** @type {Map<string, {revenue: number, orders: number}>} */
  const totals = new Map();
  for (const [key, cell] of cells) {
    const week = key.split('|')[0];
    const total = totals.get(week) ?? { revenue: 0, orders: 0 };
    total.revenue += cell.revenue;
    total.orders += cell.orders;
    totals.set(week, total);
  }
  return [...cells.entries()].map(([key, cell]) => {
    const [week, returning] = key.split('|');
    const total = totals.get(week) ?? { revenue: 0, orders: 0 };
    return {
      dims: { query: 'F13', week, returning },
      metrics: {
        sessions: cell.sessions,
        buyers: cell.buyers,
        orders: cell.orders,
        revenue: round4(cell.revenue),
        cr: cell.sessions > 0 ? round4((cell.buyers / cell.sessions) * 100) : null,
        revenue_share: total.revenue > 0 ? round4(cell.revenue / total.revenue) : null,
        order_share: total.orders > 0 ? round4(cell.orders / total.orders) : null,
      },
    };
  });
}

/**
 * X1 from the F1 pull. Weekly session share by device, visitor type, and channel.
 * @param {Array<{dims: object, metrics: object}>} f1Rows
 * @param {{trendStart: string, trendEnd: string}} windows
 */
export function trafficMixRows(f1Rows, windows) {
  /** @type {Map<string, number>} */
  const weekTotals = new Map();
  const source = inTrend(f1Rows, windows);
  for (const row of source) {
    weekTotals.set(row.dims.week, (weekTotals.get(row.dims.week) ?? 0) + num(row.metrics.sessions));
  }
  /** @type {Map<string, {sessions: number, device: string, returning: string, channel: string, week: string}>} */
  const cells = new Map();
  for (const row of source) {
    const key = `${row.dims.week}|${row.dims.device}|${row.dims.returning}|${row.dims.channel}`;
    const cell = cells.get(key) ?? {
      week: row.dims.week,
      device: row.dims.device,
      returning: row.dims.returning,
      channel: row.dims.channel,
      sessions: 0,
    };
    cell.sessions += num(row.metrics.sessions);
    cells.set(key, cell);
  }
  return [...cells.values()].map((cell) => {
    const total = weekTotals.get(cell.week) ?? 0;
    return {
      dims: {
        query: 'X1',
        week: cell.week,
        device: cell.device,
        returning: cell.returning,
        channel: cell.channel,
      },
      metrics: {
        sessions: cell.sessions,
        share: total > 0 ? round4(cell.sessions / total) : null,
      },
    };
  });
}

/**
 * F15. Mix versus rate for CR and RPS, last four trend weeks against the four before them.
 * @param {Array<{dims: object, metrics: object}>} f1Rows
 * @param {{trendStart: string, trendEnd: string}} windows
 */
export function mixRateRows(f1Rows, windows) {
  const source = inTrend(f1Rows, windows);
  const weeks = [...new Set(source.map((r) => r.dims.week))].sort();
  if (weeks.length < 8) return [];
  const nextWeeks = new Set(weeks.slice(-4));
  const baseWeeks = new Set(weeks.slice(-8, -4));
  return ['cr', 'rps'].map((measure) => {
    const base = segmentRates(source, baseWeeks, measure);
    const next = segmentRates(source, nextWeeks, measure);
    const parts = mixRateDecomposition(base, next);
    return {
      dims: { query: 'F15', measure, week: weeks[weeks.length - 1] },
      metrics: {
        rate_effect: parts.rateEffect == null ? null : round4(parts.rateEffect),
        mix_effect: parts.mixEffect == null ? null : round4(parts.mixEffect),
        interaction: parts.interaction == null ? null : round4(parts.interaction),
        base_weeks: [...baseWeeks].sort().join(','),
        next_weeks: [...nextWeeks].sort().join(','),
      },
    };
  });
}

/**
 * X6. Each trend week's sessions and CR divided by the week 52 weeks earlier.
 * @param {Array<{dims: object, metrics: object}>} f1Rows
 * @param {{trendStart: string, trendEnd: string}} windows
 */
export function seasonalityRows(f1Rows, windows) {
  /** @type {Map<string, {sessions: number, buyers: number}>} */
  const byWeek = new Map();
  for (const row of f1Rows) {
    if (row.dims.query !== 'F1' || row.dims.device === 'all' || !row.dims.week) continue;
    const cell = byWeek.get(row.dims.week) ?? { sessions: 0, buyers: 0 };
    cell.sessions += num(row.metrics.sessions);
    cell.buyers += num(row.metrics.buyers);
    byWeek.set(row.dims.week, cell);
  }
  /** @type {Array<{dims: object, metrics: object}>} */
  const out = [];
  for (const [week, cell] of byWeek) {
    if (week < windows.trendStart || week > windows.trendEnd) continue;
    const prior = byWeek.get(addDays(week, -364));
    const cr = cell.sessions > 0 ? cell.buyers / cell.sessions : null;
    const priorCr = prior && prior.sessions > 0 ? prior.buyers / prior.sessions : null;
    out.push({
      dims: { query: 'X6', week },
      metrics: {
        sessions: cell.sessions,
        cr: cr == null ? null : round4(cr * 100),
        session_index: prior && prior.sessions > 0 ? round4(cell.sessions / prior.sessions) : null,
        cr_index: cr != null && priorCr ? round4(cr / priorCr) : null,
      },
    });
  }
  return out;
}

/**
 * Stamp exit rate onto the weekly template KPI rows.
 * @param {Array<{dims: object, metrics: object}>} weeklyRows
 * @param {Array<{dims: object, metrics: object}>} exitRows
 */
export function attachExitRates(weeklyRows, exitRows) {
  /** @type {Map<string, number>} */
  const exits = new Map();
  for (const row of exitRows) {
    exits.set(grain(row), num(row.metrics.exits));
  }
  return weeklyRows.map((row) => {
    if (!['H1', 'L1', 'P1', 'C1'].includes(String(row.dims.query))) return row;
    const n = exits.get(grain(row));
    if (n == null) return row;
    const sessions = num(row.metrics.sessions);
    return {
      ...row,
      metrics: {
        ...row.metrics,
        exits: n,
        exit_rate: sessions > 0 ? round4(n / sessions) : null,
      },
    };
  });
}

/**
 * Stamp progression onto the weekly template KPI rows.
 * @param {Array<{dims: object, metrics: object}>} weeklyRows
 * @param {Array<{dims: object, metrics: object}>} progressRows
 */
export function attachProgression(weeklyRows, progressRows) {
  /** @type {Map<string, {progressed: number, sessions: number}>} */
  const progress = new Map();
  for (const row of progressRows) {
    progress.set(grain(row), {
      progressed: num(row.metrics.progressed),
      sessions: num(row.metrics.sessions),
    });
  }
  return weeklyRows.map((row) => {
    if (!['H1', 'L1', 'P1', 'C1'].includes(String(row.dims.query))) return row;
    const hit = progress.get(grain(row));
    if (!hit) return row;
    return {
      ...row,
      metrics: {
        ...row.metrics,
        progressed: hit.progressed,
        progression_rate: hit.sessions > 0 ? round4(hit.progressed / hit.sessions) : null,
      },
    };
  });
}

/** @param {{dims: object}} row */
function grain(row) {
  return `${row.dims.week}|${row.dims.template}|${row.dims.device}|${row.dims.returning}`;
}

/**
 * @param {Array<{dims: object, metrics: object}>} f1Rows
 * @param {{trendStart: string, trendEnd: string}} windows
 * @param {(row: {dims: object}) => string} keyFn
 */
function segmentWeeks(f1Rows, windows, keyFn) {
  /** @type {Map<string, {sessions: number, buyers: number, orders: number, revenue: number}>} */
  const cells = new Map();
  for (const row of inTrend(f1Rows, windows)) {
    const key = keyFn(row);
    const cell = cells.get(key) ?? { sessions: 0, buyers: 0, orders: 0, revenue: 0 };
    cell.sessions += num(row.metrics.sessions);
    cell.buyers += num(row.metrics.buyers);
    cell.orders += num(row.metrics.orders);
    cell.revenue += num(row.metrics.revenue);
    cells.set(key, cell);
  }
  return cells;
}

/**
 * @param {Array<{dims: object, metrics: object}>} rows
 * @param {Set<string>} weeks
 * @param {'cr' | 'rps'} measure
 */
function segmentRates(rows, weeks, measure) {
  /** @type {Map<string, {sessions: number, buyers: number, revenue: number}>} */
  const cells = new Map();
  for (const row of rows) {
    if (!weeks.has(row.dims.week)) continue;
    const key = `${row.dims.device}|${row.dims.returning}|${row.dims.channel}`;
    const cell = cells.get(key) ?? { sessions: 0, buyers: 0, revenue: 0 };
    cell.sessions += num(row.metrics.sessions);
    cell.buyers += num(row.metrics.buyers);
    cell.revenue += num(row.metrics.revenue);
    cells.set(key, cell);
  }
  return [...cells.entries()].map(([key, cell]) => ({
    key,
    sessions: cell.sessions,
    rate: cell.sessions > 0 ? (measure === 'cr' ? cell.buyers / cell.sessions : cell.revenue / cell.sessions) : 0,
  }));
}

/** @param {Array<{dims: object, metrics: object}>} f1Rows @param {{trendStart: string, trendEnd: string}} windows */
function inTrend(f1Rows, windows) {
  return f1Rows.filter((row) => (
    row.dims.query === 'F1'
    && row.dims.device !== 'all'
    && row.dims.week
    && row.dims.week >= windows.trendStart
    && row.dims.week <= windows.trendEnd
  ));
}

/** @param {string} key @param {unknown} value */
function dimValue(key, value) {
  if (value == null || value === '') return '';
  const text = String(value);
  return key === 'week' ? text.slice(0, 10) : text.slice(0, 240);
}

/** @param {unknown} value */
function metricValue(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  const n = Number(value);
  if (typeof value !== 'string') return n;
  return Number.isFinite(n) && value.trim() !== '' && !Number.isNaN(n) ? n : value.slice(0, 240);
}

/** @param {unknown} value */
function num(value) {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}
