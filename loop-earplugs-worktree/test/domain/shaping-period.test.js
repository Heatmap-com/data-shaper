import { describe, expect, it } from 'vitest';
import { eachDay } from '../../src/domain/shaping/dates.js';
import { checkPeriod, periodOf, periodParams, periodSql, periodsIn, previousStart, queryWindow } from '../../src/domain/shaping/period.js';
import { hasClickHouseLocal, runLocal } from './clickhouse-local.js';

const spec = (doc) => {
  const checked = checkPeriod(doc);
  if (!checked.spec) throw new Error(checked.problems.join('; '));
  return checked.spec;
};

describe('checkPeriod', () => {
  it('defaults to Monday weeks, flagging cut periods', () => {
    expect(checkPeriod(undefined)).toEqual({ spec: { grain: 'week', weekStart: 'monday', partial: 'flag', rolling: null, compare: null }, problems: [], unknownGrain: null });
    expect(spec({ grain: 'day', rolling: 7 })).toMatchObject({ grain: 'day', rolling: 7 });
  });

  it('reports an unknown grain apart from problems', () => {
    expect(checkPeriod({ grain: 'cohort' })).toEqual({ spec: null, problems: [], unknownGrain: 'cohort' });
  });

  it('refuses combinations the build cannot honor', () => {
    const problems = (doc) => checkPeriod(doc).problems;
    expect(problems({ grain: 'week', rolling: 7 })).toEqual(['period.rolling needs the day grain']);
    expect(problems({ grain: 'day', rolling: 1 })).toEqual([expect.stringMatching(/from 2 to 90/)]);
    expect(problems({ grain: 'day', rolling: 7, compare: 'previous' })).toEqual([expect.stringMatching(/do not combine/)]);
    expect(problems({ grain: 'month', weekStart: 'sunday' })).toEqual(['period.weekStart applies to the week grain only']);
    expect(problems({ grain: 'week', partial: 'keep', step: 2 })).toEqual([expect.stringMatching(/unknown key "step"/), 'period.partial is flag or drop']);
  });
});

describe('periods', () => {
  const window = { start: '2026-09-10', end: '2026-10-20' };

  it('starts each grain where the calendar does', () => {
    expect(periodOf('2026-09-10', spec({ grain: 'week' }), window)).toBe('2026-09-07');
    expect(periodOf('2026-09-10', spec({ grain: 'week', weekStart: 'sunday' }), window)).toBe('2026-09-06');
    expect(periodOf('2026-09-06', spec({ grain: 'week', weekStart: 'sunday' }), window)).toBe('2026-09-06');
    expect(periodOf('2026-09-10', spec({ grain: 'month' }), window)).toBe('2026-09-01');
    expect(periodOf('2026-11-30', spec({ grain: 'quarter' }), window)).toBe('2026-10-01');
    expect(periodOf('2026-10-01', spec({ grain: 'window', compare: 'previous' }), window)).toBe('2026-09-10');
    expect(periodOf('2026-09-09', spec({ grain: 'window', compare: 'previous' }), window)).toBe('2026-07-31');
  });

  it('lists the periods a window reports, flagging or dropping cut ones', () => {
    expect(periodsIn(spec({ grain: 'month' }), window)).toEqual([
      { start: '2026-09-01', end: '2026-09-30', complete: false },
      { start: '2026-10-01', end: '2026-10-31', complete: false },
    ]);
    expect(periodsIn(spec({ grain: 'month', partial: 'drop' }), window)).toEqual([]);
    expect(periodsIn(spec({ grain: 'week', partial: 'drop' }), window).map((p) => p.start)).toEqual(['2026-09-14', '2026-09-21', '2026-09-28', '2026-10-05', '2026-10-12']);
    expect(periodsIn(spec({ grain: 'window' }), window)).toEqual([{ start: '2026-09-10', end: '2026-10-20', complete: true }]);
    expect(periodsIn(spec({ grain: 'day' }), { start: '2026-09-29', end: '2026-10-01' }).map((p) => p.start)).toEqual(['2026-09-29', '2026-09-30', '2026-10-01']);
  });

  it('reads the lead-in a rolling sum or a comparison needs', () => {
    expect(queryWindow(spec({ grain: 'day', rolling: 7 }), window)).toEqual({ start: '2026-09-04', end: '2026-10-20' });
    expect(queryWindow(spec({ grain: 'month', compare: 'previous' }), { start: '2026-09-01', end: '2026-10-31' })).toEqual({ start: '2026-08-01', end: '2026-10-31' });
    expect(queryWindow(spec({ grain: 'window', compare: 'previous' }), window)).toEqual({ start: '2026-07-31', end: '2026-10-20' });
    expect(queryWindow(spec({ grain: 'week' }), window)).toEqual(window);
    expect(previousStart(spec({ grain: 'quarter' }), window, '2026-01-01')).toBe('2025-10-01');
  });

  it('binds the window parameters only on the window grain', () => {
    expect(periodParams(spec({ grain: 'week' }), window)).toEqual({});
    expect(periodParams(spec({ grain: 'window' }), window)).toEqual({ s0: '2026-09-10' });
    expect(periodParams(spec({ grain: 'window', compare: 'previous' }), window)).toEqual({ s0: '2026-09-10', ps0: '2026-07-31' });
  });
});

describe.skipIf(!hasClickHouseLocal())('periodSql agrees with periodOf', () => {
  const window = { start: '2026-09-10', end: '2026-10-20' };
  const days = eachDay('2025-12-20', '2027-01-10');
  const specs = [
    { grain: 'day' },
    { grain: 'week' },
    { grain: 'week', weekStart: 'sunday' },
    { grain: 'month' },
    { grain: 'quarter' },
    { grain: 'window' },
    { grain: 'window', compare: 'previous' },
  ];

  it.each(specs)('%o', (doc) => {
    const p = spec(doc);
    const inWindow = p.grain === 'window' ? days.filter((day) => day >= (doc.compare ? '2026-07-31' : window.start) && day <= window.end) : days;
    const rows = runLocal('d Date', inWindow.map((d) => ({ d })), `SELECT toString(${periodSql('d', p)}) AS p FROM table ORDER BY d`, periodParams(p, window));
    expect(rows.map((row) => row.p)).toEqual(inWindow.map((day) => periodOf(day, p, window)));
  });
});
