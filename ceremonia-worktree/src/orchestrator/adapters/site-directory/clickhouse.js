/**
 * `default.sites` over the engine's ClickHouse client. The client is made on
 * the first lookup, so commands that never look up a site need no
 * credentials.
 *
 * @param {{connect: () => object}} options connect makes the ClickHouse client
 * @returns {import('../../ports/site-directory.js').SiteDirectoryPort}
 */
export function createSiteDirectory({ connect }) {
  let client = null;
  return {
    async lookup(domain) {
      client ??= connect();
      const result = await client.query({
        query: `SELECT idsite, name, main_url, platform, currency, status
                  FROM default.sites
                 WHERE positionCaseInsensitive(main_url, {domain:String}) > 0
                 LIMIT 20`,
        query_params: { domain: String(domain).replace(/^www\./, '') },
        format: 'JSONEachRow',
      });
      return (await result.json()).map((row) => ({
        idsite: Number(row.idsite), name: row.name, mainUrl: row.main_url, platform: row.platform, currency: row.currency, status: row.status,
      }));
    },
    async close() {
      await client?.close();
      client = null;
    },
  };
}
