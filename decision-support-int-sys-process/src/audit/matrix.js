import { AUDIT_TEMPLATES, classFitsTemplate, isAuditClass } from './element-classes.js';

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * @typedef {Object} MatrixEntry
 * @property {number} idsite
 * @property {string} template
 * @property {string} element_class
 * @property {string} element_name
 * @property {string} selector_match
 * @property {number | null} position
 * @property {string} valid_from
 * @property {string} valid_to
 * @property {boolean} absent
 */

/**
 * @param {unknown} doc
 * @returns {{ entries: MatrixEntry[], urlRules: Array<{idsite: number, template: string, pattern: string}>, events: Array<{idsite: number, date: string, label: string}> }}
 */
export function parseAuditInputs(doc) {
  if (doc == null) return { entries: [], urlRules: [], events: [] };
  if (typeof doc !== 'object') throw new Error('audit inputs must be a JSON object');
  const root = /** @type {Record<string, unknown>} */ (doc);
  const entries = Array.isArray(root.entries) ? root.entries.map(parseEntry) : [];
  const urlRules = Array.isArray(root.urlRules) ? root.urlRules.map(parseRule) : [];
  const events = Array.isArray(root.events) ? root.events.map(parseEvent) : [];
  return { entries, urlRules, events };
}

/** @param {unknown} raw */
function parseEntry(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('matrix entry must be an object');
  const row = /** @type {Record<string, unknown>} */ (raw);
  const template = String(row.template ?? '');
  const elementClass = String(row.element_class ?? '');
  const absent = Boolean(row.absent);
  if (!AUDIT_TEMPLATES.includes(template)) {
    throw new Error(`matrix template "${template}" is not an audit template`);
  }
  if (!isAuditClass(elementClass) || !classFitsTemplate(template, elementClass)) {
    throw new Error(`matrix class "${elementClass}" does not belong on template "${template}"`);
  }
  const validFrom = String(row.valid_from ?? '');
  const validTo = String(row.valid_to ?? '');
  if (!DAY.test(validFrom) || !DAY.test(validTo) || validFrom > validTo) {
    throw new Error(`matrix validity for ${elementClass} must be YYYY-MM-DD with valid_from <= valid_to`);
  }
  const selector = absent ? '' : String(row.selector_match ?? '');
  if (!absent && selector.trim() === '') {
    throw new Error(`matrix class ${elementClass} needs selector_match or absent: true`);
  }
  if (/[\0\n\r]/.test(selector)) throw new Error(`matrix selector for ${elementClass} contains a control character`);
  const idsite = Number(row.idsite);
  if (!Number.isInteger(idsite) || idsite <= 0) throw new Error(`matrix idsite for ${elementClass} must be a positive integer`);
  const position = row.position == null || row.position === '' ? null : Number(row.position);
  if (position != null && !Number.isInteger(position)) {
    throw new Error(`matrix position for ${elementClass} must be an integer`);
  }
  return {
    idsite,
    template,
    element_class: elementClass,
    element_name: String(row.element_name ?? elementClass),
    selector_match: selector,
    position,
    valid_from: validFrom,
    valid_to: validTo,
    absent,
  };
}

/** @param {unknown} raw */
function parseRule(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('url rule must be an object');
  const row = /** @type {Record<string, unknown>} */ (raw);
  const template = String(row.template ?? '');
  const pattern = String(row.pattern ?? '');
  const idsite = Number(row.idsite);
  if (!AUDIT_TEMPLATES.includes(template) && template !== 'search' && template !== 'unclassified') {
    throw new Error(`url rule template "${template}" is not recognized`);
  }
  if (pattern.trim() === '') throw new Error('url rule pattern is empty');
  try {
    RegExp(pattern);
  } catch {
    throw new Error(`url rule pattern is not a regular expression: ${pattern}`);
  }
  if (!Number.isInteger(idsite) || idsite <= 0) throw new Error('url rule idsite must be a positive integer');
  return { idsite, template, pattern };
}

/** @param {unknown} raw */
function parseEvent(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('calendar event must be an object');
  const row = /** @type {Record<string, unknown>} */ (raw);
  const date = String(row.date ?? '');
  const label = String(row.label ?? '');
  const idsite = Number(row.idsite);
  if (!DAY.test(date)) throw new Error(`calendar date "${date}" must be YYYY-MM-DD`);
  if (label.trim() === '') throw new Error('calendar event label is empty');
  if (!Number.isInteger(idsite) || idsite <= 0) throw new Error('calendar event idsite must be a positive integer');
  return { idsite, date, label };
}

/**
 * ClickHouse VALUES rows for live (not absent) matrix entries.
 * Single quotes are doubled. The caller still has to keep the CTE inside
 * a query that carries {idsite:}.
 * @param {MatrixEntry[]} entries
 * @param {number} idsite
 */
export function matrixValuesSql(entries, idsite) {
  const live = entries.filter((e) => e.idsite === idsite && !e.absent && e.selector_match);
  if (live.length === 0) return '';
  const tuples = live.map((e) => {
    const position = e.position == null ? -1 : e.position;
    return `(${e.idsite}, ${sqlString(e.template)}, ${sqlString(e.element_class)}, ${sqlString(e.element_name)}, ${sqlString(e.selector_match)}, ${position}, toDate(${sqlString(e.valid_from)}), toDate(${sqlString(e.valid_to)}))`;
  });
  return `element_matrix AS (
    SELECT idsite, template, element_class, element_name, selector_match, position, valid_from, valid_to
    FROM VALUES(
      'idsite UInt32, template String, element_class String, element_name String, selector_match String, position Int32, valid_from Date, valid_to Date',
      ${tuples.join(',\n      ')}
    )
  )`;
}

/** @param {string} value */
function sqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}
