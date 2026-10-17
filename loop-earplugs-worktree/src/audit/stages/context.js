/**
 * Context stage (X1–X4, X6, X8): traffic mix and seasonality from the F1
 * rows, then the campaign, speed, experiment, and industry queries.
 */

import { seasonalityRows, trafficMixRows } from '../interpret.js';
import { contextAcquisitionQueries } from '../queries/context.js';
import { runSet } from './run-query.js';

/**
 * @param {{query: Function}} gateway
 * @param {object} input
 * @param {number} input.idsite
 * @param {object} input.windows
 * @param {Array<{pattern: string, template: string}>} input.rules
 * @param {{byTemplate?: Record<string, number[]>}|null} input.scope
 * @param {Array<{dims: object, metrics: object}>} input.kpis the F1 rows
 */
export async function contextStage(gateway, { idsite, windows, rules, scope, kpis }) {
  return [
    ...trafficMixRows(kpis, windows),
    ...seasonalityRows(kpis, windows),
    ...(await runSet(gateway, contextAcquisitionQueries(idsite, windows, rules, scope))),
  ];
}
