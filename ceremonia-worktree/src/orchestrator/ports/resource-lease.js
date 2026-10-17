/**
 * @typedef {Object} ResourceLeasePort
 * @property {(resource: string, capacity: number, owner: string, leaseMs: number) => Promise<{slot: number, token: string}|null>} tryAcquire
 * @property {(resource: string, token: string, leaseMs: number) => Promise<boolean>} renew
 * @property {(resource: string, token: string) => Promise<void>} release
 */
export {};
