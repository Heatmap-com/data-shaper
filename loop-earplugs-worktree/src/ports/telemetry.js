/**
 * Ports are JSDoc typedefs only. No port file imports ClickHouse, the
 * filesystem, or another adapter. Adapters depend on ports; the runner
 * depends on ports.
 *
 * The localhost adapter serves this process. A later adapter can ship the
 * same events to a cloud log system. Callers only see this port.
 */

/**
 * @typedef {Object} TelemetryEvent
 * @property {string} name query | stage | site | batch | write
 * @property {number} [durationMs]
 * @property {boolean} [ok]
 * @property {object} [attrs] small fields: label, rows, idsite, stage, error
 */

/**
 * @typedef {Object} Telemetry
 * @property {(event: TelemetryEvent) => void} emit never throws
 * @property {() => Promise<{host: string, port: number}>} start bind or connect
 * @property {() => Promise<void>} flush
 * @property {() => Promise<void>} close
 */

/**
 * @typedef {Object} TelemetryAdapter
 * @property {string} id
 * @property {string} purpose
 * @property {string} data
 * @property {(opts?: {port?: number}) => Telemetry} create
 */
