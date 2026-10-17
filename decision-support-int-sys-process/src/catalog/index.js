import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The catalog bundle: requirement registry, strategy catalogs, base sets,
 * crosswalk, screen rules, standards, descriptor schema, event contract,
 * funnels.
 * Loaded once, validated, deep-frozen. The coverage test (§13) checks the
 * invariants; Phase 2 seeds the reference tables from this bundle.
 */

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Where the catalog files come from.
 * @typedef {Object} CatalogSource
 * @property {(name: string) => object} read parsed JSON for a file name such as `requirements.json` or `strategies/lp.json`
 * @property {() => string[]} strategyFiles the strategy catalog file names, as `strategies/<file>.json`
 */

/**
 * The catalog files in a directory: the shipped catalog by default.
 * @param {string} [dir]
 * @returns {CatalogSource}
 */
export function directoryCatalogSource(dir = here) {
  return {
    read: (name) => JSON.parse(readFileSync(path.join(dir, name), 'utf8')),
    strategyFiles: () => readdirSync(path.join(dir, 'strategies'))
      .filter((file) => file.endsWith('.json'))
      .map((file) => path.join('strategies', file)),
  };
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function validate(bundle) {
  const errors = [];
  const registryKeys = new Set(bundle.requirements.requirements.map((r) => r.key));
  if (registryKeys.size !== bundle.requirements.requirements.length) {
    errors.push('requirement registry has duplicate keys');
  }

  const seen = new Set();
  for (const catalog of Object.values(bundle.strategies)) {
    for (const strategy of catalog.strategies) {
      const fullId = `${catalog.catalog_id}:${strategy.id}`;
      if (seen.has(fullId)) errors.push(`duplicate strategy id ${fullId}`);
      seen.add(fullId);
      for (const key of strategy.requirement_keys) {
        if (!registryKeys.has(key)) {
          errors.push(`${fullId} cites unregistered requirement ${key}`);
        }
      }
      if (strategy.alias_of && !catalog.strategies.some((s) => s.id === strategy.alias_of)) {
        errors.push(`${fullId} aliases unknown strategy ${strategy.alias_of}`);
      }
    }
  }

  for (const entry of bundle.crosswalk.entries) {
    for (const member of entry.members) {
      // members are "<catalog>:<strategy id>"; research strategy ids carry
      // the catalog prefix themselves (PO:A1), LP ids are bare (J2).
      const catalogId = member.slice(0, member.indexOf(':'));
      const catalog = bundle.strategies[catalogId];
      const strategyId = member.slice(catalogId.length + 1);
      if (!catalog || !catalog.strategies.some((s) => s.id === strategyId || s.id === member)) {
        errors.push(`crosswalk ${entry.intent_id} cites unknown strategy ${member}`);
      }
    }
  }
  errors.push(...funnelErrors(bundle.funnels));
  return errors;
}

/**
 * A funnel is two or more distinct steps, each an event of the closed list.
 * @param {{events?: string[], funnels?: Array<{id: string, steps: string[]}>}} catalog
 */
function funnelErrors(catalog) {
  const errors = [];
  const events = new Set(catalog.events ?? []);
  const ids = new Set();
  for (const funnel of catalog.funnels ?? []) {
    if (ids.has(funnel.id)) errors.push(`duplicate funnel id ${funnel.id}`);
    ids.add(funnel.id);
    if (new Set(funnel.steps).size !== funnel.steps.length || funnel.steps.length < 2) {
      errors.push(`funnel ${funnel.id} needs two or more distinct steps`);
    }
    for (const step of funnel.steps) {
      if (!events.has(step)) errors.push(`funnel ${funnel.id} step ${step} is outside the event list`);
    }
  }
  return errors;
}

/**
 * Reads, validates, and deep-freezes a catalog bundle.
 * @param {CatalogSource} source
 * @returns {object} the frozen catalog bundle
 */
export function buildCatalog(source) {
  const strategies = {};
  for (const file of source.strategyFiles()) {
    const data = source.read(file);
    strategies[data.catalog_id] = data;
  }

  const bundle = {
    requirements: source.read('requirements.json'),
    baseSets: source.read('base-sets.json'),
    strategies,
    crosswalk: source.read('crosswalk.json'),
    screenRules: source.read('screen-rules.json'),
    standards: source.read('standards.json'),
    descriptorSchema: source.read('descriptor.schema.json'),
    events: source.read('events.json'),
    funnels: source.read('funnels.json'),
  };

  const errors = validate(bundle);
  if (errors.length > 0) {
    throw new Error(`catalog bundle invalid:\n${errors.join('\n')}`);
  }
  return deepFreeze(bundle);
}

let cached = null;

/** @returns {object} the frozen shipped catalog, read once per process */
export function loadCatalog() {
  cached ??= buildCatalog(directoryCatalogSource());
  return cached;
}

/** All strategies across catalogs, flattened. */
export function allStrategies(bundle = loadCatalog()) {
  return Object.values(bundle.strategies).flatMap((catalog) =>
    catalog.strategies.map((strategy) => ({ catalog_id: catalog.catalog_id, ...strategy })),
  );
}

/** Registry keys for one base set, expanded (BASE-PAGE etc. are named sets). */
export function baseSetKeys(name, bundle = loadCatalog()) {
  return bundle.baseSets[name]?.requirements ?? [];
}
