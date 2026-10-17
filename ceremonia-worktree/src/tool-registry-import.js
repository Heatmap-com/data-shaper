import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * --tool-registry-import (plan §7.3, V13). Validates operator-supplied
 * ae_tool_registry rows against the seed shape and rejects rows that
 * collide with an existing registry row for the same (idsite, tool)
 * unless the row is an identical re-import (idempotent re-run) or the
 * only change is installed flipping 0 → 1. Positive observations only:
 * a site with no rows carries no tool facts, absence is not evidence.
 *
 * The collision baseline defaults to the Phase 0 seed
 * (src/catalog/tool-registry.seed.json); callers holding current rows
 * (the CLI reads ae_tool_registry_current) pass them as `existing`.
 */

export const TOOL_SLUG_RE = /^[a-z0-9_]+$/;
export const REVENUE_JOIN_CLASSES = ['unknown', 'tool_event', 'order_only'];
export const EVENT_TAXONOMY_STATUSES = ['documented', 'observed', 'undocumented'];
export const API_STATUSES = ['unknown', 'available', 'unavailable', 'partial'];
export const DETECTION_CONFIDENCES = ['low', 'medium', 'high'];

const ARRAY_FIELDS = ['modules', 'surfaces_owned', 'detection_sources'];
const STRING_FIELDS = ['vendor', 'parent_company', 'plan_tier', 'pricing_basis', 'identity_key', 'note'];

/** Fields that define row identity for the collision check, in stable order. */
const IDENTITY_FIELDS = [
  'idsite',
  'tool',
  'vendor',
  'parent_company',
  'installed',
  'modules',
  'plan_tier',
  'pricing_basis',
  'surfaces_owned',
  'identity_key',
  'revenue_join_class',
  'event_taxonomy_status',
  'api_status',
  'detection_sources',
  'detection_confidence',
  'note',
];

const here = path.dirname(fileURLToPath(import.meta.url));

/** The Phase 0 positive observations (one row today: 3228 rebuy). */
export function loadToolRegistrySeed() {
  return JSON.parse(readFileSync(path.join(here, 'catalog', 'tool-registry.seed.json'), 'utf8'));
}

/**
 * @param {unknown} raw
 * @returns {object | null} parsed value when `raw` is a JSON array string or array
 */
