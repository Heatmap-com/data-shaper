/**
 * Where a domain's idsite and name are looked up when the site has no
 * `site.json` yet, and where a found site is written down.
 *
 * @typedef {Object} DirectoryRow
 * @property {number} idsite
 * @property {string} name
 * @property {string} mainUrl
 * @property {string} [platform]
 * @property {string} [currency]
 * @property {string} [status]
 *
 * @typedef {Object} SiteDirectoryPort
 * @property {(domain: string) => Promise<DirectoryRow[]>} lookup rows whose main URL mentions the domain
 * @property {() => Promise<void>} [close]
 *
 * @typedef {Object} SiteRegistryPort
 * @property {(site: import('./descriptor-source.js').SiteSpec) => Promise<string>} register writes sites/<slug>/site.json and returns its path; refuses to overwrite
 */
export {};
