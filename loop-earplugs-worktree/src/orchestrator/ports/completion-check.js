/**
 * A check answers one question: is this unit of this stage complete. It is
 * read-only and cheap enough to run before and after every attempt.
 *
 * @typedef {Object} CheckDetail
 * @property {string} name
 * @property {boolean} ok
 * @property {string} [message]
 *
 * @typedef {Object} CheckResult
 * @property {boolean} ok
 * @property {string} summary one line for the journal and the agent prompt
 * @property {CheckDetail[]} details
 *
 * @typedef {Object} CompletionCheck
 * @property {string} id
 * @property {(ctx: import('./stage-handler.js').StageContext, spec: object) => Promise<CheckResult>} evaluate
 * @property {(ctx: import('./stage-handler.js').StageContext, spec: object) => string} describe what "done" means, for the prompt
 * @property {(spec: object) => string[]} [validate] problems with the spec itself, reported by `orchestrator validate`
 */
export {};
