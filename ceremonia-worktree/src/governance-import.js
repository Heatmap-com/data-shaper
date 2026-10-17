import { createHash, randomUUID } from 'node:crypto';
import { DESCRIPTOR_EXPIRY_DAYS } from './descriptor-import.js';
import { KINDS } from './experiments/normalize.js';

/**
 * Governance import (data-capture-plan.md §9.6, Phase 5 write path).
 * One JSON array, five row kinds, all operator-supplied (L8):
 *
 * - experiment      → ae_experiment (O04). ORDER BY (idsite, experiment_id):
 *                     re-importing the same experiment replaces it.
 * - experiment_descriptor → ae_experiment_descriptor, provenance
 *                     `operator`: hypothesis, dates, scope, pages, elements,
 *                     rollup zones, and arms for one experiment_key. The next
 *                     experiment-analysis run applies it over what it infers.
 * - review_verdict  → ae_review_verdict (O05). verdict_id is a uuid when the
 *                     row omits it; ORDER BY includes verdict_id so an
 *                     omitted-id row never collides with itself.
 * - change          → ae_change_log (O06). change_id is the deterministic
 *                     sha1 of "change_kind|subject|effective_at", so a
 *                     re-imported change replaces instead of duplicating.
 * - calendar_event  → ae_store_descriptor rows, field_path 's35.calendar',
 *                     one row per event (O03). Calendar rows ride
 *                     writeDescriptorRows; descriptor_version is left to the
 *                     adapter default. Operator fields expire (§7):
 *                     expires_at defaults to captured_at + 90 days.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

const TEST_CODES = new Set(['AB', 'SEG-AB', 'ROT', 'FIX', 'HOLD', 'INSTR', 'DEST']);
const EXPERIMENT_STATUSES = new Set(['planned', 'running', 'concluded', 'stopped']);
const ANALYSIS_PLANS = new Set(['fixed', 'sequential']);
const VERDICT_OUTCOMES = new Set(['pass', 'fail', 'inconclusive']);
const DESCRIPTOR_KINDS = new Set(KINDS);
const DESCRIPTOR_SCOPES = new Set(['site', 'template', 'page', 'redirect', 'script']);
const DEVICE_SCOPES = new Set(['', 'mobile', 'desktop']);
const ZONE_ROLES = new Set(['treated', 'guardrail']);
const TEMPLATES = new Set(['home', 'pdp', 'plp', 'cart', 'search', 'content', 'checkout', 'account', 'other']);

/**
 * @param {unknown} json parsed JSON (or a JSON string) of the import file
 * @param {{ now?: Date }} [opts]
 * @returns {{
 *   experiments: Array<import('./ports/persistence.js').AeExperimentRow>,
 *   experimentDescriptors: Array<import('./ports/persistence.js').AeExperimentDescriptorRow>,
 *   verdicts: Array<import('./ports/persistence.js').AeReviewVerdictRow>,
 *   changes: Array<import('./ports/persistence.js').AeChangeRow>,
 *   descriptorRows: Array<import('./ports/persistence.js').AeDescriptorRow>,
 *   errors: string[],
 * }}
 */
