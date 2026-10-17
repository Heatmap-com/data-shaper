import { describe, expect, it } from 'vitest';
import { resolveDefinitions } from '../../src/triggers/definitions.js';
import { eventNames, loadPriorPurchases, purchaseRule } from '../../src/triggers/load.js';
import { createLocalWarehouse } from '../support/local-warehouse.js';

/**
 * The prior-purchase read on `clickhouse local`: the visits, events, and
 * orders of the visits that purchased in the lookback, for a rule that
 * counts orders and for one that counts purchase events only. The span
 * holds purchase-event visits, order-only visits, intent-only visits, and
 * visits with no event, some outside the span.
 */

const IDSITE = 7;
const bounds = { purchaseStart: '2026-06-01', purchaseEnd: '2026-06-20' };

function priorRows(names, purchase) {
  const intent = names.filter((name) => !purchase.has(name));
  const bought = [...purchase][0];
  const visits = [];
  const events = [];
  const orders = [];
  for (let i = 0; i < 40; i += 1) {
    const idvisit = 5000 + i;
    const day = i % 25 === 0 ? '2026-05-30' : `2026-06-${String(1 + (i % 22)).padStart(2, '0')}`;
    visits.push({
      idsite: IDSITE, idvisit, server_date: day, visit_first_action_time: `${day} 10:${String(i).padStart(2, '0')}:00`,
      config_id: `c${i % 7}`, config_device_type: 1 + (i % 3), referer_type: 1 + (i % 4),
      visitor_returning: i % 3 === 0, location_country: 'us', visit_entry_idaction_url: String(100 + (i % 5)),
    });
    const kind = i % 5;
    if (kind === 0 || kind === 1) events.push({ idsite: IDSITE, idvisit, server_date: day, event_type: bought, ts_ms: 1 });
    if (kind === 1 || kind === 2 || kind === 3) events.push({ idsite: IDSITE, idvisit, server_date: day, event_type: intent[i % intent.length], ts_ms: 2 });
    if (kind === 1 || kind === 3) orders.push({ idsite: IDSITE, idvisit, server_date: day, idorder: `o${i}`, revenue: 10 + i });
  }
  return { udp_hsrce_visits: visits, journey_events_map: events, udp_conversions: orders };
}

const sorted = (rows) => [...rows].map((row) => JSON.stringify(row)).sort();

describe('the prior-purchase read', () => {
  const definitions = resolveDefinitions({}, []);
  const names = eventNames(definitions);
  const rule = purchaseRule(definitions);
  const warehouse = createLocalWarehouse(priorRows(names, rule.events));

  it.each([
    ['orders count', rule],
    ['events only', { events: rule.events, ordersCount: false }],
  ])('reads the purchase visits only (%s)', async (_name, which) => {
    const ctx = { gateway: warehouse };
    const prior = await loadPriorPurchases(ctx, IDSITE, bounds, names, which);
    const ids = new Set(prior.visits.map((row) => row.idvisit));
    expect(ids.size).toBeGreaterThan(0);
    for (const row of [...prior.events, ...prior.orders]) expect(ids.has(row.idvisit)).toBe(true);
    expect({ visits: sorted(prior.visits), events: sorted(prior.events), orders: sorted(prior.orders) }).toMatchSnapshot();
  }, 60_000);
});
