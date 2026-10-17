import { canonical } from '../../domain/canonical.js';
import { deepFreeze } from '../../domain/freeze.js';
import {
  MAX_VALUES, MIN_VALUES, SEGMENTATION_VOCABULARY, applyOverride, checkDeclaration, segmentationClassifier, segmentationSql, segmentationStamp,
} from '../../domain/segmentation/index.js';

/** @typedef {import('../../ports/segmentation.js').Segmentation} Segmentation */
/** @typedef {import('../../ports/segmentation.js').SegmentationGrain} SegmentationGrain */

export const GRAINS = Object.freeze(['trend', 'tagTrend', 'experiments']);

/** What each grain reads when neither the run nor the site names a selection. */
export const SHIPPED_DEFAULTS = deepFreeze({
  trend: ['traffic_source', 'returning', 'buyer', 'rager'],
  tagTrend: ['traffic_source', 'returning', 'buyer', 'rager', 'return_intent'],
  experiments: ['traffic_source', 'returning'],
});

const ID = /^[a-z][a-z0-9_]*$/;
const VALUE = /^[a-z0-9_]+$/;

/**
 * A declared segmentation, ready for any grain whose column map holds its fields.
 * @param {import('../../domain/segmentation/declaration.js').ResolvedSegmentation} seg
 * @returns {Readonly<Segmentation>}
 */
export function declaredSegmentation(seg) {
  return Object.freeze({
    id: seg.id,
    kind: 'declared',
    label: seg.label,
    values: seg.values,
    needs: seg.needs,
    fields: seg.fields,
    grains: GRAINS,
    inputs: Object.freeze([]),
    sql: (columns) => segmentationSql(seg, columns),
    classify: segmentationClassifier(seg),
    stamp: () => segmentationStamp(seg),
    ctes: () => '',
    joins: () => '',
    params: () => ({}),
    definition: () => ({ rules: seg.rules, fallback: seg.fallback }),
    descriptor: Object.freeze({ id: seg.id, purpose: seg.purpose, data: seg.data }),
  });
}

/**
 * A computed segmentation from its adapter, checked as a declaration's values are.
 * @param {import('../../ports/segmentation.js').SegmentationAdapter} adapter
 * @returns {Readonly<Segmentation>}
 */
export function computedSegmentation(adapter) {
  const fail = (message) => {
    throw new Error(`segmentations adapter ${adapter?.id}: ${message}`);
  };
  if (typeof adapter?.id !== 'string' || !ID.test(adapter.id) || adapter.id === 'all') fail('id must match ^[a-z][a-z0-9_]*$ and is not "all"');
  const values = adapter.values ?? [];
  if (values.length < MIN_VALUES || values.length > MAX_VALUES || new Set(values).size !== values.length) {
    fail(`needs ${MIN_VALUES} to ${MAX_VALUES} distinct values`);
  }
  for (const value of values) if (!VALUE.test(value) || value === 'all') fail(`value ${JSON.stringify(value)} must match ^[a-z0-9_]+$ and is not "all"`);
  if (!Array.isArray(adapter.grains) || adapter.grains.length === 0 || adapter.grains.some((grain) => !GRAINS.includes(grain))) {
    fail(`grains must name some of ${GRAINS.join(', ')}`);
  }
  if (!Number.isInteger(adapter.codeVersion) || adapter.codeVersion < 1) fail('codeVersion must be a positive integer');
  for (const name of ['sql', 'ctes', 'joins', 'params', 'stampInputs']) {
    if (typeof adapter[name] !== 'function') fail(`${name} must be a function`);
  }
  const descriptor = adapter.descriptor ?? fail('has no descriptor');
  const definition = (inputs) => ({ codeVersion: adapter.codeVersion, ...adapter.stampInputs(inputs) });
  return Object.freeze({
    id: adapter.id,
    kind: 'computed',
    label: adapter.label ?? adapter.id,
    values: Object.freeze([...values]),
    needs: Object.freeze([...(adapter.needs ?? [])]),
    fields: Object.freeze([]),
    grains: Object.freeze([...adapter.grains]),
    inputs: Object.freeze([...(adapter.inputs ?? [])]),
    sql: adapter.sql,
    classify: null,
    stamp: (inputs) => canonical(definition(inputs)),
    ctes: adapter.ctes,
    joins: adapter.joins,
    params: adapter.params,
    definition,
    descriptor: Object.freeze({ id: descriptor.id, purpose: descriptor.purpose, data: descriptor.data }),
  });
}

/**
 * Every segmentation a site can read, and what each grain reads by default.
 * Pure: the catalog, the adapters, and the site files come in as data.
 * Every site is built when the registry is, so a bad site file fails before
 * any query.
 *
 * @param {{catalog: ReadonlyArray<import('../../domain/segmentation/declaration.js').ResolvedSegmentation>,
 *   adapters: ReadonlyArray<import('../../ports/segmentation.js').SegmentationAdapter>,
 *   sites?: ReadonlyArray<import('../../ports/segmentation.js').SiteSegmentationSpec>}} input
 */