function asArray(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Stable seed-shape view of a row; DB rows (snake_case ae_tool_registry
 * columns) and seed rows both normalize here. Defaults keep an omitted
 * optional field equal to an explicitly empty one so identity compares
 * stay meaningful.
 * @param {object} row
 */
export function normalizeToolRegistryRow(row) {
  const normalized = {
    idsite: Number(row.idsite),
    tool: String(row.tool ?? ''),
    vendor: String(row.vendor ?? ''),
    parent_company: String(row.parent_company ?? ''),
    installed: Number(row.installed ?? 0),
    modules: [...(row.modules ?? [])].map(String),
    plan_tier: String(row.plan_tier ?? ''),
    pricing_basis: String(row.pricing_basis ?? ''),
    surfaces_owned: [...(row.surfaces_owned ?? [])].map(String),
    identity_key: String(row.identity_key ?? ''),
    revenue_join_class: String(row.revenue_join_class ?? 'unknown'),
    event_taxonomy_status: String(row.event_taxonomy_status ?? 'undocumented'),
    api_status: String(row.api_status ?? 'unknown'),
    detection_sources: [...(row.detection_sources ?? [])].map(String),
    detection_confidence: String(row.detection_confidence ?? ''),
    note: String(row.note ?? ''),
  };
  return Object.fromEntries(IDENTITY_FIELDS.map((field) => [field, normalized[field]]));
}

/**
 * Validate an import payload against the seed shape and the collision
 * rules. Throws an aggregated error (sibling --descriptor-import style);
 * returns the normalized rows on success.
 *
 * @param {string | object[]} json JSON array of rows, or a JSON string of one
 * @param {object} [options]
 * @param {object[]} [options.existing] registry rows to treat as already
 *   seeded; defaults to the Phase 0 seed file. Pass [] to skip collision
 *   checks (shape validation only).
 * @returns {{ rows: object[] }} normalized rows in the seed shape
 */
export function parseToolRegistryImport(json, options = {}) {
  const rows = asArray(json);
  if (!rows) throw new Error('tool registry import: expected a JSON array of rows');

  const errors = [];
  /** @type {Map<string, object>} */
  const collisionBase = new Map();
  for (const row of options.existing ?? loadToolRegistrySeed()) {
    if (!row || typeof row !== 'object') continue;
    const normalized = normalizeToolRegistryRow(row);
    if (!Number.isInteger(normalized.idsite) || normalized.idsite <= 0 || normalized.tool === '') continue;
    collisionBase.set(`${normalized.idsite}:${normalized.tool}`, normalized);
  }

  const valid = [];
  rows.forEach((row, i) => {
    const where = `row ${i}`;
    const rowErrors = [];
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      errors.push(`${where}: not an object`);
      return;
    }
    if (!Number.isInteger(row.idsite) || row.idsite <= 0) {
      rowErrors.push(`${where}: idsite must be a positive integer`);
    }
    if (typeof row.tool !== 'string' || !TOOL_SLUG_RE.test(row.tool)) {
      rowErrors.push(`${where}: tool must be a lowercase slug matching ${TOOL_SLUG_RE}`);
    }
    if (row.installed !== 0 && row.installed !== 1) {
      rowErrors.push(`${where}: installed must be 0 or 1`);
    }
    for (const field of STRING_FIELDS) {
      if (row[field] !== undefined && typeof row[field] !== 'string') {
        rowErrors.push(`${where}: ${field} must be a string`);
      }
    }
    for (const field of ARRAY_FIELDS) {
      if (row[field] !== undefined && (!Array.isArray(row[field]) || row[field].some((v) => typeof v !== 'string'))) {
        rowErrors.push(`${where}: ${field} must be an array of strings`);
      }
    }
    if (row.revenue_join_class !== undefined && !REVENUE_JOIN_CLASSES.includes(row.revenue_join_class)) {
      rowErrors.push(`${where}: revenue_join_class "${row.revenue_join_class}" is not one of ${REVENUE_JOIN_CLASSES.join(', ')}`);
    }
    if (row.event_taxonomy_status !== undefined && !EVENT_TAXONOMY_STATUSES.includes(row.event_taxonomy_status)) {
      rowErrors.push(`${where}: event_taxonomy_status "${row.event_taxonomy_status}" is not one of ${EVENT_TAXONOMY_STATUSES.join(', ')}`);
    }
    if (row.api_status !== undefined && !API_STATUSES.includes(row.api_status)) {
      rowErrors.push(`${where}: api_status "${row.api_status}" is not one of ${API_STATUSES.join(', ')}`);
    }
    if (
      row.detection_confidence !== undefined &&
      row.detection_confidence !== '' &&
      !DETECTION_CONFIDENCES.includes(row.detection_confidence)
    ) {
      rowErrors.push(`${where}: detection_confidence "${row.detection_confidence}" is not one of ${DETECTION_CONFIDENCES.join(', ')}`);
    }
    if (row.verified_by_walk_at !== undefined && row.verified_by_walk_at !== null && typeof row.verified_by_walk_at !== 'string') {
      rowErrors.push(`${where}: verified_by_walk_at must be an ISO timestamp string or null`);
    }
    if (rowErrors.length > 0) {
      errors.push(...rowErrors);
      return;
    }

    const normalized = normalizeToolRegistryRow(row);
    const existing = collisionBase.get(`${normalized.idsite}:${normalized.tool}`);
    if (existing) {
      const identical = JSON.stringify(normalized) === JSON.stringify(existing);
      const flipToInstalled = existing.installed === 0 && normalized.installed === 1;
      if (!identical && !flipToInstalled) {
        errors.push(
          `${where}: (${normalized.idsite}, "${normalized.tool}") collides with the seeded registry row; ` +
            'only an identical re-import or an installed 0→1 flip is allowed',
        );
        return;
      }
    }
    valid.push(normalized);
  });

  if (errors.length > 0) {
    throw new Error(`tool registry import validation failed (${errors.length} error(s)):\n${errors.slice(0, 20).join('\n')}`);
  }
  return { rows: valid };
}