export function parseGovernanceImport(json, opts = {}) {
  const now = opts.now ?? new Date();
  const capturedDefault = now.toISOString();
  const expiresDefault = new Date(now.getTime() + DESCRIPTOR_EXPIRY_DAYS * DAY_MS).toISOString();

  let data = json;
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data);
    } catch (err) {
      return { experiments: [], experimentDescriptors: [], verdicts: [], changes: [], descriptorRows: [], errors: [`not valid JSON: ${err.message}`] };
    }
  }
  if (!Array.isArray(data)) {
    return { experiments: [], experimentDescriptors: [], verdicts: [], changes: [], descriptorRows: [], errors: ['expected a JSON array of governance rows'] };
  }

  /** @type {Array<import('./ports/persistence.js').AeExperimentRow>} */
  const experiments = [];
  /** @type {Array<import('./ports/persistence.js').AeExperimentDescriptorRow>} */
  const experimentDescriptors = [];
  /** @type {Array<import('./ports/persistence.js').AeReviewVerdictRow>} */
  const verdicts = [];
  /** @type {Array<import('./ports/persistence.js').AeChangeRow>} */
  const changes = [];
  /** @type {Array<import('./ports/persistence.js').AeDescriptorRow>} */
  const descriptorRows = [];
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
    switch (row.kind) {
      case 'experiment': {
        if (typeof row.experiment_id !== 'string' || row.experiment_id.trim() === '') {
          errors.push(`${where}: experiment_id must be a non-empty string`);
        }
        if (!Array.isArray(row.arms) || row.arms.length === 0) {
          errors.push(`${where}: arms must be a non-empty array of {arm, allocation}`);
        } else {
          row.arms.forEach((arm, j) => {
            if (arm === null || typeof arm !== 'object' || typeof arm.arm !== 'string' || arm.arm.trim() === '') {
              errors.push(`${where}: arms[${j}] needs a non-empty arm`);
            } else if (arm.allocation !== undefined && !(Number.isFinite(arm.allocation) && arm.allocation >= 0 && arm.allocation <= 1)) {
              errors.push(`${where}: arms[${j}].allocation must be a number between 0 and 1`);
            }
          });
        }
        if (row.test_code !== undefined && !TEST_CODES.has(row.test_code)) {
          errors.push(`${where}: test_code "${row.test_code}" is not one of ${[...TEST_CODES].join(', ')}`);
        }
        if (row.status !== undefined && !EXPERIMENT_STATUSES.has(row.status)) {
          errors.push(`${where}: status "${row.status}" is not one of ${[...EXPERIMENT_STATUSES].join(', ')}`);
        }
        if (row.analysis_plan !== undefined && !ANALYSIS_PLANS.has(row.analysis_plan)) {
          errors.push(`${where}: analysis_plan "${row.analysis_plan}" is not one of ${[...ANALYSIS_PLANS].join(', ')}`);
        }
        if (row.mde !== undefined && !Number.isFinite(row.mde)) {
          errors.push(`${where}: mde must be a number`);
        }
        if (row.started_at !== undefined && !Number.isFinite(Date.parse(row.started_at))) {
          errors.push(`${where}: started_at "${row.started_at}" is not a parseable timestamp`);
        }
        if (errors.some((e) => e.startsWith(`${where}:`))) return;
        experiments.push({
          idsite: row.idsite,
          experimentId: row.experiment_id,
          source: row.source ?? 'operator',
          partner: row.partner ?? '',
          name: row.name ?? '',
          unit: row.unit ?? '',
          arms: row.arms.map((a) => ({ arm: a.arm, description: a.description ?? '', allocation: a.allocation ?? null })),
          testCode: row.test_code ?? '',
          mde: row.mde ?? null,
          analysisPlan: row.analysis_plan ?? '',
          startedAt: row.started_at ?? null,
          status: row.status ?? 'planned',
        });
        return;
      }
      case 'review_verdict': {
        for (const field of ['subject_kind', 'subject_ref', 'verdict_kind', 'reviewed_by']) {
          if (typeof row[field] !== 'string' || row[field].trim() === '') {
            errors.push(`${where}: ${field} must be a non-empty string`);
          }
        }
        if (row.outcome === undefined || row.outcome === null) {
          errors.push(`${where}: missing required field outcome`);
        } else if (!VERDICT_OUTCOMES.has(row.outcome)) {
          errors.push(`${where}: outcome "${row.outcome}" is not one of ${[...VERDICT_OUTCOMES].join(', ')}`);
        }
        if (row.verdict_id !== undefined && (typeof row.verdict_id !== 'string' || row.verdict_id.trim() === '')) {
          errors.push(`${where}: verdict_id must be a non-empty string`);
        }
        if (row.sample_size !== undefined && !(Number.isInteger(row.sample_size) && row.sample_size >= 0)) {
          errors.push(`${where}: sample_size must be a non-negative integer`);
        }
        if (row.agreement_rate !== undefined && !(Number.isFinite(row.agreement_rate) && row.agreement_rate >= 0 && row.agreement_rate <= 1)) {
          errors.push(`${where}: agreement_rate must be a number between 0 and 1`);
        }
        if (row.expires_at !== undefined && !Number.isFinite(Date.parse(row.expires_at))) {
          errors.push(`${where}: expires_at "${row.expires_at}" is not a parseable timestamp`);
        }
        if (errors.some((e) => e.startsWith(`${where}:`))) return;
        verdicts.push({
          idsite: row.idsite,
          verdictId: row.verdict_id ?? randomUUID(),
          subjectKind: row.subject_kind,
          subjectRef: row.subject_ref,
          verdictKind: row.verdict_kind,
          outcome: row.outcome,
          population: row.population ?? '',
          sampleSize: row.sample_size ?? 0,
          agreementRate: row.agreement_rate ?? null,
          reviewedBy: row.reviewed_by,
          reviewedAt: capturedDefault,
          expiresAt: row.expires_at ?? null,
        });
        return;
      }
      case 'change': {
        for (const field of ['change_kind', 'effective_at', 'subject']) {
          if (row[field] === undefined || row[field] === null || row[field] === '') {
            errors.push(`${where}: missing required field ${field}`);
          }
        }
        if (row.effective_at !== undefined && row.effective_at !== null && !Number.isFinite(Date.parse(row.effective_at))) {
          errors.push(`${where}: effective_at "${row.effective_at}" is not a parseable timestamp`);
        }
        if (errors.some((e) => e.startsWith(`${where}:`))) return;
        changes.push({
          idsite: row.idsite,
          change_id: changeId(row.change_kind, row.subject, row.effective_at),
          change_kind: row.change_kind,
          effective_at: row.effective_at,
          detected_at: row.detected_at ?? row.effective_at,
          source: row.source ?? 'operator',
          subject: row.subject,
          detail: row.detail ?? {},
        });
        return;
      }
      case 'calendar_event': {
        if (typeof row.name !== 'string' || row.name.trim() === '') {
          errors.push(`${where}: name must be a non-empty string`);
        }
        if (row.window === null || typeof row.window !== 'object' || Array.isArray(row.window)) {
          errors.push(`${where}: window must be an object {start, end}`);
        } else {
          for (const field of ['start', 'end']) {
            if (row.window[field] === undefined || row.window[field] === null || row.window[field] === '') {
              errors.push(`${where}: window.${field} is required`);
            }
          }
        }
        if (errors.some((e) => e.startsWith(`${where}:`))) return;
        const event = { name: row.name, window: { start: row.window.start, end: row.window.end } };
        if (row.flags !== undefined) event.flags = row.flags;
        descriptorRows.push({
          idsite: row.idsite,
          field_path: 's35.calendar',
          value_json: JSON.stringify(event),
          provenance: 'operator',
          confidence: 'high',
          human_confirmed_by: '',
          owner: 'operator',
          captured_at: capturedDefault,
          expires_at: expiresDefault,
        });
        return;
      }
      case 'experiment_descriptor': {
        const descriptor = experimentDescriptor(row, where, errors);
        if (descriptor) experimentDescriptors.push(descriptor);
        return;
      }
      default:
        errors.push(`${where}: kind "${row.kind}" is not one of experiment, experiment_descriptor, review_verdict, change, calendar_event`);
    }
  });

  return { experiments, experimentDescriptors, verdicts, changes, descriptorRows, errors };
}

