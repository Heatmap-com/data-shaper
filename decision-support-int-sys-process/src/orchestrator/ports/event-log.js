/**
 * @typedef {Object} EventLogPort
 * @property {(jobId: string, event: object) => Promise<void>} append
 * @property {(jobId: string, limit?: number) => Promise<object[]>} tail oldest first, the last `limit` events
 * @property {(jobId: string) => Promise<number>} remove
 */
export {};
