/**
 * One queue per stage, named `stage:<stageId>`. Delivery is at least once.
 * A reserved message is invisible to other consumers until its lease expires
 * or the holder settles it. Settling with a stale token throws LeaseLostError.
 *
 * @typedef {Object} EnqueueRequest
 * @property {string} jobId
 * @property {number} priority 0 critical, 1 high, 2 normal, 3 low
 * @property {number} rankAt epoch ms; earlier runs first within a priority (the job's created time)
 * @property {object} payload
 * @property {string} [dedupeKey] a second open message with the same key in the same queue is dropped
 * @property {number} [delayMs]
 *
 * @typedef {Object} QueueMessage
 * @property {string} id
 * @property {string} queue
 * @property {string} jobId
 * @property {number} priority
 * @property {number} rankAt
 * @property {object} payload
 * @property {number} deliveries count of reservations, including this one
 * @property {string|null} lastError
 *
 * @typedef {Object} Lease
 * @property {string} token
 * @property {string} owner
 * @property {number} expiresAt epoch ms
 * @property {QueueMessage} message
 *
 * @typedef {Object} ReserveOptions
 * @property {number} leaseMs
 * @property {string} owner worker id
 * @property {number} [maxInFlight] reserve nothing when this many leases are already held on the queue
 * @property {number} [maxDeliveries] a reclaimed message past this count is dead-lettered
 *
 * @typedef {Object} QueueStats
 * @property {string} queue
 * @property {number} ready
 * @property {number} delayed
 * @property {number} leased
 * @property {number} dead
 * @property {Array<{jobId: string, owner: string, expiresAt: number, deliveries: number}>} leases
 *
 * @typedef {Object} StageQueuePort
 * @property {(queue: string, request: EnqueueRequest) => Promise<{id: string, deduped: boolean}>} enqueue
 * @property {(queue: string, options: ReserveOptions) => Promise<Lease|null>} reserve
 * @property {(lease: Lease, leaseMs: number) => Promise<Lease>} extend
 * @property {(lease: Lease) => Promise<void>} ack
 * @property {(lease: Lease, options: {delayMs: number, reason: string}) => Promise<void>} release
 * @property {(lease: Lease, queue: string, request: EnqueueRequest) => Promise<{id: string, deduped: boolean}>} forward ack and enqueue, atomically
 * @property {(lease: Lease, reason: string) => Promise<void>} deadLetter
 * @property {(messageId: string) => Promise<void>} revive move a dead message back to ready
 * @property {(queue?: string) => Promise<QueueStats[]>} stats
 * @property {(queue: string, limit: number) => Promise<QueueMessage[]>} peekReady
 * @property {(queue?: string) => Promise<QueueMessage[]>} listDead
 * @property {(jobId: string, priority: number) => Promise<number>} reprioritize set the priority of the job's ready and leased messages; returns how many changed
 * @property {(jobId: string, reason: string) => Promise<number>} discard settle the job's ready messages as done without running them; leased ones finish on their own
 * @property {(jobId: string) => Promise<number>} purge delete the job's settled (done and dead) messages
 */

export class LeaseLostError extends Error {
  constructor(messageId) {
    super(`lease on ${messageId} is no longer held`);
    this.name = 'LeaseLostError';
  }
}
