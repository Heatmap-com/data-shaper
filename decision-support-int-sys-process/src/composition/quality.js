import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createQualityRegistry } from '../application/quality/registry.js';
import { siteDecisionsSpec, siteQualitySpec } from '../application/quality/site-files.js';
import { loadQualityScreens } from '../catalog/quality.js';
import { adaptersIn, discoverAdapterRoles } from '../discover.js';
import { loadSiteFiles, orchestrationRoot } from './registries.js';

const adaptersDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'adapters');

/** The site files that name a site's idsite at their top level. */
const NAMING_FILES = ['site.json', 'segmentations.json', 'attributes.json', 'sources.json', 'quality.json'];

/**
 * The data-quality registry: the shipped screens, the quality-methods and
 * quality-triage adapters, and every site's `quality.json` and
 * `quality-decisions.json` under the orchestration root.
 * @param {NodeJS.ProcessEnv} env
 * @param {{methods?: object[], triages?: object[]}} [adapters] the mounted roles; discovered when absent
 */
export async function loadQualityRegistry(env, adapters = {}) {
  const root = orchestrationRoot(env);
  const roles = adapters.methods && adapters.triages ? null : await discoverAdapterRoles(adaptersDir);
  const siteSlugs = new Map();
  for (const name of NAMING_FILES) {
    for (const { slug, doc } of await loadSiteFiles(root, name)) {
      if (Number.isInteger(doc?.idsite) && !siteSlugs.has(doc.idsite)) siteSlugs.set(doc.idsite, slug);
    }
  }
  return createQualityRegistry({
    screens: loadQualityScreens(),
    methods: adapters.methods ?? adaptersIn(roles, 'quality-methods'),
    triages: adapters.triages ?? adaptersIn(roles, 'quality-triage'),
    siteSpecs: (await loadSiteFiles(root, 'quality.json')).map(({ slug, where, doc }) => siteQualitySpec(doc, slug, where)),
    siteDecisions: (await loadSiteFiles(root, 'quality-decisions.json')).map(({ slug, where, doc }) => siteDecisionsSpec(doc, slug, where)),
    siteSlugs,
    decisionsFile: (slug) => path.join(root, 'sites', slug, 'quality-decisions.json'),
  });
}