export function createSegmentationRegistry({ catalog, adapters, sites = [] }) {
  /** @type {Map<string, string>} id → where it came from */
  const owners = new Map();
  const claim = (id, owner) => {
    if (owners.has(id)) throw new Error(`segmentation ${id} is defined twice: ${owners.get(id)} and ${owner}`);
    owners.set(id, owner);
  };
  const shipped = catalog.map((seg) => {
    claim(seg.id, `catalog segmentations/${seg.id}.json`);
    return seg;
  });
  const computed = adapters.map((adapter) => {
    claim(adapter.id, `adapter segmentations/${adapter.id}`);
    return computedSegmentation(adapter);
  });
  const base = new Map([...shipped.map((seg) => [seg.id, declaredSegmentation(seg)]), ...computed.map((seg) => [seg.id, seg])]);
  for (const [grain, ids] of Object.entries(SHIPPED_DEFAULTS)) checkSelection(base, grain, ids, 'the shipped defaults');

  /** @type {Map<number, {spec: object, map: Map<string, Readonly<Segmentation>>, defaults: Record<string, string[]>}>} */
  const bySite = new Map();
  const slugs = new Map();
  for (const spec of sites) {
    if (slugs.has(spec.idsite)) throw new Error(`idsite ${spec.idsite} has two segmentation files: sites/${slugs.get(spec.idsite)} and sites/${spec.slug}`);
    slugs.set(spec.idsite, spec.slug);
    bySite.set(spec.idsite, buildSite(spec, shipped, base, owners));
  }

  const site = (idsite) => bySite.get(Number(idsite)) ?? { map: base, defaults: SHIPPED_DEFAULTS };
  const grainOf = (grain) => {
    if (!GRAINS.includes(grain)) throw new Error(`unknown segmentation grain "${grain}" (${GRAINS.join(', ')})`);
    return grain;
  };

  return {
    /** @param {number} idsite @returns {ReadonlyMap<string, Readonly<Segmentation>>} */
    forSite: (idsite) => site(idsite).map,
    /** @param {number} idsite @param {SegmentationGrain} grain */
    defaults: (idsite, grain) => [...site(idsite).defaults[grainOf(grain)]],
    /**
     * Where a run's selection comes from: the run's own list, else the site's default, else the shipped one.
     * @param {number} idsite @param {SegmentationGrain} grain @param {string[] | null} [ids]
     * @returns {'run' | 'site' | 'shipped'}
     */
    sourceOf: (idsite, grain, ids) => {
      if (ids) return 'run';
      return bySite.get(Number(idsite))?.spec.defaults?.[grainOf(grain)] ? 'site' : 'shipped';
    },
    /**
     * The segmentations a run reads, in order. An unknown id, a repeated
     * id, or a computed segmentation outside its grains is refused.
     * @param {number} idsite @param {SegmentationGrain} grain @param {string[] | null} [ids]
     * @returns {Readonly<Segmentation>[]}
     */
    select: (idsite, grain, ids) => {
      const { map, defaults } = site(idsite);
      const chosen = ids ?? defaults[grainOf(grain)];
      checkSelection(map, grainOf(grain), chosen, `idsite ${idsite}`);
      return chosen.map((id) => map.get(id));
    },
  };
}

/**
 * @param {import('../../ports/segmentation.js').SiteSegmentationSpec} spec
 * @param {ReadonlyArray<import('../../domain/segmentation/declaration.js').ResolvedSegmentation>} shipped
 * @param {Map<string, Readonly<Segmentation>>} base
 * @param {Map<string, string>} owners
 */
function buildSite(spec, shipped, base, owners) {
  const where = `sites/${spec.slug}/segmentations.json`;
  const map = new Map(base);
  const overrides = spec.overrides ?? {};
  for (const [id, override] of Object.entries(overrides)) {
    const seg = shipped.find((item) => item.id === id);
    if (!seg) {
      const why = base.get(id)?.kind === 'computed' ? 'is computed; its parameters come from the run' : 'is not a shipped declared segmentation';
      throw new Error(`${where}: cannot override ${id}: it ${why}`);
    }
    map.set(id, declaredSegmentation(applyOverride(seg, override, SEGMENTATION_VOCABULARY, where)));
  }
  for (const doc of spec.declarations ?? []) {
    const seg = checkDeclaration(doc, SEGMENTATION_VOCABULARY, where);
    if (map.has(seg.id)) throw new Error(`${where}: segmentation ${seg.id} is already defined by ${owners.get(seg.id) ?? where}`);
    map.set(seg.id, declaredSegmentation(seg));
  }
  const defaults = { ...SHIPPED_DEFAULTS };
  for (const [grain, ids] of Object.entries(spec.defaults ?? {})) {
    if (!GRAINS.includes(grain)) throw new Error(`${where}: unknown grain "${grain}" in defaults (${GRAINS.join(', ')})`);
    if (!Array.isArray(ids) || ids.length === 0) throw new Error(`${where}: defaults.${grain} must be a non-empty list of ids`);
    checkSelection(map, grain, ids, where);
    defaults[grain] = Object.freeze([...ids]);
  }
  return { spec, map, defaults };
}

/**
 * @param {ReadonlyMap<string, Readonly<Segmentation>>} map
 * @param {string} grain
 * @param {string[]} ids
 * @param {string} where
 */
function checkSelection(map, grain, ids, where) {
  const seen = new Set();
  for (const id of ids) {
    const seg = map.get(id);
    if (!seg) throw new Error(`${where}: unknown segmentation "${id}" (${[...map.keys()].join(', ')})`);
    if (seen.has(id)) throw new Error(`${where}: segmentation ${id} is selected twice`);
    seen.add(id);
    if (!seg.grains.includes(grain)) throw new Error(`${where}: segmentation ${id} cannot be read in ${grain} (${seg.grains.join(', ')})`);
  }
}
