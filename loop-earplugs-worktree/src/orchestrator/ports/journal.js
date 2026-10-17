/**
 * @typedef {Object} JournalEvent
 * @property {string} type e.g. job.queued, stage.started, unit.satisfied, handler.failed, fallback.started, stage.done
 * @property {string} [stage]
 * @property {string} [message] one readable sentence
 * @property {object} [data]
 *
 * @typedef {Object} JournalPort
 * @property {(job: import('./job-store.js').Job, event: JournalEvent) => Promise<void>} record
 */
export {};
