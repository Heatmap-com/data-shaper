/**
 * Starts a worker process that outlives the command that started it.
 *
 * @typedef {Object} WorkerLauncherPort
 * @property {(options: {stages?: string[]}) => Promise<{pid: number, log: string}>} launch
 */
export {};
