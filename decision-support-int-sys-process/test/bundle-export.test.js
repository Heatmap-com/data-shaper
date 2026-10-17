import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exportRequest, exportSpec, pagePeriodSql, periodSql, periodsOf, sitePeriods, visitSql } from '../py/bundle-export.mjs';

const site = {
  slug: 'acme',
  name: 'Acme',
  domain: 'acme.example',
  idsite: 9001,
  platform: 'shopify',
  currency: 'EUR',
  focus: { path: '/products/widget', label: 'Widget', idsitehsr: 77 },
};
const window = { start: '2026-09-10', end: '2026-10-12' };

describe('exportSpec', () => {
  it('takes identity and the analysed page from the site spec and the window from the job', () => {
    expect(exportSpec(site, window)).toEqual({
      slug: 'acme',
      name: 'Acme',
      domain: 'acme.example',
      idsite: 9001,
      currency: 'EUR',
      platform: 'Shopify',
      window0: '2026-09-10',
      window1: '2026-10-12',
      focusPath: '/products/widget',
      focusLabel: 'Widget',
      idsitehsr: 77,
    });
  });

  it('carries reading notes and resolves a site calendar', () => {
    const spec = exportSpec(
      { ...site, readingNotes: { profile: ['Amounts include tax.'] }, periods: [{ name: 'pre', end: '2026-09-09' }, { name: 'sale' }] },
      window,
    );
    expect(spec.readingNotes).toEqual({ profile: ['Amounts include tax.'] });
    expect(spec.periods).toEqual([
      { name: 'pre', start: '2026-08-27', end: '2026-09-09' },
      { name: 'sale', start: '2026-09-10', end: '2026-10-12', baseline: true },
    ]);
  });

  it('refuses a site with no idsite, no analysed page, or a bad window', () => {
    expect(() => exportSpec({ ...site, idsite: undefined }, window)).toThrow(/no idsite/);
    expect(() => exportSpec({ ...site, focus: undefined }, window)).toThrow(/no focus/);
    expect(() => exportSpec(site, { start: '2026-10-12', end: '2026-09-10' })).toThrow(/start first/);
  });
});

describe('periods', () => {
  it('defaults to pre and the two calendar halves, with the first half as baseline', () => {
    expect(periodsOf(exportSpec(site, window))).toEqual([
      { name: 'pre', start: '2026-08-27', end: '2026-09-09' },
      { name: 'first', start: '2026-09-10', end: '2026-09-24', baseline: true },
      { name: 'second', start: '2026-09-25', end: '2026-10-12' },
    ]);
  });

  it('keeps the flagged baseline and each period about text', () => {
    const periods = sitePeriods(
      [
        { name: 'pre', end: '2026-09-09' },
        { name: 'full', end: '2026-09-23', baseline: true, about: 'Full price.' },
        { name: 'promo', end: '2026-10-04' },
        { name: 'post' },
      ],
      exportSpec(site, window),
    );
    expect(periods.map((p) => [p.name, p.start, p.end, Boolean(p.baseline)])).toEqual([
      ['pre', '2026-08-27', '2026-09-09', false],
      ['full', '2026-09-10', '2026-09-23', true],
      ['promo', '2026-09-24', '2026-10-04', false],
      ['post', '2026-10-05', '2026-10-12', false],
    ]);
    expect(periods[1].about).toBe('Full price.');
  });

  it('refuses ends out of order, past the window, or periods with no name', () => {
    const spec = exportSpec(site, window);
    expect(() => sitePeriods([{ name: 'a', end: '2026-09-20' }, { name: 'b', end: '2026-09-15' }, { name: 'c' }], spec)).toThrow(/period b/);
    expect(() => sitePeriods([{ name: 'a', end: '2026-11-01' }, { name: 'b' }], spec)).toThrow(/period a/);
    expect(() => sitePeriods([{ end: '2026-09-20' }, { name: 'b' }], spec)).toThrow(/lower-case name/);
    expect(() => sitePeriods([{ name: 'only' }], spec)).toThrow(/at least two/);
  });

  it('labels a date column: before the second period, then up to each end, else the last', () => {
    const spec = exportSpec(site, window);
    expect(periodSql(periodsOf(spec), 'v.d')).toBe("multiIf(v.d < '2026-09-10', 'pre', v.d <= '2026-09-24', 'first', 'second')");
    const two = sitePeriods([{ name: 'pre', end: '2026-09-09' }, { name: 'sale' }], spec);
    expect(periodSql(two, 'd')).toBe("multiIf(d < '2026-09-10', 'pre', 'sale')");
  });

  it('page_period uses the site calendar', () => {
    const spec = exportSpec({ ...site, periods: [{ name: 'pre', end: '2026-09-09' }, { name: 'full', end: '2026-09-23' }, { name: 'post' }] }, window);
    expect(pagePeriodSql(spec)).toContain("multiIf(v.d < '2026-09-10', 'pre', v.d <= '2026-09-23', 'full', 'post') AS period");
  });
});

describe('exportRequest', () => {
  it('reads the site spec file, the window, and the output directory', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-export-'));
    const file = path.join(dir, 'site.json');
    fs.writeFileSync(file, JSON.stringify(site));
    const request = exportRequest(['--site', file, '--window-start', '2026-09-10', '--window-end', '2026-10-12', '--out', path.join(dir, 'x')]);
    expect(request.out).toBe(path.join(dir, 'x'));
    expect(request.spec.idsite).toBe(9001);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('requires the site, the window, and the output directory', () => {
    expect(() => exportRequest(['--window-start', '2026-09-10', '--window-end', '2026-10-12', '--out', '/x'])).toThrow(/usage/);
    expect(() => exportRequest(['--site', '/x.json', '--out', '/x'])).toThrow(/window-start/);
  });
});

describe('visitSql', () => {
  it('shards by the history partition and limits every joined fact table to its visits', () => {
    const sql = visitSql(exportSpec(site, window), { index: 2, count: 8 });
    expect(sql).toContain("HAVING modulo(cityHash64(if(cid = '', concat('~', toString(idvisit)), cid)), 8) = 2");
    expect(sql.match(/IN \(SELECT toUInt64\(idvisit\) FROM v_rows\)/g)).toHaveLength(6);
    expect(() => visitSql(exportSpec(site, window), { index: 8, count: 8 })).toThrow(/visit shard/);
  });
});
