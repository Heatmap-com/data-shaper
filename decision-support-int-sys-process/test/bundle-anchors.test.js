import { describe, expect, it } from 'vitest';
import { evaluateAnchors } from '../src/orchestrator/domain/bundle-anchors.js';

const window = { start: '2026-09-17', end: '2026-10-16' };

function profile(anchors, reportWindow = window) {
  return { report_window: reportWindow, anchors };
}

function anchor(label, where, agg, expectValue, extra = {}) {
  return { label, where, agg, expect: expectValue, ...extra };
}

const where = "d >= '2026-09-17' and d <= '2026-10-16'";
const hvWhere = `${where} and order_revenue >= 90`;

describe('bundle anchors', () => {
  const csv = [
    'oid,d,t_utc,order_revenue,item_title',
    '1,2026-09-16,2026-09-16T12:00:00,100,"Quiet, pair"',
    '2,2026-09-17,2026-09-17T12:00:00,10,Switch',
    '3,2026-10-01,2026-10-01T12:00:00,20,Dream',
    '4,2026-10-16,2026-10-16T12:00:00,90,Engage',
    '',
  ].join('\n');

  const full = profile([
    anchor('orders in report window', where, 'count', 3),
    anchor('revenue in report window', where, 'sum', 120, { column: 'order_revenue', tolerance: 1 }),
    anchor('median order revenue in report window', where, 'median', 20, { column: 'order_revenue', tolerance: 0.01 }),
    anchor('high-value orders in report window', hvWhere, 'count', 1),
    anchor('high-value revenue in report window', hvWhere, 'sum', 90, { column: 'order_revenue', tolerance: 1 }),
  ]);

  it('counts the in-window orders and leaves the day before out', () => {
    const result = evaluateAnchors(full, csv, window);
    expect(result.ok).toBe(true);
    expect(result.summary).toBe('5 anchor(s) hold');
  });

  it('allows revenue to differ by 1 and fails at 1.01', () => {
    const pass = profile([anchor('revenue in report window', where, 'sum', 121, { column: 'order_revenue', tolerance: 1 })]);
    expect(evaluateAnchors(pass, csv, window).ok).toBe(true);
    const fail = profile([anchor('revenue in report window', where, 'sum', 121.01, { column: 'order_revenue', tolerance: 1 })]);
    const result = evaluateAnchors(fail, csv, window);
    expect(result.ok).toBe(false);
    expect(result.summary.startsWith('anchor mismatch')).toBe(true);
  });

  it('averages the two central revenues on an even count', () => {
    const even = [
      'oid,d,t_utc,order_revenue',
      '1,2026-09-17,2026-09-17T12:00:00,10',
      '2,2026-10-01,2026-10-01T12:00:00,20',
    ].join('\n');
    const pass = profile([anchor('median order revenue in report window', where, 'median', 15, { column: 'order_revenue', tolerance: 0.01 })]);
    expect(evaluateAnchors(pass, even, window).ok).toBe(true);
    const fail = profile([anchor('median order revenue in report window', where, 'median', 15.02, { column: 'order_revenue', tolerance: 0.01 })]);
    expect(evaluateAnchors(fail, even, window).ok).toBe(false);
  });

  it('passes a null median only when the window has no orders', () => {
    const empty = profile([anchor('median order revenue in report window', where, 'median', null, { column: 'order_revenue', tolerance: 0.01 })]);
    const none = 'oid,d,t_utc,order_revenue\n1,2026-09-16,2026-09-16T12:00:00,10\n';
    expect(evaluateAnchors(empty, none, window).ok).toBe(true);
    const one = 'oid,d,t_utc,order_revenue\n1,2026-09-17,2026-09-17T12:00:00,10\n';
    expect(evaluateAnchors(empty, one, window).ok).toBe(false);
  });

  it('reads the day from t_utc when the d column was dropped', () => {
    const trimmed = 'oid,t_utc,order_revenue\n1,2026-10-01T15:00:00,40\n';
    const day = "d >= '2026-10-01' and d <= '2026-10-01'";
    const result = evaluateAnchors(
      profile([anchor('orders in report window', day, 'count', 1)], { start: '2026-10-01', end: '2026-10-01' }),
      trimmed,
      { start: '2026-10-01', end: '2026-10-01' },
    );
    expect(result.ok).toBe(true);
  });

  it('sums rolled orders only where high_value is 1', () => {
    const rolled = [
      'd,orders,order_revenue,high_value',
      '2026-10-01,2,40,1',
      '2026-10-01,5,10,0',
    ].join('\n');
    const hv = `${where} and high_value == 1`;
    const result = evaluateAnchors(
      profile([anchor('high-value orders in report window', hv, 'sum', 2, { column: 'orders' })]),
      rolled,
      window,
    );
    expect(result.ok).toBe(true);
  });

  it('fails a different report window before judging anchors', () => {
    const result = evaluateAnchors(profile([anchor('orders in report window', where, 'count', 3)], { start: '2026-09-17', end: '2026-10-15' }), csv, window);
    expect(result.ok).toBe(false);
    expect(result.summary).toBe('anchor mismatch: report window');
    expect(result.details.map((row) => row.name)).toEqual(['report_window']);
  });

  it('rejects a where clause the check does not evaluate', () => {
    const result = evaluateAnchors(profile([anchor('orders in report window', "status == 'paid'", 'count', 1)]), csv, window);
    expect(result.ok).toBe(false);
    expect(result.details[1].message).toBe("anchor where is not one the check evaluates: status == 'paid'");
  });
});
