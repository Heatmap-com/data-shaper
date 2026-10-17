/**
 * The v1 naming queue and the page names it writes.
 *
 * @typedef {Object} NamingQueue
 * @property {(key: {idsite: number, idsitehsr: number}) => Promise<{status: string, taxonomyVersion: string, namedOn: string} | null>} namingStatus
 * @property {(job: {idsite: number, idsitehsr: number, url: string, pageType: string, reason: string}) => Promise<void>} enqueueNaming
 * @property {(claimTtlMs?: number) => Promise<{idsite: number, idsitehsr: number, url: string, pageType: string, reason: string, token: string} | null>} claimNaming one queued (or stale-claimed) naming job, or null
 * @property {(failure: {idsite: number, idsitehsr: number, reason: string}) => Promise<void>} failNaming naming queue row to 'failed'
 * @property {(done: {idsite: number, idsitehsr: number, url?: string, namedOn: string, names?: Array<{selector: string, element_class: string, name?: string}>}) => Promise<void>} completeNaming validates the taxonomy, writes page_naming + page_element_name, completes the naming_queue row, and re-queues awaiting_naming site_queue rows
 */

export const NAMING_QUEUE = Object.freeze([
  'namingStatus',
  'enqueueNaming',
  'claimNaming',
  'failNaming',
  'completeNaming',
]);
