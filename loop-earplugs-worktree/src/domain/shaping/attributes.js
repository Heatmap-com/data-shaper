import { deepFreeze } from '../freeze.js';
import { sqlString } from '../sql-literal.js';

/**
 * Attributes: the values a shaped dataset can key its rows by, filter on,
 * or feed to a segmentation. Each is one value per session.
 *
 * A declaration holds no SQL. It names where the value comes from in
 * terms this module compiles:
 *
 * - `field`  a registered segmentation field (src/domain/segmentation/fields.js);
 *            the query reads it from the trend column map
 * - `visit`  one column of udp_hsrce_visits from VISIT_COLUMNS, picked over
 *            the session's rows (first, last, min, max), normalized, and typed;
 *            a whole-number column can carry labels for its codes. Every pick
 *            skips NULL rows, as the field columns do: first is the earliest
 *            row that has a value
 * - `entry`  a property of one of the session's first recorded pages: its
 *            template, its URL path, or its page id. `step` 1 (the default) is
 *            the landing page, 2 and 3 the pages after it, with repeated views
 *            of one page counted as one step
 * - `lookup` a column of a site's lookup source, found by another attribute's
 *            value; built from the source kinds, not declared
 *
 * Field, visit, and entry attributes are computed in the query, so a
 * condition can read them. A lookup is applied to the query's rows, so it
 * can key rows but no condition can read it.
 *
 * @typedef {'field' | 'visit' | 'entry' | 'lookup'} AttributeKind
 * @typedef {'string' | 'number'} AttributeType
 * @typedef {Object} Attribute
 * @property {string} id
 * @property {AttributeKind} kind
 * @property {AttributeType} type
 * @property {string} label
 * @property {string} purpose
 * @property {string} data
 * @property {readonly string[]} needs     shared CTEs the value reads: orders, checkout, ragers, entry
 * @property {boolean} inQuery              computed in SQL, so conditions can read it
 * @property {string} [column]              visit: the udp_hsrce_visits column
 * @property {'first' | 'last' | 'min' | 'max'} [pick]
 * @property {readonly ('trim' | 'lower')[]} [normalize]
 * @property {Readonly<Record<string, string>>} [labels]  visit: code → label, for a whole-number column
 * @property {string} [otherwise]           visit: the label of a code labels does not name
 * @property {'template' | 'path' | 'page'} [property]  entry
 * @property {1 | 2 | 3} [step]              entry: which of the session's pages
 * @property {{source: string, column: string, key: string, fallback: string}} [lookup]
 */

/**
 * The udp_hsrce_visits columns a visit attribute may read, with the kind of
 * value each holds. The warehouse is checked for the column before a query
 * reads it, because not every deployment carries every one. referer_type
 * and referer_name are not here: the session query aliases them, and their
 * field attributes read them.
 */
export const VISIT_COLUMNS = deepFreeze({
  custom_var_k1: 'string', custom_var_k2: 'string', custom_var_k3: 'string', custom_var_k4: 'string', custom_var_k5: 'string',
  custom_var_v1: 'string', custom_var_v2: 'string', custom_var_v3: 'string', custom_var_v4: 'string', custom_var_v5: 'string',
  location_country: 'string', location_region: 'string', location_city: 'string',
  config_browser_name: 'string', config_browser_version: 'string', config_os: 'string', config_resolution: 'string',
  config_device_type: 'whole',
  referer_url: 'string', referer_keyword: 'string',
  visitor_returning: 'flag',
  visit_total_actions: 'whole', visit_total_time: 'whole', visitor_count_visits: 'whole',
});

/** What an entry attribute can read of one of the session's first recorded pages. */
export const ENTRY_PROPERTIES = deepFreeze({
  template: { type: 'string', meaning: 'the page type of its URL: home, pdp, plp, cart, and the rest' },
  path: { type: 'string', meaning: 'its URL path, lowercased, without host, query, or a trailing slash' },
  page: { type: 'number', meaning: 'its heatmap page id (idsitehsr); 0 when the session has no such page' },
});

/** The entry steps a query computes: the landing page and the two pages after it. */
export const ENTRY_STEPS = Object.freeze([1, 2, 3]);

const ID = /^[a-z][a-z0-9_]*$/;
const PICKS = ['first', 'last', 'min', 'max'];
const NORMALIZE = ['trim', 'lower'];
const HEAD = ['id', 'kind', 'label', 'purpose', 'data'];
const KIND_KEYS = {
  field: [],
  visit: ['column', 'pick', 'type', 'normalize', 'labels', 'otherwise'],
  entry: ['property', 'step'],
};

/**
 * Checks one declared attribute and returns it resolved. Throws on the first
 * problem, naming `where`.
 * @param {object} doc
 * @param {{fields: Readonly<Record<string, {type: AttributeType, needs?: string}>>, kinds?: string[], where: string}} options
 *   `fields` is the segmentation field registry; `kinds` the kinds this file may declare
 * @returns {Readonly<Attribute>}
 */
