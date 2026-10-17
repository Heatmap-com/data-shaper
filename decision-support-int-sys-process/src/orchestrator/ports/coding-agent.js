/**
 * A coding agent runs one prompt to completion in a working directory and
 * returns. It does not decide whether the stage is done; the orchestrator's
 * completion check does.
 *
 * @typedef {Object} AgentRunRequest
 * @property {string} prompt full rendered prompt
 * @property {string} runDir directory for prompt.md, transcript.jsonl, result.json
 * @property {string} workdir
 * @property {string[]} [addDirs] extra directories the agent may read and write
 * @property {string[]} [skillsDirs]
 * @property {string|null} [model]
 * @property {number} [timeoutMs]
 * @property {AbortSignal} [signal]
 *
 * @typedef {Object} AgentRunResult
 * @property {number|null} exitCode
 * @property {boolean} timedOut
 * @property {boolean} aborted
 * @property {string} finalText the agent's closing message
 * @property {string} [tail] the last lines of raw output, where provider errors land when the agent stops mid-run
 * @property {string} transcriptFile
 * @property {number} durationMs
 *
 * @typedef {Object} CodingAgentPort
 * @property {string} id descriptor id
 * @property {(request: AgentRunRequest) => Promise<AgentRunResult>} run
 */
export {};
