/**
 * @typedef {import('./dataset.js').RunContext} RunContext
 */

/**
 * @typedef {Object} SiteSourcePort
 * @property {string} id
 * @property {(ctx: RunContext) => Promise<Array<{idsite: number, siteName: string}>>} listSites
 */
