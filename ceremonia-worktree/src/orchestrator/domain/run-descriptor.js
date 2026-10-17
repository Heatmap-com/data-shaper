import { deepMerge } from './deep-merge.js';
import { DescriptorError } from './errors.js';

/**
 * @typedef {Object} RunEntry
 * @property {string} id
 * @property {string} use stage library id
 * @property {boolean} enabled
 *
 * @typedef {Object} ResolvedRun
 * @property {string} id
 * @property {string} [description]
 * @property {object} defaults
 * @property {object|null} pages
 * @property {object[]} stages resolved stage descriptors, in order, each with `id` and `use`
 */

const LIST_KEYS = new Set(['extends', 'stages', 'patch', 'remove', 'insert']);

export function normalizeEntry(entry) {
  const value = typeof entry === 'string' ? { use: entry } : { ...entry };
  if (typeof value.use !== 'string' || !value.use) throw new DescriptorError(`run stage entry needs "use": ${JSON.stringify(entry)}`);
  value.id ??= value.use;
  value.enabled ??= true;
  return value;
}

/** One override layer over the run built so far. Layers apply root first. */
export function applyRunLayer(base, layer, source) {
  const rest = Object.fromEntries(Object.entries(layer).filter(([key]) => !LIST_KEYS.has(key)));
  const run = deepMerge(base, rest);
  let list = layer.stages ? layer.stages.map(normalizeEntry) : (base.stages ?? []).map((entry) => ({ ...entry }));

  for (const id of layer.remove ?? []) {
    if (!list.some((entry) => entry.id === id)) throw new DescriptorError(`${source}: remove names no stage "${id}"`);
    list = list.filter((entry) => entry.id !== id);
  }
  for (const [id, change] of Object.entries(layer.patch ?? {})) {
    const index = list.findIndex((entry) => entry.id === id);
    if (index === -1) throw new DescriptorError(`${source}: patch names no stage "${id}"`);
    list[index] = { ...deepMerge(list[index], change), id: list[index].id, use: list[index].use };
  }
  for (const insertion of layer.insert ?? []) {
    const anchor = insertion.after ?? insertion.before;
    const index = list.findIndex((entry) => entry.id === anchor);
    if (index === -1) throw new DescriptorError(`${source}: insert anchor "${anchor}" is not in the run`);
    list.splice(insertion.after ? index + 1 : index, 0, normalizeEntry(insertion.stage));
  }
  const seen = new Set();
  for (const entry of list) {
    if (seen.has(entry.id)) throw new DescriptorError(`${source}: stage id "${entry.id}" appears twice`);
    seen.add(entry.id);
  }
  run.stages = list;
  return run;
}

/** Library descriptor under the run entry's overrides. */
export function resolveStage(library, entry) {
  const { id, use, enabled, ...override } = entry;
  return { ...deepMerge(library, override), id, use };
}

export function parseRunRef(ref) {
  const match = /^(?:(general|site):)?([a-z0-9][a-z0-9-]*)$/.exec(ref ?? '');
  if (!match) throw new DescriptorError(`run reference "${ref}" must be name, general:name, site:name, or a .json path`);
  return { scope: match[1] ?? 'auto', name: match[2] };
}
