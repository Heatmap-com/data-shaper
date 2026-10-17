import http from 'node:http';

const MAX_EVENTS = 2000;
const SLOW_MS = 5000;

/**
 * Serves the telemetry port on 127.0.0.1. Nothing here is reachable from
 * another machine. A cloud adapter replaces this file; callers keep emit.
 *
 *   GET /health
 *   GET /telemetry
 *   GET /telemetry/summary
 *
 * @param {{port?: number}} [opts]
 * @returns {import('../../ports/telemetry.js').Telemetry & { summary: () => object }}
 */
export function createLocalhostTelemetry(opts = {}) {
  const port = opts.port ?? defaultPort();
  /** @type {import('../../ports/telemetry.js').TelemetryEvent[]} */
  const events = [];
  const server = http.createServer((req, res) => {
    const url = req.url ?? '/';
    if (url === '/health') return send(res, 200, { ok: true });
    if (url.startsWith('/telemetry/summary')) return send(res, 200, summarize(events));
    if (url.startsWith('/telemetry')) return send(res, 200, { events });
    send(res, 404, { error: 'not found' });
  });

  return {
    emit(event) {
      events.push({
        ts: new Date().toISOString(),
        name: String(event?.name ?? 'event'),
        durationMs: Number(event?.durationMs ?? 0),
        ok: event?.ok !== false,
        attrs: clip(event?.attrs ?? {}),
      });
      if (events.length > MAX_EVENTS) events.shift();
    },
    /** Listens on the port, or on a free one when another process holds it. */
    async start() {
      try {
        return await listen(server, port);
      } catch (err) {
        if (err?.code !== 'EADDRINUSE' || port === 0) throw err;
        return listen(server, 0);
      }
    },
    async flush() {},
    close() {
      return new Promise((resolve) => server.close(() => resolve()));
    },
    summary() {
      return summarize(events);
    },
  };
}

/** @param {import('node:http').Server} server @param {number} port */
function listen(server, port) {
  return new Promise((resolve, reject) => {
    const failed = (err) => reject(err);
    server.once('error', failed);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', failed);
      const address = server.address();
      resolve({ host: '127.0.0.1', port: typeof address === 'object' && address ? address.port : port });
    });
  });
}

function defaultPort() {
  if (process.env.VITEST) return 0;
  const configured = Number(process.env.TELEMETRY_PORT ?? 9474);
  return Number.isInteger(configured) && configured >= 0 ? configured : 9474;
}

/**
 * What to optimize: the labels that consumed the most time, the ones that
 * failed, and the stages around them.
 * @param {object[]} events
 */
export function summarize(events) {
  /** @type {Map<string, {label: string, calls: number, failures: number, durationMs: number, rows: number, maxMs: number}>} */
  const byLabel = new Map();
  let queryFailures = 0;
  for (const event of events) {
    if (event.name !== 'query') continue;
    if (!event.ok) queryFailures += 1;
    const label = String(event.attrs?.label ?? 'query');
    const cur = byLabel.get(label) ?? { label, calls: 0, failures: 0, durationMs: 0, rows: 0, maxMs: 0 };
    cur.calls += 1;
    cur.durationMs += Number(event.durationMs ?? 0);
    cur.rows += Number(event.attrs?.rows ?? 0);
    cur.maxMs = Math.max(cur.maxMs, Number(event.durationMs ?? 0));
    if (!event.ok) cur.failures += 1;
    byLabel.set(label, cur);
  }
  const queries = [...byLabel.values()].sort((a, b) => b.durationMs - a.durationMs);
  const attention = queries
    .filter((row) => row.failures > 0 || row.maxMs >= SLOW_MS)
    .map((row) => ({
      label: row.label,
      reason: row.failures > 0 ? 'failed' : 'slow',
      durationMs: row.durationMs,
      maxMs: row.maxMs,
      failures: row.failures,
      calls: row.calls,
    }));
  return {
    events: events.length,
    queries: events.filter((event) => event.name === 'query').length,
    queryFailures,
    attention,
    slowest: queries.slice(0, 20),
    stages: events
      .filter((event) => event.name === 'stage' || event.name === 'site' || event.name === 'batch' || event.name === 'write')
      .map((event) => ({
        name: event.name,
        stage: event.attrs?.stage ?? event.attrs?.table ?? '',
        durationMs: event.durationMs,
        ok: event.ok,
        brand: event.attrs?.brand ?? '',
        idsite: event.attrs?.idsite ?? null,
        rows: event.attrs?.rows ?? null,
        error: event.attrs?.error ?? '',
      })),
  };
}

/** @param {import('node:http').ServerResponse} res @param {number} status @param {object} body */
function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

/** @type {import('../../ports/telemetry.js').TelemetryAdapter} */
export const adapter = {
  id: 'localhost',
  create: createLocalhostTelemetry,
};

/** @param {object} attrs */
function clip(attrs) {
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (typeof value === 'string' && value.length > 300) out[key] = `${value.slice(0, 300)}…`;
    else if (value == null || typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') out[key] = value;
  }
  return out;
}
