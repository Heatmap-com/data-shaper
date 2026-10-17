import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { orderedReach } from '../src/adapters/_lib/funnel-reach.js';
import { parsePath, prefixReach, typedPath } from '../src/adapters/_lib/session-paths.js';
import { reachCells, stepRows } from '../src/adapters/_lib/site-sessions.js';
import { adapter as cardsFn } from '../src/adapters/datasets/cards-fn.js';
import { adapter as cardsJr } from '../src/adapters/datasets/cards-jr.js';
import { chooseFunnels } from '../src/adapters/subject-selectors/catalog-funnels.js';
import { chooseJourneys } from '../src/adapters/subject-selectors/journey-paths.js';
import { loadCatalog } from '../src/catalog/index.js';

/**
 * Funnel and journey subjects: the ordered reach walk, the page-type path
 * prefix, how the selectors choose by criteria, and the FN and JR card
 * rules over step rows.
 */

const ev = (eventType, minute) => ({ eventType, tsMs: minute * 60000 });
const PURCHASE = ['product_viewed', 'add_to_cart', 'checkout_started', 'checkout_completed'];

describe('orderedReach', () => {
  it('walks the steps in order with other events between them', () => {
    const events = [ev('add_to_cart', 0), ev('product_viewed', 1), ev('cart_viewed', 2), ev('add_to_cart', 4), ev('checkout_completed', 5)];
    expect(orderedReach(events, PURCHASE)).toEqual({ reached: 2, gaps: [3] });
  });

  it('reaches every step of a full journey', () => {
    const events = [ev('product_viewed', 0), ev('add_to_cart', 1), ev('checkout_started', 3), ev('checkout_completed', 9)];
    expect(orderedReach(events, PURCHASE)).toEqual({ reached: 4, gaps: [1, 2, 6] });
  });
});

describe('page-type paths', () => {
  const urls = new Map([['1', 'https://x.com/'], ['2', 'https://x.com/collections/all'], ['3', 'https://x.com/products/a'], ['4', 'https://x.com/cart']]);

  it('types the pageviews and collapses a run of one type', () => {
    expect(typedPath(['1', '2', '3', '3', '4', '3'], urls)).toEqual(['home', 'collection', 'product', 'cart', 'product']);
  });

  it('measures how many template steps a path opens with', () => {
    expect(prefixReach(['home', 'collection', 'cart'], ['home', 'collection', 'product'])).toBe(2);
    expect(prefixReach(['product'], ['home', 'collection'])).toBe(0);
  });

  it('parses a template and names unknown page types', () => {
    expect(parsePath('home > collection>product')).toEqual(['home', 'collection', 'product']);
    expect(() => parsePath('home>pdp')).toThrow('journey path "home>pdp" names unknown page types pdp');
    expect(() => parsePath('home')).toThrow('needs two or more steps');
  });
});

describe('the catalog-funnels selector', () => {
  const funnels = loadCatalog().funnels.funnels;
  const firstStep = new Map([['purchase', 400], ['browse', 120], ['checkout', 40]]);

  it('chooses the funnels whose first step holds the session floor, most sessions first', () => {
    expect(chooseFunnels(funnels, firstStep, { minSessions: 100 }).map((c) => c.funnel.id)).toEqual(['purchase', 'browse']);
  });

  it('chooses a named funnel whatever its volume', () => {
    expect(chooseFunnels(funnels, firstStep, { funnel: 'checkout', minSessions: 100 }).map((c) => c.funnel.id)).toEqual(['checkout']);
  });

  it('names the known funnels in its criteria schema', () => {
    const descriptor = JSON.parse(readFileSync('src/adapters/subject-selectors/catalog-funnels.descriptor.json', 'utf8'));
    expect(descriptor.criteria.properties.funnel.enum).toEqual(funnels.map((f) => f.id));
  });
});

