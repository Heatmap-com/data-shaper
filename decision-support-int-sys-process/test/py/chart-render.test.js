import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const REPO = path.resolve(import.meta.dirname, '../..');
const PYTHON = process.env.PYTHON ?? 'python3';
const ready = spawnSync(PYTHON, ['-c', 'import matplotlib, pandas'], { encoding: 'utf8' }).status === 0;

function table(name, header, rows) {
  return [`=== TABLE: ${name} ===`, 'type: test', '--- BEGIN CSV ---', header, ...rows, `@@ ${name} | columns: ${header}`, '--- END CSV ---', ''].join('\n');
}

async function bundle(dir) {
  await writeFile(path.join(dir, '00_site_profile.json'), JSON.stringify({
    site: 'Acme', currency: 'USD', report_window: { start: '2026-09-13', end: '2026-10-12' }, analysed_page: { label: 'the hero page' },
  }));
  await writeFile(path.join(dir, '.anchors.json'), JSON.stringify({ peak_days: ['2026-09-14'] }));
  const orders = ['oid,d,order_revenue', 'a,2026-09-13,20', 'b,2026-09-14,90', 'c,2026-09-14,10', 'd,2026-10-01,30', 'e,2026-08-01,99'];
  await writeFile(path.join(dir, '01_orders.csv'), `${orders.join('\n')}\n`);
  const days = ['2026-09-14', '2026-09-21'];
  const dcd = days.flatMap((d) => [
    `${d},mobile,meta_paid,meta,100,3,3,60,12,5`,
    `${d},desktop,direct,no_campaign_link,40,2,2,50,4,6`,
  ]);
  const cohorts = ['ch,meta_paid,first,150,4,4,90,0,0', 'ch,direct,second,120,3,3,80,0,0', 'ch,email_sms,pre,500,9,9,400,0,0'];
  await writeFile(path.join(dir, '02_tables.txt'), [
    table('daily_channel_device', 'd,dev_s,ch,link_ch,visits,buyer_visits,orders,revenue,atc_visits,checkout_visits', dcd),
    table('visit_cohorts', 'family,value,period,visits,buyer_visits,orders,revenue,atc_visits,checkout_visits', cohorts),
  ].join('\n'));
}

describe.skipIf(!ready)('py/chart-render.py', () => {
  let root;
  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'chart-render-'));
    await bundle(root);
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const run = async (charts) => {
    const specs = path.join(root, 'specs.json');
    await writeFile(specs, JSON.stringify({ charts }));
    return spawnSync(PYTHON, ['py/chart-render.py', '--bundle', root, '--specs', specs, '--out', path.join(root, 'media'), '--tokens', 'scripts/report-style/tokens.json'], { cwd: REPO, encoding: 'utf8' });
  };

  it('draws the charts the bundle supports and lists the rest as skipped, with reasons', async () => {
    const out = await run([
      { file: 'fig-orders.png', stage: 'sor', type: 'daily-orders' },
      { file: 'fig-funnel.png', stage: 'sor', type: 'device-funnel' },
      { file: 'fig-channels.png', stage: 'sor', type: 'channel-rpv', min_visits: 100, labels: { meta_paid: 'Meta paid' } },
      { file: 'fig-weeks.png', stage: 'uj', type: 'weekly-revenue' },
      { file: 'fig-scroll.png', stage: 'sor', type: 'scroll-depth' },
    ]);
    expect(out.status, out.stderr).toBe(0);
    const manifest = JSON.parse(await readFile(path.join(root, 'media', 'charts.json'), 'utf8'));
    expect(manifest.report_window).toEqual({ start: '2026-09-13', end: '2026-10-12' });
    expect(manifest.charts.map((row) => [row.file, row.status])).toEqual([
      ['fig-orders.png', 'rendered'],
      ['fig-funnel.png', 'rendered'],
      ['fig-channels.png', 'rendered'],
      ['fig-weeks.png', 'rendered'],
      ['fig-scroll.png', 'skipped'],
    ]);
    expect(manifest.charts[0].title).toBe('Daily orders, 13 September – 12 October 2026');
    expect(manifest.charts[4].reason).toBe('the bundle has no scroll-decile table');
    expect((await stat(path.join(root, 'media', 'fig-orders.png'))).size).toBeGreaterThan(1000);
  }, 30_000);

  it('exits 1 and names an unknown chart type', async () => {
    const out = await run([{ file: 'x.png', type: 'pie-of-everything' }]);
    expect(out.status).toBe(1);
    expect(out.stderr).toMatch(/unknown chart type pie-of-everything; known: cart-recovery/);
  });
});