/**
 * One operator experiment descriptor, or null with the errors pushed.
 * @param {Record<string, any>} row
 * @param {string} where
 * @param {string[]} errors
 * @returns {import('./ports/persistence.js').AeExperimentDescriptorRow | null}
 */
function experimentDescriptor(row, where, errors) {
  const before = errors.length;
  const fail = (message) => errors.push(`${where}: ${message}`);
  if (typeof row.experiment_key !== 'string' || !/^[a-z0-9_-]+:.+$/i.test(row.experiment_key.trim())) {
    fail('experiment_key must be "{partner}:{partner experiment id}", as the experiment-analysis rows show it');
  }
  for (const field of ['name', 'hypothesis', 'description']) {
    if (row[field] !== undefined && typeof row[field] !== 'string') fail(`${field} must be a string`);
  }
  if (row.experiment_kind !== undefined && !DESCRIPTOR_KINDS.has(row.experiment_kind)) {
    fail(`experiment_kind "${row.experiment_kind}" is not one of ${[...DESCRIPTOR_KINDS].join(', ')}`);
  }
  if (row.scope !== undefined && !DESCRIPTOR_SCOPES.has(row.scope)) {
    fail(`scope "${row.scope}" is not one of ${[...DESCRIPTOR_SCOPES].join(', ')}`);
  }
  if (row.device_scope !== undefined && !DEVICE_SCOPES.has(row.device_scope)) {
    fail(`device_scope "${row.device_scope}" is not one of mobile, desktop, or ''`);
  }
  if (row.templates !== undefined && !(Array.isArray(row.templates) && row.templates.every((t) => TEMPLATES.has(t)))) {
    fail(`templates must be an array of ${[...TEMPLATES].join(', ')}`);
  }
  if (row.pages !== undefined && !(Array.isArray(row.pages) && row.pages.every((p) => Number.isInteger(p) && p > 0))) {
    fail('pages must be an array of positive idsitehsr integers');
  }
  if (row.elements !== undefined) {
    if (!Array.isArray(row.elements)) {
      fail('elements must be an array of {selector, idsitehsr?, arm?, element_class?}');
    } else {
      row.elements.forEach((el, j) => {
        if (el === null || typeof el !== 'object' || typeof el.selector !== 'string' || el.selector.trim() === '') {
          fail(`elements[${j}] needs a non-empty selector`);
        } else if (el.idsitehsr !== undefined && !(Number.isInteger(el.idsitehsr) && el.idsitehsr > 0)) {
          fail(`elements[${j}].idsitehsr must be a positive integer`);
        } else if (el.section !== undefined && typeof el.section !== 'string') {
          fail(`elements[${j}].section must be a section name`);
        }
      });
    }
  }
  if (row.zones !== undefined) {
    if (!Array.isArray(row.zones)) {
      fail('zones must be an array of {section, role?}');
    } else {
      row.zones.forEach((zone, j) => {
        if (zone === null || typeof zone !== 'object' || typeof zone.section !== 'string' || zone.section.trim() === '') {
          fail(`zones[${j}] needs a non-empty section (the section_name the section tracker reports)`);
        } else if (zone.role !== undefined && !ZONE_ROLES.has(zone.role)) {
          fail(`zones[${j}].role "${zone.role}" is not one of ${[...ZONE_ROLES].join(', ')}`);
        }
      });
    }
  }
  if (row.arms !== undefined) {
    if (!Array.isArray(row.arms)) {
      fail('arms must be an array of {arm, label?, is_control?, allocation?, aliases?}');
    } else {
      row.arms.forEach((arm, j) => {
        if (arm === null || typeof arm !== 'object' || typeof arm.arm !== 'string' || arm.arm.trim() === '') {
          fail(`arms[${j}] needs a non-empty arm`);
          return;
        }
        if (arm.allocation !== undefined && arm.allocation !== null && !(Number.isFinite(arm.allocation) && arm.allocation >= 0 && arm.allocation <= 1)) {
          fail(`arms[${j}].allocation must be a number between 0 and 1`);
        }
        if (arm.aliases !== undefined && !(Array.isArray(arm.aliases) && arm.aliases.every((a) => typeof a === 'string'))) {
          fail(`arms[${j}].aliases must be an array of variant ids`);
        }
      });
    }
  }
  for (const field of ['start', 'end']) {
    if (row[field] !== undefined && !(typeof row[field] === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(row[field]) && Number.isFinite(Date.parse(row[field])))) {
      fail(`${field} must be a YYYY-MM-DD date`);
    }
  }
  if (row.start && row.end && row.end < row.start) fail('end is before start');
  if (errors.length > before) return null;

  const key = row.experiment_key.trim();
  const separator = key.indexOf(':');
  return {
    idsite: row.idsite,
    experimentKey: key,
    provenance: 'operator',
    partner: key.slice(0, separator),
    partnerExperimentId: key.slice(separator + 1),
    name: row.name ?? '',
    hypothesis: row.hypothesis ?? '',
    description: row.description ?? '',
    kind: row.experiment_kind ?? '',
    scope: row.scope ?? '',
    scopeSource: row.scope ? 'operator' : '',
    deviceScope: row.device_scope ?? '',
    templates: row.templates ?? [],
    pages: row.pages ?? [],
    elements: (row.elements ?? []).map((el) => ({
      selector: el.selector.trim(),
      ...(el.idsitehsr ? { idsitehsr: el.idsitehsr } : {}),
      ...(el.arm ? { arm: String(el.arm) } : {}),
      ...(el.element_class ? { element_class: String(el.element_class) } : {}),
      ...(el.section ? { section: el.section.trim() } : {}),
    })),
    zones: (row.zones ?? []).map((zone) => ({ section: zone.section.trim(), role: zone.role ?? 'treated' })),
    arms: (row.arms ?? []).map((arm) => ({
      arm: arm.arm.trim(),
      ...(arm.label !== undefined ? { label: String(arm.label) } : {}),
      ...(arm.is_control !== undefined ? { is_control: arm.is_control === true } : {}),
      allocation: arm.allocation ?? null,
      aliases: arm.aliases ?? [],
    })),
    declaredStart: row.start ?? null,
    declaredEnd: row.end ?? null,
    observedStart: null,
    observedEnd: null,
    lastSeen: null,
    peakDailyVisits: 0,
    assignedVisits: 0,
    status: '',
    statusAsOf: null,
    metrics: {},
  };
}

/**
 * Deterministic ae_change_log change_id (plan §8.4.3): sha1 of
 * "change_kind|subject|effective_at". The same change re-imported replaces
 * its ReplacingMergeTree row instead of duplicating it.
 * @param {string} changeKind
 * @param {string} subject
 * @param {string} effectiveAt
 */
export function changeId(changeKind, subject, effectiveAt) {
  return createHash('sha1').update(`${changeKind}|${subject}|${effectiveAt}`).digest('hex');
}
