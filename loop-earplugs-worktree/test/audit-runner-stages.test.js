import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { selectBrands } from '../src/audit/brands.js';

const BRANDS = [{ key: 'ceremonia', name: 'Ceremonia', domain: 'ceremonia.com' }];
import { REQUIRED_CLASSES } from '../src/audit/element-classes.js';
import { runAudit } from '../src/audit/runner.js';
import { auditWindows } from '../src/audit/windows.js';

const TODAY = '2026-10-06';
const windows = auditWindows(TODAY);
const TEMPLATES = ['home', 'plp', 'pdp', 'cart_page', 'checkout'];
const DEVICES = ['Mobile', 'Desktop'];

const inputs = {
  entries: Object.entries(REQUIRED_CLASSES).flatMap(([template, classes]) =>
    classes.slice(0, 3).map((elementClass, i) => ({
      idsite: 9,
      template,
      element_class: elementClass,
      element_name: elementClass,
      selector_match: `div.${elementClass.replace('.', '-')}`,
      position: i === 0 ? 1 : null,
      valid_from: '2024-01-01',
      valid_to: '2099-12-31',
    }))),
  urlRules: [
    { idsite: 9, pattern: '^/$', template: 'home' },
    { idsite: 9, pattern: '^/collections/[^/]+$', template: 'plp' },
    { idsite: 9, pattern: '/products/', template: 'pdp' },
    { idsite: 9, pattern: '^/cart', template: 'cart_page' },
    { idsite: 9, pattern: '^/checkouts', template: 'checkout' },
  ],
  events: [{ idsite: 9, date: windows.snapshotStart, label: 'Sale' }],
};

/**
 * A deterministic row set for any audit query: three weeks across the
 * window, every template and device the interpreters group by, and the
 * metric names they read.
 * @param {object} params
 * @param {string} label
 */
function cannedRows(params, label) {
  if (label === 'audit:R1') {
    return [{ idsite: 9, name: 'Ceremonia', main_url: 'https://ceremonia.com', platform: 'shopify', currency: 'USD', status: 'active' }];
  }
  if (label === 'audit:pages') {
    return [
      { idsitehsr: '11', url: 'https://ceremonia.com/' },
      { idsitehsr: '22', url: 'https://ceremonia.com/collections/hair' },
      { idsitehsr: '33', url: 'https://ceremonia.com/products/oil' },
      { idsitehsr: '44', url: 'https://ceremonia.com/cart' },
      { idsitehsr: '55', url: 'https://ceremonia.com/checkouts/c/1' },
    ];
  }
  const weeks = [params.start ?? windows.trendStart, windows.snapshotStart, params.end ?? windows.trendEnd];
  return weeks.flatMap((week, w) => TEMPLATES.slice(0, 2 + w).map((template, t) => {
    const n = 100 + w * 37 + t * 11;
    return {
      week,
      day: week,
      server_date: week,
      template,
      device: DEVICES[(w + t) % 2],
      returning: t % 2 === 0 ? 'new' : 'returning',
      channel: ['Paid', 'Direct', 'Organic'][t % 3],
      step: ['cart', 'checkout', 'purchase'][t % 3],
      path: `home > ${template}`,
      element_class: Object.values(REQUIRED_CLASSES)[t][w],
      event_type: String(t),
      table: 'log_hsr',
      sessions: n,
      visits: n,
      pageviews: n * 2,
      buyers: Math.floor(n / 20),
      orders: Math.floor(n / 25),
      distinct_orders: Math.floor(n / 25),
      zero_revenue: 0,
      unmatched: 0,
      revenue: n * 3.5,
      clicks: Math.floor(n / 4),
      exits: Math.floor(n / 6),
      started: n,
      completed: Math.floor(n / 3),
      atc_no_checkout: 4 + t,
      checkout_no_purchase: 2 + w,
      abandoned_sessions: 3,
      completed_sessions: 10 + t,
      completed_revenue: 500 + n,
      idsitehsr: String(11 * (t + 1)),
      latest: params.end ?? windows.trendEnd,
      max_date: windows.snapshotEnd,
      rows: n * 10,
    };
  }));
}

/**
 * Stored rows by dataset and query: a count, and a digest of the rows in
 * the order they were written.
 * @param {object[]} rows
 */
function storedDigest(rows) {
  /** @type {Record<string, object[]>} */
  const groups = {};
  for (const { batchId: _id, ...row } of rows) {
    const key = `${row.datasetId}|${row.dimExtra?.query ?? ''}`;
    (groups[key] ??= []).push(row);
  }
  return Object.fromEntries(Object.entries(groups).map(([key, list]) => [
    key,
    `${list.length} ${createHash('sha256').update(JSON.stringify(list)).digest('hex').slice(0, 16)}`,
  ]));
}

function recordingGateway() {
  /** @type {string[]} */
  const labels = [];
  return {
    labels,
    async query(_sql, params, label) {
      labels.push(label);
      if (label === 'audit:F3') throw new Error('F3 refused for the test');
      return cannedRows(params ?? {}, label);
    },
  };
}

describe('audit runner characterization', () => {
  it.each(['readiness', 'funnel', 'template', 'context', 'all'])('keeps the %s phase output, stored rows, and query order', async (phase) => {
    const gateway = recordingGateway();
    /** @type {object[]} */
    const stored = [];
    const summary = await runAudit({
      gateway,
      persistence: {
        async createBatch() {},
        async writeDatasetRows(rows) { stored.push(...rows); },
      },
      brands: selectBrands(BRANDS, ['ceremonia'], [9]),
      clock: { todayUtc: () => TODAY },
      phase,
      inputs,
    });
    const { batchId, ...rest } = summary;
    expect(stored.every((row) => row.batchId === batchId)).toBe(true);
    expect({
      summary: rest,
      labels: gateway.labels,
      stored: storedDigest(stored),
    }).toMatchSnapshot();
  });
});
