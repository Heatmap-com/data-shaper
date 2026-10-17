/**
 * @typedef {import('./dataset.js').RunContext} RunContext
 */

/**
 * @typedef {Object} QualifierConfig
 * @property {number} minShareOfHome
 * @property {number} [minHits] pageview hits required on the chosen page
 * @property {number} minSessions
 * @property {number} minOrders
 */

/**
 * @typedef {Object} Qualification
 * @property {'qualified'|'skipped_volume'|'skipped_no_page'} status
 * @property {number} [idsitehsr]
 * @property {string} [url]
 * @property {string} [pageType]
 * @property {number} [entrySessions] bot-filtered (exclude_confirmed) entry sessions
 * @property {number} [orders] bot-filtered orders
 * @property {number} [revenue]
 * @property {string} [reason]
 * @property {object} [evidence] qualifier evidence for the analysis metadata
 */

/**
 * @typedef {Object} QualifiedPage
 * @property {number} idsite
 * @property {string} siteName
 * @property {number} idsitehsr
 * @property {string} url
 * @property {string} pageTitle
 * @property {string} pageType
 * @property {{entrySessions: number, orders: number, revenue: number}} qualified
 * @property {{entrySessions: number, orders: number, revenue: number}} unfiltered bot_filter=none totals
 * @property {number} botSessionsExcluded
 */

/**
 * @typedef {Object} QualifierPort
 * @property {string} id
 * @property {QualifierConfig} config
 * @property {(site: {idsite: number, siteName: string}, ctx: RunContext) => Promise<Qualification>} qualify
 */
