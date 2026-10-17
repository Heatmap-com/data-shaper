/**
 * Funnel stage (the F group): weekly and channel funnels, the F4 snapshot
 * against the prior window and last year, revenue at stake by step, the
 * acquisition queries, and the top-path trend.
 */

import { compareFunnel, interpretFunnelWeekly, revenueAtStakeByStep } from '../funnel.js';
import { mixRateRows, returningRows } from '../interpret.js';
import {
  funnelAcquisitionQueries,
  funnelChannelQuery,
  funnelSnapshotQuery,
  funnelWeeklyQuery,
  pathTrendQuery,
} from '../queries/funnel.js';
import { trackedIds } from '../bounds.js';
import { shapeAcquisition } from '../shape.js';
import { runLabeled, runQuery, runSet } from './run-query.js';

/**
 * @param {{query: Function}} gateway
 * @param {object} input
 * @param {string} input.brand
 * @param {number} input.idsite
 * @param {object} input.windows
 * @param {Array<{pattern: string, template: string}>} input.rules
 * @param {{byTemplate?: Record<string, number[]>}|null} input.scope
 * @param {Array<{dims: object, metrics: object}>} input.kpis the F1 rows
 * @returns {Promise<{rows: Array<{dims: object, metrics: object}>, findings: object[], revenueAtStake: number}>}
 */
export async function funnelStage(gateway, { brand, idsite, windows, rules, scope, kpis }) {
  /** @type {Array<{dims: object, metrics: object}>} */
  const rows = [];
  /** @type {object[]} */
  const findings = [];
  let revenueAtStake = 0;
  const f2 = await runQuery(gateway, funnelWeeklyQuery(idsite, windows));
  const f3 = await runQuery(gateway, funnelChannelQuery(idsite, windows));
  const snap = await runQuery(gateway, funnelSnapshotQuery('F4', idsite, windows.snapshotStart, windows.snapshotEnd));
  const prior = await runQuery(gateway, funnelSnapshotQuery('F4prior', idsite, windows.priorStart, windows.priorEnd));
  const yoy = await runQuery(gateway, funnelSnapshotQuery('F4yoy', idsite, windows.yoySnapshotStart, windows.yoySnapshotEnd));
  if (!snap.error) {
    const stakes = revenueAtStakeByStep(snap.rows);
    rows.push(...stakes);
    for (const row of stakes) {
      const stake = Number(row.metrics.revenue_at_stake ?? 0);
      revenueAtStake += stake;
      findings.push({
        brand,
        query: 'F14',
        label: `${row.dims.step} ${row.dims.device} ${row.dims.returning}`,
        revenueAtStake: stake,
        trend: 'insufficient',
      });
    }
    if (!prior.error && !yoy.error) rows.push(...compareFunnel(snap.rows, prior.rows, yoy.rows));
  }
  if (f2.error) rows.push({ dims: { query: 'F2' }, metrics: { error: f2.error } });
  else rows.push(...interpretFunnelWeekly(f2.rows));
  if (f3.error) rows.push({ dims: { query: 'F3' }, metrics: { error: f3.error } });
  else rows.push(...shapeAcquisition('F3', f3.rows));
  const acquired = await runSet(gateway, funnelAcquisitionQueries(idsite, windows, rules, scope));
  rows.push(...acquired);
  const paths = [...new Set(acquired.filter((row) => row.dims.query === 'F6').map((row) => String(row.dims.path ?? '')).filter(Boolean))].slice(0, 10);
  const f7 = pathTrendQuery(idsite, windows, rules, paths, trackedIds(scope));
  if (f7) rows.push(...(await runLabeled(gateway, f7)));
  rows.push(...returningRows(kpis, windows));
  rows.push(...mixRateRows(kpis, windows));
  harvestStake(brand, rows, findings);
  return { rows, findings, revenueAtStake };
}

/**
 * @param {string} brand
 * @param {Array<{dims: object, metrics: object}>} rows
 * @param {object[]} findings
 */
function harvestStake(brand, rows, findings) {
  for (const row of rows) {
    if (row.dims.query !== 'F12' && row.dims.query !== 'C12') continue;
    const abandoned = Number(row.metrics.atc_no_checkout ?? 0) + Number(row.metrics.checkout_no_purchase ?? 0) + Number(row.metrics.abandoned_sessions ?? 0);
    const completed = Number(row.metrics.completed_sessions ?? 0);
    const revenue = Number(row.metrics.completed_revenue ?? 0);
    const proxy = completed > 0 ? revenue / completed : 0;
    const stake = abandoned * proxy;
    if (!(stake > 0)) continue;
    findings.push({
      brand,
      query: String(row.dims.query),
      label: `${row.dims.query} ${row.dims.week ?? ''} ${row.dims.device ?? ''} ${row.dims.returning ?? ''}`.trim(),
      revenueAtStake: stake,
      trend: 'insufficient',
    });
  }
}
