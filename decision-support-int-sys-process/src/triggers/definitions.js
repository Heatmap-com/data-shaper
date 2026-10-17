import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { canonical } from '../domain/canonical.js';

const file = fileURLToPath(new URL('./defaults.json', import.meta.url));

/** @typedef {{ key: string, name: string, level: 'session' | 'visitor', version: number, active: boolean, predicate: object }} TriggerDefinition */

/** Shipped thresholds. Evaluators read these fields; they do not embed the numbers. */
export const DEFAULT_TRIGGERS = /** @type {TriggerDefinition[]} */ (JSON.parse(readFileSync(file, 'utf8')));

export { canonical };

/**
 * Site overrides patch predicate fields. An unchanged predicate keeps its
 * version. A changed predicate bumps the version recorded on the previous
 * write, or the shipped version when nothing has been stored yet.
 *
 * Super-Shopper also stamps the predicates it names (`interest_trigger`,
 * `purchase_trigger`). A change to Showed Interest changes who qualifies,
 * so Super-Shopper's version moves with it.
 *
 * @param {Record<string, object>} [overrides] predicate patches keyed by trigger key
 * @param {TriggerDefinition[]} [recorded] versions already stored
 * @returns {TriggerDefinition[]}
 */
export function resolveDefinitions(overrides = {}, recorded = []) {
  const drafted = DEFAULT_TRIGGERS.map((def) => applyPatch(def, overrides[def.key]));
  const known = new Set(drafted.map((row) => row.key));
  for (const [key, patch] of Object.entries(overrides)) {
    if (known.has(key)) continue;
    drafted.push(definitionFromOverride(key, patch));
    known.add(key);
  }
  for (const row of recorded) {
    if (known.has(row.key)) continue;
    drafted.push({
      key: row.key,
      name: row.name,
      level: row.level,
      version: row.version ?? 1,
      active: row.active !== false && row.active !== 0,
      predicate: row.predicate,
    });
    known.add(row.key);
  }
  const byKey = new Map(drafted.map((row) => [row.key, row]));
  const shipped = new Map(DEFAULT_TRIGGERS.map((row) => [row.key, row]));
  const recordedByKey = new Map(recorded.map((row) => [row.key, row]));
  for (const row of drafted) {
    const stamp = stampOf(row, byKey);
    const prev = recordedByKey.get(row.key);
    if (prev && stampOf(prev, recordedByKey) === stamp) {
      row.version = prev.version;
      continue;
    }
    const base = shipped.get(row.key);
    if (base && stamp === stampOf(base, shipped)) {
      row.version = base.version;
      continue;
    }
    if (prev) row.version = prev.version + 1;
    else if (base) row.version = base.version + 1;
    else row.version = row.version ?? 1;
  }
  return drafted.filter((row) => row.active);
}

/**
 * @param {TriggerDefinition} def
 * @param {object} [patch] predicate fields, or a full definition when `predicate` is an object
 */
function applyPatch(def, patch) {
  if (!patch) return { ...def, predicate: { ...def.predicate } };
  if (patch.predicate && typeof patch.predicate === 'object') {
    return {
      ...def,
      name: patch.name ?? def.name,
      level: patch.level ?? def.level,
      active: patch.active == null ? def.active : Boolean(patch.active),
      predicate: { ...def.predicate, ...patch.predicate },
    };
  }
  const next = { ...patch };
  const active = next.active == null ? def.active : Boolean(next.active);
  delete next.active;
  return { ...def, active, predicate: { ...def.predicate, ...next } };
}

/**
 * A trigger that is not shipped. Config must name it and give it a predicate
 * of a type the evaluator already knows.
 * @param {string} key
 * @param {object} patch
 * @returns {TriggerDefinition}
 */
function definitionFromOverride(key, patch) {
  if (!patch || typeof patch.predicate !== 'object' || !patch.name || !patch.level) {
    throw new Error(`trigger "${key}" needs a name, level, and predicate to be added from config`);
  }
  return {
    key,
    name: patch.name,
    level: patch.level,
    version: patch.version ?? 1,
    active: patch.active == null ? true : Boolean(patch.active),
    predicate: patch.predicate,
  };
}

/**
 * @param {TriggerDefinition} row
 * @param {Map<string, TriggerDefinition>} byKey
 */
function stampOf(row, byKey) {
  /** @type {object} */
  const stamp = { predicate: row.predicate };
  for (const ref of ['interest_trigger', 'purchase_trigger']) {
    const key = row.predicate?.[ref];
    if (typeof key === 'string' && byKey.get(key)) stamp[ref] = byKey.get(key).predicate;
  }
  return canonical(stamp);
}

/** @param {Record<string, object>} [overrides] */
export function listTriggers(overrides = {}) {
  return resolveDefinitions(overrides).map(publicTrigger);
}

/** @param {string} key @param {Record<string, object>} [overrides] */
export function getTrigger(key, overrides = {}) {
  const found = resolveDefinitions(overrides).find((row) => row.key === key);
  if (!found) throw new Error(`unknown trigger "${key}"`);
  return publicTrigger(found);
}

/** @param {TriggerDefinition} row */
function publicTrigger(row) {
  return {
    key: row.key,
    name: row.name,
    level: row.level,
    version: row.version,
    active: row.active,
    predicate: row.predicate,
  };
}
