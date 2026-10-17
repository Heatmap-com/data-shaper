import { describe, expect, it } from 'vitest';
import { decodeSnapshot, encodeSnapshot, mapState } from '../../src/scan/snapshot.js';

describe('day cursor snapshots', () => {
  it('round-trip Maps, Sets, arrays, and plain objects', () => {
    const value = {
      open: new Map([['1', { hsrs: new Set(['12', '15']), orders: new Map([['o1', 30.5]]), firstPages: [['t', '9', '12']] }]]),
      recent: new Map([['2026-09-08', new Set(['2'])]]),
      stats: { rows: 3, peakOpen: 1 },
      none: null,
      text: '{"r":1}',
    };
    expect(decodeSnapshot(encodeSnapshot(value))).toEqual(value);
  });

  it('decodes an object reached twice to one object, cycles included', () => {
    const session = { idvisit: '7', events: ['add_to_cart'] };
    const value = { byDate: new Map([['d', [session]]]), byConfig: new Map([['c', [session]]]) };
    value.self = value;
    const back = decodeSnapshot(encodeSnapshot(value));
    expect(back.byDate.get('d')[0]).toBe(back.byConfig.get('c')[0]);
    expect(back.self).toBe(back);
  });

  it('drops undefined fields, as JSON does', () => {
    expect(decodeSnapshot(encodeSnapshot({ a: undefined, b: [undefined, 1] }))).toEqual({ b: [null, 1] });
  });

  it('stops at the cap before the text exists', () => {
    const big = new Map(Array.from({ length: 200_000 }, (_, i) => [String(i), { tags: 'x'.repeat(200) }]));
    const started = Date.now();
    expect(encodeSnapshot({ big }, { maxBytes: 100_000 })).toBeNull();
    expect(Date.now() - started).toBeLessThan(2000);
    const small = { a: new Set(['1']) };
    const text = encodeSnapshot(small, { maxBytes: 1_000 });
    expect(decodeSnapshot(text)).toEqual(small);
    expect(encodeSnapshot(small, { maxBytes: text.length - 1 })).toBeNull();
  });

  it('restores a one-Map folder in place', () => {
    const cells = new Map([['a', { n: 1 }]]);
    const state = mapState(cells);
    const saved = decodeSnapshot(encodeSnapshot(state.snapshot()));
    cells.set('b', { n: 2 });
    state.restore(saved);
    expect([...cells]).toEqual([['a', { n: 1 }]]);
  });
});
