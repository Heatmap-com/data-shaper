/**
 * Segmentation definitions: one row per (idsite, segmentation, version).
 *
 * @typedef {Object} SegmentationDefinitionRow
 * @property {number} idsite         SHIPPED_SITE for the shipped default
 * @property {string} segmentation
 * @property {number} version
 * @property {'declared' | 'computed'} kind
 * @property {string} stamp          the canonical resolved definition
 * @property {object} definition     the resolved rules, or the code version and inputs
 * @property {string[]} values       the closed value list, in order
 *
 * @typedef {Object} SegmentationStore
 * @property {(rows: SegmentationDefinitionRow[]) => Promise<void>} writeSegmentationDefinitions idempotent on (idsite, segmentation, version)
 * @property {(idsite: number) => Promise<SegmentationDefinitionRow[]>} readSegmentationDefinitions latest version per segmentation;
 *   a site row wins over a SHIPPED_SITE row
 */

/** The site a shipped default is recorded under. */
export const SHIPPED_SITE = 0;

export const SEGMENTATION_STORE = Object.freeze([
  'writeSegmentationDefinitions',
  'readSegmentationDefinitions',
]);

/**
 * The latest version per segmentation, a site row winning over a
 * SHIPPED_SITE row.
 * Both adapters resolve their rows with this.
 * @param {SegmentationDefinitionRow[]} rows
 * @param {number} idsite
 * @returns {SegmentationDefinitionRow[]}
 */
export function latestDefinitions(rows, idsite) {
  /** @type {Map<string, SegmentationDefinitionRow>} */
  const latest = new Map();
  for (const row of rows) {
    if (row.idsite !== SHIPPED_SITE && row.idsite !== Number(idsite)) continue;
    const prev = latest.get(row.segmentation);
    const specific = row.idsite === Number(idsite);
    const prevSpecific = prev?.idsite === Number(idsite);
    if (!prev || (specific && !prevSpecific) || (specific === prevSpecific && row.version >= prev.version)) {
      latest.set(row.segmentation, row);
    }
  }
  return [...latest.values()].sort((a, b) => (a.segmentation < b.segmentation ? -1 : 1));
}
