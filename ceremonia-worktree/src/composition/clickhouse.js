import { createClient } from '@clickhouse/client';
import { createGateway, configuredDatabase } from '../adapters/query-gateway/clickhouse.js';

/**
 * @typedef {object} ClickHouseConfig
 * @property {string} url
 * @property {string} username
 * @property {string} password
 * @property {string} database the database the ae_* and v1 tables live in
 */

/**
 * The ClickHouse settings from the environment. CLICKHOUSE_HOST is either a
 * URL or a host name; a host name takes CLICKHOUSE_PORT (8443 over https,
 * 8123 over http).
 * @param {NodeJS.ProcessEnv} env
 * @returns {ClickHouseConfig}
 */
export function clickHouseConfig(env) {
  const host = env.CLICKHOUSE_HOST;
  if (!host) throw new Error('CLICKHOUSE_HOST is not set');
  const url = /^https?:\/\//.test(host)
    ? host
    : `${env.CLICKHOUSE_PORT === '8123' ? 'http' : 'https'}://${host}:${env.CLICKHOUSE_PORT ?? '8443'}`;
  return {
    url,
    username: env.CLICKHOUSE_USER ?? 'default',
    password: env.CLICKHOUSE_PASSWORD ?? '',
    database: clickHouseDatabase(env),
  };
}

/**
 * The database name alone, for callers that are handed a client.
 * @param {NodeJS.ProcessEnv} env
 */
export function clickHouseDatabase(env) {
  return configuredDatabase(env);
}

/**
 * The client from the config. Long exports raise the request timeout and
 * add settings such as max_execution_time.
 * @param {ClickHouseConfig} config
 * @param {{requestTimeoutMs?: number, settings?: Record<string, unknown>}} [options]
 */
export function createClickHouseClient(config, { requestTimeoutMs = 600_000, settings = {} } = {}) {
  return createClient({
    url: config.url,
    username: config.username,
    password: config.password,
    request_timeout: requestTimeoutMs,
    clickhouse_settings: {
      output_format_json_quote_64bit_integers: 0,
      output_format_json_quote_denormals: 1,
      send_progress_in_http_headers: 1,
      http_headers_progress_interval_ms: 10_000,
      ...settings,
    },
  });
}

/**
 * The client, the database name, and the gateway over the client. Adapters
 * take `{ client, database }`; dataset code takes the gateway.
 * @param {ClickHouseConfig} config
 * @param {{logger?: object, telemetry?: object | null, client?: object}} [options] `client` replaces the real one in tests
 */
export function createClickHouse(config, { logger = console, telemetry = null, client } = {}) {
  const resolved = client ?? createClickHouseClient(config);
  return {
    client: resolved,
    database: config.database,
    gateway: createGateway(resolved, { logger, telemetry, database: config.database }),
  };
}
