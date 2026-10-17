/**
 * Times one piece of work and emits a stage event. The telemetry argument
 * is the port; this module does not choose an adapter.
 *
 * @param {import('../ports/telemetry.js').Telemetry | null | undefined} telemetry
 * @param {string} stageName
 * @param {object} attrs
 * @param {() => Promise<unknown>} fn
 */
export async function stage(telemetry, stageName, attrs, fn) {
  const started = Date.now();
  try {
    const value = await fn();
    emit(telemetry, { name: 'stage', durationMs: Date.now() - started, ok: true, attrs: { stage: stageName, ...attrs } });
    return value;
  } catch (err) {
    emit(telemetry, {
      name: 'stage',
      durationMs: Date.now() - started,
      ok: false,
      attrs: { stage: stageName, ...attrs, error: err instanceof Error ? err.message : String(err) },
    });
    throw err;
  }
}

/** @param {import('../ports/telemetry.js').Telemetry | null | undefined} telemetry @param {import('../ports/telemetry.js').TelemetryEvent} event */
export function emit(telemetry, event) {
  if (telemetry && typeof telemetry.emit === 'function') telemetry.emit(event);
}
