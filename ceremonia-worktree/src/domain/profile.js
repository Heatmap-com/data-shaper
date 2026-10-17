import { isPageShaped, isSubjectType, SUBJECT_TYPES } from './subject-types.js';

/**
 * Execution profiles: data that binds a subject type to a selector, a
 * dataset set, catalogs, and an ordered step list. The runner runs the
 * steps; a profile adds no code path of its own.
 *
 * A profile file is `profiles/<id>.profile.json`:
 *
 *   {
 *     "id": "pdp",
 *     "subject_type": "page",
 *     "label": "Product detail pages",
 *     "selector": { "use": "page-by-kind", "criteria": { "kinds": ["product"] } },
 *     "datasets": { "include": ["provides"], "exclude": ["campaign-weekly"] },
 *     "catalogs": ["PI", "PG"],
 *     "steps": ["qualify", "capture-gate", "page-datasets", "descriptors", "site-datasets", "analysis"]
 *   }
 *
 * `selector` null keeps the configured page selector (the `lp` profile).
 * `selector.criteria` are defaults that `--select` overrides; the
 * selector's descriptor holds their schema. `datasets.include` is
 * `["provides"]` (every discovered dataset) or explicit ids; `catalogs` is
 * `"all"` or catalog ids, and keeps only the card datasets of those
 * catalogs.
 */

/**
 * The steps a profile may name, in the order they may run. `pageShaped`
 * steps need page subjects; `keyed` steps need subjects other than pages
 * (experiments, funnels, journeys); `after` names a step that must come
 * earlier. A profile of keyed subjects selects them with select-subjects.
 */
export const PROFILE_STEPS = Object.freeze({
  qualify: Object.freeze({ pageShaped: true }),
  'capture-gate': Object.freeze({ pageShaped: true, after: 'qualify' }),
  'page-datasets': Object.freeze({ pageShaped: true, after: 'capture-gate' }),
  descriptors: Object.freeze({ pageShaped: true, after: 'page-datasets' }),
  'select-subjects': Object.freeze({ keyed: true }),
  'subject-datasets': Object.freeze({ keyed: true, after: 'select-subjects' }),
  'site-datasets': Object.freeze({}),
  analysis: Object.freeze({}),
});

const ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const FIELDS = new Set(['id', 'subject_type', 'label', 'selector', 'datasets', 'catalogs', 'steps']);

export class ProfileError extends Error {
  /**
   * @param {string} message
   * @param {string[]} errors
   */
  constructor(message, errors) {
    super(message);
    this.name = 'ProfileError';
    this.errors = errors;
  }
}

/**
 * @typedef {Object} Profile
 * @property {string} id
 * @property {string} subjectType
 * @property {string} label
 * @property {{use: string, criteria: object} | null} selector
 * @property {{include: string[], exclude: string[]}} datasets
 * @property {string[] | 'all'} catalogs
 * @property {string[]} steps
 */

/**
 * Checks one profile document and returns it frozen in camel case.
 * @param {object} raw the parsed JSON
 * @param {{file: string, catalogIds: string[]}} opts
 * @returns {Readonly<Profile>}
 */
export function parseProfile(raw, { file, catalogIds }) {
  const errors = profileErrors(raw, catalogIds);
  if (errors.length > 0) throw new ProfileError(`${file}: ${errors.join('; ')}`, errors);
  return deepFreeze({
    id: raw.id,
    subjectType: raw.subject_type,
    label: raw.label,
    selector: raw.selector ? { use: raw.selector.use, criteria: { ...(raw.selector.criteria ?? {}) } } : null,
    datasets: { include: [...raw.datasets.include], exclude: [...(raw.datasets.exclude ?? [])] },
    catalogs: raw.catalogs === 'all' ? 'all' : [...raw.catalogs],
    steps: [...raw.steps],
  });
}

/**
 * Profiles by id. Ids are unique, and each file is named for its id.
 * @param {Array<{file: string, raw: object}>} documents
 * @param {string[]} catalogIds
 * @returns {Map<string, Readonly<Profile>>}
 */
export function profilesById(documents, catalogIds) {
  const byId = new Map();
  for (const { file, raw } of documents) {
    const profile = parseProfile(raw, { file, catalogIds });
    const named = file.split('/').pop().replace(/\.profile\.json$/, '');
    if (named !== profile.id) throw new ProfileError(`${file}: id "${profile.id}" differs from the file name "${named}"`, []);
    if (byId.has(profile.id)) throw new ProfileError(`${file}: duplicate profile id "${profile.id}"`, []);
    byId.set(profile.id, profile);
  }
  return byId;
}

