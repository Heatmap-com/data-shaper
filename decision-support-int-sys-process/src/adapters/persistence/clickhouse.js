import { DEFAULT_DATABASE } from '../query-gateway/clickhouse.js';
import { aeSupport, v1Support } from './clickhouse/support.js';
import { createLandingPageStore } from './clickhouse/landing-page-store.js';
import { createNamingQueue } from './clickhouse/naming-queue.js';
import { createBatchStore } from './clickhouse/batch-store.js';
import { createCaptureStore } from './clickhouse/capture-store.js';
import { createDatasetStore } from './clickhouse/dataset-store.js';
import { createTrendStore } from './clickhouse/trend-store.js';
import { createSessionTagStore } from './clickhouse/session-tag-store.js';
import { createDescriptorStore } from './clickhouse/descriptor-store.js';
import { createGovernanceStore } from './clickhouse/governance-store.js';
import { createTriggerStore } from './clickhouse/trigger-store.js';
import { createSegmentationStore } from './clickhouse/segmentation-store.js';
import { createCardAnalysisStore } from './clickhouse/card-analysis-store.js';
import { createCatalogSeedStore } from './clickhouse/catalog-seed-store.js';

export { CLAIM_TTL_MS, _setClockForTests, experimentDescriptorFromCh } from './clickhouse/support.js';

/**
 * ClickHouse persistence for the v1 and schema-2 ports, composed of one
 * module per role port (src/ports/persistence/). Each factory takes the
 * client and the database name from composition; the DDL lives in
 * clickhouse/schema-migrator.js and the gateway in query-gateway/clickhouse.js.
 *
 * Tables are ReplacingMergeTree with a generated_at version and reads go
 * through _current views using argMax(..., generated_at), so inserts are
 * idempotent for a batch rerun. IMPLEMENTATION-PLAN.md section 7.
 */

/**
 * The v1 port: the landing-page store and the naming queue.
 * @param {{client: object, database?: string, logger?: object}} opts
 * @returns {{adapter: import('../../ports/persistence.js').PersistencePort}}
 */
export function createClickHousePersistence({ client, database = DEFAULT_DATABASE, logger = console }) {
  const support = v1Support({ client, database, logger });
  return {
    adapter: {
      id: 'clickhouse',
      ...createLandingPageStore(support),
      ...createNamingQueue(support),
    },
  };
}

/**
 * Schema-2 persistence (data-capture-plan.md §9.1). Same claim-token protocol
 * as v1: a claim inserts a row carrying a random token, then re-reads through
 * the `_current` FINAL view and confirms the token won; a concurrent claimer
 * with a newer generated_at wins and the loser returns null. Queue reads and
 * writes go through the `_current` views; inserts are JSONEachRow with
 * clock.now() timestamps so a rerun replaces instead of duplicating.
 *
 * @param {{client: object, database?: string, logger?: object, telemetry?: import('../../ports/telemetry.js').Telemetry | null}} opts
 * @returns {{adapter: import('../../ports/persistence.js').AePersistencePort}}
 */
export function createClickHouseAePersistence({ client, database = DEFAULT_DATABASE, logger = console, telemetry = null }) {
  const support = aeSupport({ client, database, logger, telemetry });
  return {
    adapter: {
      id: 'clickhouse-ae',
      ...createBatchStore(support),
      ...createCaptureStore(support),
      ...createDatasetStore(support),
      ...createTrendStore(support),
      ...createSessionTagStore(support),
      ...createDescriptorStore(support),
      ...createGovernanceStore(support),
      ...createTriggerStore(support),
      ...createSegmentationStore(support),
      ...createCardAnalysisStore(support),
      ...createCatalogSeedStore(support),
    },
  };
}

const instance = createClickHousePersistence({ client: null, logger: console });
const aeInstance = createClickHouseAePersistence({ client: null, logger: console });
export const adapter = instance.adapter;
export const adapters = [instance.adapter, aeInstance.adapter];