export function checkAttribute(doc, { fields, kinds = ['field', 'visit', 'entry'], where }) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error(`${where}: an attribute is an object`);
  const name = typeof doc.id === 'string' ? doc.id : JSON.stringify(doc.id);
  const fail = (message) => {
    throw new Error(`${where}: attribute ${name}: ${message}`);
  };
  if (typeof doc.id !== 'string' || !ID.test(doc.id)) fail('id must match ^[a-z][a-z0-9_]*$');
  if (!kinds.includes(doc.kind)) fail(`kind must be one of ${kinds.join(', ')}`);
  const allowed = new Set([...HEAD, ...KIND_KEYS[doc.kind]]);
  for (const key of Object.keys(doc)) if (!allowed.has(key)) fail(`unknown key "${key}" for a ${doc.kind} attribute`);
  for (const key of ['label', 'purpose', 'data']) if (typeof doc[key] !== 'string' || !doc[key].trim()) fail(`${key} must be a non-empty string`);
  const head = { id: doc.id, kind: doc.kind, label: doc.label, purpose: doc.purpose, data: doc.data };

  if (doc.kind === 'field') {
    const spec = fields[doc.id] ?? fail(`is not a registered segmentation field (${Object.keys(fields).join(', ')})`);
    return deepFreeze({ ...head, type: spec.type, needs: spec.needs ? [spec.needs] : [], inQuery: true });
  }
  if (doc.kind === 'entry') {
    const property = ENTRY_PROPERTIES[doc.property] ?? fail(`property must be one of ${Object.keys(ENTRY_PROPERTIES).join(', ')}`);
    const step = doc.step ?? 1;
    if (!ENTRY_STEPS.includes(step)) fail(`step must be one of ${ENTRY_STEPS.join(', ')}`);
    return deepFreeze({ ...head, type: property.type, needs: ['entry'], inQuery: true, property: doc.property, step });
  }

  const native = VISIT_COLUMNS[doc.column] ?? fail(`column must be one of the udp_hsrce_visits columns ${Object.keys(VISIT_COLUMNS).join(', ')}`);
  const pick = doc.pick ?? 'first';
  if (!PICKS.includes(pick)) fail(`pick must be one of ${PICKS.join(', ')}`);
  if (doc.type !== 'string' && doc.type !== 'number') fail('type must be string or number');
  const normalize = doc.normalize ?? [];
  if (!Array.isArray(normalize) || normalize.some((step) => !NORMALIZE.includes(step)) || new Set(normalize).size !== normalize.length) {
    fail(`normalize must be a list of distinct steps from ${NORMALIZE.join(', ')}`);
  }
  if (normalize.length > 0 && (doc.type !== 'string' || native !== 'string')) fail('normalize applies to a string attribute over a string column');
  if (native === 'flag' && doc.type !== 'number') fail(`${doc.column} is a flag; its attribute is a number, 1 or 0`);
  if (doc.labels !== undefined) {
    if (native !== 'whole' || doc.type !== 'string') fail('labels name the codes of a whole-number column, for a string attribute');
    if (!doc.labels || typeof doc.labels !== 'object' || Array.isArray(doc.labels) || Object.keys(doc.labels).length === 0) fail('labels must be a non-empty object');
    for (const [code, label] of Object.entries(doc.labels)) {
      if (!/^-?\d+$/.test(code)) fail(`labels key ${JSON.stringify(code)} is not a whole number`);
      if (typeof label !== 'string' || !label) fail(`labels.${code} must be a non-empty string`);
    }
  }
  if (doc.otherwise !== undefined && (doc.labels === undefined || typeof doc.otherwise !== 'string' || !doc.otherwise)) {
    fail('otherwise is the label of an unlisted code, beside labels');
  }
  return deepFreeze({
    ...head,
    type: doc.type,
    needs: [],
    inQuery: true,
    column: doc.column,
    pick,
    normalize: [...normalize],
    ...(doc.labels ? { labels: { ...doc.labels }, otherwise: doc.otherwise ?? 'unknown' } : {}),
  });
}

/**
 * The aggregate expression of a visit attribute over one session's rows of
 * udp_hsrce_visits, never NULL: strings default to '' and numbers to 0.
 * @param {Attribute} attr a visit attribute
 */
export function visitAttributeSql(attr) {
  const native = VISIT_COLUMNS[attr.column];
  const picked = {
    first: `argMin(${attr.column}, visit_first_action_time)`,
    last: `argMax(${attr.column}, visit_first_action_time)`,
    min: `min(${attr.column})`,
    max: `max(${attr.column})`,
  }[attr.pick];
  if (native === 'flag') return `toUInt8(ifNull(${picked}, false))`;
  if (native === 'whole') {
    const code = `toInt64(ifNull(${picked}, 0))`;
    if (attr.type === 'number') return code;
    if (!attr.labels) return `toString(${code})`;
    const codes = Object.keys(attr.labels);
    return `transform(${code}, [${codes.join(', ')}], [${codes.map((key) => sqlString(attr.labels[key])).join(', ')}], ${sqlString(attr.otherwise)})`;
  }
  if (attr.type === 'number') return `toFloat64OrZero(ifNull(trim(toString(${picked})), ''))`;
  let text = `toString(${picked})`;
  for (const step of attr.normalize) text = `${step}(${text})`;
  return `ifNull(${text}, '')`;
}

/**
 * The fields a condition may read in a shaped query: every attribute
 * computed in SQL, typed, so checkCondition refuses a lookup or a wrong type.
 * @param {Iterable<Attribute>} attributes
 */
export function conditionFields(attributes) {
  const fields = {};
  for (const attr of attributes) {
    if (attr.inQuery) fields[attr.id] = { type: attr.type, source: attr.data, ...(attr.needs.length ? { needs: attr.needs[0] } : {}) };
  }
  return deepFreeze(fields);
}
