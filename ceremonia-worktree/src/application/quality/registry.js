import { decisionsFor } from '../../domain/quality/decisions.js';
import { checkScreen, resolveScreen } from '../../domain/quality/screens.js';

/**
 * @typedef {import('../../domain/quality/screens.js').ResolvedScreen & {
 *   origin: string,
 *   methodParams: Record<string, unknown>,
 *   triageParams: Record<string, unknown>,
 * }} ActiveScreen
 */

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** Defaults under declared values, objects merged key by key. */
function withDefaults(defaults, declared) {
  const out = JSON.parse(JSON.stringify(defaults ?? {}));
  for (const [key, value] of Object.entries(declared ?? {})) {
    out[key] = isObject(value) && isObject(out[key]) ? withDefaults(out[key], value) : value;
  }
  return out;
}

/**
 * Every data-quality screen a dataset runs, resolved through its layers:
 * the shipped screens, a site's quality.json, the request's quality block,
 * and the reprocess decisions a person recorded. The site files are
 * checked when the registry is built, so a bad one fails before a query.
 *
 * @param {{screens: ReadonlyArray<import('../../domain/quality/screens.js').Screen>,
 *   methods: ReadonlyArray<import('../../ports/quality.js').QualityMethodAdapter>,
 *   triages: ReadonlyArray<import('../../ports/quality.js').QualityTriageAdapter>,
 *   siteSpecs?: ReadonlyArray<import('./site-files.js').SiteQualitySpec>,
 *   siteDecisions?: ReadonlyArray<{slug: string, idsite: number, decisions: import('../../domain/quality/decisions.js').Decision[]}>,
 *   siteSlugs?: ReadonlyMap<number, string>,
 *   decisionsFile?: (slug: string) => string}} input
 *   `siteSlugs` names the folder of every site with any site file, so a
 *   decision can be recorded for a site that has no quality file yet.
 */
