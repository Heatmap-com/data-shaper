import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { adapter as staticIdsites } from '../src/adapters/site-sources/static-idsites.js';
import { adapter as activeSites } from '../src/adapters/site-sources/active-ecommerce-sites.js';
import { namesForPage } from '../src/adapters/_lib/element-names.js';
import { runSites } from '../src/application/commands/args.js';

function gateway({ rows = [], columns = [], fail = false } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params, label) {
      calls.push({ sql, params, label });
      if (fail) throw new Error('boom');
      return rows;
    },
    async columns() {
      return columns.map((name) => ({ name }));
    },
  };
}

describe('static-idsites', () => {
  it('lists the given idsites with names from default.sites', async () => {
    const gw = gateway({ rows: [{ idsite: '12', name: 'Twelve' }] });
    const sites = await staticIdsites.listSites({ gateway: gw, sites: { idsites: [12, 34] } });
    expect(sites).toEqual([
      { idsite: 12, siteName: 'Twelve' },
      { idsite: 34, siteName: '' },
    ]);
    expect(gw.calls[0].params).toEqual({ idsite0: 12, idsite1: 34 });
  });

  it('leaves names blank when the lookup fails', async () => {
    const sites = await staticIdsites.listSites({ gateway: gateway({ fail: true }), sites: { idsites: [7] } });
    expect(sites).toEqual([{ idsite: 7, siteName: '' }]);
  });

  it('is an error when the run has no idsites', async () => {
    await expect(staticIdsites.listSites({ gateway: gateway() })).rejects.toThrow(/no idsites/);
    await expect(staticIdsites.listSites({ gateway: gateway(), sites: { idsites: [] } })).rejects.toThrow(/no idsites/);
  });

  it('rejects idsites that are not positive integers', async () => {
    await expect(staticIdsites.listSites({ gateway: gateway(), sites: { idsites: [3, 0] } })).rejects.toThrow(/0/);
  });
});

describe('active-ecommerce-sites', () => {
  const columns = ['idsite', 'name', 'status', 'platform'];

  it('queries default.sites with the run platform and status', async () => {
    const gw = gateway({ columns, rows: [{ idsite: '9', name: 'Nine' }] });
    const sites = await activeSites.listSites({ gateway: gw, sites: { platform: 'bigcommerce', status: 'trial' } });
    expect(sites).toEqual([{ idsite: 9, siteName: 'Nine' }]);
    expect(gw.calls[0].params).toEqual({ status: 'trial', platform: 'bigcommerce' });
  });

  it('is an error without a platform and status', async () => {
    await expect(activeSites.listSites({ gateway: gateway({ columns }), sites: { platform: 'shopify' } })).rejects.toThrow(/platform and sites.status/);
  });

  it('fails closed when default.sites lacks a column', async () => {
    const gw = gateway({ columns: ['idsite', 'name', 'platform'] });
    await expect(activeSites.listSites({ gateway: gw, sites: { platform: 'shopify', status: 'active' } })).rejects.toThrow(/status/);
  });
});

describe('runSites', () => {
  it('parses --sites and defaults the platform and status', () => {
    expect(runSites({ sites: '5, 6' })).toEqual({ idsites: [5, 6], platform: 'shopify', status: 'active' });
    expect(runSites({ platform: 'woo', status: 'paused' })).toEqual({ platform: 'woo', status: 'paused' });
    expect(runSites({ idsites: '8' }, 'idsites')).toEqual({ idsites: [8], platform: 'shopify', status: 'active' });
  });

  it('rejects a site that is not a positive integer', () => {
    expect(() => runSites({ sites: '5,abc' })).toThrow(/abc/);
  });
});

describe('element names from the run context', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'element-names-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'element-names.json');
  writeFileSync(file, JSON.stringify({
    sites: [{ elements: [{ selector: '#buy', selector_aliases: ['.buy'], element_id: 'e1', element_class: 'cta' }] }],
  }));

  it('matches selectors and aliases from ctx.elementNamesPath', async () => {
    const match = await namesForPage({ gateway: null, elementNamesPath: file }, { idsite: 1, idsitehsr: 2 });
    expect((await match('#buy'))?.element.element_id).toBe('e1');
    expect((await match('.buy'))?.matched).toBe('.buy');
    expect(await match('#other')).toBeNull();
  });

  it('matches nothing when the run has no names file', async () => {
    const match = await namesForPage({ gateway: null }, { idsite: 1, idsitehsr: 2 });
    expect(await match('#buy')).toBeNull();
  });
});
