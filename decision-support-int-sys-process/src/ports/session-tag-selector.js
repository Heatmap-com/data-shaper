/**
 * Session-tag selector port. The tag trend reads one adapter from
 * src/adapters/session-tag-selectors. The adapter is pure: the run queries
 * the warehouse and hands the adapter the counts.
 *
 * `candidates` sees only the key inventory and decides which keys are worth
 * a per-value scan. `select` sees the per-value counts of those keys and
 * decides which keys to trend and which of their values get their own row.
 * A rejected key keeps its reason so the selection table can say why.
 */

/**
 * @typedef {Object} TagKeyInventory
 * @property {string} key tag key, lowercased
 * @property {number} visits visits that carry the key
 * @property {number} distinctValues
 */

/**
 * Window totals for one tag value over kept sessions. Revenue is the
 * visit's order revenue.
 * @typedef {Object} TagValueStats
 * @property {string} key
 * @property {string} value
 * @property {number} sessions
 * @property {number} buyers
 * @property {number} orders
 * @property {number} revenue
 * @property {number} visitRevenueSq sum over sessions of the squared visit revenue
 * @property {number} orderRevenueSq sum over orders of the squared order revenue
 */

/**
 * @typedef {Object} TagValueSummary
 * @property {string} value
 * @property {number} sessions
 * @property {number} orders
 * @property {number} revenue
 * @property {number} rps
 * @property {number | null} aov
 */

/**
 * @typedef {Object} TagKeyVerdict
 * @property {string} key
 * @property {string} family source | medium | campaign | ad | content | term | channel | affiliate, or the rejected family
 * @property {'candidate' | 'selected' | 'rejected'} status
 * @property {string} reason
 * @property {number} taggedSessions
 * @property {number} distinctValues
 * @property {import('../enrichment/tag-stats.js').Spread | null} rps
 * @property {import('../enrichment/tag-stats.js').Spread | null} aov
 * @property {string[]} trendValues values that get their own trend row, in session order
 * @property {TagValueSummary[]} values the largest values, for the selection table
 */

/**
 * @typedef {Object} SessionTagSelector
 * @property {string} id
 * @property {(inventory: TagKeyInventory[]) => TagKeyVerdict[]} candidates one verdict per key, status candidate or rejected
 * @property {(input: {candidates: TagKeyVerdict[], values: TagValueStats[], sessions: number}) => TagKeyVerdict[]} select one verdict per candidate, status selected or rejected
 */

export {};
