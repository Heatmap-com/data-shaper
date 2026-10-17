import { fileURLToPath } from 'node:url';
import { createSegmentationRegistry } from '../../src/application/segmentation/registry.js';
import { loadSegmentationCatalog } from '../../src/catalog/segmentations.js';
import { adaptersIn, discoverAdapterRoles } from '../../src/discover.js';

const roles = await discoverAdapterRoles(fileURLToPath(new URL('../../src/adapters', import.meta.url)));

/** The shipped segmentations: the catalog and the computed adapters, with no site files. */
export const SHIPPED = createSegmentationRegistry({ catalog: loadSegmentationCatalog(), adapters: adaptersIn(roles, 'segmentations') });

/**
 * The shipped segmentations with site files.
 * @param {import('../../src/ports/segmentation.js').SiteSegmentationSpec[]} sites
 */
export const withSites = (sites) => createSegmentationRegistry({ catalog: loadSegmentationCatalog(), adapters: adaptersIn(roles, 'segmentations'), sites });

/**
 * The shipped default selection for a grain, or the named ids.
 * @param {'trend' | 'tagTrend' | 'experiments'} grain
 * @param {string[]} [ids]
 */
export const shipped = (grain, ids) => SHIPPED.select(1, grain, ids ?? null);

/**
 * One visit set as the fan-out returns it: the `all` cell and one cell per
 * segmentation, each carrying its value from `values` (or the
 * segmentation's last value).
 * @param {object} cell the measures and keys
 * @param {Record<string, string>} [values] segmentation id → value
 * @param {ReadonlyArray<{id: string, values: ReadonlyArray<string>}>} [segmentations]
 */
export function fanned(cell, values = {}, segmentations = shipped('trend')) {
  return [
    { ...cell, segment: 'all', segmentValue: 'all' },
    ...segmentations.map((seg) => ({ ...cell, segment: seg.id, segmentValue: values[seg.id] ?? seg.values[seg.values.length - 1] })),
  ];
}
