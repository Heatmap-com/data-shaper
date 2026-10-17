/** Device, referer, and naming maps from the measurement contract. */

const DEVICES = { 1: 'desktop', 2: 'tablet', 3: 'mobile' };
const REFERERS = { 1: 'direct', 2: 'search', 3: 'website', 6: 'campaign', 7: 'social' };

/** @param {number} n */
export function deviceName(n) {
  return DEVICES[n] ?? `device_${n}`;
}

/** @param {number} n */
export function refererName(n) {
  return REFERERS[n] ?? `referer_${n}`;
}

/** @param {number} n */
export function returningName(n) {
  return n === 1 ? 'returning' : 'new';
}

/**
 * Bots never reach orders after the safety rule, but the check is explicit in
 * the data plan's reconciliation: orders on exclude_confirmed sessions are 0.
 */
export const BOT_FILTERS = /** @type {const} */ (['none', 'exclude_confirmed']);
