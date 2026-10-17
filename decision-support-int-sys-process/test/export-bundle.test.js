import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { exportBundle } from '../bin/export-bundle.mjs';

const window = { start: '2026-09-17', end: '2026-10-16' };
let dir;

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

function siteBody(focus) {
  return {
    slug: 'frankandeileen',
    name: 'Frank & Eileen',
    domain: 'frankandeileen.com',
    idsite: 6277,
    platform: 'shopify',
    currency: 'USD',
    ...(focus ? { focus } : {}),
  };
}

async function layout({ focus = true, attempt = '1', meta } = {}) {
  dir = await mkdtemp(path.join(tmpdir(), 'export-bundle-'));
  const site = path.join(dir, 'site.json');
  await writeFile(site, `${JSON.stringify(siteBody(focus ? { path: '/', label: 'Home', idsitehsr: 99 } : null), null, 2)}\n`);
  const extract = path.join(dir, 'extract');
  const out = path.join(dir, 'out');
  await mkdir(extract, { recursive: true });
  if (meta) await writeFile(path.join(extract, 'meta.json'), JSON.stringify(meta));
  const runs = path.join(dir, 'runs');
  const calls = [];
  const io = {
    say(line) { calls.push({ say: line }); },
    spawn(command, args, options) {
      calls.push({ command, args, env: options.env });
      if (args.some((arg) => String(arg).endsWith('bundle-build.py'))) {
        return writeBundle(out).then(() => ({ code: 0, stdout: '', stderr: '' }));
      }
      return Promise.resolve({ code: 0, stdout: 'frankandeileen visits done\n', stderr: '' });
    },
    queryPage: async () => ({ idsitehsr: 99, url: 'https://frankandeileen.com/', pageTitle: 'Home' }),
  };
  const argv = [
    '--site', site,
    '--window-start', window.start,
    '--window-end', window.end,
    '--extract', extract,
    '--out', out,
    '--job', 'frankandeileen-job',
    '--runs', runs,
    '--attempt', attempt,
    '--python', 'python3',
  ];
  return { io, argv, calls, site };
}

async function writeBundle(out) {
  await mkdir(out, { recursive: true });
  await writeFile(path.join(out, '00_site_profile.json'), JSON.stringify({
    report_window: window,
    analysed_page: { path: '/', idsitehsr: 99 },
    anchors: [{ label: 'orders in report window', where: "d >= '2026-09-17' and d <= '2026-10-16'", agg: 'count', expect: 1 }],
  }));
  await writeFile(path.join(out, '01_orders.csv'), 'oid,d,t_utc,order_revenue\n1,2026-09-20,2026-09-20T00:00:00,40\n');
}

describe('export-bundle resume', () => {
  it('does not set BUNDLE_RESUME on attempt 1', async () => {
    const { io, argv, calls } = await layout();
    expect(await exportBundle(argv, io)).toBe(0);
    const extract = calls.find((call) => call.args?.some((arg) => String(arg).endsWith('bundle-export.mjs')));
    expect(extract.env.BUNDLE_RESUME).toBeUndefined();
  });

  it('sets BUNDLE_RESUME when attempt 2 reuses a matching extract', async () => {
    const { io, argv, calls } = await layout({
      attempt: '2',
      meta: { slug: 'frankandeileen', window0: window.start, window1: window.end, idsite: 6277 },
    });
    expect(await exportBundle(argv, io)).toBe(0);
    const extract = calls.find((call) => call.args?.some((arg) => String(arg).endsWith('bundle-export.mjs')));
    expect(extract.env.BUNDLE_RESUME).toBe('1');
  });

  it('does not resume when the extract meta names a different window', async () => {
    const { io, argv, calls } = await layout({
      attempt: '2',
      meta: { slug: 'frankandeileen', window0: '2026-08-01', window1: '2026-08-31', idsite: 6277 },
    });
    expect(await exportBundle(argv, io)).toBe(0);
    const extract = calls.find((call) => call.args?.some((arg) => String(arg).endsWith('bundle-export.mjs')));
    expect(extract.env.BUNDLE_RESUME).toBeUndefined();
  });

  it('writes a missing focus from the primary page and does not overwrite an existing one', async () => {
    const written = await layout({ focus: false });
    await mkdir(path.join(dir, 'runs', 'frankandeileen-job', 'analysis', 'attempt-1'), { recursive: true });
    await writeFile(
      path.join(dir, 'runs', 'frankandeileen-job', 'analysis', 'attempt-1', 'batch.json'),
      JSON.stringify({ batchId: '11111111-1111-1111-1111-111111111111', profile: 'lp', idsite: 6277, windowDays: 30 }),
    );
    expect(await exportBundle(written.argv, written.io)).toBe(0);
    const saved = JSON.parse(await readFile(written.site, 'utf8'));
    expect(saved.focus).toEqual({ path: '/', label: 'Home', idsitehsr: 99 });

    const kept = await layout();
    kept.io.queryPage = async () => { throw new Error('should not query'); };
    expect(await exportBundle(kept.argv, kept.io)).toBe(0);
    const unchanged = JSON.parse(await readFile(kept.site, 'utf8'));
    expect(unchanged.focus.idsitehsr).toBe(99);
  });
});
