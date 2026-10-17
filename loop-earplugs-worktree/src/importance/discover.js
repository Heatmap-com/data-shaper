import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverAdapters } from '../discover.js';
import { strategies } from './strategies.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Default folder of importance descriptors. */
export const IMPORTANCE_DIR = path.join(HERE, '../adapters/importance');

const KINDS = new Set(['button', 'link']);

/**
 * Load importance descriptors and sort them by priority, then id.
 * A descriptor is declarative: every field is JSON data, and `strategy`
 * names a registered interpreter.
 *
 * @param {string} [dir]
 * @returns {Promise<import('../ports/importance.js').ImportanceDescriptor[]>}
 */
export async function discoverImportance(dir = IMPORTANCE_DIR) {
  const found = await discoverAdapters(dir);
  for (const adapter of found) assertDescriptor(adapter);
  return found.sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
}

/** @param {import('../ports/importance.js').ImportanceDescriptor} adapter */
export function assertDescriptor(adapter) {
  const id = adapter?.id ?? '(missing id)';
  if (hasFunction(adapter)) {
    throw new Error(`importance adapter "${id}" must be declarative data; it exports a function`);
  }
  if (!Number.isInteger(adapter.priority)) {
    throw new Error(`importance adapter "${id}" is missing an integer priority`);
  }
  if (typeof adapter.strategy !== 'string' || adapter.strategy.length === 0) {
    throw new Error(`importance adapter "${id}" is missing a strategy`);
  }
  if (!Object.hasOwn(strategies, adapter.strategy)) {
    throw new Error(
      `importance adapter "${id}" uses unknown strategy "${adapter.strategy}"; known: ${Object.keys(strategies).join(', ')}`,
    );
  }
  if (adapter.strategy === 'match') assertMatchRules(adapter);
}

/** @param {import('../ports/importance.js').ImportanceDescriptor} adapter */
function assertMatchRules(adapter) {
  if (!Array.isArray(adapter.select) || adapter.select.length === 0) {
    throw new Error(`importance adapter "${adapter.id}" strategy "match" needs a select list`);
  }
  for (const rule of adapter.select) {
    if (!rule || typeof rule !== 'object') {
      throw new Error(`importance adapter "${adapter.id}" has a select rule that is not an object`);
    }
    if (!KINDS.has(rule.kind)) {
      throw new Error(`importance adapter "${adapter.id}" has a select rule with kind "${rule.kind}"`);
    }
    if (!rule.tag && !rule.role && !rule.type) {
      throw new Error(`importance adapter "${adapter.id}" has a select rule with no tag, role, or type`);
    }
  }
}

/** @param {unknown} value @param {WeakSet<object>} [seen] */
function hasFunction(value, seen = new WeakSet()) {
  if (typeof value === 'function') return true;
  if (!value || typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  return Object.values(value).some((item) => hasFunction(item, seen));
}
