import { describe, expect, it } from 'vitest';
import { fetchSessionRows } from '../../src/adapters/_lib/session-stream.js';
import { fpHashOfVisit } from '../../src/adapters/_lib/sql.js';
import { queryBoundGaps } from '../../src/governance/query-bounds.js';
import { scanDays } from '../../src/scan/day-scan.js';
import { daySql, pageFactsSql, parseDayRow, spreadVisitsSql } from '../../src/scan/day-record.js';
import { createOpenVisits } from '../../src/scan/open-visits.js';
import { sessionRowOf, triggerInputsOf } from '../../src/scan/views.js';
import { resolveDefinitions } from '../../src/triggers/definitions.js';
import { assembleLoaded, assembleSessions } from '../../src/triggers/facts.js';
import { eventNames, loadTriggerFacts } from '../../src/triggers/load.js';
import { mondayOf } from '../../src/triggers/time.js';
import { hasClickHouseLocal } from '../domain/clickhouse-local.js';
import { createLocalWarehouse } from '../support/local-warehouse.js';

const IDSITE = 1;
const WINDOW = { windowStart: '2026-09-07', windowEnd: '2026-09-13' };
const URLS = new Map([
  ['11', { url: 'https://x.com/', title: 'Home' }],
  ['12', { url: 'https://x.com/products/a', title: 'A' }],
  ['13', { url: 'https://x.com/collections/b', title: 'B' }],
]);

const visit = (idvisit, day, time, extra = {}) => ({
  idsite: IDSITE, idvisit, server_date: day, visit_first_action_time: time, config_id: `c${idvisit}`,
  config_device_type: 1, referer_type: 2, visitor_returning: true, location_country: 'us', location_city: 'nyc',
  config_resolution: '1920x1080', config_browser_name: 'CH', config_browser_version: '120',
  visit_entry_idaction_url: 11, custom_var_k5: ' Google ', ...extra,
});
let pvSeq = 0;
const pv = (idvisit, day, idsitehsr, time_on_page, scroll_y_max_relative, clock = '12:00:00') => {
  pvSeq += 1;
  return {
    idsite: IDSITE, idvisit, idloghsr: 1000 - pvSeq, idsitehsr, server_date: day, server_time: `${day} ${clock}`,
    time_on_page, scroll_y_max_relative,
  };
};
const ev = (idvisit, day, event_type) => ({ idsite: IDSITE, idvisit, server_date: day, event_type });
const order = (idvisit, day, idorder, revenue) => ({ idsite: IDSITE, idvisit, server_date: day, idorder, revenue });
const click = (idvisit, day) => ({ idsite: IDSITE, idvisit, server_date: day });
const tag = (idvisit, day, session_tags) => ({ idsite: IDSITE, idvisit, server_date: day, session_tags });

/**
 * Seven days, one visit across midnight, an orphan pageview, a confirmed
 * bot, a rescued suspect, and two spread visits: 700 returns three days
 * later with an order, 750 five days later, past the late-row days.
 */
