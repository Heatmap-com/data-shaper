/**
 * The audit's brands come from a registry the caller passes in
 * (orchestration/registries/brands.json through composition). idsite is
 * filled by R1 unless the caller passes one. Domains are the registry lookup
 * key, not a tracking claim.
 */

/** @typedef {{key: string, name: string, domain: string, idsite?: number}} BrandEntry */

/** The idsite of a brand R1 has not resolved yet. */
const UNRESOLVED = 0;

/**
 * @param {BrandEntry[]} registry
 * @param {string[] | undefined} keys every registry brand when empty
 * @param {number[]} [idsites] aligned with keys, or with the full list when keys is empty
 * @returns {Array<{key: string, name: string, domain: string, idsite: number}>}
 */
export function selectBrands(registry, keys, idsites = []) {
  if (!Array.isArray(registry) || registry.length === 0) {
    throw new Error('the audit needs a brand registry with at least one brand');
  }
  const wanted = keys && keys.length > 0 ? keys : registry.map((b) => b.key);
  return wanted.map((key, i) => {
    const known = registry.find((b) => b.key === key);
    if (!known) {
      throw new Error(`unknown brand "${key}"; known: ${registry.map((b) => b.key).join(', ')}`);
    }
    const idsite = idsites[i] ?? known.idsite ?? UNRESOLVED;
    return { key: known.key, name: known.name, domain: known.domain, idsite: Number.isFinite(idsite) ? idsite : UNRESOLVED };
  });
}
