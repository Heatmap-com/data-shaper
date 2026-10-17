import { describe, expect, it } from 'vitest';
import { adapter, resolveConstants } from '../src/adapters/traffic-exclusion/viewport-dead.js';

const siteSessions = 709761;

function pattern(overrides) {
  return {
    resolution: '1366x1366',
    device: 1,
    width: 1366,
    height: 1366,
    sessions: 348698,
    orders: 0,
    clicks: 0,
    revenue: 0,
    ...overrides,
  };
}

function build(patterns, dead = { sessions: 400000, orders: 0, clicks: 0, revenue: 0 }, constants, retained = { sessions: 0, orders: 0, clicks: 0, revenue: 0 }) {
  return adapter.build({
    siteSessions,
    dead,
    retained,
    patterns,
    constants: constants ?? resolveConstants(null).constants,
  });
}

describe('viewport-dead traffic exclusion', () => {
  it('excludes one-page, zero-click, zero-scroll sessions with no transaction', () => {
    const { rules } = build([], { sessions: 400000, orders: 0, clicks: 0, revenue: 0 }, undefined, {
      sessions: 159,
      orders: 159,
      clicks: 0,
      revenue: 27008,
    });
    const dead = rules.find((rule) => rule.ruleId === 'dead_session');
    expect(dead.disposition).toBe('exclude');
    expect(dead.sessions).toBe(400000);
    expect(dead.orders).toBe(0);
    expect(dead.reason).toBe('one page, zero clicks, zero scroll, no transaction');
    const kept = rules.find((rule) => rule.ruleId === 'consent_purchase');
    expect(kept.disposition).toBe('retain');
    expect(kept.sessions).toBe(159);
    expect(kept.orders).toBe(159);
    expect(kept.revenue).toBe(27008);
  });

  it('excludes a very large square viewport with zero orders and zero clicks', () => {
    const { rules } = build([pattern()]);
    const row = rules.find((rule) => rule.patternKey === '1366x1366|d1');
    expect(row.disposition).toBe('exclude');
    expect(row.detail.square).toBe(true);
    expect(row.detail.magnitude).toBe('very_large');
  });

  it('excludes a very large phone viewport that is wider than the phone maximum', () => {
    const { rules } = build([
      pattern({ resolution: '1050x1893', width: 1050, height: 1893, sessions: 45400 }),
    ]);
    const row = rules.find((rule) => rule.patternKey === '1050x1893|d1');
    expect(row.disposition).toBe('exclude');
    expect(row.detail.mismatch).toBe(true);
    expect(row.detail.square).toBe(false);
  });

  it('watches a large pattern that is under the very-large bar', () => {
    const { rules } = build([
      pattern({ resolution: '1800x1125', width: 1800, height: 1125, sessions: 8000 }),
    ]);
    const row = rules.find((rule) => rule.patternKey === '1800x1125|d1');
    expect(row.disposition).toBe('watch');
    expect(row.detail.magnitude).toBe('large');
  });

  it('keeps a square viewport that has orders or clicks', () => {
    const { rules } = build([
      pattern({ orders: 2 }),
      pattern({ resolution: '1280x1280', width: 1280, height: 1280, sessions: 20000, clicks: 10 }),
    ]);
    expect(rules.map((rule) => rule.ruleId)).toEqual(['dead_session', 'consent_purchase']);
  });

  it('keeps a narrow phone viewport and a small square', () => {
    const { rules } = build([
      pattern({ resolution: '402x714', device: 3, width: 402, height: 714, sessions: 180000, orders: 2290, clicks: 50000 }),
      pattern({ resolution: '200x200', width: 200, height: 200, sessions: 40 }),
    ]);
    expect(rules.map((rule) => rule.patternKey)).toEqual([
      'scroll:0|clicks:0|pages:1|orders:0',
      'scroll:0|clicks:0|pages:1|orders>0',
    ]);
  });

  it('reads large and very large from the site descriptor', () => {
    const { constants, source } = resolveConstants({
      very_large_sessions: 100000,
      very_large_share: 0.5,
      large_sessions: 1000,
      large_share: 0.001,
    });
    expect(source).toBe('descriptor');
    expect(constants.phoneMaxWidth).toBe(500);
    const { rules } = build(
      [pattern({ resolution: '1050x1893', width: 1050, height: 1893, sessions: 45400 })],
      { sessions: 1, orders: 0, clicks: 0, revenue: 0 },
      constants,
    );
    const row = rules.find((rule) => rule.patternKey === '1050x1893|d1');
    expect(row.disposition).toBe('watch');
  });
});