/**
 * The text a batch stores and a run compares, so a profile edited after
 * its batch was created is refused at run time.
 * @param {Readonly<Profile>} profile
 */
export function profileFingerprint(profile) {
  return JSON.stringify(sortedKeys(profile));
}

/**
 * @param {object} raw
 * @param {string[]} catalogIds
 * @returns {string[]}
 */
function profileErrors(raw, catalogIds) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return ['a profile is a JSON object'];
  /** @type {string[]} */
  const errors = [];
  for (const key of Object.keys(raw)) {
    if (!FIELDS.has(key)) errors.push(`unknown field "${key}"`);
  }
  if (typeof raw.id !== 'string' || !ID.test(raw.id)) errors.push('id must be kebab-case');
  if (!isSubjectType(raw.subject_type)) {
    errors.push(`subject_type must be one of ${Object.keys(SUBJECT_TYPES).join(', ')}`);
  }
  if (typeof raw.label !== 'string' || raw.label.trim() === '') errors.push('label is required');
  errors.push(...selectorErrors(raw.selector));
  errors.push(...datasetErrors(raw.datasets));
  errors.push(...catalogErrors(raw.catalogs, catalogIds));
  errors.push(...stepErrors(raw.steps, raw.subject_type));
  return errors;
}

function selectorErrors(selector) {
  if (selector === null) return [];
  if (!selector || typeof selector !== 'object' || Array.isArray(selector)) return ['selector is null or {use, criteria}'];
  const errors = Object.keys(selector).filter((k) => k !== 'use' && k !== 'criteria').map((k) => `selector: unknown field "${k}"`);
  if (typeof selector.use !== 'string' || selector.use === '') errors.push('selector.use names a subject selector');
  const { criteria } = selector;
  if (criteria !== undefined && (!criteria || typeof criteria !== 'object' || Array.isArray(criteria))) {
    errors.push('selector.criteria is an object');
  }
  return errors;
}

function datasetErrors(datasets) {
  if (!datasets || typeof datasets !== 'object') return ['datasets is {include, exclude}'];
  const errors = [];
  const { include, exclude = [] } = datasets;
  if (!Array.isArray(include) || include.length === 0 || !include.every((id) => typeof id === 'string')) {
    errors.push('datasets.include lists dataset ids, or is ["provides"]');
  } else if (include.includes('provides') && include.length > 1) {
    errors.push('datasets.include is ["provides"] alone or explicit ids');
  }
  if (!Array.isArray(exclude) || !exclude.every((id) => typeof id === 'string')) errors.push('datasets.exclude lists dataset ids');
  return errors;
}

function catalogErrors(catalogs, catalogIds) {
  if (catalogs === 'all') return [];
  if (!Array.isArray(catalogs) || catalogs.length === 0) return ['catalogs is "all" or catalog ids'];
  const unknown = catalogs.filter((id) => !catalogIds.includes(id));
  return unknown.length > 0 ? [`unknown catalogs ${unknown.join(', ')}; loaded: ${catalogIds.join(', ')}`] : [];
}

function stepErrors(steps, subjectType) {
  if (!Array.isArray(steps) || steps.length === 0) return ['steps lists the steps in order'];
  const errors = [];
  if (isSubjectType(subjectType) && !isPageShaped(subjectType) && !steps.includes('select-subjects')) {
    errors.push(`subject_type ${subjectType} needs the "select-subjects" step`);
  }
  const known = Object.keys(PROFILE_STEPS);
  steps.forEach((step, i) => {
    const rule = PROFILE_STEPS[step];
    if (!rule) {
      errors.push(`unknown step "${step}"; steps: ${known.join(', ')}`);
      return;
    }
    if (steps.indexOf(step) !== i) errors.push(`step "${step}" appears twice`);
    if (rule.pageShaped && isSubjectType(subjectType) && !isPageShaped(subjectType)) {
      errors.push(`step "${step}" needs page subjects; subject_type is ${subjectType}`);
    }
    if (rule.keyed && isPageShaped(subjectType)) {
      errors.push(`step "${step}" needs subjects other than pages; subject_type is ${subjectType}`);
    }
    if (rule.after && !steps.slice(0, i).includes(rule.after)) errors.push(`step "${step}" runs after "${rule.after}"`);
    const later = steps.slice(i + 1).filter((s) => known.indexOf(s) >= 0 && known.indexOf(s) < known.indexOf(step));
    if (later.length > 0) errors.push(`step "${later[0]}" runs before "${step}"`);
  });
  return errors;
}

function sortedKeys(value) {
  if (Array.isArray(value)) return value.map(sortedKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortedKeys(value[key])]));
  }
  return value;
}

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
