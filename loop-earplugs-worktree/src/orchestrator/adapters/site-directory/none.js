/**
 * No directory: every site needs its `site.json`.
 *
 * @returns {import('../../ports/site-directory.js').SiteDirectoryPort}
 */
export function createSiteDirectory() {
  return {
    async lookup(domain) {
      throw new Error(`the site directory is off in this config (siteDirectory.adapter "none"), so ${domain} needs a site.json`);
    },
  };
}
