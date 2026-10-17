/**
 * The Enterprise trend grain. One shape for a journey step, a path, a
 * page, and an element. Segmentation is a column, not a new table.
 *
 * Within one segment, the values partition the sessions. `all` / `all`
 * is the unsegmented total and is stored on its own row. A segment is a
 * segmentation id; summing every segment_value across segmentations
 * double-counts.
 */

export const ROW_TYPES = ['journey', 'page', 'element', 'experiment'];

/** `all` is the total. The three devices partition it, plus `unknown` when a visit has no device type. */
export const VIEWPORT_TYPES = ['all', 'desktop', 'tablet', 'mobile', 'unknown'];

const COUNTS = ['sessions', 'buyers', 'orders', 'clicks', 'progressed'];

/**
 * @param {import('../ports/persistence.js').AeTrendRow} input
 * @returns {import('../ports/persistence.js').AeTrendRow}
 */
export function buildTrendRow(input) {
  const rowType = text(input?.rowType, 'rowType');
  if (!ROW_TYPES.includes(rowType)) {
    throw new Error(`rowType must be one of ${ROW_TYPES.join(', ')}`);
  }
  const idsite = integer(input.idsite, 'idsite');
  if (idsite <= 0) throw new Error('idsite must be positive');
  const idsitehsr = integer(input.idsitehsr ?? 0, 'idsitehsr');
  if (idsitehsr < 0) throw new Error('idsitehsr must be zero or positive');
  /** @type {import('../ports/persistence.js').AeTrendRow} */
  const row = {
    batchId: input.batchId == null ? '' : String(input.batchId),
    idsite,
    idsitehsr,
    rowType,
    rowKey: text(input.rowKey, 'rowKey'),
    rowKey1: input.rowKey1 == null ? '' : String(input.rowKey1),
    rowKey2: input.rowKey2 == null ? '' : String(input.rowKey2),
    viewportType: viewport(input.viewportType),
    segment: text(input.segment, 'segment'),
    segmentValue: text(input.segmentValue, 'segmentValue'),
    week: monday(input.week),
    sessions: 0,
    buyers: 0,
    orders: 0,
    revenue: money(input.revenue ?? 0),
    clicks: 0,
    progressed: 0,
    metrics: input.metrics ?? {},
  };
  for (const field of COUNTS) row[field] = count(input[field] ?? 0, field);
  return row;
}

/**
 * One week of one session-tag value under one strategy, for
 * ae_session_tag_trend. The values of one tag key partition the sessions:
 * `(none)` is a visit without that key and `other` is a value outside the
 * selected list.
 * @param {import('../ports/persistence.js').AeSessionTagTrendRow} input
 * @returns {import('../ports/persistence.js').AeSessionTagTrendRow}
 */
export function buildTagTrendRow(input) {
  const idsite = integer(input?.idsite, 'idsite');
  if (idsite <= 0) throw new Error('idsite must be positive');
  /** @type {import('../ports/persistence.js').AeSessionTagTrendRow} */
  const row = {
    batchId: input.batchId == null ? '' : String(input.batchId),
    idsite,
    tagKey: text(input.tagKey, 'tagKey'),
    tagValue: text(input.tagValue, 'tagValue'),
    viewportType: viewport(input.viewportType),
    segment: text(input.segment, 'segment'),
    segmentValue: text(input.segmentValue, 'segmentValue'),
    week: monday(input.week),
    sessions: 0,
    buyers: 0,
    orders: 0,
    revenue: money(input.revenue ?? 0),
    progressed: 0,
    metrics: input.metrics ?? {},
  };
  for (const field of ['sessions', 'buyers', 'orders', 'progressed']) row[field] = count(input[field] ?? 0, field);
  return row;
}

/**
 * How each row type fills the keys. idsite is always set. idsitehsr is
 * the page id when the subject is one page, and 0 otherwise.
 */
export const KEY_GUIDE = {
  journey: {
    rowKey: 'path, step, url_path, or url_step',
    rowKey1: 'the template or URL path; for a step, its 1-based index and name, such as 2:pdp',
    rowKey2: 'empty for a path; the path for a step',
    idsitehsr: 0,
  },
  page: { rowKey: 'page', rowKey1: 'page id', rowKey2: 'page URL', idsitehsr: 'page id' },
  element: { rowKey: 'selector', rowKey1: 'selector', rowKey2: '', idsitehsr: 'page id' },
};

/** @param {unknown} value */
function viewport(value) {
  const out = value == null ? '' : String(value).trim();
  if (!VIEWPORT_TYPES.includes(out)) {
    throw new Error(`viewportType must be one of ${VIEWPORT_TYPES.join(', ')}`);
  }
  return out;
}

/** @param {unknown} value @param {string} name */
function text(value, name) {
  const out = value == null ? '' : String(value).trim();
  if (!out) throw new Error(`${name} is required`);
  return out;
}

/** @param {unknown} value @param {string} name */
function integer(value, name) {
  const n = Number(value);
  if (!Number.isInteger(n)) throw new Error(`${name} must be an integer`);
  return n;
}

/** @param {unknown} value @param {string} name */
function count(value, name) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer`);
  return n;
}

/** @param {unknown} value */
function money(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error('revenue must be a finite number');
  return n;
}

/** @param {unknown} value */
function monday(value) {
  const week = text(value, 'week');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(week)) throw new Error('week must be YYYY-MM-DD');
  const [year, month, day] = week.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new Error(`week ${week} is not a date`);
  }
  if (date.getUTCDay() !== 1) throw new Error(`week ${week} is not a Monday`);
  return week;
}
