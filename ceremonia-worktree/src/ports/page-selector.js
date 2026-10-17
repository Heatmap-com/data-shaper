/**
 * @typedef {import('./dataset.js').RunContext} RunContext
 * @typedef {import('./qualifier.js').Qualification} Qualification
 * @typedef {import('./persistence.js').AePageTarget} AePageTarget
 */

/**
 * @typedef {Object} PageSelectOptions
 * @property {number} [maxPages] the batch's pages-per-site limit; 1 selects the primary only
 */

/**
 * Chooses the pages a qualified site is analyzed on. The first target is
 * the qualifier's page with role `primary`. The list is in priority order,
 * and the runner keeps the first `maxPages`, so a selector may return more.
 *
 * @typedef {Object} PageSelectorPort
 * @property {string} id
 * @property {(site: {idsite: number, siteName: string}, qualification: Qualification, ctx: RunContext, opts?: PageSelectOptions) => Promise<AePageTarget[]>} select
 */
