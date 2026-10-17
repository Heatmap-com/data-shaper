/**
 * The retired `process/queue/queue.json`, read once to import its items.
 *
 * @typedef {Object} LegacyQueueItem
 * @property {string} id
 * @property {string} domain
 * @property {string} process
 * @property {'critical'|'high'|'normal'|'low'} priority
 * @property {'standard'|'top'} resilience
 * @property {'queued'|'waiting'|'running'|'done'|'failed'} status
 * @property {string} created_at
 * @property {string} [updated_at]
 * @property {string|null} [blocker]
 * @property {string|null} [note]
 * @property {string} [journal]
 * @property {Array<{id: string, status: string, attempts?: number, started_at?: string, finished_at?: string, note?: string}>} steps
 *
 * @typedef {Object} LegacyQueuePort
 * @property {string} location where the items were read from, for the journal
 * @property {() => Promise<LegacyQueueItem[]>} items
 */
export {};
