import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { criteriaSchemaErrors } from './domain/criteria.js';
import { SUBJECT_TYPES, isSubjectType } from './domain/subject-types.js';

/**
 * Human-readable description of an adapter. It lives in
 * `<module>.descriptor.json` beside the module. The adapter module does not
 * repeat these fields.
 *
 * @typedef {Object} AdapterDescriptor
 * @property {string} id
 * @property {string} purpose what the adapter is for
 * @property {string} data what each row or element means
 * @property {ReplayMode} [replay] what replay does with the adapter's rows; every dataset declares one
 * @property {DatasetRole} [role] a dataset the pipeline treats apart from the readers
 * @property {string} [catalogId] the catalog a `card` dataset writes cards for
 * @property {object} [criteria] a subject selector's criteria schema (src/domain/criteria.js)
 */

/**
 * `card` datasets write strategy cards for their catalogId. The
 * `requirements` dataset reads the readiness of the others and runs again
 * after the site datasets.
 * @typedef {'card' | 'requirements'} DatasetRole
 */

export const DATASET_ROLES = Object.freeze(['card', 'requirements']);

/**
 * `keep` loads the stored rows, `restamp` rewrites their element classes from
 * the current bindings, and `recollect` runs the adapter again.
 * @typedef {'keep' | 'restamp' | 'recollect'} ReplayMode
 */

export const REPLAY_MODES = Object.freeze(['keep', 'restamp', 'recollect']);

/**
 * Adapter loader. The runner passes a directory; it never lists the modules
 * inside it. A file is an adapter when it ends in .js, does not start with
 * `_`, and does not end in .test.js. Each file exports `adapter`, or an
 * `adapters` array when one file holds more than one. Purpose and the
 * meaning of the data are read from the sibling descriptor file and attached
 * as `adapter.descriptor`. Discovery order is filename order.
 *
 * @param {string} dir
 * @returns {Promise<object[]>} discovered adapters, sorted by filename
 */
export async function discoverAdapters(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = entries
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .filter((name) => name.endsWith('.js') && !name.startsWith('_') && !name.endsWith('.test.js'))
    .sort();

  /** @type {object[]} */
  const adapters = [];
  const seen = new Map();
  for (const file of files) {
    const url = pathToFileURL(path.join(dir, file));
    const mod = await import(url.href);
    const exported = Array.isArray(mod.adapters) ? mod.adapters : [mod.adapter];
    if (exported.length === 0 || exported.some((adapter) => !adapter || typeof adapter !== 'object')) {
      throw new Error(`${file}: expected an exported \`adapter\` object`);
    }
    for (const adapter of exported) {
      if (typeof adapter.id !== 'string' || adapter.id.length === 0) {
        throw new Error(`${file}: adapter is missing a string \`id\``);
      }
      if (Object.hasOwn(adapter, 'purpose') || Object.hasOwn(adapter, 'data')) {
        throw new Error(`${file}: adapter "${adapter.id}" hardcodes purpose or data; those fields belong in its descriptor`);
      }
    }
    const descriptors = await loadDescriptorFile(dir, file);
    for (const adapter of exported) {
      const descriptor = descriptors.get(adapter.id);
      if (!descriptor) {
        throw new Error(`${file}: descriptor has no entry for adapter "${adapter.id}"`);
      }
      if (seen.has(adapter.id)) {
        throw new Error(`duplicate adapter id "${adapter.id}" in ${seen.get(adapter.id)} and ${file}`);
      }
      seen.set(adapter.id, file);
      adapter.descriptor = descriptor;
      adapters.push(adapter);
    }
  }
  return adapters;
}

/**
 * @param {string} dir
 * @param {string} file adapter module filename
 * @returns {Promise<Map<string, AdapterDescriptor>>}
 */
