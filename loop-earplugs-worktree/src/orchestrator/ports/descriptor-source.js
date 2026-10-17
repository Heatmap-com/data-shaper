/**
 * @typedef {Object} SiteSpec
 * @property {string} slug
 * @property {string} domain
 * @property {string} origin
 * @property {string} [name]
 * @property {number} [idsite]
 * @property {string} [run]
 * @property {{include?: Array<{url: string, role?: string}>}} [pages]
 * @property {object} [context]
 *
 * @typedef {Object} DescriptorSourcePort
 * @property {(id: string) => Promise<object>} stage
 * @property {() => Promise<string[]>} stageIds
 * @property {(id: string) => Promise<object>} agent
 * @property {() => Promise<object>} resilience
 * @property {(scope: 'general'|'site', name: string, slug?: string) => Promise<{body: object, file: string}|null>} run
 * @property {(file: string) => Promise<{body: object, file: string}>} runFile
 * @property {(slug: string) => Promise<string[]>} runFiles every general run file, then the site's own, each set sorted
 * @property {(slugOrDomain: string) => Promise<SiteSpec|null>} site
 * @property {() => Promise<SiteSpec[]>} sites
 */
export {};
