import { describe, expect, it } from 'vitest';
import { createMemoryDayStore } from '../../src/adapters/day-store/memory.js';
import { dayEvents } from '../../src/scan/day-record.js';
import { DAY_RECORD_VERSION, createLiveDayRecords, createStoredDayRecords } from '../../src/scan/day-records.js';
import { createLocalWarehouse } from '../support/local-warehouse.js';
import { IDSITE, warehouseRows } from '../support/site-fixture.js';

/**
 * The stored days against the live queries on `clickhouse local`: a day
 * replayed from the store, narrowed or not, is the day the live query
 * returns for the same request.
 */

const DAY = '2026-09-10';

function warehouse() {
  const rows = warehouseRows();
  // A visit whose only fact on DAY is an event outside the narrow request.
  rows.journey_events_map.push({ idsite: IDSITE, idvisit: 5000, server_date: DAY, event_type: 'promo_seen', ts_ms: 9 });
  const local = createLocalWarehouse(rows);
  const calls = [];
  return {
    calls,
    async query(sql, params, label) {
      calls.push({ label, params });
      return local.query(sql, params, label);
    },
  };
}

const wide = { events: dayEvents(['promo_seen']), partnerTags: true };
const narrow = { events: dayEvents(), partnerTags: false };

function sources(gateway, store, finalThrough = '2026-09-30') {
  const live = createLiveDayRecords({ gateway, idsite: IDSITE });
  return { live, stored: createStoredDayRecords({ live, store, idsite: IDSITE, finalThrough }) };
}

describe('stored day records', () => {
  it('replays a stored day as the live query returns it', async () => {
    const gateway = warehouse();
    const store = createMemoryDayStore();
    const first = await sources(gateway, store).stored.day(DAY, wide);
    const { live, stored } = sources(gateway, store);
    const replayed = await stored.day(DAY, wide);
    expect(replayed).toEqual(first);
    expect(replayed).toEqual(await live.day(DAY, wide));
    expect(replayed.every((row) => row.day === DAY)).toBe(true);
    expect(stored.stats()).toMatchObject({ daysStored: 1, daysLive: 0, written: 0 });
  }, 60_000);

  it('narrows a wider stored day to the rows the narrow query returns', async () => {
    const gateway = warehouse();
    const store = createMemoryDayStore();
    const stored = await sources(gateway, store).stored.day(DAY, wide);
    expect(stored.some((row) => row.idvisit === '5000')).toBe(true);
    expect(stored.some((row) => row.arms.length > 0)).toBe(true);

    const { live, stored: next } = sources(gateway, store);
    const replayed = await next.day(DAY, narrow);
    expect(replayed).toEqual(await live.day(DAY, narrow));
    expect(replayed.some((row) => row.idvisit === '5000')).toBe(false);
    expect(next.stats()).toMatchObject({ daysStored: 1, daysLive: 0 });
  }, 60_000);

  it('reads a day live with both shapes when the stored one lacks a name, and keeps the union', async () => {
    const gateway = warehouse();
    const store = createMemoryDayStore();
    await sources(gateway, store).stored.day(DAY, narrow);
    const { live, stored } = sources(gateway, store);
    const asked = { events: dayEvents(['promo_seen']), partnerTags: false };
    gateway.calls.length = 0;
    expect(await stored.day(DAY, asked)).toEqual(await live.day(DAY, asked));
    expect(gateway.calls[0].params.events).toEqual(dayEvents(['promo_seen']));
    const entry = await store.read({ idsite: IDSITE, kind: 'day', key: '', day: DAY });
    expect(entry.shape).toEqual({ events: dayEvents(['promo_seen']), partnerTags: false });
    expect(stored.stats()).toMatchObject({ daysStored: 0, daysLive: 1, written: 1 });
  }, 60_000);

  it('reads a day after finalThrough live on each source, and once within a source', async () => {
    const gateway = warehouse();
    const store = createMemoryDayStore();
    const first = sources(gateway, store, '2026-09-09').stored;
    await first.day(DAY, narrow);
    await first.day(DAY, narrow);
    expect(first.stats()).toMatchObject({ daysLive: 1, daysStored: 1 });
    expect((await store.read({ idsite: IDSITE, kind: 'day', key: '', day: DAY })).final).toBe(false);

    const second = sources(gateway, store, '2026-09-09').stored;
    await second.day(DAY, narrow);
    expect(second.stats()).toMatchObject({ daysLive: 1, daysStored: 0 });

    const later = sources(gateway, store, '2026-09-10').stored;
    await later.day(DAY, narrow);
    expect(later.stats()).toMatchObject({ daysLive: 1, daysStored: 0 });
    expect((await store.read({ idsite: IDSITE, kind: 'day', key: '', day: DAY })).final).toBe(true);
    const settled = sources(gateway, store, '2026-09-10').stored;
    await settled.day(DAY, narrow);
    expect(settled.stats()).toMatchObject({ daysLive: 0, daysStored: 1 });
  }, 60_000);

  it('reads a day stored in another format version live', async () => {
    const gateway = warehouse();
    const store = createMemoryDayStore();
    await store.write({ idsite: IDSITE, kind: 'day', key: '', day: DAY, version: DAY_RECORD_VERSION + 1, final: true, shape: wide, rows: [] });
    const { live, stored } = sources(gateway, store);
    expect(await stored.day(DAY, narrow)).toEqual(await live.day(DAY, narrow));
    expect(stored.stats()).toMatchObject({ daysLive: 1 });
    expect((await store.read({ idsite: IDSITE, kind: 'day', key: '', day: DAY })).version).toBe(DAY_RECORD_VERSION);
  }, 60_000);

  it('keeps page facts per page and reads only the pages the store lacks', async () => {
    const gateway = warehouse();
    const store = createMemoryDayStore();
    await sources(gateway, store).stored.pageFacts(DAY, [12, 15]);
    const { live, stored } = sources(gateway, store);
    gateway.calls.length = 0;
    const facts = await stored.pageFacts(DAY, [12, 13]);
    expect(gateway.calls.map(({ label, params }) => [label, params.pages])).toEqual([['scan:page-facts', [13]]]);
    expect(facts).toEqual(await live.pageFacts(DAY, [12, 13]));
    expect(facts.length).toBeGreaterThan(0);
    expect(stored.stats()).toMatchObject({ pageDaysStored: 1, pageDaysLive: 1, written: 1 });
  }, 60_000);
});