async function loadDescriptorFile(dir, file) {
  const descriptorFile = file.replace(/\.js$/, '.descriptor.json');
  let raw;
  try {
    raw = await readFile(path.join(dir, descriptorFile), 'utf8');
  } catch (err) {
    if (err && /** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') {
      throw new Error(`${file}: missing ${descriptorFile}`);
    }
    throw err;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${descriptorFile}: descriptor is not valid JSON`);
  }
  const entries = Array.isArray(parsed?.adapters) ? parsed.adapters : [parsed];
  /** @type {Map<string, AdapterDescriptor>} */
  const byId = new Map();
  for (const entry of entries) {
    if (!entry || typeof entry.id !== 'string' || entry.id.length === 0) {
      throw new Error(`${descriptorFile}: a descriptor entry is missing a string id`);
    }
    if (typeof entry.purpose !== 'string' || entry.purpose.trim() === '') {
      throw new Error(`${descriptorFile}: adapter "${entry.id}" is missing a human-readable purpose`);
    }
    if (typeof entry.data !== 'string' || entry.data.trim() === '') {
      throw new Error(`${descriptorFile}: adapter "${entry.id}" is missing a human-readable description of its data`);
    }
    if (byId.has(entry.id)) {
      throw new Error(`${descriptorFile}: duplicate descriptor id "${entry.id}"`);
    }
    if (entry.replay !== undefined && !REPLAY_MODES.includes(entry.replay)) {
      throw new Error(`${descriptorFile}: adapter "${entry.id}" has replay "${entry.replay}"; expected one of ${REPLAY_MODES.join(', ')}`);
    }
    if (entry.role !== undefined && !DATASET_ROLES.includes(entry.role)) {
      throw new Error(`${descriptorFile}: adapter "${entry.id}" has role "${entry.role}"; expected one of ${DATASET_ROLES.join(', ')}`);
    }
    if (entry.role === 'card' && (typeof entry.catalogId !== 'string' || entry.catalogId === '')) {
      throw new Error(`${descriptorFile}: card adapter "${entry.id}" is missing a catalogId`);
    }
    /** @type {AdapterDescriptor} */
    const descriptor = { id: entry.id, purpose: entry.purpose, data: entry.data };
    if (entry.replay !== undefined) descriptor.replay = entry.replay;
    if (entry.role !== undefined) descriptor.role = entry.role;
    if (entry.catalogId !== undefined) descriptor.catalogId = entry.catalogId;
    if (entry.criteria !== undefined) descriptor.criteria = entry.criteria;
    byId.set(entry.id, descriptor);
  }
  return byId;
}

/**
 * Dataset adapters, topologically sorted on dependsOn. A cycle, a missing
 * dependency, or a descriptor without a replay mode fails startup; the error
 * names the ids.
 *
 * @param {string} dir
 * @returns {Promise<object[]>}
 */
export async function discoverDatasets(dir) {
  const adapters = await discoverAdapters(dir);
  const unplanned = adapters.filter((a) => !a.descriptor.replay).map((a) => a.id);
  if (unplanned.length > 0) {
    throw new Error(`datasets without a replay mode in their descriptor: ${unplanned.join(', ')}`);
  }
  const byId = new Map(adapters.map((a) => [a.id, a]));
  const sorted = [];
  const state = new Map(); // id -> 'visiting' | 'done'

  /** @param {object} adapter @param {string[]} trail */
  function visit(adapter, trail) {
    const mark = state.get(adapter.id);
    if (mark === 'done') return;
    if (mark === 'visiting') {
      const cycle = [...trail, adapter.id].join(' -> ');
      throw new Error(`dataset dependency cycle: ${cycle}`);
    }
    state.set(adapter.id, 'visiting');
    const deps = Array.isArray(adapter.dependsOn) ? adapter.dependsOn : [];
    for (const dep of deps) {
      if (dep === adapter.id) {
        throw new Error(`dataset "${adapter.id}" depends on itself`);
      }
      const target = byId.get(dep);
      if (!target) {
        throw new Error(`dataset "${adapter.id}" depends on missing dataset "${dep}"`);
      }
      visit(target, [...trail, adapter.id]);
    }
    state.set(adapter.id, 'done');
    sorted.push(adapter);
  }

  for (const adapter of adapters) visit(adapter, []);
  return sorted;
}

/**
 * Subject selectors. Each names a registered subject type, and its
 * descriptor carries the criteria schema `--select` is checked against.
 * @param {string} dir
 * @returns {Promise<object[]>}
 */
export async function discoverSubjectSelectors(dir) {
  const adapters = await discoverAdapters(dir);
  for (const adapter of adapters) {
    if (!isSubjectType(adapter.subjectType)) {
      throw new Error(`subject selector "${adapter.id}" has subjectType "${adapter.subjectType}"; known: ${Object.keys(SUBJECT_TYPES).join(', ')}`);
    }
    if (adapter.descriptor.criteria === undefined) {
      throw new Error(`subject selector "${adapter.id}" has no criteria schema in its descriptor`);
    }
    const errors = criteriaSchemaErrors(adapter.descriptor.criteria, adapter.id);
    if (errors.length > 0) throw new Error(`subject selector "${adapter.id}" criteria: ${errors.join('; ')}`);
  }
  return adapters;
}

/**
 * Every adapter role under src/adapters. A role is a directory whose name
 * does not start with `_`. Datasets are ordered by dependsOn. Importance
 * descriptors are ordered by priority. A new directory is mounted on the
 * next start with no change here.
 *
 * @param {string} root
 * @returns {Promise<Array<{role: string, adapters: object[]}>>}
 */
export async function discoverAdapterRoles(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const names = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('_'))
    .map((entry) => entry.name)
    .sort();
  /** @type {Array<{role: string, adapters: object[]}>} */
  const roles = [];
  for (const role of names) {
    const dir = path.join(root, role);
    const adapters = role === 'datasets'
      ? await discoverDatasets(dir)
      : role === 'importance'
        ? await discoverImportance(dir)
        : role === 'subject-selectors'
          ? await discoverSubjectSelectors(dir)
          : await discoverAdapters(dir);
    roles.push({ role, adapters });
  }
  return roles;
}

/**
 * One log line per mounted adapter. The message carries the purpose; the
 * data field carries what the rows mean.
 * @param {{info: Function}} logger
 * @param {Array<{role: string, adapters: object[]}>} roles
 */
export function mountAdapters(logger, roles) {
  for (const { role, adapters } of roles) {
    for (const adapter of adapters) {
      const descriptor = adapter.descriptor;
      if (!descriptor?.purpose) {
        throw new Error(`adapter "${adapter.id}" has no descriptor purpose`);
      }
      logger.info(
        { role, id: adapter.id, purpose: descriptor.purpose, data: descriptor.data },
        `mounted ${role} adapter ${adapter.id}: ${descriptor.purpose}`,
      );
    }
  }
}

/** @param {Array<{role: string, adapters: object[]}>} roles @param {string} role */
export function adaptersIn(roles, role) {
  return roles.find((item) => item.role === role)?.adapters ?? [];
}

async function discoverImportance(dir) {
  const { discoverImportance: load } = await import('./importance/discover.js');
  return load(dir);
}

/**
 * Adapter selection by environment variable. There is no switch: an unknown
 * id fails startup and prints the ids that were found.
 *
 * @param {object[]} adapters
 * @param {string | undefined} wanted
 * @param {string} envVar
 * @returns {object}
 */
export function selectAdapter(adapters, wanted, envVar) {
  const id = wanted && wanted.trim() !== '' ? wanted.trim() : undefined;
  if (!id) {
    throw new Error(`${envVar} is not set; discovered ids: ${adapters.map((a) => a.id).join(', ') || '(none)'}`);
  }
  const found = adapters.find((a) => a.id === id);
  if (!found) {
    throw new Error(`unknown ${envVar}="${id}"; discovered ids: ${adapters.map((a) => a.id).join(', ') || '(none)'}`);
  }
  return found;
}
