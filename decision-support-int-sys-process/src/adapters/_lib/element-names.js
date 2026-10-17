import { readFile } from 'node:fs/promises';
import { configuredDatabase } from '../query-gateway/clickhouse.js';

/**
 * Optional element-names.json (the landing-page naming file). The first
 * build does not require it; when the run's `elementNamesPath` names a file,
 * selector rows gain element_id/element_class on exact selector or alias
 * matches. No prefix matching, ever.
 */

let cache = null;
let cachePath = null;

/** @typedef {{selector: string, selector_aliases?: string[], element_id: string, element_class: string, name?: string}} NamedElement */

/**
 * @param {string | null | undefined} path
 * @returns {Promise<Map<string, {element: NamedElement, matched: string}>>}
 *   key: stored selector string (primary or alias)
 */
export async function loadElementNames(path) {
  if (!path) return new Map();
  if (cache && cachePath === path) return cache;
  const raw = JSON.parse(await readFile(path, 'utf8'));
  const sites = Array.isArray(raw) ? raw : (raw.sites ?? []);
  /** @type {Map<string, {element: NamedElement, matched: string}>} */
  const bySelector = new Map();
  for (const site of sites) {
    for (const el of site.elements ?? []) {
      const keys = [el.selector, ...(el.selector_aliases ?? [])].filter(Boolean);
      for (const key of keys) {
        if (!bySelector.has(key)) {
          bySelector.set(key, { element: el, matched: key });
        }
      }
    }
  }
  cache = bySelector;
  cachePath = path;
  return bySelector;
}

/** @param {string | null | undefined} selector @param {string | null | undefined} path */
export async function matchElement(selector, path) {
  if (!selector) return null;
  const map = await loadElementNames(path);
  return map.get(selector) ?? null;
}

/**
 * Names written by the capture consumer into ae_element_binding (schema 2).
 * A missing gateway, or a database without the schema-2 view yet (pre-rebuild
 * installations), returns an empty map. Any other query error is thrown.
 *
 * @param {import('../../ports/query-gateway.js').QueryGateway | null | undefined} gateway
 * @param {number} idsite
 * @param {number|string} idsitehsr
 */
export async function loadStoredNames(gateway, idsite, idsitehsr) {
  if (!gateway) return new Map();
  let rows;
  try {
    rows = await gateway.query(
      `SELECT selector, element_class, name
       FROM ${configuredDatabase()}.ae_element_binding_current
      WHERE idsite = {idsite:UInt32}
        AND idsitehsr = {idsitehsr:UInt64}`,
      { idsite, idsitehsr: Number(idsitehsr) },
      'element-binding',
    );
  } catch (err) {
    if (err && err.type === 'UNKNOWN_TABLE') return new Map();
    throw err;
  }
  /** @type {Map<string, NamedElement>} */
  const bySelector = new Map();
  for (const row of rows) {
    if (!row.selector || !row.element_class) continue;
    bySelector.set(String(row.selector), {
      selector: String(row.selector),
      element_id: `${idsite}:${row.element_class}:${row.selector}`,
      element_class: String(row.element_class),
      name: String(row.name ?? ''),
    });
  }
  return bySelector;
}

/**
 * Stored names win over the optional JSON file. Exact selector match only.
 *
 * @param {import('../../ports/dataset.js').RunContext} ctx
 * @param {{idsite: number, idsitehsr: number|string}} page
 */
export async function namesForPage(ctx, page) {
  const stored = await loadStoredNames(ctx.gateway, page.idsite, page.idsitehsr);
  return async function match(selector) {
    if (!selector) return null;
    const fromStore = stored.get(selector);
    if (fromStore) return { element: fromStore, matched: selector };
    return matchElement(selector, ctx.elementNamesPath);
  };
}
