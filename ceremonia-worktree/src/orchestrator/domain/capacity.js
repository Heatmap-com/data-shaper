/**
 * A governor capacity is a number (shared by every machine on the store) or
 * `{ limit, scope }`, where scope `machine` gives each host its own slots and
 * `cluster` shares them.
 *
 * @typedef {number | {limit: number, scope?: 'machine'|'cluster'}} CapacityEntry
 * @typedef {{limit: number, scope: 'machine'|'cluster'}} Capacity
 */

export const SCOPES = Object.freeze(['machine', 'cluster']);

/** @param {CapacityEntry|undefined} entry @returns {Capacity} */
export function capacityOf(entry) {
  if (typeof entry === 'number') return { limit: entry, scope: 'cluster' };
  if (entry && typeof entry === 'object') return { limit: entry.limit, scope: entry.scope ?? 'cluster' };
  return { limit: 0, scope: 'cluster' };
}

/** The lease key: machine-scoped resources get one key per host. */
export function resourceKey(name, { scope }, host) {
  return scope === 'machine' ? `${name}@${host}` : name;
}

/** Why an entry cannot be leased, or null when it can. */
export function capacityProblem(entry) {
  if (entry === undefined) return 'has no capacity';
  const { limit, scope } = capacityOf(entry);
  if (!Number.isInteger(limit) || limit < 1) return `needs a whole-number limit of at least 1, got ${JSON.stringify(entry)}`;
  if (!SCOPES.includes(scope)) return `has scope "${scope}"; use ${SCOPES.join(' or ')}`;
  return null;
}
