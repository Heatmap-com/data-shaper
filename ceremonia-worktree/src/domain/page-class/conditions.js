import { sqlString } from '../sql-literal.js';

const lower = (value) => String(value).toLowerCase();

/**
 * Every kind of page-path condition, keyed by its name in a rule. Each kind
 * says how its value is stored (`value`), how JavaScript tests a path (`js`),
 * and the ClickHouse expression that gives the same answer (`sql`). A new kind
 * is one entry here; rules, the classifier, and the SQL builder read it.
 *
 * Paths are already lower-cased (pathOf, pathSql), so plain values are too.
 */
export const PATH_CONDITIONS = Object.freeze({
  root: {
    value: () => true,
    js: () => (path) => path === '' || path === '/',
    sql: (path) => `(${path} = '' OR ${path} = '/')`,
  },
  startsWith: {
    value: lower,
    js: (value) => (path) => path.startsWith(value),
    sql: (path, value) => `startsWith(${path}, ${sqlString(value)})`,
  },
  contains: {
    value: lower,
    js: (value) => (path) => path.includes(value),
    sql: (path, value) => `position(${path}, ${sqlString(value)}) > 0`,
  },
  equals: {
    value: lower,
    js: (value) => (path) => path.replace(/\/+$/, '') === value,
    sql: (path, value) => `replaceRegexpOne(${path}, '/+$', '') = ${sqlString(value)}`,
  },
  match: {
    value: (pattern) => {
      new RegExp(String(pattern), 'i');
      return String(pattern);
    },
    js: (pattern) => {
      const regex = new RegExp(pattern, 'i');
      return (path) => regex.test(path);
    },
    sql: (path, pattern) => `match(${path}, ${sqlString(`(?i)${pattern}`)})`,
  },
});

/** The one kind a condition names, and its value. */
export function conditionEntry(condition) {
  const [kind] = Object.keys(condition);
  return [kind, condition[kind]];
}
