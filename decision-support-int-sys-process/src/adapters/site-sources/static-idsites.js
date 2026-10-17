/**
 * A static site list: the idsites the run was given (`ctx.sites.idsites`).
 * A run with no list is an error.
 *
 * Names are looked up from default.sites best-effort; a lookup failure leaves
 * the name blank rather than failing the batch.
 */

/** @param {unknown} idsites */
function requireIdsites(idsites) {
  if (!Array.isArray(idsites) || idsites.length === 0) {
    throw new Error('static-idsites: the run has no idsites; pass them with --sites');
  }
  const bad = idsites.filter((n) => !Number.isInteger(n) || n <= 0);
  if (bad.length > 0) throw new Error(`static-idsites: not positive integer idsites: ${bad.join(', ')}`);
  return idsites;
}

async function lookupNames(idsites, ctx) {
  try {
    const placeholders = idsites.map((_, i) => `{idsite${i}:UInt32}`).join(', ');
    const params = Object.fromEntries(idsites.map((id, i) => [`idsite${i}`, id]));
    const rows = await ctx.gateway.query(
      `SELECT idsite, name FROM default.sites WHERE idsite IN (${placeholders})`,
      params,
      'site-names',
    );
    return new Map(rows.map((r) => [Number(r.idsite), r.name ?? '']));
  } catch {
    return new Map();
  }
}

export const adapter = {
  id: 'static-idsites',

  /** @param {import('../../ports/dataset.js').RunContext} ctx */
  async listSites(ctx) {
    const idsites = requireIdsites(ctx.sites?.idsites);
    const names = await lookupNames(idsites, ctx);
    return idsites.map((idsite) => ({ idsite, siteName: names.get(idsite) ?? '' }));
  },
};
