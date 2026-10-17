/**
 * Data-quality screens. A screen is a declared rule (src/catalog/quality/,
 * a site's quality.json, a request's quality block): a subject, a method,
 * a triage, and the dispositions. Methods and triage are adapters, so the
 * way suspect data is found, and the way the engine decides a person must
 * look, can differ by dataset without a code change to the run.
 *
 * Both adapter kinds are pure: they read the rows they are given and the
 * parameters the declaration resolved, and they query nothing.
 *
 * @typedef {'orders' | 'groups'} QualitySubjectKind
 *
 * @typedef {Object} OrderRow                   one order of a kept session
 * @property {string} key                       the order id
 * @property {string} idvisit
 * @property {number} revenue
 *
 * @typedef {Object} GroupRow                   one value of an attribute over the kept sessions
 * @property {string} key                       the attribute value
 * @property {number} sessions
 * @property {number} buyers
 * @property {number} orders
 * @property {number} revenue
 * @property {number} progressed                checkout sessions
 *
 * @typedef {Object} SubjectTotals              the subject's rows summed
 * @property {number} rows
 * @property {number} [sessions]
 * @property {number} [buyers]
 * @property {number} orders
 * @property {number} revenue
 * @property {number} [progressed]
 *
 * @typedef {Object} Candidate                  what a method found
 * @property {string[]} members                 row keys, in the subject's key space
 * @property {string} label                     the rows in words: "2 orders", "resolution 0x0"
 * @property {string} reason                    why they are suspect, in words
 * @property {Record<string, number | string>} values  numbers a question template may name
 * @property {Record<string, 'money' | 'share' | 'count' | 'number'>} [units]  how values print
 *
 * @typedef {Object} QualityMethodAdapter       a module in src/adapters/quality-methods
 * @property {string} id
 * @property {readonly QualitySubjectKind[]} subjects  the subjects it can screen
 * @property {Readonly<Record<string, unknown>>} defaults  every constant it reads, with its shipped value
 * @property {(params: Record<string, unknown>, subject: {kind: QualitySubjectKind}) => string[]} check  problems with resolved params
 * @property {(input: {subject: {kind: QualitySubjectKind, by?: string, measure?: string}, rows: ReadonlyArray<OrderRow | GroupRow>,
 *   params: Record<string, unknown>, totals: SubjectTotals}) => {candidates: Candidate[], stats: Record<string, number | string>, skipped?: string}} screen
 * @property {{id: string, purpose: string, data: string}} [descriptor]  attached by discovery
 *
 * @typedef {Object} Impact                     what excluding a finding's members does to the subject's totals
 * @property {number} [sessions]
 * @property {number} [sessionShare]
 * @property {number} [buyers]
 * @property {number} [buyerShare]
 * @property {number} orders
 * @property {number} orderShare
 * @property {number} revenue
 * @property {number} revenueShare
 * @property {number | null} [conversionWith]
 * @property {number | null} [conversionWithout]
 * @property {number | null} aovWith
 * @property {number | null} aovWithout
 *
 * @typedef {Object} QualityTriageAdapter       a module in src/adapters/quality-triage
 * @property {string} id
 * @property {Readonly<Record<string, unknown>>} defaults
 * @property {(params: Record<string, unknown>) => string[]} check
 * @property {(input: {candidate: Candidate, impact: Impact, params: Record<string, unknown>}) => {ask: boolean, why: string}} triage
 * @property {{id: string, purpose: string, data: string}} [descriptor]
 */

export {};