const FIXTURE = {
  udp_hsrce_visits: [
    visit(700, '2026-09-08', '2026-09-08 09:00:00', { visit_entry_idaction_url: 12 }),
    visit(750, '2026-09-07', '2026-09-07 08:00:00'),
    visit(750, '2026-09-12', '2026-09-12 08:00:00', { location_country: 'later', visit_entry_idaction_url: 13 }),
    visit(100, '2026-09-08', '2026-09-08 10:00:00'),
    visit(200, '2026-09-09', '2026-09-09 23:58:00', { device: 2, config_device_type: 2, referer_type: 1, visitor_returning: false, location_country: 'ca', visit_entry_idaction_url: 12, custom_var_k5: 'meta' }),
    visit(200, '2026-09-10', '2026-09-09 23:58:00.5', { location_country: 'xx', visit_entry_idaction_url: 13 }),
    visit(400, '2026-09-11', '2026-09-11 08:00:00', { config_browser_name: 'BOT' }),
    visit(500, '2026-09-12', '2026-09-12 09:00:00', { config_browser_name: 'SUS' }),
    visit(600, '2026-09-12', '2026-09-12 12:00:00', { config_id: null, location_country: null, visitor_returning: null, custom_var_k5: null }),
    visit(900, '2026-09-06', '2026-09-06 23:59:00', { location_country: 'before' }),
    visit(900, '2026-09-07', '2026-09-07 00:02:00', { location_country: 'inside' }),
  ],
  udp_hsrce_pageviews: [
    pv(100, '2026-09-08', 11, 5000, 300, '10:00:00'),
    pv(100, '2026-09-08', 12, 2_000_000, 900, '10:05:00'),
    pv(100, '2026-09-08', 12, null, null, '10:05:00'),
    pv(200, '2026-09-09', 12, 1000, 100, '23:58:00'),
    pv(200, '2026-09-10', 13, 3000, 500, '00:01:00'),
    pv(200, '2026-09-10', 12, 10, 50, '00:03:00'),
    pv(300, '2026-09-11', 11, 100, 10),
    pv(400, '2026-09-11', 11, 100, 10),
    pv(500, '2026-09-12', 12, 7000, 600),
    pv(900, '2026-09-06', 12, 4000, 200, '23:59:00'),
    pv(900, '2026-09-07', 11, 6000, 300, '00:02:00'),
    pv(700, '2026-09-08', 12, 1500, 200, '09:00:00'),
    pv(700, '2026-09-11', 12, 2500, 800, '14:00:00'),
    pv(750, '2026-09-07', 11, 100, 10, '08:00:00'),
    pv(750, '2026-09-12', 13, 900, 90, '08:00:00'),
  ],
  journey_events_map: [
    ev(100, '2026-09-08', 'product_viewed'),
    ev(100, '2026-09-08', 'product_viewed'),
    ev(200, '2026-09-09', 'product_viewed'),
    ev(200, '2026-09-10', 'add_to_cart'),
    ev(200, '2026-09-10', 'checkout_started'),
    ev(200, '2026-09-10', 'search_submitted'),
    ev(500, '2026-09-12', 'add_to_cart'),
    ev(700, '2026-09-11', 'add_to_cart'),
  ],
  udp_conversions: [
    order(100, '2026-09-08', 'o1', 50),
    order(100, '2026-09-08', 'o1', 50),
    order(200, '2026-09-09', 'o2', 80),
    order(200, '2026-09-10', 'o2', 80),
    order(200, '2026-09-10', 'o3', 20),
    order(700, '2026-09-11', 'o7', 30),
  ],
  udp_clicksce_clicks: [
    click(100, '2026-09-08'), click(100, '2026-09-08'), click(200, '2026-09-09'), click(200, '2026-09-10'), click(200, '2026-09-10'),
    click(700, '2026-09-11'),
  ],
  udp_session_tags: [
    tag(100, '2026-09-08', '{}'),
    tag(200, '2026-09-10', '{"utm_source":"meta","utm_medium":"paid"}'),
    tag(600, '2026-09-12', '{"Medium":"email"}'),
    tag(700, '2026-09-11', '{"utm_medium":"email"}'),
  ],
};

async function botStub(gateway) {
  const rows = await gateway.query(
    `SELECT toString(idvisit) AS idvisit, toString(min(server_date)) AS day, toString(${fpHashOfVisit()}) AS fp
     FROM default.udp_hsrce_visits WHERE idsite = {idsite:UInt32} GROUP BY idvisit`,
    { idsite: IDSITE },
    'test:fingerprints',
  );
  const tiers = new Map();
  for (const row of rows) {
    const key = `${mondayOf(row.day)}|${row.fp}`;
    if (row.idvisit === '400') tiers.set(key, { tier: 'confirmed', reasons: ['square'] });
    if (row.idvisit === '500') tiers.set(key, { tier: 'suspect', reasons: ['spike'] });
  }
  return { tierOf: (week, fp) => tiers.get(`${week}|${fp}`) ?? null, notes: {} };
}

function ctxFor(gateway, bot) {
  const batchNotes = new Map([
    [`bot:${IDSITE}`, Promise.resolve(bot)],
    [`url-pages:${IDSITE}`, Promise.resolve(URLS)],
  ]);
  return { ...WINDOW, gateway, batchNotes, logger: { info() {}, warn() {} } };
}

async function scanned(gateway, events = [], pages = [], start = WINDOW.windowStart) {
  const closed = [];
  const notes = await scanDays({
    gateway, idsite: IDSITE, end: WINDOW.windowEnd, events, pages,
    consumers: [{ start, onClosed: (visits) => { closed.push(...visits); } }],
  });
  return { closed, notes: { days: notes.days, ...notes.lanes[0] } };
}

