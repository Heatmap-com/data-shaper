import { attachConnectionRetry } from '../../../connection-retry.js';

/**
 * State the ClickHouse persistence roles share: the clock, the claim TTL,
 * the row mappers, and per adapter the client, database, logger, and write
 * helpers. Each role file takes the parts it uses.
 */

// A claim younger than this is a live agent's in-flight work and is not
// reclaimable; older claims belong to crashed workers.
export const CLAIM_TTL_MS = 15 * 60 * 1000;

/** @param {number} ttlMs */
export function staleBeforeCh(ttlMs) {
  return new Date(Date.now() - ttlMs).toISOString().replace('T', ' ').slice(0, -1);
}

export function nowCh() {
  return new Date().toISOString().replace('T', ' ').slice(0, -1);
}

export let clock = { now: nowCh };
/** test hook: deterministic timestamps */
export function _setClockForTests(c) {
  clock = c;
}

/**
 * @param {object} row ae_experiment_descriptor_current row
 * @returns {import('../../../ports/persistence.js').AeExperimentDescriptorRow}
 */
export function experimentDescriptorFromCh(row) {
  const json = (value, fallback) => {
    if (typeof value !== 'string' || value === '') return fallback;
    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  };
  const date = (value) => (value ? String(value).slice(0, 10) : null);
  return {
    idsite: Number(row.idsite),
    experimentKey: String(row.experiment_key),
    provenance: String(row.provenance),
    partner: String(row.partner ?? ''),
    partnerExperimentId: String(row.partner_experiment_id ?? ''),
    name: String(row.name ?? ''),
    hypothesis: String(row.hypothesis ?? ''),
    description: String(row.description ?? ''),
    kind: String(row.kind ?? ''),
    scope: String(row.scope ?? ''),
    scopeSource: String(row.scope_source ?? ''),
    deviceScope: String(row.device_scope ?? ''),
    templates: Array.isArray(row.templates) ? row.templates.map(String) : [],
    pages: Array.isArray(row.pages) ? row.pages.map(Number) : [],
    elements: json(row.elements, []),
    zones: json(row.zones, []),
    arms: json(row.arms, []),
    declaredStart: date(row.declared_start),
    declaredEnd: date(row.declared_end),
    observedStart: date(row.observed_start),
    observedEnd: date(row.observed_end),
    lastSeen: date(row.last_seen),
    peakDailyVisits: Number(row.peak_daily_visits ?? 0),
    assignedVisits: Number(row.assigned_visits ?? 0),
    status: String(row.status ?? ''),
    statusAsOf: date(row.status_as_of),
    metrics: json(row.metrics, {}),
  };
}

/** @param {object} row */
export function hitFromCh(row) {
  return {
    idsite: Number(row.idsite),
    triggerKey: row.trigger_key,
    serverDate: String(row.server_date).slice(0, 10),
    triggerVersion: Number(row.trigger_version),
    idvisit: String(row.idvisit),
    configId: row.config_id ?? '',
    level: row.level,
    device: row.device ?? '',
    channel: row.channel ?? '',
    source: row.source ?? '',
    medium: row.medium ?? '',
    returning: row.returning ?? '',
    country: row.country ?? '',
    landingPage: row.landing_page ?? '',
    entryTemplate: row.entry_template ?? '',
  };
}

/** @param {object} row */
export function chainFromCh(row) {
  return {
    ...hitFromCh(row),
    returned: Number(row.returned) === 1,
    sessionsUntilReturn: Number(row.sessions_until_return) || 0,
    sessionsUntilPurchase: Number(row.sessions_until_purchase) || 0,
    purchased: Number(row.purchased) === 1,
    revenue: Number(row.revenue) || 0,
    secondsToPurchase: Number(row.seconds_to_purchase) || 0,
    recovered: Number(row.recovered) === 1,
    windowDays: Number(row.window_days) || 0,
    windowCloses: String(row.window_closes).slice(0, 10),
    final: Number(row.final) === 1,
  };
}

// One HTTP body for every hit on a large site is what the socket closed on.
// 50k matches the experiment-row chunks. A dropped chunk is retried by the
// client wrapper; a landed chunk is replaced by generated_at on a rerun.
/**
 * Runs the calls it is given one at a time, in call order. A claim reads the
 * queue, inserts its token, and reads the token back; ClickHouse does not
 * make the three atomic, so two claims in flight in one process can both
 * read back their own token and both win.
 * @returns {<T>(fn: () => Promise<T>) => Promise<T>}
 */
export function oneAtATime() {
  let last = Promise.resolve();
  return (fn) => {
    const next = last.then(fn, fn);
    last = next.then(() => undefined, () => undefined);
    return next;
  };
}

export const INSERT_CHUNK = 50_000;

/** ClickHouse Date serialized forms -> YYYY-MM-DD */
export function toIsoDate(value) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function logTo(logger) {
  return (msg, extra) => {
    if (typeof logger.info === 'function') logger.info(extra ?? {}, msg);
  };
}

/**
 * The v1 roles' shared state.
 * @param {{client: object, database: string, logger: object}} opts
 */
export function v1Support({ client, database, logger }) {
  return { client, database, log: logTo(logger) };
}

/**
 * The schema-2 roles' shared state: the client wrapped in connection retry,
 * timed writes reported to telemetry, chunked trigger inserts, and the
 * change-log insert.
 * @param {{client: object, database: string, logger: object, telemetry?: import('../../../ports/telemetry.js').Telemetry | null}} opts
 */
export function aeSupport({ client, database, logger, telemetry = null }) {
  client = attachConnectionRetry(client, logger);
  const log = logTo(logger);
  async function timedWrite(table, rows, fn) {
    const started = Date.now();
    try {
      await fn();
      telemetry?.emit({ name: 'write', durationMs: Date.now() - started, ok: true, attrs: { table, rows: rows.length } });
    } catch (err) {
      telemetry?.emit({
        name: 'write',
        durationMs: Date.now() - started,
        ok: false,
        attrs: { table, rows: rows.length, error: err instanceof Error ? err.message : String(err) },
      });
      throw err;
    }
  }
  const run = (promise) => promise.then((r) => r.json());

  async function insertTriggerChunks(table, rows, toValue) {
    for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
      const slice = rows.slice(i, i + INSERT_CHUNK);
      await timedWrite(table, slice, () => client.insert({
        table: `${database}.${table}`,
        format: 'JSONEachRow',
        values: slice.map(toValue),
      }));
      log('writeTriggerChunk', { table, rows: slice.length, offset: i });
    }
  }

  async function readCurrent(table, where, params) {
    return run(
      client.query({
        query: `SELECT * FROM ${database}.${table}_current WHERE ${where}`,
        query_params: params,
        format: 'JSONEachRow',
      }),
    );
  }

  /** @param {Array<import('../../../ports/persistence.js').AeChangeRow>} rows */
  async function insertChangeRows(rows) {
    if (rows.length === 0) return;
    await client.insert({
      table: `${database}.ae_change_log`,
      format: 'JSONEachRow',
      values: rows.map((r) => ({
        idsite: r.idsite,
        change_id: r.change_id,
        change_kind: r.change_kind,
        effective_at: r.effective_at,
        detected_at: r.detected_at ?? r.effective_at,
        source: r.source ?? '',
        subject: r.subject ?? '',
        detail: JSON.stringify(r.detail ?? {}),
        generated_at: clock.now(),
      })),
    });
  }

  return { client, database, log, timedWrite, run, insertTriggerChunks, readCurrent, insertChangeRows };
}
