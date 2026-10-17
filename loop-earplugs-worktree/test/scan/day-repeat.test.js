import { describe, expect, it } from 'vitest';
import { fetchSessionTags } from '../../src/adapters/_lib/session-tags.js';
import { scanDays } from '../../src/scan/day-scan.js';
import { parseDayRow } from '../../src/scan/day-record.js';
import { loadTriggerFacts } from '../../src/triggers/load.js';
import { hasClickHouseLocal } from '../domain/clickhouse-local.js';
import { createLocalWarehouse } from '../support/local-warehouse.js';

const IDSITE = 1;
const DAY = '2026-09-08';

const visit = (idvisit, extra = {}) => ({
  idsite: IDSITE, idvisit, server_date: DAY, visit_first_action_time: `${DAY} 10:00:00`, config_id: `c${idvisit}`,
  config_device_type: 1, referer_type: 2, visitor_returning: true, location_country: 'us', location_city: 'nyc',
  config_resolution: '1920x1080', config_browser_name: 'CH', config_browser_version: '120',
  visit_entry_idaction_url: '12', custom_var_k5: '', ...extra,
});
const tag = (idvisit, session_tags, server_date = DAY) => ({ idsite: IDSITE, idvisit, server_date, session_tags });

/**
 * Visit 801's tag rows arrive b then a, and 802's a then b, so a pick by
 * arrival order gives a different answer for each.
 */
const FIXTURE = {
  udp_hsrce_visits: [visit(801), visit(802), visit(803, { server_date: '2026-09-09', visit_first_action_time: '2026-09-09 10:00:00' })],
  udp_hsrce_pageviews: [
    { idsite: IDSITE, idvisit: 801, idloghsr: 1, idsitehsr: 12, server_date: DAY, server_time: `${DAY} 10:00:00`, time_on_page: 10, scroll_y_max_relative: 10 },
    { idsite: IDSITE, idvisit: 802, idloghsr: 2, idsitehsr: 12, server_date: DAY, server_time: `${DAY} 10:00:00`, time_on_page: 10, scroll_y_max_relative: 10 },
  ],
  udp_conversions: [
    { idsite: IDSITE, idvisit: 803, server_date: '2026-09-09', idorder: 'o9', revenue: 10 },
    { idsite: IDSITE, idvisit: 803, server_date: '2026-09-10', idorder: 'o9', revenue: 12 },
  ],
  udp_session_tags: [
    tag(801, '{"utm_source":"b"}'),
    tag(801, '{"utm_source":"a"}'),
    tag(802, '{"utm_source":"a"}'),
    tag(802, '{"utm_source":"b"}'),
  ],
};

const SMALLEST = '{"utm_source":"a"}';

describe.skipIf(!hasClickHouseLocal())('a visit with several tag rows or revenue rows reads one way', () => {
  it('takes the smallest tag row in the day record', async () => {
    const gateway = createLocalWarehouse(FIXTURE);
    const closed = [];
    await scanDays({ gateway, idsite: IDSITE, end: DAY, consumers: [{ start: DAY, onClosed: (visits) => { closed.push(...visits); } }] });
    expect(Object.fromEntries(closed.map((v) => [v.idvisit, v.tags]))).toEqual({ 801: SMALLEST, 802: SMALLEST });
  }, 60_000);

  it('takes the smallest tag row and the largest revenue in the trigger window load', async () => {
    const gateway = createLocalWarehouse(FIXTURE);
    const ctx = {
      windowStart: DAY, windowEnd: '2026-09-10', gateway, logger: { info() {}, warn() {} },
      batchNotes: new Map([[`url-pages:${IDSITE}`, Promise.resolve(new Map())]]),
    };
    const loaded = await loadTriggerFacts(ctx, IDSITE, []);
    expect(Object.fromEntries(loaded.tags.map((row) => [row.idvisit, row.session_tags]))).toEqual({ 801: SMALLEST, 802: SMALLEST });
    expect(loaded.orders.find((row) => row.idvisit === '803')).toMatchObject({ revenue: 12 });
  }, 60_000);

  it('takes the smallest tag row in the per-page tag load', async () => {
    const gateway = createLocalWarehouse(FIXTURE);
    const ctx = { windowStart: DAY, windowEnd: DAY, gateway, batchNotes: new Map(), pageNotes: new Map() };
    const tags = await fetchSessionTags(ctx, { idsite: IDSITE, idsitehsr: 12 });
    expect(Object.fromEntries(tags)).toEqual({ 801: SMALLEST, 802: SMALLEST });
  }, 60_000);
});

describe('a day record is the same however the warehouse orders it', () => {
  it('sorts each row\'s sets', () => {
    const row = parseDayRow({
      idvisit: '1', has_visit: 1, hsrs: ['13', '11', '12'], events: ['b', 'a'],
      orders: [['o2', 5], ['o1', 7]], arms: [['2026-09-07', 'e2', 'v1'], ['2026-09-07', 'e1', 'v2']],
    }, DAY);
    expect(row.hsrs).toEqual(['11', '12', '13']);
    expect(row.events).toEqual(['a', 'b']);
    expect(row.orders).toEqual([['o1', 7], ['o2', 5]]);
    expect(row.arms).toEqual([JSON.stringify(['2026-09-07', 'e1', 'v2']), JSON.stringify(['2026-09-07', 'e2', 'v1'])]);
  });

  it('closes a day\'s visits in idvisit order', async () => {
    const day = (ids) => ids.map((idvisit) => ({ idvisit, has_visit: 1, started_at: `${DAY} 10:00:00`, pageview_rows: 1, hsrs: ['11'] }));
    const order = async (ids) => {
      const gateway = { query: async (sql) => (/HAVING/.test(sql) ? [] : day(ids)) };
      const closed = [];
      await scanDays({ gateway, idsite: IDSITE, end: DAY, consumers: [{ start: DAY, onClosed: (visits) => { closed.push(...visits.map((v) => v.idvisit)); } }] });
      return closed;
    };
    expect(await order(['30', '4', '200'])).toEqual(['4', '30', '200']);
    expect(await order(['200', '30', '4'])).toEqual(['4', '30', '200']);
  });
});
