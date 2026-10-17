import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSegmentationRegistry } from '../application/segmentation/registry.js';
import { loadSegmentationCatalog } from '../catalog/segmentations.js';
import { adaptersIn, discoverAdapterRoles } from '../discover.js';
import { loadSegmentationSpecs, orchestrationRoot } from './registries.js';

const adaptersDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'adapters');

/**
 * The segmentation registry: the shipped catalog, the computed adapters,
 * and the site files under the orchestration root.
 * @param {NodeJS.ProcessEnv} env
 * @param {Array<import('../ports/segmentation.js').SegmentationAdapter>} [adapters] the mounted
 *   `segmentations` role; discovered when absent
 * @param {{site?: import('../ports/segmentation.js').SiteSegmentationSpec}} [options] a site file read
 *   in place of the one stored for its idsite
 */
export async function loadSegmentationRegistry(env, adapters, { site } = {}) {
  const computed = adapters ?? adaptersIn(await discoverAdapterRoles(adaptersDir), 'segmentations');
  const stored = await loadSegmentationSpecs(orchestrationRoot(env));
  return createSegmentationRegistry({
    catalog: loadSegmentationCatalog(),
    adapters: computed,
    sites: site ? [...stored.filter((spec) => spec.idsite !== site.idsite), site] : stored,
  });
}
