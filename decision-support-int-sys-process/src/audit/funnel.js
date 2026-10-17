/**
 * Funnel interpretation: site KPIs, the weekly funnel, revenue at stake by
 * step, the F4 comparison, and the conversion trend series.
 */

import { EVENT_STEPS } from './queries/funnel.js';
import { isDirectional, revenueAtStake, round4, slopePercentPerStep, trendLabel, twoProportionZ } from './stats.js';

/**
 * @param {object[]} rawRows
 * @param {{trendStart: string, trendEnd: string}} windows
 */
export function interpretSiteKpis(rawRows, windows) {
  const rows = rawRows.map((r) => {
    const sessions = num(r.sessions);
    const buyers = num(r.buyers);
    const orders = num(r.orders);
    const revenue = num(r.revenue);
    return {
      dims: {
        query: 'F1',
        week: day(r.week),
        device: String(r.device),
        returning: String(r.returning),
        channel: String(r.channel),
      },
      metrics: {
        sessions,
        buyers,
        orders,
        revenue,
        cr: sessions > 0 ? round4((buyers / sessions) * 100) : null,
        rps: sessions > 0 ? round4(revenue / sessions) : null,
        aov: orders > 0 ? round4(revenue / orders) : null,
        directional: isDirectional(sessions, buyers),
      },
    };
  });
  const blended = blendWeeks(rows);
  const recent = blended.filter((w) => w.week >= windows.trendStart && w.week <= windows.trendEnd);
  const prior = blended.filter((w) => w.week < windows.trendStart);
  const slope = slopePercentPerStep(recent.slice(-13).map((w) => w.cr ?? 0));
  const yoy = relativeChange(sumMetric(recent, 'buyers'), sumMetric(recent, 'sessions'), sumMetric(prior, 'buyers'), sumMetric(prior, 'sessions'));
  rows.push({
    dims: { query: 'F1', week: windows.trendEnd, device: 'all', returning: 'all', channel: 'all' },
    metrics: {
      slope_13w_cr_pct: slope == null ? null : round4(slope),
      yoy_cr_change: yoy == null ? null : round4(yoy),
      trend: trendLabel(slope, yoy),
      sessions: sumMetric(recent, 'sessions'),
      revenue: round4(sumMetric(recent, 'revenue')),
    },
  });
  return rows;
}

/**
 * One dataset row per week and quadrant, with reach and progression counts.
 * @param {object[]} rawRows
 */
export function interpretFunnelWeekly(rawRows) {
  return rawRows.map((row) => {
    const sessions = num(row.sessions);
    /** @type {Record<string, number | null>} */
    const metrics = {
      sessions,
      buyers: num(row.buyers),
      revenue: num(row.revenue),
    };
    for (const step of EVENT_STEPS) {
      const reached = num(row[`reach_${step}`]);
      const progressed = num(row[`prog_${step}`]);
      metrics[`reach_${step}`] = reached;
      metrics[`prog_${step}`] = progressed;
      metrics[`prog_rate_${step}`] = sessions > 0 ? round4(progressed / sessions) : null;
    }
    return {
      dims: {
        query: 'F2',
        week: day(row.week),
        device: String(row.device),
        returning: String(row.returning),
      },
      metrics,
    };
  });
}

/**
 * F14 from the snapshot funnel (F4). Lost sessions are the drop in
 * progression from the previous step. Downstream value is the RPS of
 * sessions that reached the step.
 * @param {object[]} snapshotRows rows from the F4 snapshot query
 */
export function revenueAtStakeByStep(snapshotRows) {
  /** @type {Map<string, object>} */
  const cells = new Map();
  for (const row of snapshotRows) {
    const key = `${row.device}|${row.returning}`;
    const cell = cells.get(key) ?? { device: String(row.device), returning: String(row.returning) };
    cell.sessions = (cell.sessions ?? 0) + num(row.sessions);
    cell.buyers = (cell.buyers ?? 0) + num(row.buyers);
    for (const step of EVENT_STEPS) {
      cell[`reach_${step}`] = (cell[`reach_${step}`] ?? 0) + num(row[`reach_${step}`]);
      cell[`prog_${step}`] = (cell[`prog_${step}`] ?? 0) + num(row[`prog_${step}`]);
      cell[`revenue_${step}`] = (cell[`revenue_${step}`] ?? 0) + num(row[`revenue_${step}`]);
    }
    cells.set(key, cell);
  }
  /** @type {Array<{dims: object, metrics: object}>} */
  const out = [];
  for (const cell of cells.values()) {
    let previous = cell.sessions;
    for (const step of EVENT_STEPS) {
      const progressed = cell[`prog_${step}`];
      const reached = cell[`reach_${step}`];
      const lost = Math.max(0, previous - progressed);
      const rps = reached > 0 ? cell[`revenue_${step}`] / reached : 0;
      const stake = revenueAtStake(lost, 1, 0, rps);
      out.push({
        dims: { query: 'F14', device: cell.device, returning: cell.returning, step },
        metrics: {
          sessions_lost: lost,
          progressed,
          reached,
          rps_reached: round4(rps),
          revenue_at_stake: stake == null ? null : round4(stake),
          directional: isDirectional(cell.sessions, cell.buyers ?? 0),
        },
      });
      previous = progressed;
    }
  }
  return out;
}

