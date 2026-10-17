import { createHash } from 'node:crypto';
import { isPageShaped } from '../../domain/subject-types.js';

const PROMOTED = new Set(['week', 'device', 'referer', 'selector']);
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Stable hash of the dims, so a rerun replaces the row instead of
 * duplicating it. Keys are sorted before serialization.
 * @param {object} dims
 */
export function rowKey(dims, opts = {}) {
  const stableDims = { ...dims };
  // element-binding's grain is the selector plus its class. Click cells keep
  // the same key when a later naming pass changes the class.
  if (!opts.keepClass) {
    delete stableDims.element_class;
    delete stableDims.element_id;
  }
  const stable = JSON.stringify(stableDims, Object.keys(stableDims).sort());
  return createHash('md5').update(stable).digest('hex');
}

/**
 * Appends every row without spreading the array into one call. A spread of
 * a large dataset overflows the call stack.
 * @param {unknown[]} target
 * @param {ArrayLike<unknown>} rows
 */
export function appendRows(target, rows) {
  for (let i = 0; i < rows.length; i += 1) target.push(rows[i]);
}

/**
 * Flattens a dataset's {dims, metrics} rows into DatasetRow objects.
 * Grain keys beyond week/device/referer/selector stay in dim_extra, and so
 * does a week that is not a date (the whole window's `all`), since dim_week
 * is a date column.
 * A row of a subject other than a page carries its subject type and key.
 * A subject that is not page-shaped shares idsitehsr 0 with every other
 * subject of its site, so its subject key joins the row key.
 *
 * @param {string} batchId
 * @param {{idsite: number, idsitehsr: number, subjectType?: string, subjectKey?: string}} page
 * @param {{id: string, rows: Array<{dims: object, metrics: object}>}} dataset
 */
export function toDatasetRows(batchId, page, dataset) {
  return dataset.rows.map((row) => {
    /** @type {object} */
    const dimExtra = {};
    let dimWeek;
    let dimDevice;
    let dimReferer;
    let dimSelector;
    let botFilter = '';
    for (const [key, value] of Object.entries(row.dims)) {
      if (key === 'bot_filter') {
        botFilter = value;
      } else if (key === 'week') {
        if (DATE.test(String(value))) dimWeek = value;
        else dimExtra.week = value;
      } else if (key === 'device') {
        dimDevice = value;
      } else if (key === 'referer') {
        dimReferer = value;
      } else if (key === 'selector') {
        dimSelector = value;
      } else if (!PROMOTED.has(key)) {
        dimExtra[key] = value;
      }
    }
    const subject = page.subjectType && page.subjectType !== 'page'
      ? { subjectType: page.subjectType, subjectKey: page.subjectKey }
      : {};
    const keyed = subject.subjectType && !isPageShaped(subject.subjectType);
    const dims = keyed ? { ...row.dims, subject_key: subject.subjectKey } : { ...row.dims };
    return {
      batchId,
      idsite: page.idsite,
      idsitehsr: page.idsitehsr,
      datasetId: dataset.id,
      botFilter,
      dimWeek,
      dimDevice,
      dimReferer,
      dimSelector,
      dimExtra: Object.keys(dimExtra).length > 0 ? dimExtra : undefined,
      metrics: row.metrics,
      dimElementClass: dims.element_class == null ? '' : String(dims.element_class),
      rowKey: rowKey(dims, { keepClass: dataset.id === 'element-binding' }),
      ...subject,
    };
  });
}

/**
 * Merges dataset notes into the analysis metadata object. Later datasets
 * win on key collision; each key is prefixed by its dataset id when needed
 * by the caller.
 */
export function mergeNotes(target, dataset) {
  if (dataset.notes && typeof dataset.notes === 'object') {
    Object.assign(target, dataset.notes);
  }
  return target;
}

function parseObject(value) {
  if (value && typeof value === 'object') return { ...value };
  if (typeof value !== 'string' || value === '') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Rebuilds one collected row from an ae_dataset_row record. dim_extra and
 * the promoted dim columns become dims; metrics is parsed from JSON.
 * @param {object} raw
 */
export function storedRowToCollected(raw) {
  const extra = parseObject(raw.dim_extra);
  const metrics = parseObject(raw.metrics);
  const dims = { ...extra };
  if (raw.dim_week) dims.week = String(raw.dim_week).slice(0, 10);
  if (raw.dim_device) dims.device = String(raw.dim_device);
  if (raw.dim_source) dims.referer = String(raw.dim_source);
  if (raw.dim_selector) dims.selector = String(raw.dim_selector);
  if (raw.bot_filter) dims.bot_filter = String(raw.bot_filter);
  if (raw.dim_element_class) dims.element_class = String(raw.dim_element_class);
  return {
    datasetId: String(raw.dataset_id),
    idsitehsr: Number(raw.idsitehsr),
    scope: raw.scope || (Number(raw.idsitehsr) === 0 ? 'site' : 'page'),
    dims,
    metrics,
    generatedAt: raw.generated_at ?? null,
  };
}

/**
 * A dataset object later adapters can read from ctx.datasets, rebuilt from
 * stored rows plus the notes saved on the checkpoint.
 * @param {string} id
 * @param {object[]} rawRows
 * @param {object} [notes]
 */
export function collectedFromStored(id, rawRows, notes = {}) {
  return {
    id,
    rows: rawRows.map((raw) => {
      const parsed = storedRowToCollected(raw);
      return { dims: parsed.dims, metrics: parsed.metrics };
    }),
    notes,
  };
}
