import { mkdtemp, rm, writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { adapter } from '../src/orchestrator/adapters/checks/bundle-anchors.js';

const window = { start: '2026-09-17', end: '2026-10-16' };
let dir;

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

function ctx(bundle, site) {
  return {
    render: (value) => value,
    values: { window },
    job: { site: {} },
    bundle,
    site,
  };
}

describe('bundle-anchors check', () => {
  it('needs a bundle path', () => {
    expect(adapter.validate({})).toEqual(['bundle-anchors needs bundle']);
    expect(adapter.id).toBe('bundle-anchors');
  });

  it('passes when the profile, the orders, and the focus page agree', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'bundle-check-'));
    const profile = {
      report_window: window,
      analysed_page: { path: '/', idsitehsr: 10 },
      anchors: [{ label: 'orders in report window', where: "d >= '2026-09-17' and d <= '2026-10-16'", agg: 'count', expect: 1 }],
    };
    await writeFile(path.join(dir, '00_site_profile.json'), JSON.stringify(profile));
    await writeFile(path.join(dir, '01_orders.csv'), 'oid,d,t_utc,order_revenue\n1,2026-09-20,2026-09-20T00:00:00,12\n');
    const site = path.join(dir, 'site.json');
    await writeFile(site, JSON.stringify({ focus: { path: '/', label: 'Home', idsitehsr: 10 } }));
    const result = await adapter.evaluate(ctx(dir, site), { bundle: dir, site, page: 'focus' });
    expect(result.ok).toBe(true);
  });

  it('reports a missing orders file', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'bundle-check-'));
    await writeFile(path.join(dir, '00_site_profile.json'), JSON.stringify({ report_window: window, anchors: [] }));
    await writeFile(path.join(dir, '01_orders.csv'), 'oid,d,order_revenue\n');
    await unlink(path.join(dir, '01_orders.csv'));
    const result = await adapter.evaluate(ctx(dir), { bundle: dir });
    expect(result.ok).toBe(false);
    expect(result.summary).toBe(`missing bundle files in ${dir}`);
  });
});
