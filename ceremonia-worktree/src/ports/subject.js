/**
 * @typedef {import('./dataset.js').RunContext} RunContext
 * @typedef {import('./qualifier.js').Qualification} Qualification
 */

/**
 * One unit a profile analyzes. A page-shaped subject (page, quiz) also
 * carries the AePageTarget fields, so the page datasets read it as they
 * read a page target today.
 *
 * @typedef {Object} SubjectTarget
 * @property {'page'|'quiz'|'experiment'|'funnel'|'journey'} subjectType
 * @property {string} subjectKey the idsitehsr as text, or a prefixed key such as exp:kameleoon:12345
 * @property {string} label a human label: the URL, the experiment name, the funnel title
 * @property {Object<string, string|number>} dims what the selector chose it by
 * @property {string} role
 * @property {string} selectionReason
 * @property {number} [idsitehsr] page-shaped subjects only
 * @property {string} [url]
 * @property {string} [pageTitle]
 * @property {string} [pageType]
 * @property {number} [entrySessions]
 * @property {number} [orders]
 * @property {number} [revenue]
 * @property {Object} [evidence] what a non-page subject's steps read: arms, funnel steps, path
 */

/**
 * Chooses a site's subjects for one profile from the profile's criteria.
 * The qualification is null for a profile that runs without a qualifier.
 * A selector that reads sessions may also open a folder for the day scan:
 * `open(site, ctx)` returns a SessionFolder whose finish takes the select
 * arguments after the site.
 *
 * @typedef {Object} SubjectSelectorPort
 * @property {string} id
 * @property {string} subjectType
 * @property {(site: {idsite: number, siteName: string}, qualification: Qualification | null, ctx: RunContext, criteria: object) => Promise<SubjectTarget[]>} select
 * @property {(site: {idsite: number}, ctx: RunContext) => object} [open]
 */
