/**
 * Selection criteria: a JSON Schema subset, checked with no dependency.
 * A schema may use `type` (object, array, string, integer, number,
 * boolean), `properties`, `required`, `items`, `enum`, `minimum`,
 * `description`, and `additionalProperties: false`. A criteria schema is an
 * object with `additionalProperties: false`, so a misspelled criterion is
 * an error rather than a silent default.
 */

const TYPES = ['object', 'array', 'string', 'integer', 'number', 'boolean'];
const KEYWORDS = new Set(['type', 'properties', 'required', 'items', 'enum', 'minimum', 'description', 'additionalProperties']);

export class CriteriaError extends Error {
  /**
   * @param {string} message
   * @param {string[]} errors
   */
  constructor(message, errors) {
    super(message);
    this.name = 'CriteriaError';
    this.errors = errors;
  }
}

/**
 * The problems with a schema itself; empty when it is usable.
 * @param {object} schema
 * @param {string} [where]
 * @returns {string[]}
 */
export function schemaErrors(schema, where = 'criteria') {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return [`${where}: schema must be an object`];
  /** @type {string[]} */
  const errors = [];
  for (const key of Object.keys(schema)) {
    if (!KEYWORDS.has(key)) errors.push(`${where}: unsupported keyword "${key}"`);
  }
  if (!TYPES.includes(schema.type)) errors.push(`${where}: type must be one of ${TYPES.join(', ')}`);
  if (schema.enum !== undefined && !Array.isArray(schema.enum)) errors.push(`${where}: enum must be an array`);
  if (schema.minimum !== undefined && typeof schema.minimum !== 'number') errors.push(`${where}: minimum must be a number`);
  if (schema.additionalProperties !== undefined && schema.additionalProperties !== false) {
    errors.push(`${where}: additionalProperties may only be false`);
  }
  if (schema.type === 'object') {
    const properties = schema.properties ?? {};
    for (const [name, child] of Object.entries(properties)) errors.push(...schemaErrors(child, `${where}.${name}`));
    for (const name of schema.required ?? []) {
      if (!Object.hasOwn(properties, name)) errors.push(`${where}: required "${name}" is not a property`);
    }
  }
  if (schema.type === 'array') {
    if (!schema.items) errors.push(`${where}: an array needs items`);
    else errors.push(...schemaErrors(schema.items, `${where}[]`));
  }
  return errors;
}

/**
 * The problems with a top-level criteria schema: a usable schema, an
 * object, closed to unknown properties.
 * @param {object} schema
 * @param {string} where
 */
export function criteriaSchemaErrors(schema, where) {
  const errors = schemaErrors(schema, where);
  if (errors.length > 0) return errors;
  if (schema.type !== 'object') return [`${where}: criteria schema must be an object`];
  if (schema.additionalProperties !== false) return [`${where}: criteria schema needs additionalProperties: false`];
  return [];
}

/**
 * The ways a value breaks a schema; empty when it fits.
 * @param {unknown} value
 * @param {object} schema
 * @param {string} [where]
 * @returns {string[]}
 */
export function valueErrors(value, schema, where = 'criteria') {
  if (!typeMatches(value, schema.type)) return [`${where} must be ${article(schema.type)}`];
  /** @type {string[]} */
  const errors = [];
  if (schema.enum && !schema.enum.some((option) => option === value)) {
    errors.push(`${where} must be one of ${schema.enum.map((option) => JSON.stringify(option)).join(', ')}`);
  }
  if (schema.minimum !== undefined && typeof value === 'number' && value < schema.minimum) {
    errors.push(`${where} must be at least ${schema.minimum}`);
  }
  if (schema.type === 'array') {
    /** @type {unknown[]} */ (value).forEach((item, i) => errors.push(...valueErrors(item, schema.items, `${where}[${i}]`)));
  }
  if (schema.type === 'object') {
    const object = /** @type {Record<string, unknown>} */ (value);
    const properties = schema.properties ?? {};
    for (const name of schema.required ?? []) {
      if (object[name] === undefined) errors.push(`${where}.${name} is required`);
    }
    for (const [name, item] of Object.entries(object)) {
      if (Object.hasOwn(properties, name)) errors.push(...valueErrors(item, properties[name], `${where}.${name}`));
      else if (schema.additionalProperties === false) errors.push(`${where}.${name} is not a criterion; known: ${Object.keys(properties).join(', ') || '(none)'}`);
    }
  }
  return errors;
}

/**
 * The criteria a run selects with: the given criteria over the defaults,
 * checked against the schema. Throws a CriteriaError naming every problem.
 * @param {object} schema
 * @param {object} [defaults]
 * @param {object} [given]
 * @returns {object}
 */
export function resolveCriteria(schema, defaults = {}, given = {}) {
  if (given === null || typeof given !== 'object' || Array.isArray(given)) {
    throw new CriteriaError('criteria must be a JSON object', ['criteria must be an object']);
  }
  const criteria = { ...defaults, ...given };
  const errors = valueErrors(criteria, schema);
  if (errors.length > 0) throw new CriteriaError(`invalid criteria: ${errors.join('; ')}`, errors);
  return criteria;
}

/**
 * `--select` text as an object. Bad JSON throws a CriteriaError.
 * @param {string | undefined} text
 */
export function parseCriteria(text) {
  if (text === undefined || text === 'true' || text.trim() === '') return {};
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new CriteriaError(`--select is not JSON: ${error.message}`, ['criteria is not JSON']);
  }
}

function typeMatches(value, type) {
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  return typeof value === type;
}

const article = (type) => (/^[aeiou]/.test(type) ? `an ${type}` : `a ${type}`);
