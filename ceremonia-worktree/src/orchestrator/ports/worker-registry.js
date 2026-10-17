/**
 * @typedef {Object} WorkerRegistryPort
 * @property {(worker: {owner: string, pid: number, host: string, stages: string[]}) => Promise<void>} heartbeat
 * @property {(owner: string) => Promise<void>} remove
 * @property {() => Promise<Array<{owner: string, pid: number, host: string, stages: string[], lastSeen: number}>>} list
 */
export {};