const byVisit = (a, b) => a.idvisit.localeCompare(b.idvisit);
const sortedArrays = (session) => ({ ...session, events: [...session.events].sort(), productPages: [...session.productPages].sort() });

describe.skipIf(!hasClickHouseLocal())('day scan matches the window queries', () => {
  it('folds each visit to the fetchSessionRows row', async () => {
    const gateway = createLocalWarehouse(FIXTURE);
    const bot = await botStub(gateway);
    const window = await fetchSessionRows(ctxFor(gateway, bot), IDSITE);
    const { closed, notes } = await scanned(gateway);
    const scan = closed.map((visit) => sessionRowOf(visit, bot));

    expect(scan.sort(byVisit)).toEqual(window.sort(byVisit));
    expect(window.map((row) => row.idvisit)).toEqual(['100', '200', '400', '500', '600', '700', '750', '900']);
    const midnight = scan.find((row) => row.idvisit === '200');
    expect(midnight).toMatchObject({ firstDate: '2026-09-09', country: 'ca', entryHsr: '12', pageviews: 3, orders: 2, revenue: 100, sawAtc: true });
    expect(scan.find((row) => row.idvisit === '400').tier).toBe('confirmed');
    expect(scan.find((row) => row.idvisit === '500')).toMatchObject({ tier: null, rescued: true });
    expect(scan.find((row) => row.idvisit === '700')).toMatchObject({ firstDate: '2026-09-08', pageviews: 2, orders: 1, revenue: 30, sawAtc: true });
    expect(scan.find((row) => row.idvisit === '750')).toMatchObject({ firstDate: '2026-09-07', country: 'us', pageviews: 2 });
    expect(notes).toMatchObject({ days: 7, orphans: 1, lateRows: 0, closed: 8, open: 0, spread: 2 });
  }, 60_000);

  it('carries a chosen page\'s scroll and time as fetchSessionRows with idsitehsr does', async () => {
    const gateway = createLocalWarehouse(FIXTURE);
    const bot = await botStub(gateway);
    const window = await fetchSessionRows(ctxFor(gateway, bot), IDSITE, { idsitehsr: 12 });
    const { closed } = await scanned(gateway, [], [12]);
    const scan = closed.map((visit) => sessionRowOf(visit, bot, { idsitehsr: 12 }));
    expect(scan.sort(byVisit)).toEqual(window.sort(byVisit));
    expect(scan.find((row) => row.idvisit === '200')).toMatchObject({ scrollMax: 100, landingPageviews: 2, pageCappedMs: 1010 });
  }, 60_000);

  it('keeps a lane that starts at the window apart from one that starts earlier', async () => {
    const gateway = createLocalWarehouse(FIXTURE);
    const lanes = { early: [], window: [] };
    await scanDays({
      gateway, idsite: IDSITE, end: WINDOW.windowEnd,
      consumers: [
        { start: '2026-09-06', onClosed: (visits) => { lanes.early.push(...visits); } },
        { start: WINDOW.windowStart, onClosed: (visits) => { lanes.window.push(...visits); } },
      ],
    });
    const early = lanes.early.find((v) => v.idvisit === '900');
    const inside = lanes.window.find((v) => v.idvisit === '900');
    expect(early).toMatchObject({ firstDate: '2026-09-06', country: 'before', pageviewRows: 2 });
    expect(inside).toMatchObject({ firstDate: '2026-09-07', country: 'inside', pageviewRows: 1 });
  }, 60_000);

  it('folds each visit to the assembleSessions trigger fact', async () => {
    const gateway = createLocalWarehouse(FIXTURE);
    const bot = await botStub(gateway);
    const ctx = ctxFor(gateway, bot);
    const loaded = await loadTriggerFacts(ctx, IDSITE, []);
    const window = assembleLoaded(loaded);

    const names = eventNames(resolveDefinitions({}, []));
    // The fixture's earliest day; loadTriggerFacts reads from 28 days before the window.
    const { closed } = await scanned(gateway, names, [], '2026-09-06');
    const scan = assembleSessions({ ...triggerInputsOf(closed, new Set(names)), urls: URLS });

    expect(scan.map(sortedArrays).sort(byVisit)).toEqual(window.map(sortedArrays).sort(byVisit));
    expect(scan.find((row) => row.idvisit === '200')).toMatchObject({
      serverDate: '2026-09-09', pageviews: 2, clicks: 3, medium: 'paid', scrollPct: 50, durationSec: 4.01,
    });
  }, 60_000);
});

