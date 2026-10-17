/**
 * Where a stage attempt or a fallback writes its files, and how the
 * orchestrator reads back what an agent left there.
 *
 * @typedef {Object} WorkspacePort
 * @property {(jobId: string, stage: string, label: string) => Promise<string>} runDir
 *   creates <root>/<jobId>/<stage>/<label>/ and returns its path
 * @property {(file: string) => Promise<unknown|undefined>} readJson
 *   the parsed file, or undefined when it is missing or is not valid JSON
 */
export {};
