/**
 * Rate-limits progress reports. The first call always goes through, and so
 * does any call with force. Later calls wait intervalMs.
 * @param {(fields: object, force?: boolean) => void} [onProgress]
 * @param {number} [intervalMs]
 */
export function progressEvery(onProgress, intervalMs = 15_000) {
  let last = 0;
  return function tick(fields, force = false) {
    if (typeof onProgress !== 'function') return;
    const now = Date.now();
    if (!force && last !== 0 && now - last < intervalMs) return;
    last = now;
    onProgress(fields);
  };
}

/** @param {number} done @param {number} stride */
export function atStride(done, stride) {
  return done > 0 && done % stride === 0;
}

export const PROGRESS_STRIDE = 250_000;
