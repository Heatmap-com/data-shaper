import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Query-formation rules for fact tables.
 *
 * A joined table that has server_date (or its date column, when the table
 * dates on server_time or fetched_at) must constrain that column on its own
 * alias. The same applies to idsite. When the caller knows idsitehsr — a
 * page-specific or element-specific trend — every joined table that has
 * idsitehsr must constrain it too. A site-level query leaves idsitehsr unset
 * and does not require the column.
 *
 * Three aliases that all have server_date need three predicates. A join
 * equality between two dates does not count: the predicate has to bound the
 * column (BETWEEN, a comparison, or IN).
 */

/**
 * @typedef {Object} BoundSpec
 * @property {string} [date] column that bounds the table in time
 * @property {boolean} [idsite]
 * @property {boolean} [idsitehsr]
 */

const DATASETS_DIR = fileURLToPath(new URL('../adapters/datasets/', import.meta.url));
const SPEC_KEYS = new Set(['date', 'idsite', 'idsitehsr']);

/**
 * The shared warehouse tables (fact-tables.json), plus the tables a
 * dataset declares under `factTables` in its descriptor. A dataset that
 * reads a new table adds its bounds there; two declarations of one table
 * must agree.
 *
 * @param {Array<{source: string, factTables?: Record<string, BoundSpec>}>} declarations
 * @returns {Readonly<Record<string, Readonly<BoundSpec>>>}
 */
export function factBounds(declarations) {
  /** @type {Record<string, BoundSpec>} */
  const bounds = {};
  /** @type {Record<string, string>} */
  const from = {};
  for (const { source, factTables } of declarations) {
    for (const [table, spec] of Object.entries(factTables ?? {})) {
      checkSpec(source, table, spec);
      if (bounds[table] && [...SPEC_KEYS].some((key) => bounds[table][key] !== spec[key])) {
        throw new Error(`${source}: factTables.${table} differs from the bounds in ${from[table]}`);
      }
      bounds[table] = Object.freeze({ ...spec });
      from[table] = from[table] ?? source;
    }
  }
  return Object.freeze(bounds);
}

function checkSpec(source, table, spec) {
  const where = `${source}: factTables.${table}`;
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new Error(`${where} must be an object`);
  for (const key of Object.keys(spec)) {
    if (!SPEC_KEYS.has(key)) throw new Error(`${where} has unknown key "${key}"; expected date, idsite, idsitehsr`);
  }
  if (spec.date !== undefined && (typeof spec.date !== 'string' || spec.date === '')) throw new Error(`${where}.date must be a column name`);
  for (const key of ['idsite', 'idsitehsr']) {
    if (spec[key] !== undefined && typeof spec[key] !== 'boolean') throw new Error(`${where}.${key} must be true or false`);
  }
}

function datasetDeclarations(dir) {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.descriptor.json'))
    .sort()
    .flatMap((name) => {
      const parsed = JSON.parse(readFileSync(path.join(dir, name), 'utf8'));
      const entries = Array.isArray(parsed?.adapters) ? parsed.adapters : [parsed];
      return entries.filter((entry) => entry.factTables).map((entry) => ({ source: name, factTables: entry.factTables }));
    });
}

const SHARED = JSON.parse(readFileSync(new URL('./fact-tables.json', import.meta.url), 'utf8'));

/** @type {Readonly<Record<string, Readonly<BoundSpec>>>} */
export const FACT_BOUNDS = factBounds([
  { source: 'src/governance/fact-tables.json', factTables: SHARED.bounds },
  ...datasetDeclarations(DATASETS_DIR),
]);

const FROM_RE = /\b(?:FROM|JOIN)\s+(?:(?:default|journey_events)\.)?([a-z0-9_]+)(?:\s+AS\s+([a-z_][a-z0-9_]*))?/gi;

/**
 * The gap check over one set of bounds.
 * @param {Readonly<Record<string, BoundSpec>>} bounds
 */
export function createQueryBoundGaps(bounds) {
  return (sql, opts = {}) => boundGaps(bounds, sql, opts);
}

/**
 * @param {string} sql
 * @param {{ idsitehsr?: boolean }} [opts] set idsitehsr when the page is known
 * @returns {string[]} missing `alias.column (table)` entries
 */
export function queryBoundGaps(sql, opts = {}) {
  return boundGaps(FACT_BOUNDS, sql, opts);
}

function boundGaps(bounds, sql, opts) {
  /** @type {Array<{table: string, alias: string}>} */
  const refs = [];
  const re = new RegExp(FROM_RE.source, FROM_RE.flags);
  let match = re.exec(sql);
  while (match) {
    const table = match[1];
    if (Object.hasOwn(bounds, table)) refs.push({ table, alias: match[2] ?? '' });
    match = re.exec(sql);
  }
  /** @type {string[]} */
  const gaps = [];
  for (const ref of refs) {
    const spec = bounds[ref.table];
    /** @type {string[]} */
    const columns = [];
    if (spec.date) columns.push(spec.date);
    if (spec.idsite) columns.push('idsite');
    if (opts.idsitehsr && spec.idsitehsr) columns.push('idsitehsr');
    for (const column of columns) {
      if (!isConstrained(sql, ref.alias, column)) {
        gaps.push(ref.alias ? `${ref.alias}.${column} (${ref.table})` : `${ref.table}.${column}`);
      }
    }
  }
  return gaps;
}

/**
 * @param {string} sql
 * @param {string} alias empty when the table is the only fact reference
 * @param {string} column
 */
function isConstrained(sql, alias, column) {
  // An unaliased reference is checked by column name. Aliased references
  // must bound that alias: a comparison, IN, or equality to a parameter
  // or literal. `e.server_date = h.server_date` does not bound e.
  if (!alias) return new RegExp(`\\b${column}\\b`, 'i').test(sql);
  const name = `${alias}\\.${column}`;
  const bounded = new RegExp(`\\b${name}\\s*(?:BETWEEN|<=|>=|<|>|IN)\\b`, 'i');
  if (bounded.test(sql)) return true;
  const equals = new RegExp(`\\b${name}\\s*=\\s*(?:\\{|\\d|'|"|today\\s*\\(|toDate\\s*\\()`, 'i');
  if (equals.test(sql)) return true;
  const wrapped = new RegExp(`toDate\\(\\s*${name}\\s*\\)\\s*(?:BETWEEN|=|<=|>=|<|>)`, 'i');
  return wrapped.test(sql);
}
