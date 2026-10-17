import { createClickHousePersistence } from '../adapters/persistence/clickhouse.js';
import { ensureSchema } from '../adapters/persistence/clickhouse/schema-migrator.js';
import { clickHouseConfig, createClickHouse } from './clickhouse.js';

/**
 * The deprecated v1 path's ClickHouse store: the v1 tables ensured, the
 * persistence adapter, and the gateway. Phase 5 retires it
 * with `src/index.js`.
 * @param {{env: NodeJS.ProcessEnv, logger: object}} options
 */
export async function openV1ClickHouse({ env, logger }) {
  const clickhouse = createClickHouse(clickHouseConfig(env), { logger });
  await ensureSchema(clickhouse.client, clickhouse.database);
  const instance = createClickHousePersistence({ client: clickhouse.client, database: clickhouse.database, logger });
  return { persistence: instance.adapter, gateway: clickhouse.gateway };
}
