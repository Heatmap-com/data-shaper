/**
 * Traffic-exclusion port. One adapter in src/adapters/traffic-exclusion.
 * The run measures the site's window and reads the site descriptor. The
 * adapter is pure: it decides which measured cells are dead traffic and
 * which viewport patterns are large or very large.
 */

/**
 * Constants for one site. A high-confidence s37.traffic_exclusion
 * descriptor overrides the shipped defaults field by field.
 * @typedef {Object} TrafficExclusionConstants
 * @property {number} largeSessions
 * @property {number} veryLargeSessions
 * @property {number} largeShare
 * @property {number} veryLargeShare
 * @property {number} phoneMaxWidth a phone device wider than this disagrees with its viewport
 * @property {number[]} mismatchDeviceCodes device codes treated as phones for the width check
 */

/**
 * One viewport signature measured over the window.
 * @typedef {Object} ViewportPattern
 * @property {string} resolution
 * @property {number} device
 * @property {number} width
 * @property {number} height
 * @property {number} sessions
 * @property {number} orders
 * @property {number} clicks
 * @property {number} revenue
 */

/**
 * @typedef {Object} ExclusionRule
 * @property {string} ruleId
 * @property {string} patternKey
 * @property {'exclude' | 'watch' | 'retain'} disposition
 * @property {string} reason
 * @property {number} sessions
 * @property {number} orders
 * @property {number} clicks
 * @property {number} revenue
 * @property {number} share
 * @property {object} detail
 */

/**
 * @typedef {Object} TrafficExclusionAdapter
 * @property {string} id
 * @property {(input: {siteSessions: number, dead: {sessions: number, orders: number, clicks: number, revenue: number}, retained: {sessions: number, orders: number, clicks: number, revenue: number}, patterns: ViewportPattern[], constants: TrafficExclusionConstants}) => {rules: ExclusionRule[], constants: TrafficExclusionConstants}} build
 */

export {};
