import { describe, expect, it } from 'vitest';
import { collectTriggerWindow } from '../../src/triggers/batch.js';
import { resolveDefinitions } from '../../src/triggers/definitions.js';
import { createTriggerFolder } from '../../src/triggers/fold.js';
import { factWindow, scanWindow } from '../../src/triggers/load.js';
import { decodeSnapshot, encodeSnapshot } from '../../src/scan/snapshot.js';
import { addDays, eachDate } from '../../src/triggers/time.js';

/**
 * The trigger folder against collectTriggerWindow on the sessions each path
 * reads: the window query's fact window plus its prior purchases, and the
 * day scan's lane plus its prior purchases. Prior purchase sessions carry
 * no page counts, as loadPriorPurchases reads them.
 */

const definitions = resolveDefinitions();

/** A small deterministic generator. */
function random(seed) {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

/**
 * Visitors over 2026-07-01..windowEnd. Some return within a chain, some buy
 * on the hit day, some bought before their first interest, some have no
 * config id.
 */
function sessionsUntil(windowEnd, seed) {
  const next = random(seed);
  const days = eachDate('2026-07-01', windowEnd);
  const sessions = [];
  let id = 1;
  for (let visitor = 0; visitor < 70; visitor += 1) {
    const configId = visitor % 9 === 0 ? '' : `cfg${visitor}`;
    const visits = 1 + Math.floor(next() * 9);
    for (let n = 0; n < visits; n += 1) {
      const day = days[Math.floor(next() * days.length)];
      const events = [];
      if (next() < 0.35) events.push('add_to_cart');
      if (next() < 0.2) events.push('checkout_started');
      const bought = next() < 0.18;
      if (bought) events.push('checkout_completed');
      const hour = Math.floor(next() * 24);
      sessions.push({
        idvisit: String(id),
        configId,
        serverDate: day,
        startedAt: Date.parse(`${day}T${String(hour).padStart(2, '0')}:00:00Z`) + id,
        device: 'desktop',
        channel: 'search',
        source: '',
        medium: '',
        returning: 'new',
        country: 'us',
        landingPage: '',
        entryTemplate: '',
        events,
        orders: bought && next() < 0.7 ? 1 : 0,
        revenue: bought ? 20 + Math.floor(next() * 80) : 0,
        pageviews: Math.floor(next() * 6),
        clicks: Math.floor(next() * 6),
        scrollPct: Math.floor(next() * 100),
        durationSec: Math.floor(next() * 200),
        productPages: next() < 0.3 ? ['p1', 'p2', 'p3'].slice(0, 1 + Math.floor(next() * 3)) : [],
      });
      id += 1;
    }
  }
  return sessions;
}

const purchased = (s) => s.events.includes('checkout_completed') || s.orders > 0;
const stripped = (s) => ({ ...s, pageviews: 0, clicks: 0, scrollPct: 0, durationSec: 0, productPages: [], medium: '' });

/** The window path's inputs, as loadTriggerFacts + assembleLoaded build them. */
function windowSessions(all, windowStart, windowEnd) {
  const bounds = factWindow(windowStart, windowEnd, definitions);
  const facts = all.filter((s) => s.serverDate >= bounds.factStart && s.serverDate <= windowEnd);
  const prior = all.filter((s) => s.serverDate >= bounds.purchaseStart && s.serverDate <= bounds.purchaseEnd && purchased(s)).map(stripped);
  return [...facts, ...prior];
}

/**
 * The folder fed as the scan feeds it: each lane day's sessions close after
 * a quiet day, some later, and the folder advances while no earlier visit is
 * open. With `restartAfter`, a new folder restores the encoded state after
 * that day, as a resumed scan does.
 */
function folded(all, windowStart, windowEnd, seed, restartAfter = null) {
  const bounds = scanWindow(windowStart, windowEnd, definitions);
  const prior = all.filter((s) => s.serverDate >= bounds.purchaseStart && s.serverDate <= bounds.purchaseEnd && purchased(s)).map(stripped);
  const args = { windowStart, windowEnd, idsite: 1, bounds, prior };
  let folder = createTriggerFolder(args);
  const next = random(seed);
  const lane = all.filter((s) => s.serverDate >= bounds.laneStart && s.serverDate <= windowEnd);
  /** @type {Map<string, object[]>} close day -> sessions */
  const closing = new Map();
  for (const session of lane) {
    const close = [addDays(session.serverDate, 1 + (next() < 0.2 ? 1 : 0)), windowEnd].sort()[0];
    const list = closing.get(close) ?? [];
    list.push(session);
    closing.set(close, list);
  }
  const seen = new Set();
  for (const day of eachDate(bounds.laneStart, windowEnd)) {
    const closed = closing.get(day) ?? [];
    folder.add([...closed].reverse());
    for (const session of closed) seen.add(session);
    const earliestOpen = lane.filter((s) => s.serverDate <= day && !seen.has(s)).map((s) => s.serverDate).sort()[0] ?? null;
    folder.advance(day, earliestOpen);
    if (day === restartAfter) {
      const saved = encodeSnapshot(folder.snapshot());
      folder = createTriggerFolder(args);
      folder.restore(decodeSnapshot(saved));
    }
  }
  return folder.finish();
}

const key = (row) => [row.triggerKey, row.serverDate, row.idvisit, row.configId].join('|');
const byKey = (a, b) => key(a).localeCompare(key(b));

describe('trigger folder', () => {
  it.each([
    ['a 20-day window', '2026-09-11', '2026-09-30', 7],
    ['a 7-day window, whose open chains begin before it', '2026-09-24', '2026-09-30', 11],
    ['a 30-day window', '2026-09-01', '2026-09-30', 23],
  ])('gives collectTriggerWindow\'s hits and chains on %s', (_label, windowStart, windowEnd, seed) => {
    const all = sessionsUntil(windowEnd, seed);
    const expected = collectTriggerWindow({ windowStart, windowEnd, idsite: 1, sessions: windowSessions(all, windowStart, windowEnd) });
    const actual = folded(all, windowStart, windowEnd, seed);
    expect(expected.hits.length).toBeGreaterThan(20);
    expect(expected.chains.some((c) => c.purchased)).toBe(true);
    expect(expected.chains.some((c) => !c.final)).toBe(true);
    expect(expected.hits.some((h) => h.triggerKey === 'super_shopper')).toBe(true);
    expect([...actual.hits].sort(byKey)).toEqual([...expected.hits].sort(byKey));
    expect([...actual.chains].sort(byKey)).toEqual([...expected.chains].sort(byKey));
    expect(actual.definitions).toEqual(expected.definitions);
  });

  it('gives the same hits and chains when restored from a saved state', () => {
    const all = sessionsUntil('2026-09-30', 23);
    const whole = folded(all, '2026-09-01', '2026-09-30', 23);
    for (const day of ['2026-08-20', '2026-09-10', '2026-09-30']) {
      expect(folded(all, '2026-09-01', '2026-09-30', 23, day)).toEqual(whole);
    }
  });

  it('keeps a prior purchase one session across its maps after a restore', () => {
    const bounds = scanWindow('2026-09-11', '2026-10-10', definitions);
    const prior = [{ ...stripped(sessionsUntil('2026-07-02', 3)[0]), idvisit: '77', configId: 'cfg', serverDate: bounds.purchaseEnd, events: ['checkout_completed'] }];
    const args = { windowStart: '2026-09-11', windowEnd: '2026-10-10', idsite: 1, bounds, prior };
    const folder = createTriggerFolder(args);
    folder.restore(decodeSnapshot(encodeSnapshot(createTriggerFolder(args).snapshot())));
    const state = folder.snapshot();
    expect(state.byConfig.get('cfg')[0]).toBe(state.priorById.get('77'));
    folder.add([{ ...prior[0], serverDate: bounds.laneStart, events: ['add_to_cart'], orders: 0, revenue: 0 }]);
    expect(folder.snapshot().byConfig.get('cfg')).toHaveLength(1);
    expect(folder.snapshot().byConfig.get('cfg')[0].events.sort()).toEqual(['add_to_cart', 'checkout_completed']);
  });

  it('reads the visitor window before the first hit day, plus one day', () => {
    expect(scanWindow('2026-09-11', '2026-10-10', definitions)).toMatchObject({
      firstHitDay: '2026-09-11', laneStart: '2026-08-27', purchaseEnd: '2026-08-26', retainDays: 14,
    });
    expect(scanWindow('2026-10-04', '2026-10-10', definitions)).toMatchObject({ firstHitDay: '2026-09-26', laneStart: '2026-09-11' });
  });
});
