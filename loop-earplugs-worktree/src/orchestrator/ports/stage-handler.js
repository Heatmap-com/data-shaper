/**
 * @typedef {Object} StageContext
 * @property {import('./job-store.js').Job} job
 * @property {object} stage resolved stage descriptor
 * @property {{key: string, page?: {url: string, role?: string}}} unit
 * @property {number} attempt
 * @property {string} runDir
 * @property {string} owner worker id
 * @property {AbortSignal} signal
 * @property {object} values template values: site, job, stage, unit, params, window, config, paths, resilience, run
 * @property {(template: string) => string} render strict {{path}} substitution over values
 * @property {(extra?: object) => NodeJS.ProcessEnv} env
 * @property {{repo: string, analysis: string, reports: string}} paths
 *
 * @typedef {Object} HandlerResult
 * @property {'ok'|'error'} status
 * @property {number|null} [exitCode]
 * @property {boolean} [timedOut]
 * @property {string} [message]
 * @property {string} [command]
 * @property {string} [logFile]
 * @property {string} [logTail]
 * @property {object} [facts] values the job keeps for later stages (phase 2)
 * @property {import('../domain/failure.js').Verdict} [verdict] how the handler reads its own failure
 *   (an agent that reported a blocker, for example); a matching stage rule still wins
 *
 * @typedef {Object} StageHandler
 * @property {string} id
 * @property {(ctx: StageContext, spec: object) => Promise<HandlerResult>} run
 *
 * A handler module exports either `adapter` (a StageHandler with no
 * dependencies) or `createAdapter(deps)`, which composition calls once with
 * the ports the handler needs (agents, prompts, checks, workspace).
 */
export {};
