/**
 * Ports are JSDoc typedefs only. No port file imports ClickHouse, the
 * filesystem, or another adapter. Adapters depend on ports; the runner
 * depends on ports. See IMPLEMENTATION-PLAN.md section 4.
 */

/**
 * Supplies "today" so tests never call Date.now().
 *
 * @typedef {Object} Clock
 * @property {() => string} todayUtc ISO date string, e.g. '2026-10-03'
 */

/**
 * The only SQL surface dataset and qualifier adapters see. The concrete
 * gateway binds parameters, sets max_execution_time, logs label/rows/seconds,
 * memoizes system.columns notes, and refuses a query that is not scoped to the
 * site being processed (fleet scans for the bot-flag rule carry an explicit
 * `fleet:` label and skip that guard).
 *
 * @typedef {Object} QueryGateway
 * @property {(sql: string, params: object, label: string) => Promise<object[]>} query
 * @property {(sql: string, params: object, label: string) => Promise<string>} explain
 * @property {(table: string) => Promise<Array<{name: string, type: string}>>} columns system.columns for default.table
 */
