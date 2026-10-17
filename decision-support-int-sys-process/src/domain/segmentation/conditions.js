import { sqlIdentifier, sqlString } from '../sql-literal.js';

/**
 * The condition language segmentations and channel rules are written in.
 *
 * A condition is { field, <operator>: value } with one operator from
 * OPERATORS, or { any: [] } | { all: [] }. An `in` list may name a shared
 * list as "@name". Fields are typed (`string` or `number`); a value of the
 * wrong type, or an operator the type does not allow, is refused.
 *
 * @typedef {{field?: string, eq?: string|number, ne?: string|number, in?: Array<string|number>|string, like?: string, startsWith?: string,
 *   gt?: number, gte?: number, lt?: number, lte?: number, any?: Condition[], all?: Condition[]}} Condition
 * @typedef {'string' | 'number'} FieldType
 * @typedef {{type: FieldType, source: string, needs?: string}} FieldSpec
 * @typedef {{fields: Readonly<Record<string, FieldSpec>>, lists: Readonly<Record<string, ReadonlyArray<string|number>>>}} Vocabulary
 */

const literal = (value) => (typeof value === 'number' ? String(value) : sqlString(value));

/** SQL LIKE as a whole-string pattern: % any run, _ one character. */
function likePattern(like) {
  const source = [...String(like)].map((ch) => (ch === '%' ? '.*' : ch === '_' ? '.' : ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('');
  return new RegExp(`^${source}$`, 's');
}

/**
 * Every field operator a condition can use, keyed by its name in the
 * condition. Each says which field types it applies to (`types`), what value
 * it accepts (`check` returns a problem or null), how JavaScript tests a
 * field value (`js`), and the ClickHouse expression that gives the same
 * answer (`sql`). A new operator is one entry here; validation, the
 * classifier, and the SQL builder read it.
 */
export const OPERATORS = Object.freeze({
  eq: {
    types: ['string', 'number'],
    check: scalar,
    js: (expected) => (value) => value === expected,
    sql: (field, expected) => `${field} = ${literal(expected)}`,
  },
  ne: {
    types: ['string', 'number'],
    check: scalar,
    js: (expected) => (value) => value !== expected,
    sql: (field, expected) => `${field} != ${literal(expected)}`,
  },
  in: {
    types: ['string', 'number'],
    check: (list) => (Array.isArray(list) && list.length > 0 && list.every((item) => scalar(item) === null) ? null : 'needs a non-empty list of strings or numbers'),
    js: (list) => (value) => list.includes(value),
    sql: (field, list) => `${field} IN (${list.map(literal).join(', ')})`,
  },
  like: {
    types: ['string'],
    check: text,
    js: (pattern) => {
      const regex = likePattern(pattern);
      return (value) => regex.test(String(value));
    },
    sql: (field, pattern) => `${field} LIKE ${sqlString(pattern)}`,
  },
  startsWith: {
    types: ['string'],
    check: text,
    js: (prefix) => (value) => String(value).startsWith(prefix),
    sql: (field, prefix) => `startsWith(${field}, ${sqlString(prefix)})`,
  },
  gt: compare('>', (value, bound) => value > bound),
  gte: compare('>=', (value, bound) => value >= bound),
  lt: compare('<', (value, bound) => value < bound),
  lte: compare('<=', (value, bound) => value <= bound),
});

/** A number comparison: the field against one finite number. */
function compare(symbol, test) {
  return {
    types: ['number'],
    check: (value) => (typeof value === 'number' && Number.isFinite(value) ? null : 'needs a finite number'),
    js: (bound) => (value) => test(Number(value), bound),
    sql: (field, bound) => `${field} ${symbol} ${literal(bound)}`,
  };
}

/** The value a field reads when the row has none: `''` for strings and `0` for numbers. */
export const TYPE_DEFAULTS = Object.freeze({ string: '', number: 0 });

function scalar(value) {
  return typeof value === 'string' || typeof value === 'number' ? null : 'needs a string or number';
}

function text(value) {
  return typeof value === 'string' ? null : 'needs a string';
}

const isListRef = (value) => typeof value === 'string' && value.startsWith('@');

/** A leaf condition's field and its one operator. */
export function leafEntry(condition) {
  const op = Object.keys(condition).find((key) => key !== 'field');
  return { field: condition.field, op, value: condition[op] };
}

/**
 * Checks one condition tree and throws on the first problem, naming `owner`.
 * Without a vocabulary only the shape and the operator values are checked.
 * With one, the field must be registered, the operator must apply to its
 * type, every value must have that type, and a list reference must name a
 * registered list.
 *
 * @param {Condition} condition
 * @param {Vocabulary | null} vocabulary
 * @param {string} owner who wrote it, for the message: a segmentation id and value, or a channel
 */
export function checkCondition(condition, vocabulary, owner) {
  if (condition?.any || condition?.all) {
    const list = condition.any ?? condition.all;
    if (!Array.isArray(list) || list.length === 0) throw new Error(`${owner}: any/all needs a non-empty list`);
    if (condition.any && condition.all) throw new Error(`${owner}: a condition has any or all, not both`);
    for (const inner of list) checkCondition(inner, vocabulary, owner);
    return;
  }
  const ops = Object.keys(condition ?? {}).filter((key) => key !== 'field');
  if (typeof condition?.field !== 'string' || !condition.field || ops.length !== 1 || !Object.hasOwn(OPERATORS, ops[0])) {
    throw new Error(`${owner}: a condition is { field, ${Object.keys(OPERATORS).join(' | ')} } or any/all, got ${JSON.stringify(condition)}`);
  }
  const op = ops[0];
  let value = condition[op];
  if (op === 'in' && isListRef(value)) {
    if (!vocabulary) throw new Error(`${owner}: list ${value} needs the list registry`);
    const name = value.slice(1);
    if (!Object.hasOwn(vocabulary.lists, name)) {
      throw new Error(`${owner}: unknown list ${value} (${Object.keys(vocabulary.lists).map((key) => `@${key}`).join(', ')})`);
    }
    value = vocabulary.lists[name];
  }
  const problem = OPERATORS[op].check(value);
  if (problem) throw new Error(`${owner}: "${op}" ${problem}, got ${JSON.stringify(condition)}`);
  if (!vocabulary) return;
  const spec = vocabulary.fields[condition.field];
  if (!spec) {
    throw new Error(`${owner}: unknown field "${condition.field}" (${Object.keys(vocabulary.fields).join(', ')})`);
  }
  if (!OPERATORS[op].types.includes(spec.type)) {
    throw new Error(`${owner}: "${op}" does not apply to ${spec.type} field "${condition.field}"`);
  }
  for (const item of Array.isArray(value) ? value : [value]) {
    if (typeof item !== spec.type) {
      throw new Error(`${owner}: field "${condition.field}" is a ${spec.type}, got ${JSON.stringify(item)} in ${JSON.stringify(condition)}`);
    }
  }
}

/**
 * A copy of the condition with every "@name" list replaced by its values,
 * so the classifier, the SQL, and the version stamp read the same lists.
 * @param {Condition} condition
 * @param {Vocabulary['lists']} lists
 * @returns {Condition}
 */
export function resolveLists(condition, lists) {
  if (condition.any) return { any: condition.any.map((inner) => resolveLists(inner, lists)) };
  if (condition.all) return { all: condition.all.map((inner) => resolveLists(inner, lists)) };
  if (isListRef(condition.in)) {
    const values = lists[condition.in.slice(1)];
    if (!values) throw new Error(`unknown list ${condition.in}`);
    return { field: condition.field, in: [...values] };
  }
  return { ...condition };
}

/** The fields a condition reads, in first-appearance order. */
export function fieldsOf(condition, into = []) {
  if (condition.any || condition.all) {
    for (const inner of condition.any ?? condition.all) fieldsOf(inner, into);
    return into;
  }
  if (!into.includes(condition.field)) into.push(condition.field);
  return into;
}

/**
 * Walks a condition tree with one visitor per shape, so the classifier and the
 * SQL builder share the any/all structure and differ only in the leaves.
 *
 * @template T
 * @param {Condition} condition
 * @param {{any: (parts: T[]) => T, all: (parts: T[]) => T, leaf: (field: string, op: string, value: unknown) => T}} visit
 * @returns {T}
 */
export function foldCondition(condition, visit) {
  if (condition.any) return visit.any(condition.any.map((inner) => foldCondition(inner, visit)));
  if (condition.all) return visit.all(condition.all.map((inner) => foldCondition(inner, visit)));
  const { field, op, value } = leafEntry(condition);
  return visit.leaf(field, op, value);
}

/**
 * The SQL visitor over a column map: field name to the SQL expression the
 * target query reads it from. The caller's expressions must not be NULL;
 * a missing value is the type's default, as the JavaScript twin reads it.
 * Without a map, each field is its own column name.
 *
 * @param {Readonly<Record<string, string>>} [columns]
 * @param {string} [owner] for the unmapped-field message
 */
export function sqlVisitor(columns, owner = 'condition') {
  const column = (field) => {
    if (!columns) return sqlIdentifier(field);
    if (!Object.hasOwn(columns, field)) throw new Error(`${owner}: field "${field}" has no column in this query`);
    return columns[field];
  };
  return {
    any: (parts) => `(${parts.join(' OR ')})`,
    all: (parts) => `(${parts.join(' AND ')})`,
    leaf: (field, op, value) => OPERATORS[op].sql(column(field), value),
  };
}

export const toSql = sqlVisitor();

/**
 * The JavaScript visitor. A field the row lacks, or holds as null, reads
 * as its type's default when the field is registered, and as '' otherwise.
 * @param {Vocabulary['fields']} [fields]
 */
export function predicateVisitor(fields) {
  return {
    any: (tests) => (row) => tests.some((test) => test(row)),
    all: (tests) => (row) => tests.every((test) => test(row)),
    leaf: (field, op, value) => {
      const test = OPERATORS[op].js(value);
      const fallback = TYPE_DEFAULTS[fields?.[field]?.type] ?? '';
      return (row) => test(row[field] ?? fallback);
    },
  };
}

/** @type {{any: Function, all: Function, leaf: Function}} */
export const toPredicate = predicateVisitor();
