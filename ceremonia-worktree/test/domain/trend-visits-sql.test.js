import { describe, expect, it } from 'vitest';
import { groupParams, planGroups } from '../../src/enrichment/segmentation-sql.js';
import { pageAggregateSql, pathAggregateSql, selectorAggregateSql } from '../../src/enrichment/trend-sql.js';
import { SHIPPED } from '../support/segmentations.js';
import { hasClickHouseLocal } from './clickhouse-local.js';
import { createLocalWarehouse } from '../support/local-warehouse.js';

const PDP = 101;
const PLP = 102;
const URLS = { [PDP]: 'https://x.com/products/a', [PLP]: 'https://x.com/collections/b' };

function visit(idvisit, firstAction, views, extra = {}) {
  const days = [...new Set(views.map(([time]) => time.slice(0, 10)))];
  return {
    visits: days.map((day) => ({ idsite: 7, idvisit, server_date: day, visit_first_action_time: firstAction, config_device_type: 1, referer_type: 1, location_city: 'Austin' })),
    pageviews: views.map(([time, idsitehsr], i) => ({ idsite: 7, idvisit, idloghsr: idvisit * 10 + i, idsitehsr, server_date: time.slice(0, 10), server_time: time })),
    ...extra,
  };
}

/**
 * Visit 1 starts on Sunday 09-27 and runs into Monday 09-28, where it orders.
 * Visit 2 stays inside week 09-28 and rage-clicks. Visit 3 starts on Sunday
 * 10-04 and checks out on Monday 10-05.
 */
const VISITS = [
  visit(1, '2026-09-27 23:50:00', [['2026-09-27 23:50:00', PDP], ['2026-09-28 00:05:00', PLP], ['2026-09-28 00:10:00', PDP]], {
    conversions: [{ idsite: 7, idvisit: 1, server_date: '2026-09-28', idorder: 'o1', revenue: 80 }],
  }),
  visit(2, '2026-09-29 10:00:00', [['2026-09-29 10:00:00', PDP], ['2026-09-29 10:02:00', PLP], ['2026-09-29 10:04:00', PDP]], {
    clicks: [{ idsite: 7, idvisit: 2, idsitehsr: PDP, server_date: '2026-09-29', idselector: '#buy', meta1: 'rage' }],
  }),
  visit(3, '2026-10-04 23:58:00', [['2026-10-04 23:58:00', PDP], ['2026-10-05 00:01:00', PLP], ['2026-10-05 00:03:00', PDP]], {
    events: [{ idsite: 7, idvisit: 3, server_date: '2026-10-05', event_type: 'checkout_started' }],
    clicks: [{ idsite: 7, idvisit: 3, idsitehsr: PDP, server_date: '2026-10-05', idselector: '#buy', meta1: '' }],
  }),
];

const warehouse = () => createLocalWarehouse({
  udp_hsrce_visits: VISITS.flatMap((v) => v.visits),
  udp_hsrce_pageviews: VISITS.flatMap((v) => v.pageviews),
  udp_conversions: VISITS.flatMap((v) => v.conversions ?? []),
  udp_clicksce_clicks: VISITS.flatMap((v) => v.clicks ?? []),
  journey_events_map: VISITS.flatMap((v) => v.events ?? []),
  site_hsr: Object.entries(URLS).map(([idsitehsr, url]) => ({ idsite: 7, idsitehsr: Number(idsitehsr), screenshot_url: url })),
});

const GROUP = planGroups(SHIPPED.select(7, 'trend'))[0];
const SCANS = [
  ['path', pathAggregateSql('template', GROUP), { templateExact: ['pdp', 'pdp > plp > pdp', 'plp > pdp'], templateExt: ['pdp > '] }],
  ['page', pageAggregateSql(GROUP), { pages: [PDP, PLP] }],
  ['selector', selectorAggregateSql(GROUP), { idsitehsr: PDP, selectors: ['#buy'] }],
];

