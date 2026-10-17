import { describe, expect, it } from 'vitest';
import { TREND_COLUMNS, sessionCtes } from '../../src/enrichment/trend-sql.js';
import { assembleLoaded } from '../../src/triggers/facts.js';
import { loadTriggerFacts } from '../../src/triggers/load.js';
import { hasClickHouseLocal } from '../domain/clickhouse-local.js';
import { createLocalWarehouse } from '../support/local-warehouse.js';
import { variedWarehouseRows } from '../support/segmentation-fixture.js';
import { SHIPPED, withSites } from '../support/segmentations.js';
import { IDSITE } from '../support/site-fixture.js';

const WINDOW = { windowStart: '2026-09-07', windowEnd: '2026-09-20' };
const GOOGLE_PAID = { value: 'google_paid', when: { all: [{ field: 'referer_type', in: [2, 6] }, { field: 'utm_medium', eq: 'cpc' }] } };

/**
 * The trigger lane classifies a session on its `fields` with a declared
 * segmentation's JavaScript twin; the trend classifies the same visit with
 * its SQL over the kept sessions. They must agree on every visit both read.
 */
describe.skipIf(!hasClickHouseLocal())('trigger sessions and trend rows agree on a segmentation', () => {
  it('gives each visit the same channel, shipped and overridden', async () => {
    const gateway = createLocalWarehouse(variedWarehouseRows());
    const ctx = { ...WINDOW, gateway, batchNotes: new Map([[`url-pages:${IDSITE}`, Promise.resolve(new Map())]]), logger: { info() {}, warn() {} } };
    const sessions = assembleLoaded(await loadTriggerFacts(ctx, IDSITE, []))
      .filter((session) => session.serverDate >= WINDOW.windowStart && session.serverDate <= WINDOW.windowEnd);
    const edited = withSites([{ slug: 'test', idsite: IDSITE, defaults: {}, declarations: [], overrides: { channel: { prepend: [GOOGLE_PAID] } } }]);

    for (const registry of [SHIPPED, edited]) {
      const channel = registry.forSite(IDSITE).get('channel');
      const rows = await gateway.query(
        `WITH ${sessionCtes()} SELECT toString(k.idvisit) AS idvisit, ${channel.sql(TREND_COLUMNS)} AS value FROM kept AS k`,
        { idsite: IDSITE, w0: WINDOW.windowStart, w1: WINDOW.windowEnd },
        'test:channel',
      );
      const sql = new Map(rows.map((row) => [String(row.idvisit), String(row.value)]));
      const both = sessions.filter((session) => sql.has(session.idvisit));
      expect(both.length).toBe(sql.size);
      const mismatched = both
        .map((session) => [session.idvisit, channel.classify(session.fields), sql.get(session.idvisit)])
        .filter(([, js, fromSql]) => js !== fromSql);
      expect(mismatched).toEqual([]);
      expect(new Set(sql.values()).size).toBeGreaterThan(2);
    }
  }, 60_000);
});