describe('the journey-paths selector', () => {
  const paths = [
    ...Array(60).fill(['home', 'collection', 'product', 'cart']),
    ...Array(30).fill(['product', 'cart']),
    ...Array(5).fill(['search', 'product']),
    ...Array(40).fill(['home']),
  ];

  it('clusters the multi-step paths at the template depth and keeps the clusters over both floors', () => {
    const chosen = chooseJourneys(paths, { depth: 3, minSessions: 20, minClusterShare: 0.1 });
    expect(chosen.map((c) => [c.steps.join('>'), c.sessions, c.share])).toEqual([
      ['home>collection>product', 60, 0.6316],
      ['product>cart', 30, 0.3158],
    ]);
  });

  it('chooses a named template with the sessions that open with it', () => {
    const chosen = chooseJourneys(paths, { path: 'product>cart' });
    expect(chosen.map((c) => [c.steps, c.sessions])).toEqual([[['product', 'cart'], 30]]);
  });
});

/** Step rows from counts per week, where counts[i] sessions reached i steps and the completers bought. */
function rowsFor(steps, perWeek) {
  const sessions = [];
  for (const [week, reachedCounts] of Object.entries(perWeek)) {
    reachedCounts.forEach((count, reached) => {
      for (let i = 0; i < count; i += 1) sessions.push({ week, tier: null, orders: reached === steps.length ? 1 : 0, revenue: 0, reached });
    });
  }
  return stepRows(reachCells(sessions, steps.length, (s) => ({ reached: s.reached })), steps);
}

describe('the FN cards', () => {
  const ctx = (rows) => ({ datasets: new Map([['funnel-steps', { rows }]]) });

  it('cards the bottleneck and the weekly drop from the step rows', async () => {
    // Index i holds the sessions that reached i steps. Over both weeks 400
    // reach the product, 80 the cart (0.2), 60 checkout, 40 the order; the
    // latest week completes 10 of 200 against 30 of 200 the week before.
    const rows = rowsFor(PURCHASE, { '2026-09-28': [0, 150, 10, 10, 30], '2026-10-05': [0, 170, 10, 10, 10] });
    const { rows: cards } = await cardsFn.collect({}, ctx(rows));
    const byId = Object.fromEntries(cards.map((c) => [c.dims.strategy_id, c.metrics]));
    expect(byId['FN:A1']).toMatchObject({ verdict: 'include', trigger_state: 'triggered', value: 0.2, detail: 'step 1 add_to_cart' });
    expect(byId['FN:A2']).toMatchObject({ verdict: 'conditional', trigger_evaluated: 0 });
    expect(byId['FN:A3']).toMatchObject({ verdict: 'include', trigger_state: 'triggered', value: 0.6667, detail: 'week 2026-10-05' });
  });

  it('misses H12 on every card without readout rows', async () => {
    const { rows: cards } = await cardsFn.collect({}, ctx([]));
    expect(cards.every((c) => c.metrics.verdict === 'conditional' && c.metrics.missing_requirements[0] === 'H12')).toBe(true);
  });
});

describe('the JR cards', () => {
  it('cards the path leak and the path conversion against the site', async () => {
    const steps = ['home', 'collection', 'product'];
    const pathRows = rowsFor(steps, { '2026-10-05': [0, 80, 15, 5] });
    const site = { dims: { week: 'all', bot_filter: 'exclude_confirmed', step_index: -1, step: 'site' }, metrics: { reached_sessions: 1000, cvr: 0.5 } };
    const ctx = { datasets: new Map([['journey-path', { rows: [...pathRows, site] }]]) };
    const { rows: cards } = await cardsJr.collect({}, ctx);
    const byId = Object.fromEntries(cards.map((c) => [c.dims.strategy_id, c.metrics]));
    expect(byId['JR:A1']).toMatchObject({ trigger_state: 'triggered', value: 0.2, detail: 'step 1 collection' });
    expect(byId['JR:A2']).toMatchObject({ trigger_state: 'silent', value: 2 });
    expect(byId['JR:A3']).toMatchObject({ trigger_state: '', trigger_evaluated: 0 });
  });
});
