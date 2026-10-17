/** @typedef {import('../persistence.js').AeCaptureComplete} AeCaptureComplete */
/** @typedef {import('../persistence.js').AeCaptureJob} AeCaptureJob */
/** @typedef {import('../persistence.js').AeSaliencyWrite} AeSaliencyWrite */

/**
 * The capture queue, page captures, renders, and saliency.
 *
 * @typedef {Object} CaptureStore
 * @property {(key: {idsite: number, idsitehsr: number}) => Promise<{status: string, taxonomyVersion: string, capturedOn: string, hasRender: boolean, hasSaliency: boolean} | null>} captureStatus
 * @property {(job: AeCaptureJob) => Promise<void>} enqueueCapture idempotent on (idsite, idsitehsr) except a failed row, which is queued again
 * @property {(claimTtlMs?: number) => Promise<object | null>} claimCapture job plus token
 * @property {(done: AeCaptureComplete) => Promise<Array<{batchId: string, idsite: number, siteName: string}>>} completeCapture validates the taxonomy, writes ae_page_capture + ae_element_binding (+ ae_page_render / ae_render_node and a render-drift ae_change_log row when renders are present), completes the queue row, re-queues waiting targets and sites; returns the re-queued site rows
 * @property {(failure: {idsite: number, idsitehsr: number, reason: string}) => Promise<void>} failCapture queue row to 'failed'
 * @property {(args: AeSaliencyWrite) => Promise<object[]>} writeSaliency rewrites ae_render_node for one device with saliency filled (ReplacingMergeTree rewrite, geometry preserved) and flips ae_page_capture.has_saliency = 1; the caller must only invoke it once every device of the page succeeded. Returns the rows as written
 */

export const CAPTURE_STORE = Object.freeze([
  'captureStatus',
  'enqueueCapture',
  'claimCapture',
  'completeCapture',
  'failCapture',
  'writeSaliency',
]);
