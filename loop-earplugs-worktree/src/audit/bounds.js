/**
 * Fact-table bounds for the Roswell reader.
 *
 * log_hsr and log_hsr_event are ordered by (idsite, idsitehsr, …, server_date).
 * A date predicate without idsitehsr still walks every page on the site.
 * idsitehsr IN is applied when the classified page set is small enough to
 * prune. Larger sets stay on idsite + server_date and are split by week,
 * because splitting sessions across page batches would double-count visits.
 */

import { queryBoundGaps } from '../governance/query-bounds.js';
import { addDays, daysInclusive } from './windows.js';

/** Commerce templates the audit names. Unclassified URLs stay out of the IN list. */
export const COMMERCE_TEMPLATES = ['home', 'plp', 'pdp', 'cart_page', 'checkout', 'search'];

/**
 * Above this, an IN list no longer prunes and session metrics cannot be
 * batched by page. The query keeps idsite + server_date and is week-chunked.
 */
export const HSR_IN_LIMIT = 3000;

/**
 * @param {{byTemplate?: Record<string, number[]>}|null|undefined} scope
 * @param {string[]} templates
 * @returns {number[]|null} null when the scope was not loaded
 */
export function templateIds(scope, templates) {
  if (!scope?.byTemplate) return null;
  /** @type {number[]} */
  const out = [];
  for (const template of templates) {
    for (const id of scope.byTemplate[template] ?? []) {
      const n = Number(id);
      if (Number.isInteger(n) && n > 0) out.push(n);
    }
  }
  return [...new Set(out)];
}

/** @param {{byTemplate?: Record<string, number[]>}|null|undefined} scope */
export function trackedIds(scope) {
  return templateIds(scope, COMMERCE_TEMPLATES);
}

/**
 * Page ids a click class can occur on. Cart and global chrome are collected
 * on the six named experiences, so those classes use the tracked union.
 * @param {{byTemplate?: Record<string, number[]>}|null|undefined} scope
 * @param {string[]} classes
 */
export function hsrForClasses(scope, classes) {
  if (!scope) return null;
  /** @type {Set<string>} */
  const templates = new Set();
  let tracked = false;
  for (const elementClass of classes) {
    const prefix = String(elementClass).split('.')[0];
    if (prefix === 'home' || prefix === 'plp' || prefix === 'pdp' || prefix === 'checkout') templates.add(prefix);
    else tracked = true;
  }
  if (tracked) return trackedIds(scope);
  return templateIds(scope, [...templates]);
}

/**
 * @param {string} start inclusive
 * @param {string} end inclusive
 * @param {number} days
 * @returns {Array<{start: string, end: string}>}
 */
export function weekChunks(start, end, days) {
  if (!start || !end || !(days > 0) || start > end) return [{ start, end }];
  /** @type {Array<{start: string, end: string}>} */
  const out = [];
  let cursor = start;
  while (cursor <= end) {
    const chunkEnd = addDays(cursor, days - 1);
    const bounded = chunkEnd < end ? chunkEnd : end;
    out.push({ start: cursor, end: bounded });
    cursor = addDays(bounded, 1);
  }
  return out;
}

/**
 * Weekly (or daily) aggregates can be concatenated across chunks.
 * Snapshot totals and LIMIT queries cannot.
 * Page scans use 28-day chunks. Visit and journey scans use 91-day chunks.
 * @param {string} sql
 * @param {{start?: string, end?: string}} [params]
 */
export function chunkDaysFor(sql, params = {}) {
  if (!params.start || !params.end) return 0;
  if (daysInclusive(params.start, params.end) <= 28) return 0;
  if (/\bLIMIT\b/i.test(sql)) return 0;
  const weekly = /toStartOfWeek\s*\(/i.test(sql) || /toString\s*\(\s*(?:\w+\.)?server_date\s*\)/i.test(sql);
  if (!weekly) return 0;
  const scansPages = /log_hsr\b|log_hsr_event|session_tags|partner_tags|udp_am_/i.test(sql);
  return scansPages ? 28 : 91;
}

/**
 * Missing idsite / date predicates on fact-table aliases.
 * idsitehsr is required only when the caller knows the page.
 * @param {string} sql
 * @param {{ idsitehsr?: boolean }} [opts]
 */
export function boundGaps(sql, opts) {
  return queryBoundGaps(sql, opts);
}
