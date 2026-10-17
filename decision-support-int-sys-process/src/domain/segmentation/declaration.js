import { deepFreeze } from '../freeze.js';
import { checkCondition, fieldsOf, resolveLists } from './conditions.js';

/**
 * A declared segmentation: a closed list of values, each with the condition
 * that puts a visit in it, over the registered fields. The first rule that
 * matches wins, and a visit no rule matches takes the fallback, so the
 * values partition every set of visits.
 *
 * As written, a declaration has `rules`, or a `base` (a shipped channel
 * table) adjusted by `prepend`, `remove`, `append`, and `fallback`.
 *
 * @typedef {import('./conditions.js').Condition} Condition
 * @typedef {{value: string, when: Condition}} SegmentationRule
 * @typedef {{id: string, label: string, purpose: string, data: string, rules?: SegmentationRule[], base?: string,
 *   prepend?: SegmentationRule[], remove?: string[], append?: SegmentationRule[], fallback?: string}} Declaration
 * @typedef {{prepend?: SegmentationRule[], remove?: string[], append?: SegmentationRule[], fallback?: string}} Override
 * @typedef {{rules: ReadonlyArray<{channel: string, when: Condition}>, fallback: string}} BaseTable
 * @typedef {import('./conditions.js').Vocabulary & {bases: Readonly<Record<string, BaseTable>>}} Registry
 *
 * @typedef {Object} ResolvedSegmentation
 * @property {'declared'} kind
 * @property {string} id
 * @property {string} label
 * @property {string} purpose
 * @property {string} data
 * @property {SegmentationRule[]} rules     in order, with every "@list" replaced by its values
 * @property {string} fallback
 * @property {string[]} values              the rule values in first-appearance order, then the fallback
 * @property {string[]} fields              the fields the rules read
 * @property {string[]} needs               the shared CTEs those fields read
 */

export const MIN_VALUES = 2;
export const MAX_VALUES = 16;
const ID = /^[a-z][a-z0-9_]*$/;
const VALUE = /^[a-z0-9_]+$/;
const KEYS = new Set(['id', 'label', 'purpose', 'data', 'rules', 'base', 'prepend', 'remove', 'append', 'fallback']);
const OVERRIDE_KEYS = new Set(['prepend', 'remove', 'append', 'fallback']);

/**
 * Checks a declaration as written and returns it resolved. Throws on the
 * first problem, naming `where` and the segmentation.
 *
 * @param {Declaration} doc
 * @param {Registry} registry
 * @param {string} where a file name or site slug, for messages
 * @returns {Readonly<ResolvedSegmentation>}
 */
export function checkDeclaration(doc, registry, where) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error(`${where}: a segmentation is an object`);
  const name = typeof doc.id === 'string' ? doc.id : JSON.stringify(doc.id);
  const fail = (message) => {
    throw new Error(`${where}: segmentation ${name}: ${message}`);
  };
  if (typeof doc.id !== 'string' || !ID.test(doc.id) || doc.id === 'all') fail('id must match ^[a-z][a-z0-9_]*$ and is not "all"');
  for (const key of Object.keys(doc)) if (!KEYS.has(key)) fail(`unknown key "${key}"`);
  for (const key of ['label', 'purpose', 'data']) {
    if (typeof doc[key] !== 'string' || !doc[key].trim()) fail(`${key} must be a non-empty string`);
  }
  const hasRules = doc.rules !== undefined;
  const hasBase = doc.base !== undefined;
  if (hasRules === hasBase) fail('needs exactly one of rules or base');

  let rules;
  let fallback;
  if (hasBase) {
    const table = registry.bases[doc.base];
    if (!table) fail(`unknown base "${doc.base}" (${Object.keys(registry.bases).join(', ')})`);
    rules = table.rules.map((rule) => ({ value: rule.channel, when: rule.when }));
    fallback = table.fallback;
  } else {
    if (!Array.isArray(doc.rules)) fail('rules must be a list');
    for (const key of ['prepend', 'remove', 'append']) if (doc[key] !== undefined) fail(`${key} needs a base`);
    rules = doc.rules;
    fallback = doc.fallback;
  }
  const adjusted = adjust({ rules, fallback }, hasBase ? doc : {}, fail);
  return finish(doc, adjusted, registry, fail);
}

