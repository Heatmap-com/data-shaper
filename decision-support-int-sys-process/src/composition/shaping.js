import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createShapingRegistry } from '../application/shaping/registry.js';
import { siteAttributesSpec, siteSourcesSpec } from '../application/shaping/site-files.js';
import { loadAttributeCatalog } from '../catalog/attributes.js';
import { loadSourceKinds } from '../catalog/sources.js';
import { adaptersIn, discoverAdapterRoles } from '../discover.js';
import { loadSiteFiles, orchestrationRoot } from './registries.js';

const adaptersDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'adapters');

/**
 * The shaping registry: the shipped attributes and source kinds, the
 * external-source adapters, and every site's `attributes.json` and
 * `sources.json` under the orchestration root.
 * @param {NodeJS.ProcessEnv} env
 * @param {Array<import('../ports/external-source.js').ExternalSourceAdapter>} [adapters] the mounted
 *   `external-sources` role; discovered when absent
 */
export async function loadShapingRegistry(env, adapters) {
  const root = orchestrationRoot(env);
  const attributes = loadAttributeCatalog();
  return createShapingRegistry({
    attributes,
    kinds: loadSourceKinds(attributes),
    adapters: adapters ?? adaptersIn(await discoverAdapterRoles(adaptersDir), 'external-sources'),
    siteAttributes: (await loadSiteFiles(root, 'attributes.json')).map(({ slug, where, doc }) => siteAttributesSpec(doc, slug, where)),
    siteSources: (await loadSiteFiles(root, 'sources.json')).map(({ slug, dir, where, doc }) => siteSourcesSpec(doc, slug, where, dir)),
  });
}