/**
 * Z-test snapshot progression against the prior window and last year.
 * @param {object[]} snapshot
 * @param {object[]} prior
 * @param {object[]} yoy
 */
export function compareFunnel(snapshot, prior, yoy) {
  const snap = sumFunnel(snapshot);
  const prev = sumFunnel(prior);
  const year = sumFunnel(yoy);
  return EVENT_STEPS.map((step) => {
    const againstPrior = twoProportionZ(snap[`prog_${step}`] ?? 0, snap.sessions, prev[`prog_${step}`] ?? 0, prev.sessions);
    const againstYear = twoProportionZ(snap[`prog_${step}`] ?? 0, snap.sessions, year[`prog_${step}`] ?? 0, year.sessions);
    return {
      dims: { query: 'F4', step },
      metrics: {
        sessions: snap.sessions,
        progressed: snap[`prog_${step}`] ?? 0,
        reached: snap[`reach_${step}`] ?? 0,
        rate: snap.sessions > 0 ? round4((snap[`prog_${step}`] ?? 0) / snap.sessions) : null,
        z_prior: againstPrior.z == null ? null : round4(againstPrior.z),
        significant_prior: againstPrior.significant,
        z_yoy: againstYear.z == null ? null : round4(againstYear.z),
        significant_yoy: againstYear.significant,
        directional: isDirectional(snap.sessions, snap[`prog_${step}`] ?? 0),
      },
    };
  });
}

/** @param {object[]} rows */
function sumFunnel(rows) {
  /** @type {Record<string, number>} */
  const totals = { sessions: 0 };
  for (const row of rows) {
    totals.sessions += num(row.sessions);
    for (const step of EVENT_STEPS) {
      totals[`prog_${step}`] = (totals[`prog_${step}`] ?? 0) + num(row[`prog_${step}`]);
      totals[`reach_${step}`] = (totals[`reach_${step}`] ?? 0) + num(row[`reach_${step}`]);
    }
  }
  return totals;
}

/** @param {Array<{dims: {week: string}, metrics: object}>} rows */
function blendWeeks(rows) {
  /** @type {Map<string, {week: string, sessions: number, buyers: number, revenue: number, cr: number | null}>} */
  const byWeek = new Map();
  for (const row of rows) {
    const week = row.dims.week;
    if (!week) continue;
    const cell = byWeek.get(week) ?? { week, sessions: 0, buyers: 0, revenue: 0, cr: null };
    cell.sessions += num(row.metrics.sessions);
    cell.buyers += num(row.metrics.buyers);
    cell.revenue += num(row.metrics.revenue);
    byWeek.set(week, cell);
  }
  return [...byWeek.values()]
    .sort((a, b) => a.week.localeCompare(b.week))
    .map((cell) => ({ ...cell, cr: cell.sessions > 0 ? (cell.buyers / cell.sessions) * 100 : null }));
}

/** @param {Array<{week: string, sessions: number, buyers: number, revenue: number}>} weeks @param {string} key */
function sumMetric(weeks, key) {
  return weeks.reduce((s, w) => s + num(w[key]), 0);
}

/**
 * Blended weekly CR for the trend window, oldest first.
 * @param {Array<{dims: object, metrics: object}>} kpiRows
 * @param {{trendStart: string, trendEnd: string}} windows
 */
export function trendSeries(kpiRows, windows) {
  /** @type {Map<string, {sessions: number, buyers: number}>} */
  const byWeek = new Map();
  for (const row of kpiRows) {
    if (row.dims.query !== 'F1' || row.dims.device === 'all') continue;
    const week = row.dims.week;
    if (!week || week < windows.trendStart || week > windows.trendEnd) continue;
    const cell = byWeek.get(week) ?? { sessions: 0, buyers: 0 };
    cell.sessions += num(row.metrics.sessions);
    cell.buyers += num(row.metrics.buyers);
    byWeek.set(week, cell);
  }
  const weeks = [...byWeek.keys()].sort();
  const cr = weeks.map((week) => {
    const cell = byWeek.get(week);
    return cell.sessions > 0 ? (cell.buyers / cell.sessions) * 100 : 0;
  });
  return { weeks, cr };
}

function relativeChange(buyersNow, sessionsNow, buyersThen, sessionsThen) {
  if (!(sessionsNow > 0) || !(sessionsThen > 0)) return null;
  const now = buyersNow / sessionsNow;
  const then = buyersThen / sessionsThen;
  if (then === 0) return null;
  return (now - then) / then;
}

/** @param {unknown} value */
function num(value) {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/** @param {unknown} value */
function day(value) {
  if (value == null || value === '') return null;
  return String(value).slice(0, 10);
}
