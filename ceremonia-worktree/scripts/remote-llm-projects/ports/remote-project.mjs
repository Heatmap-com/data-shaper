/**
 * A remote project is a named workspace at an LLM provider: instructions and
 * files that a later prompt can read. The id is opaque. Callers pass it back
 * to the same provider; they do not parse it.
 *
 * @typedef {Object} ProjectRequest
 * @property {string} name display name; the provider may store a normalized form
 * @property {string} [instructions] standing instructions for later prompts
 *
 * @typedef {Object} RemoteProject
 * @property {string} id
 * @property {string} name name as stored by the provider
 *
 * @typedef {Object} ProjectFile
 * @property {string} path path inside the project, relative, forward slashes
 * @property {Buffer | string} body
 *
 * @typedef {Object} PromptRequest
 * @property {string} prompt
 * @property {string[]} [expectPaths] files the prompt was told to write
 * @property {string} [title]
 *
 * @typedef {Object} PromptResult
 * @property {string} id opaque run id
 * @property {string} text the model's closing note
 * @property {string} [stopReason]
 * @property {ProjectFile[]} files files written by the run
 *
 * @typedef {Object} RemoteProjectPort
 * @property {(request: ProjectRequest) => Promise<RemoteProject>} createProject
 * @property {(request: ProjectRequest) => Promise<RemoteProject>} ensureProject
 * @property {(projectId: string, file: ProjectFile) => Promise<{ path: string, updated: boolean }>} putFile
 * @property {(projectId: string, request: PromptRequest) => Promise<PromptResult>} runPrompt
 */

export {}
