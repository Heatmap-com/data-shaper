#!/usr/bin/env node
// Full-page and per-panel screenshots of one revision, through headless Chrome's DevTools protocol.
// Needs serve.mjs running.
//
//   node prototype/query-tool/capture.mjs --revision quick-concept --out /tmp/qt-cap/quick-concept
//     [--base http://127.0.0.1:8765] [--sites mellow,loop-earplugs] [--panels mellow] [--width 1440]
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const CHROME = process.env.CHROME_BIN ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9333;

function args() {
  const out = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) if (argv[i].startsWith('--')) out[argv[i].slice(2)] = argv[i + 1]?.startsWith('--') ? true : argv[++i] ?? true;
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForChrome() {
  for (let i = 0; i < 100; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await sleep(100);
  }
  throw new Error('Chrome did not open its debugging port');
}

function cdpClient(url) {
  const ws = new WebSocket(url);
  let next = 0;
  const pending = new Map();
  const onEvent = [];
  ws.onmessage = (evt) => {
    const msg = JSON.parse(evt.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.message}`)); else resolve(msg.result);
    } else if (msg.method) onEvent.forEach((fn) => fn(msg));
  };
  const ready = new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  return {
    ready,
    onEvent(fn) { onEvent.push(fn); },
    send(method, params = {}) {
      next += 1;
      const id = next;
      ws.send(JSON.stringify({ id, method, params }));
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    },
    close() { ws.close(); },
  };
}

async function evaluate(cdp, expression) {
  const res = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  return res.result.value;
}

async function load(cdp, url, width, ready) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.navigate', { url });
  const expr = ready ?? `document.readyState === 'complete' && document.querySelectorAll('.panel').length > 0
      && ![...document.querySelectorAll('.panel')].some((p) => p.textContent.trim() === 'Loading…')`;
  for (let i = 0; i < 300; i += 1) {
    await sleep(200);
    const ok = await evaluate(cdp, expr).catch(() => false);
    if (ok) { await sleep(400); return; }
  }
  throw new Error(`timed out loading ${url}`);
}

async function shoot(cdp, file, width, { panels = false, before } = {}) {
  if (before) { await evaluate(cdp, before); await sleep(300); }
  const height = await evaluate(cdp, 'Math.ceil(document.documentElement.scrollHeight)');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await sleep(300);
  const full = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  await writeFile(file, Buffer.from(full.data, 'base64'));
  const written = [file];
  if (panels) {
    const boxes = await evaluate(cdp, `[...document.querySelectorAll('.panel')].map((p) => {
      const r = p.getBoundingClientRect();
      return { id: p.id.replace(/^panel-/, ''), x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height };
    })`);
    for (const [i, b] of boxes.entries()) {
      const shot = await cdp.send('Page.captureScreenshot', {
        format: 'png', captureBeyondViewport: true,
        clip: { x: Math.max(0, b.x - 8), y: Math.max(0, b.y - 8), width: b.width + 16, height: b.height + 16, scale: 2 },
      });
      const panelFile = file.replace(/\.png$/, `--${String(i + 1).padStart(2, '0')}-${b.id}.png`);
      await writeFile(panelFile, Buffer.from(shot.data, 'base64'));
      written.push(panelFile);
    }
  }
  return written;
}

const hashFor = (site, tab, state, params) => {
  const q = new URLSearchParams({ site, ...(tab ? { tab } : {}), ...(params ?? {}) });
  if (state && Object.keys(state).length) q.set('s', JSON.stringify(state));
  return `#${q}`;
};

async function main() {
  const opts = args();
  if (!opts.out) throw new Error('--out is required');
  if (!opts.revision) throw new Error('--revision is required');
  const out = path.resolve(String(opts.out).replace(/^~(?=\/)/, process.env.HOME));
  const base = opts.base ?? 'http://127.0.0.1:8765';
  const width = Number(opts.width ?? 1440);
  const revision = String(opts.revision);

  await mkdir(out, { recursive: true });
  const profile = await mkdtemp(path.join(tmpdir(), 'qt-chrome-'));
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--hide-scrollbars', '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' });
  const index = [];
  const consoleErrors = [];
  try {
    const cdp = cdpClient(await waitForChrome());
    await cdp.ready;
    cdp.onEvent((msg) => {
      if (msg.method === 'Runtime.exceptionThrown') consoleErrors.push(msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text);
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
      }
    });
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: 'window.__errs=[];addEventListener("error",(e)=>__errs.push(String(e.message)));addEventListener("unhandledrejection",(e)=>__errs.push(String(e.reason&&e.reason.message||e.reason)));',
    });

    if (revision === 'entry') {
      await load(cdp, `${base}/?r=${Date.now()}`, width, `document.readyState === 'complete' && document.querySelectorAll('.rev-card').length > 0`);
      const file = path.join(out, 'entry.png');
      await shoot(cdp, file, width);
      const errs = await evaluate(cdp, 'window.__errs');
      index.push({ what: 'Entry page', files: ['entry.png'], errors: errs ?? [] });
      console.log(`entry: 1 image`);
    } else {
      const revDir = path.join(here, 'revisions', revision);
      const views = JSON.parse(await readFile(path.join(revDir, 'views.json'), 'utf8'));
      let capture = { variants: [] };
      try { capture = JSON.parse(await readFile(path.join(revDir, 'capture.json'), 'utf8')); } catch { /* optional */ }
      const sites = String(opts.sites ?? 'mellow,loop-earplugs').split(',');
      const panelSites = new Set(String(opts.panels ?? 'mellow').split(','));
      const lead = sites.includes(capture.lead) ? capture.lead : sites[0];
      const shots = [];
      for (const site of sites) {
        views.tabs.forEach((tab, i) => shots.push({ site, name: `${String(i + 1).padStart(2, '0')}-${tab.id}`, hash: hashFor(site, tab.id), panels: panelSites.has(site), what: tab.label }));
      }
      for (const v of capture.variants ?? []) {
        shots.push({ site: lead, name: v.name, hash: hashFor(lead, v.tab, v.state, v.params), panels: false, before: v.before, viewportOnly: v.viewportOnly, what: v.what });
      }
      for (const [n, shot] of shots.entries()) {
        const dir = path.join(out, shot.site);
        await mkdir(dir, { recursive: true });
        await load(cdp, `${base}/revisions/${revision}/?r=${Date.now()}-${n}${shot.hash}`, width);
        const file = path.join(dir, `${shot.name}.png`);
        let files;
        if (shot.viewportOnly) {
          if (shot.before) { await evaluate(cdp, shot.before); await sleep(300); }
          const img = await cdp.send('Page.captureScreenshot', { format: 'png' });
          await writeFile(file, Buffer.from(img.data, 'base64'));
          files = [file];
        } else {
          files = await shoot(cdp, file, width, { panels: shot.panels, before: shot.before });
        }
        const errs = await evaluate(cdp, 'window.__errs');
        if (errs?.length) consoleErrors.push(...errs.map((e) => `${shot.name}: ${e}`));
        index.push({ site: shot.site, what: shot.what, files: files.map((f) => path.relative(out, f)), errors: errs ?? [] });
        console.log(`${shot.site} ${shot.name}: ${files.length} image(s)${errs?.length ? ` (${errs.length} error(s))` : ''}`);
      }
    }
    cdp.close();
  } finally {
    chrome.kill();
    await sleep(300);
    await rm(profile, { recursive: true, force: true });
  }
  if (consoleErrors.length) console.log(`console errors: ${consoleErrors.length}`);
  await writeFile(path.join(out, 'index.json'), `${JSON.stringify({ shots: index, consoleErrors }, null, 2)}\n`);
}

main().catch((err) => { console.error(err); process.exit(1); });
