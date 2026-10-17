/**
 * Rows from the audit acquisition queries, shaped for the findings store.
 * A few queries fan out into several query ids, and K2 is compared across
 * the snapshot, prior, and year-ago windows.
 */

import { fanOutByTemplate, interpretAcquisition } from './interpret.js';
import { round4, twoProportionZ } from './stats.js';

const SCROLL_QUERY = { home: 'H2', plp: 'L2', pdp: 'P2', cart_page: 'C2' };

const HISTOGRAM_QUERY = { home: 'H3', plp: 'L3', pdp: 'P3', cart_page: 'C3' };

const ELEMENT_TREND_QUERY = { home: 'H5', plp: 'L5', pdp: 'P5', cart_page: 'C5', cart_drawer: 'C5', global: 'G2' };

/**
 * @param {string} id
 * @param {object[]} rows
 */
export function shapeAcquisition(id, rows) {
  const interpreted = interpretAcquisition(id, rows);
  if (id === 'H2') return fanOutByTemplate(interpreted, SCROLL_QUERY);
  if (id === 'H3') {
    const main = fanOutByTemplate(interpreted, HISTOGRAM_QUERY);
    const depth = fanOutByTemplate(interpreted, { plp: 'L8' });
    return [...main, ...depth];
  }
  if (id === 'H5') return fanOutByTemplate(interpreted, ELEMENT_TREND_QUERY);
  if (id === 'H8') {
    const mobileAtc = interpreted
      .filter((row) => row.dims.element_class === 'pdp.add_to_cart' && row.dims.device === 'Mobile')
      .map((row) => ({ dims: { ...row.dims, query: 'P10' }, metrics: { ...row.metrics } }));
    return [...interpreted, ...mobileAtc];
  }
  if (id === 'K2' || id === 'K2prior' || id === 'K2yoy') {
    const measure = id === 'K2' ? 'snapshot' : id === 'K2prior' ? 'prior' : 'yoy';
    return interpreted.map((row) => ({ dims: { ...row.dims, query: 'K2', measure }, metrics: row.metrics }));
  }
  return interpreted;
}

/**
 * K2 z-test of checkout completion, snapshot against the prior window and last year.
 * @param {object[]} snapshot
 * @param {object[]} prior
 * @param {object[]} yoy
 */
export function compareCheckout(snapshot, prior, yoy) {
  const snap = sumCheckout(snapshot);
  const prev = sumCheckout(prior);
  const year = sumCheckout(yoy);
  const againstPrior = twoProportionZ(snap.completed, snap.started, prev.completed, prev.started);
  const againstYear = twoProportionZ(snap.completed, snap.started, year.completed, year.started);
  return [{
    dims: { query: 'K2', measure: 'compare' },
    metrics: {
      started: snap.started,
      completed: snap.completed,
      rate: snap.started > 0 ? round4(snap.completed / snap.started) : null,
      z_prior: againstPrior.z == null ? null : round4(againstPrior.z),
      significant_prior: againstPrior.significant,
      z_yoy: againstYear.z == null ? null : round4(againstYear.z),
      significant_yoy: againstYear.significant,
    },
  }];
}

/** @param {object[]} rows */
function sumCheckout(rows) {
  return rows.reduce((tot, row) => ({
    started: tot.started + num(row.started ?? row.metrics?.started),
    completed: tot.completed + num(row.completed ?? row.metrics?.completed),
  }), { started: 0, completed: 0 });
}

/** @param {unknown} value */
function num(value) {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}
