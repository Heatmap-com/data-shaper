import { describe, expect, it } from 'vitest';
import { createClickTable } from '../src/adapters/_lib/click-table.js';
import { getClickRows } from '../src/adapters/_lib/clicks.js';

/**
 * The page's clicks are read one window day per query into a column table,
 * and the table gives back every click with the fields it was given.
 */

const click = (over = {}) => ({
  idvisit: '1', idloghsr: 'pv1', selector: '#a', week: '2026-09-28', date: '2026-09-28',
  serverTime: '2026-09-28 10:00:00', meta1: '', x: 10, y: 20, timeSinceLoad: 100, ...over,
});

describe('the click table', () => {
  it('gives back each click in order, positions without a value as null', () => {
    const table = createClickTable();
    const clicks = [click(), click({ idvisit: '2', x: null, y: null, timeSinceLoad: -1 }), click({ selector: '#b', meta1: 'rage' })];
    for (const c of clicks) table.push(c);
    expect(table.length).toBe(3);
    expect([...table]).toEqual(clicks);
    expect([...table]).toEqual(clicks);
  });
});

describe('getClickRows', () => {
  it('reads the page clicks one window day per query', async () => {
    const reads = [];
    const ctx = {
      windowStart: '2026-09-29',
      windowEnd: '2026-10-01',
      batchNotes: new Map(),
      gateway: {
        async query(sql, params, label) {
          reads.push({ label, day: params.day, w0: params.w0, w1: params.w1 });
          expect(sql).toContain('server_date = {day:Date}');
          return [{ idvisit: `v-${params.day}`, idloghsr: 'pv', selector: '#a', week: '2026-09-28', date: params.day, server_time: `${params.day} 09:00:00`, meta1: '', x: 1, y: 2, time_since_load: 5 }];
        },
      },
    };
    const table = await getClickRows(ctx, { idsite: 1, idsitehsr: 222 });
    expect(reads).toEqual(['2026-09-29', '2026-09-30', '2026-10-01'].map((day) => ({ label: 'clicks:page', day, w0: '2026-09-29', w1: '2026-10-01' })));
    expect([...table].map((c) => c.idvisit)).toEqual(['v-2026-09-29', 'v-2026-09-30', 'v-2026-10-01']);
  });
});
