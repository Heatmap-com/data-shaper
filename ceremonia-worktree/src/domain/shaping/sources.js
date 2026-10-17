import { deepFreeze } from '../freeze.js';
import { isIsoDay } from './dates.js';

/**
 * Source kinds: the contract of an external dataset, apart from how its
 * rows are fetched. A kind is `facts` (dated rows of additive measures,
 * such as ad spend by day and campaign) or `lookup` (attributes of a key,
 * such as the product type of a URL path).
 *
 * A fact kind maps some of its columns onto attributes, its `keys`. Its
 * measures can be split by those attributes, and by lookups over them,
 * and by nothing else: ad spend has no new and returning visitors. A
 * lookup kind maps one column onto one attribute, its `key`, and gives
 * each of its `attributes` to the sessions whose attribute value matches.
 *
 * A key mapping turns the source's value into the attribute's: `transform`
 * steps in order, then `map` for values the two spell differently, such as
 * GA4's "(direct)" for the empty source of a direct session.
 *
 * @typedef {'date' | 'string' | 'number'} ColumnType
 * @typedef {{column: string, attribute: string, transform: readonly ('trim' | 'lower')[], map: Readonly<Record<string, string>>}} KeyMapping
 * @typedef {Object} SourceKind
 * @property {string} id
 * @property {string} label
 * @property {string} purpose
 * @property {string} data
 * @property {'facts' | 'lookup'} role
 * @property {'day' | null} grain           facts: the date resolution of the rows
 * @property {Readonly<Record<string, ColumnType>>} columns
 * @property {readonly KeyMapping[]} keys   facts
 * @property {Readonly<Record<string, {label: string, data: string}>>} measures   facts: summed over rows
 * @property {KeyMapping | null} key        lookup
 * @property {Readonly<Record<string, {label: string, data: string}>>} attributes lookup
 * @property {string} fallback              lookup: the value of a session the lookup does not match
 */

const ID = /^[a-z][a-z0-9_]*$/;
const TYPES = ['date', 'string', 'number'];
const STEPS = ['trim', 'lower'];
const COMMON = ['id', 'label', 'purpose', 'data', 'role', 'columns'];
const ROLE_KEYS = { facts: ['grain', 'keys', 'measures'], lookup: ['key', 'attributes', 'fallback'] };

/**
 * Checks a source kind and returns it resolved. Throws on the first problem.
 * @param {object} doc
 * @param {string} where
 * @returns {Readonly<SourceKind>}
 */
export function checkSourceKind(doc, where) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error(`${where}: a source kind is an object`);
  const fail = (message) => {
    throw new Error(`${where}: source ${typeof doc.id === 'string' ? doc.id : '?'}: ${message}`);
  };
  if (typeof doc.id !== 'string' || !ID.test(doc.id)) fail('id must match ^[a-z][a-z0-9_]*$');
  if (!Object.hasOwn(ROLE_KEYS, doc.role)) fail('role must be facts or lookup');
  const allowed = new Set([...COMMON, ...ROLE_KEYS[doc.role]]);
  for (const key of Object.keys(doc)) if (!allowed.has(key)) fail(`unknown key "${key}" for a ${doc.role} source`);
  for (const key of ['label', 'purpose', 'data']) if (typeof doc[key] !== 'string' || !doc[key].trim()) fail(`${key} must be a non-empty string`);
  if (!doc.columns || typeof doc.columns !== 'object' || Array.isArray(doc.columns)) fail('columns must name each column and its type');
  for (const [name, type] of Object.entries(doc.columns)) {
    if (!ID.test(name)) fail(`column ${JSON.stringify(name)} must match ^[a-z][a-z0-9_]*$`);
    if (!TYPES.includes(type)) fail(`column ${name} has type ${JSON.stringify(type)}; expected ${TYPES.join(', ')}`);
  }
  const head = { id: doc.id, label: doc.label, purpose: doc.purpose, data: doc.data, role: doc.role, columns: { ...doc.columns } };
  const described = (entries, type, what) => {
    if (!entries || typeof entries !== 'object' || Array.isArray(entries) || Object.keys(entries).length === 0) fail(`${what} must name at least one column`);
    for (const [name, text] of Object.entries(entries)) {
      if (doc.columns[name] !== type) fail(`${what}.${name} must be a ${type} column`);
      if (!text || typeof text.label !== 'string' || !text.label || typeof text.data !== 'string' || !text.data) fail(`${what}.${name} needs a label and data`);
    }
    return Object.fromEntries(Object.entries(entries).map(([name, text]) => [name, { label: text.label, data: text.data }]));
  };

  if (doc.role === 'facts') {
    if (doc.grain !== 'day') fail('grain must be day');
    if (doc.columns.date !== 'date') fail('a facts source has a date column of type date');
    if (!Array.isArray(doc.keys)) fail('keys must be a list of key mappings');
    const keys = doc.keys.map((entry, i) => keyMapping(entry, doc.columns, `keys[${i}]`, fail));
    if (new Set(keys.map((key) => key.attribute)).size !== keys.length) fail('two keys map onto one attribute');
    return deepFreeze({ ...head, grain: 'day', keys, measures: described(doc.measures, 'number', 'measures'), key: null, attributes: {}, fallback: '' });
  }
  const fallback = doc.fallback ?? '(unmatched)';
  if (typeof fallback !== 'string' || !fallback) fail('fallback must be a non-empty string');
  return deepFreeze({
    ...head,
    grain: null,
    keys: [],
    measures: {},
    key: keyMapping(doc.key, doc.columns, 'key', fail),
    attributes: described(doc.attributes, 'string', 'attributes'),
    fallback,
  });
}

