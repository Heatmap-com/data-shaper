import { describe, expect, it } from 'vitest';
import { adapter as navNextPage } from '../../src/adapters/datasets/nav-next-page.js';
import { adapter as rageClicks } from '../../src/adapters/datasets/rage-clicks.js';
import { adapter as selectorWeekly } from '../../src/adapters/datasets/selector-weekly.js';
import { adapter as tapGeometry } from '../../src/adapters/datasets/tap-geometry-weekly.js';

/**
 * The page's click datasets over nine days of generated clicks: selectors
 * with bursts that rage, portal rage flags, clicks without a position or
 * a time since load, clicks by sessions that entered elsewhere, and next
 * pages inside and outside the site. The fake gateway answers a click read
 * bounded by the window or by one day, so the stored rows pin the datasets
 * whatever the shape of the click read. The read has no order, so the rows
 * are compared in dims order.
 */

/** @param {Array<{dims: object}>} rows */
const sortRows = (rows) => [...rows].sort((a, b) => (JSON.stringify(a.dims) < JSON.stringify(b.dims) ? -1 : 1));

const WINDOW = { windowStart: '2026-09-26', windowEnd: '2026-10-04' };
const HSR = 222;
const PAGE = { idsite: 1, idsitehsr: HSR, url: 'https://x.com/pages/lp', title: 'LP', pageType: 'content' };
const DAYS = Array.from({ length: 9 }, (_, i) => {
  const d = new Date(`${WINDOW.windowStart}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + i);
  return d.toISOString().slice(0, 10);
});
const mondayOf = (day) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
};
const SELECTORS = ['#buy', '.hero a', 'nav > li:nth-child(2)', '#size'];

const SESSIONS = Array.from({ length: 48 }, (_, i) => ({
  idvisit: String(i + 1),
  first_date: DAYS[i % 9],
  week: mondayOf(DAYS[i % 9]),
  device: i % 3 === 0 ? 2 : 1,
  referer: 1,
  returning: 0,
  entry_hsr: i % 7 === 6 ? '999' : String(HSR),
  country: 'us',
  browser: i % 5 === 0 ? '' : 'Chrome',
  fp_hash: '1',
  utm_source: '',
  pageviews: 3,
  capped_ms: 20000,
  saw_product: 1,
  saw_atc: i % 4 === 0 ? 1 : 0,
  saw_checkout: i % 6 === 0 ? 1 : 0,
  saw_purchase: i % 8 === 0 ? 1 : 0,
  orders: i % 8 === 0 ? 1 : 0,
  revenue: i % 8 === 0 ? 40 + i : 0,
}));

const CLICKS = SESSIONS.flatMap((session, i) => {
  const day = session.first_date;
  const count = 1 + (i % 5);
  return Array.from({ length: count }, (_, k) => ({
    idvisit: session.idvisit,
    idloghsr: `pv${session.idvisit}-${k % 2}`,
    selector: SELECTORS[(i + k) % SELECTORS.length],
    week: session.week,
    date: day,
    server_time: `${day} ${String(8 + k).padStart(2, '0')}:00:00`,
    meta1: i % 11 === 0 && k === 0 ? 'rage' : '',
    x: (i + k) % 9 === 0 ? null : 20 + ((i * 37 + k * 11) % 300),
    y: (i + k) % 9 === 0 ? null : 40 + ((i * 53 + k * 7) % 900),
    time_since_load: (i + k) % 10 === 0 ? -1 : 1000 + k * (i % 3 === 0 ? 400 : 2500),
  })).concat(i % 7 === 3 ? [{
    idvisit: session.idvisit,
    idloghsr: `pv${session.idvisit}-0`,
    selector: SELECTORS[i % SELECTORS.length],
    week: `${session.week}+1`,
    date: day,
    server_time: `${day} 23:00:00`,
    meta1: '',
    x: 60,
    y: 110,
    time_since_load: i % 10 === 0 ? -1 : 1000,
  }] : []);
});

const SEQUENCES = SESSIONS.flatMap((session, i) => [
  { idvisit: session.idvisit, idloghsr: `pv${session.idvisit}-0`, hsr: String(HSR) },
  { idvisit: session.idvisit, idloghsr: `pv${session.idvisit}-1`, hsr: String(HSR) },
  ...(i % 4 === 3 ? [] : [{ idvisit: session.idvisit, idloghsr: `pv${session.idvisit}-2`, hsr: i % 4 === 2 ? '7' : '5' }]),
]);
const URLS = [
  { hsr: String(HSR), url: 'https://x.com/pages/lp' },
  { hsr: '5', url: 'https://x.com/products/a' },
  { hsr: '7', url: 'https://pay.example.com/checkout' },
];
const BOXES = [
  { device_class: '', selector: '#buy', x: 50, y: 100, w: 120, h: 40 },
  { device_class: 'mobile', selector: '.hero a', x: 0, y: 300, w: 200, h: 80 },
  { device_class: 'desktop', selector: '.hero a', x: 100, y: 200, w: 300, h: 90 },
];

function gateway() {
  const clickReads = [];
  return {
    clickReads,
    async query(_sql, params, label) {
      switch (label) {
        case 'sessions:entry':
          return SESSIONS;
        case 'clicks:page': {
          const from = params.day ?? params.w0;
          const to = params.day ?? params.w1;
          const rows = CLICKS.filter((c) => c.date >= from && c.date <= to);
          clickReads.push(rows.length);
          return rows.map((r) => ({ ...r }));
        }
        case 'pageviews:sequences':
          return SEQUENCES;
        case 'urls:site-hsr':
          return URLS;
        case 'selector-weekly:am-elements':
          return [{ selector: '#buy', label: 'Buy now', role: 'button' }];
        case 'tap-geometry-weekly:boxes':
          return BOXES;
        case 'element-binding':
          return [{ selector: '#buy', element_class: 'buy_button', name: 'Buy' }];
        case 'check:time-since-load-unit':
          return [{ mn: 50, p50: 500, mx: 20000 }];
        case 'bot:fingerprints':
        case 'bot:version-shares':
        case 'bot:version-lookback':
          return [];
        default:
          throw new Error(`unexpected query: ${label}`);
      }
    },
    async explain() { return 'plan'; },
    async columns() { return []; },
  };
}

describe('the page click datasets', () => {
  it('store the same rows over a multi-day click read', async () => {
    const gw = gateway();
    const ctx = {
      batchId: 'b1',
      ...WINDOW,
      gateway: gw,
      logger: { info() {}, warn() {}, error() {} },
      clock: { todayUtc: () => '2026-10-05' },
      datasets: new Map(),
      batchNotes: new Map(),
    };
    const out = {};
    for (const adapter of [selectorWeekly, rageClicks, tapGeometry, navNextPage]) {
      const result = await adapter.collect(PAGE, ctx);
      ctx.datasets.set(adapter.id, result);
      out[adapter.id] = { rows: sortRows(result.rows), notes: result.notes ?? {} };
    }
    expect(gw.clickReads.reduce((a, b) => a + b, 0)).toBe(CLICKS.length);
    expect(out).toMatchSnapshot();
  });
});
