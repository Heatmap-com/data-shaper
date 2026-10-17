import { deepFreeze } from '../freeze.js';
import { SUBJECT_MEASURES } from './stats.js';

/**
 * Screen declarations and the layers that patch them.
 *
 * A screen is { id, label, purpose, subject, method, triage, propose,
 * pending, auto, scope, question, enabled, datasets? }. Every constant a
 * method or a triage reads is in `method.params` or `triage.params`; the
 * adapters' defaults fill what a declaration leaves out.
 *
 * A patch is the same object without `id` and `datasets`, holding only the
 * fields it changes. Objects merge key by key; anything else replaces.
 *
 * @typedef {'exclude' | 'include'} Disposition
 * @typedef {{kind: 'orders', measure?: string} | {kind: 'groups', by: string, measure?: string}} Subject
 * @typedef {Object} Screen
 * @property {string} id
 * @property {string} label
 * @property {string} purpose
 * @property {Subject} subject
 * @property {{adapter: string, params: Record<string, unknown>}} method
 * @property {{adapter: string, params: Record<string, unknown>}} triage
 * @property {Disposition} propose   what the engine suggests a person do
 * @property {Disposition} pending   what applies while a person has not answered
 * @property {Disposition} auto      what applies when triage does not ask
 * @property {'order' | 'session'} scope  what an exclusion drops
 * @property {string} question      the question for a person, with {{value}} names
 * @property {boolean} enabled
 * @property {Record<string, object>} [datasets] patches by dataset id, shipped screens only
 *
 * @typedef {{path: string, layer: string, value: unknown}} Provenance
 * @typedef {Screen & {layers: Provenance[]}} ResolvedScreen
 */

export const DISPOSITIONS = Object.freeze(['exclude', 'include']);
export const SUBJECT_KINDS = Object.freeze(['orders', 'groups']);
export const SCOPES = Object.freeze({ orders: Object.freeze(['order', 'session']), groups: Object.freeze(['session']) });

const ID = /^[a-z][a-z0-9_]*$/;
const SCREEN_KEYS = ['id', 'label', 'purpose', 'subject', 'method', 'triage', 'propose', 'pending', 'auto', 'scope', 'question', 'enabled', 'datasets'];
const PATCH_KEYS = SCREEN_KEYS.filter((key) => key !== 'id' && key !== 'datasets');
const SUBJECT_KEYS = ['kind', 'by', 'measure'];
const PART_KEYS = ['adapter', 'params'];

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/**
 * Checks a patch's shape, before it is applied. Throws naming `where`.
 * @param {unknown} patch
 * @param {string} where
 */
export function checkPatch(patch, where) {
  if (!isObject(patch)) throw new Error(`${where}: a patch is an object`);
  for (const key of Object.keys(patch)) if (!PATCH_KEYS.includes(key)) throw new Error(`${where}: unknown key "${key}" (${PATCH_KEYS.join(', ')})`);
  if (patch.subject !== undefined) {
    if (!isObject(patch.subject)) throw new Error(`${where}: subject is an object`);
    for (const key of Object.keys(patch.subject)) if (!SUBJECT_KEYS.includes(key)) throw new Error(`${where}: subject has unknown key "${key}"`);
  }
  for (const part of ['method', 'triage']) {
    if (patch[part] === undefined) continue;
    if (!isObject(patch[part])) throw new Error(`${where}: ${part} is { adapter?, params? }`);
    for (const key of Object.keys(patch[part])) if (!PART_KEYS.includes(key)) throw new Error(`${where}: ${part} has unknown key "${key}"`);
    if (patch[part].params !== undefined && !isObject(patch[part].params)) throw new Error(`${where}: ${part}.params is an object`);
  }
}

/**
 * Checks a whole screen: a shipped one, or one a site or request adds.
 * Adapter ids and parameters are checked by the registry, which knows the
 * adapters. Throws naming `where`.
 * @param {unknown} doc
 * @param {string} where
 * @returns {Screen}
 */
