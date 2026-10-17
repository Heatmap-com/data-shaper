/**
 * @typedef {Object} RenderedPrompt
 * @property {string} text
 * @property {string[]} sources files used, general first
 *
 * @typedef {Object} PromptSourcePort
 * @property {(name: string, values: object, scope: {site?: string}) => Promise<RenderedPrompt>} render
 * @property {(name: string, scope: {site?: string}) => Promise<string[]>} sources
 */
export {};