export function createQualityRegistry({ screens, methods, triages, siteSpecs = [], siteDecisions = [], siteSlugs = new Map(), decisionsFile = (slug) => `orchestration/sites/${slug}/quality-decisions.json` }) {
  const methodById = new Map(methods.map((adapter) => [adapter.id, adapter]));
  const triageById = new Map(triages.map((adapter) => [adapter.id, adapter]));
  const shippedIds = new Set(screens.map((screen) => screen.id));
  const sites = new Map();
  const slugs = new Map(siteSlugs);
  const claim = (idsite, slug, where) => {
    if (slugs.has(idsite) && slugs.get(idsite) !== slug) throw new Error(`${where}: idsite ${idsite} also has quality files in sites/${slugs.get(idsite)}`);
    slugs.set(idsite, slug);
  };
  for (const spec of siteSpecs) {
    claim(spec.idsite, spec.slug, `sites/${spec.slug}/quality.json`);
    sites.set(spec.idsite, spec);
  }
  const decisions = new Map();
  for (const spec of siteDecisions) {
    claim(spec.idsite, spec.slug, `sites/${spec.slug}/quality-decisions.json`);
    decisions.set(spec.idsite, spec.decisions);
  }

  /**
   * @param {number} idsite
   * @param {string} dataset
   * @param {{off: boolean, rules: Record<string, object>, add: ReadonlyArray<import('../../domain/quality/screens.js').Screen>}} [request]
   * @param {ReadonlyArray<import('../../domain/quality/decisions.js').Decision>} [extra] decisions not yet in the site's file, as if they were last
   * @returns {{screens: ActiveScreen[], off: Array<{id: string, layer: string}>, problems: string[]}}
   */
  function resolve(idsite, dataset, request = { off: false, rules: {}, add: [] }, extra = []) {
    const site = sites.get(Number(idsite)) ?? null;
    const siteDecisionList = [...(decisions.get(Number(idsite)) ?? []), ...extra];
    const problems = [];
    const active = [];
    const off = [];
    if (request.off) return { screens: [], off: [{ id: '*', layer: `request ${dataset}` }], problems };
    const where = site ? `sites/${site.slug}/quality.json` : null;
    const bases = [
      ...screens.map((screen) => [screen, 'catalog']),
      ...(site?.add ?? []).map((screen) => [screen, where]),
      ...(site?.datasets?.[dataset]?.add ?? []).map((screen) => [screen, `${where}, dataset ${dataset}`]),
      ...request.add.map((screen) => [screen, `request ${dataset}`]),
    ];
    const seen = new Set();
    for (const [base, origin] of bases) {
      if (seen.has(base.id)) {
        problems.push(`${origin}: screen ${base.id} is already defined${shippedIds.has(base.id) ? ' by the catalog; patch it under rules instead' : ''}`);
        continue;
      }
      seen.add(base.id);
      const reprocess = decisionsFor(siteDecisionList, base.id, dataset).reprocess
        .map((d) => ({ patch: d.params, layer: `decision of ${d.at} by ${d.by}${d.dataset ? `, dataset ${d.dataset}` : ''}` }));
      let resolved;
      try {
        resolved = resolveScreen(base, { dataset, site, request: request.rules, decisions: reprocess });
        const { layers, ...plain } = resolved;
        resolved = { ...checkScreen(plain, `screen ${base.id} for dataset ${dataset}`), layers };
      } catch (err) {
        problems.push(err instanceof Error ? err.message : String(err));
        continue;
      }
      if (!resolved.enabled) {
        off.push({ id: resolved.id, layer: [...resolved.layers].reverse().find((entry) => entry.path === 'enabled')?.layer ?? origin });
        continue;
      }
      const method = methodById.get(resolved.method.adapter);
      const triage = triageById.get(resolved.triage.adapter);
      if (!method) problems.push(`screen ${resolved.id}: no quality method "${resolved.method.adapter}" (${[...methodById.keys()].join(', ')})`);
      else if (!method.subjects.includes(resolved.subject.kind)) problems.push(`screen ${resolved.id}: method ${method.id} screens ${method.subjects.join(', ')}, not ${resolved.subject.kind}`);
      if (!triage) problems.push(`screen ${resolved.id}: no quality triage "${resolved.triage.adapter}" (${[...triageById.keys()].join(', ')})`);
      if (!method || !triage || !method.subjects.includes(resolved.subject.kind)) continue;
      const methodParams = withDefaults(method.defaults, { ...(resolved.subject.measure && 'measure' in method.defaults ? { measure: resolved.subject.measure } : {}), ...resolved.method.params });
      const triageParams = withDefaults(triage.defaults, resolved.triage.params);
      const trouble = [
        ...method.check(methodParams, resolved.subject).map((text) => `method ${method.id}: ${text}`),
        ...triage.check(triageParams).map((text) => `triage ${triage.id}: ${text}`),
      ];
      if (trouble.length > 0) {
        problems.push(...trouble.map((text) => `screen ${resolved.id}: ${text}`));
        continue;
      }
      active.push({ ...resolved, origin, methodParams, triageParams });
    }
    for (const [label, patches] of [[where, site?.rules], [`${where}, dataset ${dataset}`, site?.datasets?.[dataset]?.rules], [`request ${dataset}`, request.rules]]) {
      for (const id of Object.keys(patches ?? {})) if (!seen.has(id)) problems.push(`${label}: patches screen ${id}, which no layer defines`);
    }
    return { screens: active, off, problems };
  }

  for (const site of sites.values()) {
    for (const dataset of ['*', ...Object.keys(site.datasets)]) {
      const { problems } = resolve(site.idsite, dataset);
      if (problems.length > 0) throw new Error(`sites/${site.slug}/quality.json: ${problems.join('; ')}`);
    }
  }

  return {
    resolve,
    methods: methodById,
    triages: triageById,
    /** @param {number} idsite */
    decisions: (idsite) => decisions.get(Number(idsite)) ?? [],
    /** @param {number} idsite */
    slugOf: (idsite) => slugs.get(Number(idsite)) ?? null,
    decisionsFile,
  };
}