async function weekRows(gateway, w0, w1) {
  const rows = [];
  for (const [scan, sql, params] of SCANS) {
    for (const row of await gateway.query(sql, { idsite: 7, w0, w1, ...groupParams(GROUP, {}), ...params }, `trend:${scan}`)) rows.push(JSON.stringify({ scan, ...row }));
  }
  const byWeek = {};
  for (const row of rows.sort()) (byWeek[JSON.parse(row).week_start] ??= []).push(row);
  return byWeek;
}

describe.skipIf(!hasClickHouseLocal())('trend weeks', () => {
  it('reads a week the same from the first run, the next run, and the full window', async () => {
    const gateway = warehouse();
    const first = await weekRows(gateway, '2026-09-21', '2026-10-04');
    const next = await weekRows(gateway, '2026-09-28', '2026-10-11');
    const full = await weekRows(gateway, '2026-09-21', '2026-10-11');
    expect(full['2026-09-28'].length).toBeGreaterThan(0);
    expect(next['2026-09-28']).toEqual(full['2026-09-28']);
    expect(first['2026-09-28']).toEqual(full['2026-09-28']);
    expect(next['2026-10-05']).toEqual(full['2026-10-05']);
    expect(first['2026-09-21']).toEqual(full['2026-09-21']);
  }, 120_000);

  it('orders two pageviews in the same second by idloghsr, whatever order the rows arrive in', async () => {
    const pageviews = [
      { idsite: 7, idvisit: 9, idloghsr: 91, idsitehsr: PLP, server_date: '2026-09-29', server_time: '2026-09-29 10:00:00' },
      { idsite: 7, idvisit: 9, idloghsr: 92, idsitehsr: PDP, server_date: '2026-09-29', server_time: '2026-09-29 10:00:00' },
    ];
    const read = async (rows) => {
      const gateway = createLocalWarehouse({
        udp_hsrce_visits: [{ idsite: 7, idvisit: 9, server_date: '2026-09-29', visit_first_action_time: '2026-09-29 10:00:00', config_device_type: 1, referer_type: 1, location_city: 'Austin' }],
        udp_hsrce_pageviews: rows,
        site_hsr: Object.entries(URLS).map(([idsitehsr, url]) => ({ idsite: 7, idsitehsr: Number(idsitehsr), screenshot_url: url })),
      });
      const out = await gateway.query(pathAggregateSql('template', GROUP), { ...groupParams(GROUP, {}), idsite: 7, w0: '2026-09-28', w1: '2026-10-04', templateExact: ['plp > pdp', 'pdp > plp'], templateExt: [] }, 'trend:path');
      return [...new Set(out.map((row) => row.path))];
    };
    expect(await read(pageviews)).toEqual(['plp > pdp']);
    expect(await read([...pageviews].reverse())).toEqual(['plp > pdp']);
  }, 120_000);

  it('counts a visit that crosses Sunday midnight in each week it has rows, with each week’s own facts', async () => {
    const full = await weekRows(warehouse(), '2026-09-21', '2026-10-11');
    const rows = (week, scan) => full[week].map((row) => JSON.parse(row)).filter((row) => row.scan === scan && row.viewport_value === 'desktop');
    const cell = (week, scan, segment, value) => rows(week, scan).filter((row) => row.segment === segment && row.segment_value === value);
    for (const [segment, value] of [['all', 'all'], ['traffic_source', 'direct'], ['returning', 'new'], ['rager', 'non_rager']]) {
      expect(cell('2026-09-21', 'path', segment, value).find((row) => row.path === 'pdp')).toMatchObject({ sessions: 1, orders: 0 });
    }
    expect(cell('2026-09-28', 'path', 'all', 'all').find((row) => row.path === 'plp > pdp')).toMatchObject({ sessions: 1, buyers: 1, orders: 1, revenue: 80 });
    expect(cell('2026-10-05', 'selector', 'all', 'all')).toEqual([expect.objectContaining({ selector: '#buy', clicks: 1, progressed: 1 })]);
  }, 120_000);
});