export function checkScreen(doc, where) {
  if (!isObject(doc)) throw new Error(`${where}: a screen is an object`);
  const name = typeof doc.id === 'string' ? doc.id : JSON.stringify(doc.id);
  const fail = (message) => {
    throw new Error(`${where}: screen ${name}: ${message}`);
  };
  for (const key of Object.keys(doc)) if (!SCREEN_KEYS.includes(key)) fail(`unknown key "${key}" (${SCREEN_KEYS.join(', ')})`);
  if (typeof doc.id !== 'string' || !ID.test(doc.id)) fail('id must match ^[a-z][a-z0-9_]*$');
  for (const key of ['label', 'purpose', 'question']) if (typeof doc[key] !== 'string' || !doc[key].trim()) fail(`${key} must be a non-empty string`);
  if (!isObject(doc.subject)) fail('subject is { kind, by?, measure? }');
  for (const key of Object.keys(doc.subject)) if (!SUBJECT_KEYS.includes(key)) fail(`subject has unknown key "${key}"`);
  const kind = doc.subject.kind;
  if (!SUBJECT_KINDS.includes(kind)) fail(`subject.kind must be one of ${SUBJECT_KINDS.join(', ')}`);
  if (kind === 'groups' && (typeof doc.subject.by !== 'string' || !doc.subject.by)) fail('a groups subject names the attribute it groups by in subject.by');
  if (kind === 'orders' && doc.subject.by !== undefined) fail('an orders subject is one row per order; it has no by');
  const measure = doc.subject.measure ?? SUBJECT_MEASURES[kind][0];
  if (!SUBJECT_MEASURES[kind].includes(measure)) fail(`subject.measure must be one of ${SUBJECT_MEASURES[kind].join(', ')} for ${kind}`);
  for (const part of ['method', 'triage']) {
    const value = doc[part];
    if (!isObject(value) || typeof value.adapter !== 'string' || !value.adapter) fail(`${part} is { adapter, params? }`);
    for (const key of Object.keys(value)) if (!PART_KEYS.includes(key)) fail(`${part} has unknown key "${key}"`);
    if (value.params !== undefined && !isObject(value.params)) fail(`${part}.params is an object`);
  }
  for (const key of ['propose', 'pending', 'auto']) if (!DISPOSITIONS.includes(doc[key])) fail(`${key} must be one of ${DISPOSITIONS.join(', ')}`);
  if (!SCOPES[kind].includes(doc.scope)) fail(`scope must be one of ${SCOPES[kind].join(', ')} for ${kind}`);
  if (doc.enabled !== undefined && typeof doc.enabled !== 'boolean') fail('enabled is true or false');
  if (doc.datasets !== undefined) {
    if (!isObject(doc.datasets)) fail('datasets maps dataset ids to patches');
    for (const [id, patch] of Object.entries(doc.datasets)) checkPatch(patch, `${where}: screen ${name}: datasets.${id}`);
  }
  return deepFreeze({
    id: doc.id,
    label: doc.label,
    purpose: doc.purpose,
    subject: kind === 'groups' ? { kind, by: doc.subject.by, measure } : { kind, measure },
    method: { adapter: doc.method.adapter, params: { ...(doc.method.params ?? {}) } },
    triage: { adapter: doc.triage.adapter, params: { ...(doc.triage.params ?? {}) } },
    propose: doc.propose,
    pending: doc.pending,
    auto: doc.auto,
    scope: doc.scope,
    question: doc.question,
    enabled: doc.enabled ?? true,
    ...(doc.datasets ? { datasets: structuredCopy(doc.datasets) } : {}),
  });
}

/**
 * Applies one patch to a screen, recording every field it sets.
 * @param {ResolvedScreen | Screen} screen
 * @param {object} patch
 * @param {string} layer   who set it, for the dataset's QUALITY.md
 * @returns {ResolvedScreen}
 */
export function applyPatch(screen, patch, layer) {
  const layers = [...(/** @type {ResolvedScreen} */ (screen).layers ?? [])];
  const merged = merge(withoutLayers(screen), patch, '', layer, layers);
  return { ...merged, layers };
}

function merge(base, patch, prefix, layer, layers) {
  const out = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const at = prefix ? `${prefix}.${key}` : key;
    if (isObject(value) && isObject(base[key])) {
      out[key] = merge(base[key], value, at, layer, layers);
      continue;
    }
    out[key] = isObject(value) ? structuredCopy(value) : value;
    layers.push({ path: at, layer, value });
  }
  return out;
}

function withoutLayers(screen) {
  const { layers: _layers, datasets: _datasets, ...rest } = /** @type {any} */ (screen);
  return structuredCopy(rest);
}

/**
 * The layers of one screen for one dataset, in the order they apply.
 * @param {Screen} shipped
 * @param {{dataset: string, site?: {slug: string, rules?: Record<string, object>, datasets?: Record<string, {rules?: Record<string, object>}>} | null,
 *   request?: Record<string, object> | null, decisions?: Array<{patch: object, layer: string}>}} context
 * @returns {ResolvedScreen}
 */
export function resolveScreen(shipped, { dataset, site = null, request = null, decisions = [] }) {
  let screen = applyPatch(shipped, {}, 'catalog');
  const steps = [
    [shipped.datasets?.[dataset], `catalog, dataset ${dataset}`],
    [site?.rules?.[shipped.id], site ? `sites/${site.slug}/quality.json` : ''],
    [site?.datasets?.[dataset]?.rules?.[shipped.id], site ? `sites/${site.slug}/quality.json, dataset ${dataset}` : ''],
    [request?.[shipped.id], `request ${dataset}`],
    ...decisions.map((entry) => [entry.patch, entry.layer]),
  ];
  for (const [patch, layer] of steps) if (patch) screen = applyPatch(screen, patch, layer);
  return screen;
}

function structuredCopy(value) {
  return JSON.parse(JSON.stringify(value));
}
