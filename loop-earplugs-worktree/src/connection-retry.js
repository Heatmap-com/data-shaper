/**
 * ClickHouse Cloud closes idle and oversized HTTP bodies. Inserts and reads
 * are idempotent (ReplacingMergeTree, or a query that only reads), so a
 * dropped connection is retried. A refused query or a server error is not.
 */

const TRANSIENT_CODES = new Set([
  'EPIPE',
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ECONNABORTED',
  'UND_ERR_SOCKET',
]);

const TRANSIENT_MESSAGE = /socket hang up|EPIPE|ECONNRESET|ECONNREFUSED|ETIMEDOUT|other side closed|socket disconnected|fetch failed/i;

const MARK = Symbol.for('ae.clickhouse.retry');

/**
 * @param {unknown} err
 * @returns {boolean}
 */
export function isTransientConnectionError(err) {
  const seen = new Set();
  let current = err;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const code = /** @type {{ code?: unknown }} */ (current).code;
    if (typeof code === 'string' && TRANSIENT_CODES.has(code)) return true;
    const message = /** @type {{ message?: unknown }} */ (current).message;
    if (typeof message === 'string' && TRANSIENT_MESSAGE.test(message)) return true;
    current = /** @type {{ cause?: unknown }} */ (current).cause;
  }
  return false;
}

/**
 * @template T
 * @param {() => Promise<T>} fn
 * @param {{ attempts?: number, delaysMs?: number[], onRetry?: (err: Error, attempt: number) => void }} [opts]
 * @returns {Promise<T>}
 */
export async function withConnectionRetry(fn, { attempts = 4, delaysMs = [2000, 5000, 15000], onRetry } = {}) {
  /** @type {unknown} */
  let last;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      const retry = isTransientConnectionError(err) && attempt < attempts - 1;
      if (!retry) throw err;
      onRetry?.(err instanceof Error ? err : new Error(String(err)), attempt + 1);
      const wait = delaysMs[Math.min(attempt, delaysMs.length - 1)] ?? 0;
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
  throw last;
}

/**
 * query, insert, and command retry when the socket drops. query() still
 * returns `{ json() }`, and the body read is inside the retry, so a hang-up
 * while the rows are arriving runs the query again.
 * A second call with the same client returns the wrapper already attached.
 * @param {object | null | undefined} client
 * @param {{ warn?: Function, info?: Function }} [logger]
 */
export function attachConnectionRetry(client, logger = {}, { delaysMs = [2000, 5000, 15000] } = {}) {
  if (!client || client[MARK]) return client?.[MARK] ?? client;
  const retry = (op, fn) => withConnectionRetry(fn, {
    delaysMs,
    onRetry(err, attempt) {
      const fields = { op, attempt, error: err.message };
      if (typeof logger.warn === 'function') logger.warn(fields, 'clickhouse connection retry');
      else if (typeof logger.info === 'function') logger.info(fields, 'clickhouse connection retry');
    },
  });
  const wrapped = new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === MARK) return wrapped;
      if (prop === 'insert' || prop === 'command' || prop === 'exec') {
        return (...args) => retry(String(prop), () => target[prop](...args));
      }
      if (prop === 'query') {
        return (...args) => retry('query', async () => {
          const res = await target.query(...args);
          const rows = await res.json();
          return { json: async () => rows };
        });
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  Object.defineProperty(client, MARK, { value: wrapped });
  return wrapped;
}
