import { loadCatalog } from './catalog/index.js';

/**
 * Descriptor import (data-capture-plan.md §9.6, Phase 5 write path).
 * `src/catalog/descriptor.schema.json` is the authority: a row's field_path
 * must live under a schema path (page_fields or store_fields; sub-paths are
 * allowed — 'p10.hierarchy.movable' is valid because the base path
 * 'p10.hierarchy' exists), provenance and confidence come from the schema
 * enums, and operator fields expire (§7): expires_at defaults to
 * captured_at + 90 days. A field no layer supplies is stored as Unknown
 * (value_json 'null'), never as empty (§3). Rows normalize to the
 * AeDescriptorRow port shape; rows carrying a template_key land in
 * ae_page_descriptor, rows without in ae_store_descriptor.
 */

export const DESCRIPTOR_EXPIRY_DAYS = 90;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * @typedef {object} ParseOptions
 * @property {Date} [now] clock override for captured_at/expires_at defaults
 */

/**
 * @param {unknown} json parsed JSON (or a JSON string) of the import file
 * @param {ParseOptions} [opts]
 * @returns {{ rows: Array<import('./ports/persistence.js').AeDescriptorRow>, errors: string[] }}
 */
export function parseDescriptorImport(json, opts = {}) {
  const schema = loadCatalog().descriptorSchema;
  const now = opts.now ?? new Date();
  const capturedDefault = now.toISOString();
  const expiresDefault = new Date(now.getTime() + DESCRIPTOR_EXPIRY_DAYS * DAY_MS).toISOString();

  const pagePaths = new Map(schema.page_fields.map((f) => [f.path, f]));
  const storePaths = new Map(schema.store_fields.map((f) => [f.path, f]));
  const provenances = new Set(schema.provenance);
  const confidences = new Set(schema.confidence);
  const deviceClasses = new Set(schema.device_classes);

  let data = json;
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data);
    } catch (err) {
      return { rows: [], errors: [`not valid JSON: ${err.message}`] };
    }
  }
  if (!Array.isArray(data)) {
    return { rows: [], errors: ['expected a JSON array of descriptor rows'] };
  }

  /** @type {Array<import('./ports/persistence.js').AeDescriptorRow>} */
  const rows = [];
  /** @type {string[]} */
  const errors = [];

  data.forEach((row, i) => {
    const where = `row ${i}`;
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      errors.push(`${where}: not an object`);
      return;
    }

    if (!(Number.isInteger(row.idsite) && row.idsite > 0)) {
      errors.push(`${where}: idsite must be a positive integer`);
    }
    if (row.idsitehsr !== undefined && !(Number.isInteger(row.idsitehsr) && row.idsitehsr > 0)) {
      errors.push(`${where}: idsitehsr must be a positive integer`);
    }
    if (row.field_path === undefined || row.field_path === null || row.field_path === '') {
      errors.push(`${where}: missing required field field_path`);
    } else if (typeof row.field_path !== 'string') {
      errors.push(`${where}: field_path must be a string`);
    } else {
      const base = row.field_path.split('.').slice(0, 2).join('.');
      if (!pagePaths.has(base) && !storePaths.has(base)) {
        errors.push(`${where}: field_path "${row.field_path}" is not in descriptor.schema.json`);
      }
    }
    if (row.provenance === undefined || row.provenance === null) {
      errors.push(`${where}: missing required field provenance`);
    } else if (!provenances.has(row.provenance)) {
      errors.push(`${where}: provenance "${row.provenance}" is not one of ${[...provenances].join(', ')}`);
    }
    if (row.confidence === undefined || row.confidence === null) {
      errors.push(`${where}: missing required field confidence`);
    } else if (!confidences.has(row.confidence)) {
      errors.push(`${where}: confidence "${row.confidence}" is not one of ${[...confidences].join(', ')}`);
    }
    if (typeof row.owner !== 'string' || row.owner.trim() === '') {
      errors.push(`${where}: owner must be a non-empty string`);
    }
    if (row.device_class !== undefined && !deviceClasses.has(row.device_class)) {
      errors.push(`${where}: device_class "${row.device_class}" is not one of ${[...deviceClasses].join(', ')}`);
    }
    if (row.captured_at !== undefined && !Number.isFinite(Date.parse(row.captured_at))) {
      errors.push(`${where}: captured_at "${row.captured_at}" is not a parseable timestamp`);
    }
    if (row.expires_at !== undefined && !Number.isFinite(Date.parse(row.expires_at))) {
      errors.push(`${where}: expires_at "${row.expires_at}" is not a parseable timestamp`);
    }

    const fieldPath = typeof row.field_path === 'string' ? row.field_path : '';
    const isStoreField = storePaths.has(fieldPath.split('.').slice(0, 2).join('.')) && !pagePaths.has(fieldPath.split('.').slice(0, 2).join('.'));
    if (isStoreField && row.template_key !== undefined && row.template_key !== null && row.template_key !== '') {
      errors.push(`${where}: store field_path "${fieldPath}" must not carry a template_key (store descriptors are per-site)`);
    }

    if (errors.some((e) => e.startsWith(`${where}:`))) return;

    // value may be anything; undefined/null is Unknown ('null'). A
    // pre-serialized value_json string passes through untouched.
    let valueJson;
    if (row.value !== undefined && row.value !== null) {
      valueJson = JSON.stringify(row.value);
    } else if (typeof row.value_json === 'string') {
      valueJson = row.value_json;
    } else {
      valueJson = 'null';
    }

    /** @type {import('./ports/persistence.js').AeDescriptorRow} */
    const out = {
      idsite: row.idsite,
      device_class: row.device_class ?? 'all',
      field_path: fieldPath,
      value_json: valueJson,
      provenance: row.provenance,
      confidence: row.confidence,
      human_confirmed_by: row.human_confirmed_by ?? '',
      owner: row.owner,
      captured_at: row.captured_at ?? capturedDefault,
      expires_at: row.expires_at ?? (row.captured_at ? new Date(Date.parse(row.captured_at) + DESCRIPTOR_EXPIRY_DAYS * DAY_MS).toISOString() : expiresDefault),
    };
    // Page fields key by template family; a URL override keys
    // 'url:<idsitehsr>' (§7.1). Store fields never carry a template_key.
    if (!isStoreField) {
      out.template_key =
        row.template_key ?? (row.idsitehsr !== undefined ? `url:${row.idsitehsr}` : 'template');
    }
    rows.push(out);
  });

  return { rows, errors };
}
