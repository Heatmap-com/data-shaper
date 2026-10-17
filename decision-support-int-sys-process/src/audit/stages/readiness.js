/**
 * Readiness stage (R1–R13). R1 resolves the brand to a site; the rest run
 * only when it resolves, with the matrix coverage query when the matrix
 * names that site.
 */

import { matrixCoverageQuery, readinessQueries } from '../queries/readiness.js';
import { interpretReadiness, resolveSite } from '../readiness.js';
import { runQuery } from './run-query.js';

/**
 * @param {{query: Function}} gateway
 * @param {{key: string, name: string, domain: string, idsite: number}} brand
 * @param {object} windows
 * @param {{entries: object[], urlRules: object[], events: object[]}} inputs
 */
export async function readinessStage(gateway, brand, windows, inputs) {
  const r1 = readinessQueries(brand, windows).find((q) => q.id === 'R1');
  const r1Result = await runQuery(gateway, r1);
  const resolved = resolveSite(brand, r1Result.rows ?? []);
  /** @type {Record<string, {rows?: object[], error?: string}>} */
  const results = { R1: r1Result };
  if (resolved.found) {
    const site = { ...brand, idsite: resolved.idsite };
    const rest = readinessQueries(site, windows).filter((q) => q.id !== 'R1');
    const coverage = matrixCoverageQuery(resolved.idsite, windows, inputs.entries);
    if (coverage) rest.push(coverage);
    for (const query of rest) {
      results[query.id] = await runQuery(gateway, query);
    }
  }
  return interpretReadiness(brand, windows, results, inputs);
}
