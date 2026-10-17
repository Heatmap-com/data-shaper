import { deepFreeze } from '../freeze.js';

/**
 * Measures of a shaped dataset. Session measures come from the query and
 * are the same five every trend row carries. A source measure is
 * `<source>.<measure>`, summed over the source's rows. All of these add up
 * across disjoint rows, so a lookup, a rank's (other) row, and a rolling
 * sum are exact. A derived measure is a ratio of two additive ones,
 * computed after every sum, never summed itself.
 *
 * @typedef {{id: string, kind: 'session' | 'source' | 'derived', label: string, data: string,
 *   source?: string, measure?: string, ratio?: readonly [string, string], scale?: number}} Measure
 */

export const SESSION_MEASURES = deepFreeze({
  sessions: { label: 'Sessions', data: 'Kept sessions in the row: a visit\'s rows in one period, after the bot filter.' },
  buyers: { label: 'Buying sessions', data: 'Sessions in the row with at least one order.' },
  orders: { label: 'Orders', data: 'Distinct orders of the row\'s sessions, dated by the order\'s first day.' },
  revenue: { label: 'Revenue', data: 'Order revenue of the row\'s sessions, in the store currency.' },
  progressed: { label: 'Checkout sessions', data: 'Sessions in the row that started checkout.' },
});

export const SHIPPED_DERIVED = deepFreeze({
  conversion_rate: { label: 'Conversion rate', data: 'Buying sessions over sessions.', ratio: ['buyers', 'sessions'] },
  revenue_per_session: { label: 'Revenue per session', data: 'Revenue over sessions.', ratio: ['revenue', 'sessions'] },
  aov: { label: 'Average order value', data: 'Revenue over orders.', ratio: ['revenue', 'orders'] },
  checkout_rate: { label: 'Checkout rate', data: 'Checkout sessions over sessions.', ratio: ['progressed', 'sessions'] },
});

const ID = /^[a-z][a-z0-9_]*$/;
const SOURCE_MEASURE = /^([a-z][a-z0-9_]*)\.([a-z][a-z0-9_]*)$/;

/**
 * Resolves the measures a request names. A derived measure the request
 * declares is checked here; a name that is neither a session measure, a
 * measure of a known source kind, nor a derived one comes back in
 * `unknown`, because adding it is work for a person.
 *
 * @param {{measures: string[], derived: object[], rankBy?: string | null, floor?: Record<string, number>}} request
 * @param {ReadonlyMap<string, import('./sources.js').SourceKind>} kinds every known source kind
 * @returns {{measures: Measure[], output: string[], additive: string[], sources: string[], unknown: Array<{name: string, why: string}>, problems: string[]}}
 */
export function resolveMeasures(request, kinds) {
  const problems = [];
  const unknown = [];
  /** @type {Map<string, Measure>} */
  const derived = new Map(Object.entries(SHIPPED_DERIVED).map(([id, spec]) => [id, { id, kind: 'derived', ...spec, scale: 1 }]));
  for (const [i, doc] of request.derived.entries()) {
    const where = `derived[${i}]`;
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
      problems.push(`${where} must be { id, label, data, ratio: [numerator, denominator], scale? }`);
      continue;
    }
    const extra = Object.keys(doc).filter((key) => !['id', 'label', 'data', 'ratio', 'scale'].includes(key));
    if (extra.length > 0) problems.push(`${where} has unknown keys ${extra.join(', ')}`);
    if (typeof doc.id !== 'string' || !ID.test(doc.id)) problems.push(`${where}.id must match ^[a-z][a-z0-9_]*$`);
    else if (Object.hasOwn(SESSION_MEASURES, doc.id) || derived.has(doc.id)) problems.push(`${where}.id ${doc.id} is already a measure`);
    for (const key of ['label', 'data']) if (typeof doc[key] !== 'string' || !doc[key].trim()) problems.push(`${where}.${key} must be a non-empty string`);
    if (!Array.isArray(doc.ratio) || doc.ratio.length !== 2 || doc.ratio.some((part) => typeof part !== 'string')) problems.push(`${where}.ratio is [numerator, denominator]`);
    if (doc.scale !== undefined && (typeof doc.scale !== 'number' || !Number.isFinite(doc.scale) || doc.scale <= 0)) problems.push(`${where}.scale must be a positive number`);
    if (problems.length === 0) derived.set(doc.id, { id: doc.id, kind: 'derived', label: doc.label, data: doc.data, ratio: [doc.ratio[0], doc.ratio[1]], scale: doc.scale ?? 1 });
  }

  /** @type {Map<string, Measure>} */
  const resolved = new Map();
  const additiveOf = (name, owner) => {
    if (Object.hasOwn(SESSION_MEASURES, name)) return { id: name, kind: 'session', ...SESSION_MEASURES[name] };
    const match = SOURCE_MEASURE.exec(name);
    if (match) {
      const kind = kinds.get(match[1]);
      if (!kind) {
        unknown.push({ name, why: `no source kind "${match[1]}"${owner}` });
        return null;
      }
      const spec = kind.measures[match[2]];
      if (!spec) {
        unknown.push({ name, why: `source ${kind.id} reports no measure "${match[2]}" (${Object.keys(kind.measures).join(', ') || 'it is a lookup'})${owner}` });
        return null;
      }
      return { id: name, kind: 'source', source: kind.id, measure: match[2], label: spec.label, data: spec.data };
    }
    return undefined;
  };
  const add = (name, owner = '') => {
    if (resolved.has(name)) return true;
    const additive = additiveOf(name, owner);
    if (additive) {
      resolved.set(name, additive);
      return true;
    }
    if (additive === null) return false;
    const ratio = derived.get(name);
    if (!ratio) {
      unknown.push({ name, why: `not a session measure (${Object.keys(SESSION_MEASURES).join(', ')}), a source measure <source>.<measure>, or a derived measure${owner}` });
      return false;
    }
    let ok = true;
    for (const part of ratio.ratio) {
      const additive = additiveOf(part, ` in ${name}`);
      if (additive) resolved.set(part, resolved.get(part) ?? additive);
      else {
        if (additive === undefined) problems.push(`derived ${name}: ${part} is not an additive measure; a ratio divides session or source measures`);
        ok = false;
      }
    }
    if (ok) resolved.set(name, ratio);
    return ok;
  };
  for (const name of request.measures) add(name);
  if (request.rankBy) add(request.rankBy, ' (rank.by)');
  for (const name of Object.keys(request.floor ?? {})) {
    if (add(name, ' (floor)') && resolved.get(name)?.kind === 'derived') problems.push(`floor ${name}: a floor reads an additive measure`);
  }
  const measures = [...resolved.values()];
  return {
    measures,
    output: request.measures.filter((name) => resolved.has(name)),
    additive: measures.filter((m) => m.kind !== 'derived').map((m) => m.id),
    sources: [...new Set(measures.filter((m) => m.kind === 'source').map((m) => m.source))],
    unknown,
    problems,
  };
}