/** @returns {KeyMapping} */
function keyMapping(entry, columns, what, fail) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail(`${what} must be { column, attribute, transform?, map? }`);
  for (const key of Object.keys(entry)) if (!['column', 'attribute', 'transform', 'map'].includes(key)) fail(`${what} has unknown key "${key}"`);
  if (columns[entry.column] !== 'string') fail(`${what}.column must be a string column`);
  if (typeof entry.attribute !== 'string' || !ID.test(entry.attribute)) fail(`${what}.attribute must name an attribute`);
  const transform = entry.transform ?? [];
  if (!Array.isArray(transform) || transform.some((step) => !STEPS.includes(step))) fail(`${what}.transform must be steps from ${STEPS.join(', ')}`);
  const map = entry.map ?? {};
  if (!map || typeof map !== 'object' || Array.isArray(map) || Object.values(map).some((value) => typeof value !== 'string')) fail(`${what}.map must map strings to strings`);
  return { column: entry.column, attribute: entry.attribute, transform: [...transform], map: { ...map } };
}

/**
 * The attribute value a source value stands for.
 * @param {KeyMapping} mapping
 * @param {unknown} raw
 */
export function keyValue(mapping, raw) {
  let value = raw == null ? '' : String(raw);
  for (const step of mapping.transform) value = step === 'trim' ? value.trim() : value.toLowerCase();
  return Object.hasOwn(mapping.map, value) ? mapping.map[value] : value;
}

/**
 * The rows of a kind with every column typed. A row with a bad date or a
 * number that is not finite is left out and counted, with up to three
 * examples, so a build can report it rather than guess.
 * @param {SourceKind} kind
 * @param {ReadonlyArray<Record<string, unknown>>} rows
 * @returns {{rows: Array<Record<string, string | number>>, rejected: number, examples: string[]}}
 */
export function typedRows(kind, rows) {
  const out = [];
  const examples = [];
  let rejected = 0;
  for (const [index, row] of rows.entries()) {
    const typed = {};
    let problem = null;
    for (const [name, type] of Object.entries(kind.columns)) {
      const value = row?.[name];
      if (type === 'date') {
        if (!isIsoDay(value)) problem ??= `${name} ${JSON.stringify(value)} is not a day`;
        typed[name] = value;
      } else if (type === 'number') {
        const number = value == null || value === '' ? 0 : Number(value);
        if (!Number.isFinite(number)) problem ??= `${name} ${JSON.stringify(value)} is not a number`;
        typed[name] = number;
      } else {
        typed[name] = value == null ? '' : String(value);
      }
    }
    if (problem) {
      rejected += 1;
      if (examples.length < 3) examples.push(`row ${index + 1}: ${problem}`);
    } else {
      out.push(typed);
    }
  }
  return { rows: out, rejected, examples };
}

/**
 * A lookup kind's rows as a map from the attribute value to the looked-up
 * columns. Two rows for one key that disagree are a conflict; the first wins
 * and the conflict is counted.
 * @param {SourceKind} kind a lookup kind
 * @param {ReadonlyArray<Record<string, string | number>>} rows typed rows
 */
export function lookupTable(kind, rows) {
  /** @type {Map<string, Record<string, string>>} */
  const table = new Map();
  let conflicts = 0;
  for (const row of rows) {
    const key = keyValue(kind.key, row[kind.key.column]);
    const values = Object.fromEntries(Object.keys(kind.attributes).map((name) => [name, String(row[name] ?? '')]));
    const prior = table.get(key);
    if (!prior) table.set(key, values);
    else if (Object.keys(values).some((name) => values[name] !== prior[name])) conflicts += 1;
  }
  return { table, conflicts };
}
