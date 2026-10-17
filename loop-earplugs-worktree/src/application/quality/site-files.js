import { checkDecisions } from '../../domain/quality/decisions.js';
import { checkPatch, checkScreen } from '../../domain/quality/screens.js';

/**
 * One site's `quality.json`:
 *
 *   { idsite,
 *     rules:    { <screen id>: patch },          every dataset of the site
 *     add:      [ screen ],                       screens of the site's own
 *     datasets: { <dataset id>: { rules: { <screen id>: patch }, add: [ screen ] } } }
 *
 * @typedef {{slug: string, idsite: number, rules: Record<string, object>, add: import('../../domain/quality/screens.js').Screen[],
 *   datasets: Record<string, {rules: Record<string, object>, add: import('../../domain/quality/screens.js').Screen[]}>}} SiteQualitySpec
 *
 * @param {unknown} doc
 * @param {string} slug
 * @param {string} where
 * @returns {SiteQualitySpec}
 */
export function siteQualitySpec(doc, slug, where) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error(`${where}: must be an object`);
  const d = /** @type {Record<string, any>} */ (doc);
  for (const key of Object.keys(d)) if (!['idsite', 'rules', 'add', 'datasets'].includes(key)) throw new Error(`${where}: unknown key "${key}" (idsite, rules, add, datasets)`);
  if (!Number.isInteger(d.idsite) || d.idsite <= 0) throw new Error(`${where}: idsite must be a positive integer`);
  const block = (value, at) => {
    if (value === undefined) return { rules: {}, add: [] };
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${at}: must be { rules?, add? }`);
    for (const key of Object.keys(value)) if (key !== 'rules' && key !== 'add') throw new Error(`${at}: unknown key "${key}" (rules, add)`);
    return { rules: rulesOf(value.rules, `${at}: rules`), add: addOf(value.add, `${at}: add`) };
  };
  const top = block({ rules: d.rules, add: d.add }, where);
  const datasets = {};
  if (d.datasets !== undefined) {
    if (!d.datasets || typeof d.datasets !== 'object' || Array.isArray(d.datasets)) throw new Error(`${where}: datasets maps dataset ids to { rules?, add? }`);
    for (const [id, value] of Object.entries(d.datasets)) datasets[id] = block(value, `${where}: datasets.${id}`);
  }
  return { slug, idsite: d.idsite, rules: top.rules, add: top.add, datasets };
}

/**
 * A request's `quality` block: `{ off?, rules?, add? }`.
 * @param {unknown} value
 * @param {string} where
 * @returns {{off: boolean, rules: Record<string, object>, add: import('../../domain/quality/screens.js').Screen[]}}
 */
export function requestQualitySpec(value, where) {
  if (value === undefined || value === null) return { off: false, rules: {}, add: [] };
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error(`${where}: is { off?, rules?, add? }`);
  const v = /** @type {Record<string, any>} */ (value);
  for (const key of Object.keys(v)) if (!['off', 'rules', 'add'].includes(key)) throw new Error(`${where}: unknown key "${key}" (off, rules, add)`);
  if (v.off !== undefined && typeof v.off !== 'boolean') throw new Error(`${where}: off is true or false`);
  return { off: v.off ?? false, rules: rulesOf(v.rules, `${where}: rules`), add: addOf(v.add, `${where}: add`) };
}

/**
 * One site's `quality-decisions.json`.
 * @param {unknown} doc @param {string} slug @param {string} where
 */
export function siteDecisionsSpec(doc, slug, where) {
  return { slug, ...checkDecisions(doc, where) };
}

function rulesOf(value, where) {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${where}: maps screen ids to patches`);
  for (const [id, patch] of Object.entries(value)) checkPatch(patch, `${where}.${id}`);
  return { ...value };
}

function addOf(value, where) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${where}: is a list of screens`);
  return value.map((doc, i) => checkScreen(doc, `${where}[${i}]`));
}
