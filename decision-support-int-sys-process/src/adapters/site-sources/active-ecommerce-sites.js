/**
 * Fleet site source: default.sites rows with the run's platform and status
 * (`ctx.sites.platform`, `ctx.sites.status`). A run without both is an error.
 *
 * The status column is confirmed via system.columns before the query; if the
 * expected column is absent the source fails closed (throws) rather than
 * guessing. Not the default source.
 */

const REQUIRED_COLUMNS = ['idsite', 'name', 'status', 'platform'];

export const adapter = {
  id: 'active-ecommerce-sites',

  /** @param {import('../../ports/dataset.js').RunContext} ctx */
  async listSites(ctx) {
    const { platform, status } = ctx.sites ?? {};
    if (!platform || !status) {
      throw new Error('active-ecommerce-sites: the run needs sites.platform and sites.status');
    }
    const columns = await ctx.gateway.columns('sites');
    const names = new Set(columns.map((c) => c.name));
    const missing = REQUIRED_COLUMNS.filter((c) => !names.has(c));
    if (missing.length > 0) {
      throw new Error(
        `active-ecommerce-sites: default.sites is missing expected column(s) ${missing.join(', ')}; failing closed`,
      );
    }

    const rows = await ctx.gateway.query(
      `SELECT idsite, name
         FROM default.sites
        WHERE status = {status:String} AND platform = {platform:String}
        ORDER BY idsite`,
      { status, platform },
      'active-ecommerce-sites',
    );
    return rows.map((r) => ({ idsite: Number(r.idsite), siteName: r.name ?? '' }));
  },
};
