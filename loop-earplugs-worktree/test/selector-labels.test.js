import { describe, expect, it } from 'vitest';
import { AM_ELEMENTS_SQL } from '../src/adapters/datasets/selector-weekly.js';
import { createLocalWarehouse } from './support/local-warehouse.js';

/**
 * A selector with several element rows in the window gets one label and
 * role on every read: the smallest non-empty one, else empty.
 */
describe('selector labels', () => {
  it('takes the smallest non-empty label and role, whatever order the rows are in', async () => {
    const row = (selector, label, role) => ({ idsite: 1, server_date: '2026-09-10', selector, label, role });
    const rows = [row('a', '', 'media'), row('a', 'Rosa', ''), row('a', 'Bella', 'media'), row('b', '', ''), row('c', 'Only', 'link')];
    const read = async (ordered) => {
      const warehouse = createLocalWarehouse({ udp_am_elements: ordered });
      const out = await warehouse.query(AM_ELEMENTS_SQL, { idsite: 1, w0: '2026-09-01', w1: '2026-09-30' }, 'selector-weekly:am-elements');
      return Object.fromEntries(out.map((r) => [r.selector, [r.label, r.role]]).sort());
    };
    const forward = await read(rows);
    expect(forward).toEqual({ a: ['Bella', 'media'], b: ['', ''], c: ['Only', 'link'] });
    expect(await read([...rows].reverse())).toEqual(forward);
  }, 60_000);
});