/**
 * A resolved segmentation with a site's changes applied and checked again:
 * `prepend` runs first, `remove` drops values' rules, `append` runs before
 * the fallback, and `fallback` renames it.
 *
 * @param {ResolvedSegmentation} seg
 * @param {Override} override
 * @param {Registry} registry
 * @param {string} where
 * @returns {Readonly<ResolvedSegmentation>}
 */
export function applyOverride(seg, override, registry, where) {
  const fail = (message) => {
    throw new Error(`${where}: override of ${seg.id}: ${message}`);
  };
  if (!override || typeof override !== 'object' || Array.isArray(override)) fail('an override is an object');
  for (const key of Object.keys(override)) if (!OVERRIDE_KEYS.has(key)) fail(`unknown key "${key}" (${[...OVERRIDE_KEYS].join(', ')})`);
  const adjusted = adjust({ rules: seg.rules, fallback: seg.fallback }, override, fail);
  return finish(seg, adjusted, registry, fail);
}

/** @param {{rules: SegmentationRule[], fallback?: string}} table @param {Override} change @param {(m: string) => never} fail */
function adjust(table, change, fail) {
  for (const key of ['prepend', 'append']) {
    if (change[key] !== undefined && !Array.isArray(change[key])) fail(`${key} must be a list of rules`);
  }
  if (change.remove !== undefined) {
    if (!Array.isArray(change.remove) || change.remove.some((value) => typeof value !== 'string')) fail('remove must be a list of values');
    const known = new Set(table.rules.map((rule) => rule.value));
    const unknown = change.remove.filter((value) => !known.has(value));
    if (unknown.length > 0) fail(`remove names values no rule has: ${unknown.join(', ')}`);
  }
  const removed = new Set(change.remove ?? []);
  return {
    rules: [...(change.prepend ?? []), ...table.rules.filter((rule) => !removed.has(rule.value)), ...(change.append ?? [])],
    fallback: change.fallback ?? table.fallback,
  };
}

/** @param {{id: string, label: string, purpose: string, data: string}} head @param {{rules: SegmentationRule[], fallback?: string}} table @param {Registry} registry @param {(m: string) => never} fail */
function finish(head, table, registry, fail) {
  if (typeof table.fallback !== 'string' || !VALUE.test(table.fallback) || table.fallback === 'all') {
    fail('fallback must be a value matching ^[a-z0-9_]+$ and is not "all"');
  }
  if (table.rules.length === 0) fail('needs at least one rule');
  /** @type {SegmentationRule[]} */
  const rules = [];
  for (const rule of table.rules) {
    if (!rule || typeof rule !== 'object' || Object.keys(rule).some((key) => key !== 'value' && key !== 'when')) {
      fail(`a rule is { value, when }, got ${JSON.stringify(rule)}`);
    }
    if (typeof rule.value !== 'string' || !VALUE.test(rule.value) || rule.value === 'all') {
      fail(`rule value ${JSON.stringify(rule.value)} must match ^[a-z0-9_]+$ and is not "all"`);
    }
    checkCondition(rule.when, registry, `${head.id} "${rule.value}"`);
    rules.push({ value: rule.value, when: resolveLists(rule.when, registry.lists) });
  }
  const values = [...new Set([...rules.map((rule) => rule.value), table.fallback])];
  if (values.length < MIN_VALUES || values.length > MAX_VALUES) {
    fail(`has ${values.length} values; a segmentation has ${MIN_VALUES} to ${MAX_VALUES}`);
  }
  const fields = [];
  for (const rule of rules) fieldsOf(rule.when, fields);
  const needs = [...new Set(fields.map((field) => registry.fields[field].needs).filter(Boolean))];
  return deepFreeze({
    kind: /** @type {'declared'} */ ('declared'),
    id: head.id,
    label: head.label,
    purpose: head.purpose,
    data: head.data,
    rules,
    fallback: table.fallback,
    values,
    fields,
    needs,
  });
}
