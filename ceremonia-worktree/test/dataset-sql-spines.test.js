import { describe, expect, it } from 'vitest';
import { adapter as lineItems } from '../src/adapters/datasets/line-items.js';
import { adapter as orderValueHist } from '../src/adapters/datasets/order-value-hist.js';
import { adapter as strategyTriggers } from '../src/adapters/datasets/strategy-triggers.js';
import { adapter as viewportWeekly } from '../src/adapters/datasets/viewport-weekly.js';
import { getClickRows } from '../src/adapters/_lib/clicks.js';

/**
 * The SQL the datasets send, whitespace collapsed, for the adapters whose
 * repeated CTEs (the entry-visit spine and the dominant viewport) moved
 * into adapters/_lib. The snapshot was taken before the move.
 */

const PAGE = { idsite: 7, idsitehsr: 99, url: 'https://shop.example/pages/lp', pageType: 'content' };

function recordingContext(datasets = new Map()) {
  const sent = [];
  return {
    sent,
    ctx: {
      windowStart: '2026-09-01',
      windowEnd: '2026-09-28',
      batchNotes: new Map(),
      datasets,
      standards: {},
      gateway: {
        async query(sql, params, label) {
          sent.push({ label, sql: sql.replace(/\s+/g, ' ').trim(), params: Object.keys(params ?? {}).sort() });
          return [];
        },
      },
    },
  };
}

async function sqlOf(run, datasets) {
  const { ctx, sent } = recordingContext(datasets);
  try {
    await run(ctx);
  } catch {
    // the recorded queries are the subject; empty results may end a collect early
  }
  // a rejected Promise.all leaves sibling queries in flight
  await new Promise((resolve) => setTimeout(resolve, 50));
  return sent.sort((a, b) => a.label.localeCompare(b.label) || a.sql.localeCompare(b.sql));
}

describe('dataset SQL spines', () => {
  it('line-items, order-value-hist, viewport-weekly, and clicks send the same SQL', async () => {
    expect({
      lineItems: await sqlOf((ctx) => lineItems.collect(PAGE, ctx)),
      orderValueHist: await sqlOf((ctx) => orderValueHist.collect(PAGE, ctx)),
      viewportWeekly: await sqlOf((ctx) => viewportWeekly.collect(PAGE, ctx)),
      clicks: await sqlOf((ctx) => getClickRows(ctx, PAGE)),
    }).toMatchSnapshot();
  });

  it('strategy-triggers sends the same entry-viewport SQL', async () => {
    const datasets = new Map([
      ['element-binding', { rows: [{ dims: { element_class: 'hero_cta', selector: '#hero a' } }] }],
      ['render-snapshot', { rows: [{ dims: { node_kind: 'element', selector: '#hero a', device_class: 'mobile' }, metrics: { y: 420 } }] }],
    ]);
    const sent = await sqlOf((ctx) => strategyTriggers.collect(PAGE, ctx), datasets);
    expect(sent.map((q) => q.label)).toContain('strategy-triggers:hero-fold');
    expect(sent).toMatchSnapshot();
  });
});