describe('day record', () => {
  it('bounds every fact table to the site and the day', () => {
    expect(queryBoundGaps(daySql())).toEqual([]);
    expect(queryBoundGaps(daySql({ partnerTags: true }))).toEqual([]);
  });

  it('bounds the spread-visit reads to the site and the range', () => {
    expect(queryBoundGaps(spreadVisitsSql({ partnerTags: true }))).toEqual([]);
    expect(queryBoundGaps(daySql({ partnerTags: true, spread: true }))).toEqual([]);
    expect(queryBoundGaps(pageFactsSql({ spread: true }))).toEqual([]);
  });
});

describe('open visits', () => {
  const row = (idvisit, day, extra = {}) => parseDayRow({
    idvisit, has_visit: 1, started_at: `${day} 10:00:00`, pageview_rows: 1, hsrs: ['11'], ...extra,
  }, day);

  it('closes a visit after a quiet day and keeps one seen that day', () => {
    const open = createOpenVisits({ hold: 1 });
    open.add([row('a', '2026-09-01'), row('b', '2026-09-01')]);
    expect(open.closeQuiet('2026-09-01')).toEqual([]);
    open.add([row('b', '2026-09-02')]);
    expect(open.closeQuiet('2026-09-02').map((v) => v.idvisit)).toEqual(['a']);
    expect(open.closeAll('2026-09-02').map((v) => v.idvisit)).toEqual(['b']);
  });

  it('drops and counts a row that arrives after its visit closed', () => {
    const open = createOpenVisits({ hold: 1, lateDays: 3 });
    open.add([row('a', '2026-09-01')]);
    open.add([]);
    expect(open.closeQuiet('2026-09-02').map((v) => v.idvisit)).toEqual(['a']);
    open.add([row('a', '2026-09-03')]);
    expect(open.closeAll('2026-09-03')).toEqual([]);
    expect(open.stats()).toMatchObject({ lateRows: 1, closed: 1 });
  });

  it('keeps the visit fields of the earliest-starting row', () => {
    const open = createOpenVisits();
    open.add([row('a', '2026-09-02', { started_at: '2026-09-01 23:59:00', country: 'late' })]);
    open.add([row('a', '2026-09-02', { started_at: '2026-09-01 23:58:00', country: 'early' })]);
    const [visit] = open.closeAll('2026-09-02');
    expect(visit.country).toBe('early');
    expect(visit.pageviewRows).toBe(2);
  });

  it('opens a spread visit whole on its first day and skips its later rows', () => {
    const later = row('a', '2026-09-05', { pageview_rows: 2, orders: [['o1', 30]] });
    const ahead = new Map([['a', { rows: [row('a', '2026-09-01'), later], facts: [{ idvisit: 'a', day: '2026-09-05', hsr: '12', scrollMax: 80, landingPageviews: 1, pageCappedMs: 900 }] }]]);
    const open = createOpenVisits({ hold: 1, lateDays: 3, ahead });
    open.add([row('a', '2026-09-01')]);
    open.addPageFacts([{ idvisit: 'a', hsr: '12', scrollMax: 10, landingPageviews: 1, pageCappedMs: 5 }]);
    open.add([]);
    const [visit] = open.closeQuiet('2026-09-02');
    expect(visit).toMatchObject({ firstDate: '2026-09-01', pageviewRows: 3 });
    expect([...visit.orders]).toEqual([['o1', 30]]);
    expect(visit.pageFacts.get('12')).toEqual({ scrollMax: 80, landingPageviews: 1, pageCappedMs: 900 });
    open.add([later]);
    expect(open.closeAll('2026-09-05')).toEqual([]);
    expect(open.stats()).toMatchObject({ spread: 1, spreadRows: 1, lateRows: 0, closed: 1 });
  });

  it('drops a visit with facts and no visit row', () => {
    const open = createOpenVisits();
    open.add([row('a', '2026-09-01', { has_visit: 0 })]);
    expect(open.closeAll('2026-09-01')).toEqual([]);
    expect(open.stats().orphans).toBe(1);
  });
});
