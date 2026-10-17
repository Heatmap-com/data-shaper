/**
 * Template stage (the H, L, P, C, K and G groups): the weekly template
 * series, an element scorecard per template, the acquisition queries with
 * exit and progression rates stamped on, and the K2 checkout comparison.
 */

import { templateIds, trackedIds } from '../bounds.js';
import { attachExitRates, attachProgression } from '../interpret.js';
import { elementScorecardQuery, templateAcquisitionQueries, templateWeeklyQuery } from '../queries/template.js';
import { compareCheckout } from '../shape.js';
import { interpretScorecard, interpretTemplateWeekly } from '../template.js';
import { runQuery, runSet } from './run-query.js';

const SCORE_TEMPLATES = ['home', 'plp', 'pdp', 'cart_page', 'cart_drawer', 'checkout', 'global'];

/**
 * @param {{query: Function}} gateway
 * @param {object} input
 * @param {string} input.brand
 * @param {number} input.idsite
 * @param {object} input.windows
 * @param {Array<{pattern: string, template: string}>} input.rules
 * @param {object[]} input.entries the site's matrix entries
 * @param {{byTemplate?: Record<string, number[]>}|null} input.scope
 * @param {boolean} input.checkoutTracked R5 found checkout pages
 * @param {Array<{dims: object, metrics: object}>} input.exitRows the F9 weekly exits
 * @returns {Promise<{rows: Array<{dims: object, metrics: object}>, templateCr: object[]}>}
 */
export async function templateStage(gateway, { brand, idsite, windows, rules, entries, scope, checkoutTracked, exitRows }) {
  /** @type {Array<{dims: object, metrics: object}>} */
  let rows = [];
  /** @type {object[]} */
  const templateCr = [];
  const tracked = trackedIds(scope);
  const weekly = await runQuery(gateway, templateWeeklyQuery(idsite, windows, rules, tracked));
  if (!weekly.error) {
    const interpreted = attachExitRates(interpretTemplateWeekly(weekly.rows), exitRows);
    rows.push(...interpreted);
    templateCr.push(...snapshotCr(brand, interpreted, windows));
  } else {
    rows.push({ dims: { query: 'H1' }, metrics: { error: weekly.error } });
  }
  for (const template of SCORE_TEMPLATES) {
    if (template === 'checkout' && !checkoutTracked) {
      rows.push(...interpretScorecard(template, [], []));
      continue;
    }
    const subset = entries.filter((e) => e.template === template);
    const pageIds = template === 'global' || template === 'cart_drawer' ? tracked : templateIds(scope, [template]);
    const query = elementScorecardQuery(idsite, template, windows, subset, rules, pageIds);
    const raw = query ? await runQuery(gateway, query) : { rows: [] };
    rows.push(...interpretScorecard(template, raw.error ? [] : raw.rows, subset));
  }
  const shaped = await runSet(gateway, templateAcquisitionQueries(idsite, windows, rules, entries, checkoutTracked, scope));
  const progress = shaped.filter((row) => row.dims.query === 'H1progress');
  const exits = shaped.filter((row) => row.dims.query === 'H1exit');
  const rest = shaped.filter((row) => row.dims.query !== 'H1progress' && row.dims.query !== 'H1exit');
  if (exits.length > 0) rows = attachExitRates(rows, exits);
  if (progress.length > 0) rows = attachProgression(rows, progress);
  rows.push(...rest, ...exits, ...progress);
  const k2 = (measure) => rows.filter((row) => row.dims.query === 'K2' && row.dims.measure === measure);
  const [k2snap, k2prior, k2yoy] = [k2('snapshot'), k2('prior'), k2('yoy')];
  if (k2snap.length > 0 && k2prior.length > 0 && k2yoy.length > 0) {
    rows.push(...compareCheckout(k2snap, k2prior, k2yoy));
  }
  return { rows, templateCr };
}

/**
 * @param {string} brand
 * @param {Array<{dims: object, metrics: object}>} rows
 * @param {{snapshotStart: string, snapshotEnd: string}} windows
 */
function snapshotCr(brand, rows, windows) {
  /** @type {Map<string, {sessions: number, buyers: number}>} */
  const cells = new Map();
  for (const row of rows) {
    if (row.dims.query !== 'H1') continue;
    const week = row.dims.week;
    if (!week || week < windows.snapshotStart || week > windows.snapshotEnd) continue;
    const key = `${row.dims.template}|${row.dims.device}`;
    const cell = cells.get(key) ?? { sessions: 0, buyers: 0 };
    cell.sessions += Number(row.metrics.sessions ?? 0);
    cell.buyers += Number(row.metrics.buyers ?? 0);
    cells.set(key, cell);
  }
  return [...cells.entries()].map(([key, cell]) => {
    const [template, device] = key.split('|');
    return {
      brand,
      template,
      device,
      sessions: cell.sessions,
      cr: cell.sessions > 0 ? (cell.buyers / cell.sessions) * 100 : 0,
    };
  });
}
