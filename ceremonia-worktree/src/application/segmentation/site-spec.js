const SPEC_KEYS = ['idsite', 'defaults', 'overrides', 'declarations'];

/**
 * One site's segmentation file, checked for shape: its default selection
 * per grain, its overrides of shipped declarations, and its own
 * declarations. The registry checks what they say.
 * @param {unknown} doc the parsed file
 * @param {string} slug
 * @param {string} where how errors name the file
 * @returns {import('../../ports/segmentation.js').SiteSegmentationSpec}
 */
export function siteSegmentationSpec(doc, slug, where) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error(`${where}: must be an object`);
  const unknown = Object.keys(doc).filter((key) => !SPEC_KEYS.includes(key));
  if (unknown.length > 0) throw new Error(`${where}: unknown keys ${unknown.join(', ')} (${SPEC_KEYS.join(', ')})`);
  if (!Number.isInteger(doc.idsite) || doc.idsite <= 0) throw new Error(`${where}: idsite must be a positive integer`);
  for (const key of ['defaults', 'overrides']) {
    if (doc[key] !== undefined && (typeof doc[key] !== 'object' || doc[key] === null || Array.isArray(doc[key]))) {
      throw new Error(`${where}: ${key} must be an object`);
    }
  }
  if (doc.declarations !== undefined && !Array.isArray(doc.declarations)) throw new Error(`${where}: declarations must be a list`);
  return { slug, idsite: doc.idsite, defaults: doc.defaults ?? {}, overrides: doc.overrides ?? {}, declarations: doc.declarations ?? [] };
}
