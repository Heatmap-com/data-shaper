import { createClickHouseAePersistence } from '../../adapters/persistence/clickhouse.js';

/**
 * Stored analysis batches over the engine's ClickHouse persistence, for the
 * analysis stage's check. The client is made on the first read, so commands
 * that never check a batch need no credentials. It reads ae_batch only.
 *
 * @param {{connect: () => object}} options connect makes the ClickHouse client
 */
export function createAeBatchReader({ connect }) {
  let persistence = null;
  return {
    /** @param {string} batchId */
    async getBatch(batchId) {
      persistence ??= createClickHouseAePersistence({ client: connect(), logger: { info() {}, warn() {}, error() {} } }).adapter;
      return persistence.getBatch(batchId);
    },
  };
}
