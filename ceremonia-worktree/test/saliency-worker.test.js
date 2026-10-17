import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { runSaliencyWorker } from '../src/saliency-worker.js';
import { saliencyConfig } from '../src/composition/engine.js';
import { createMemoryAePersistence } from '../src/adapters/persistence/memory.js';

/**
 * Saliency worker (D-08): ships disabled behind AE_ENABLE_SALIENCY; when
 * enabled it sweeps the pending captures per site through the gateway, runs
 * the configured model command per device screenshot, writes saliency
 * through the persistence port, and flips has_saliency. Covers the no-op
 * default, the happy path against the memory adapter, per-page failure
 * semantics (bad model exit, missing screenshot), and the pre-cutover
 * UNKNOWN_TABLE quiet return.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_MODEL = path.join(here, 'fixtures', 'fake-saliency-model.mjs');

/** @type {string[]} */
const tmpDirs = [];

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tmpDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ae-saliency-'));
  tmpDirs.push(dir);
  return dir;
}

function createLogger() {
  /** @type {Array<{level: string, msg: string, obj?: object}>} */
  const lines = [];
  const push = (level) => (obj, msg) => lines.push({ level, msg: String(msg ?? obj), obj: msg === undefined ? undefined : obj });
  return { lines, info: push('info'), warn: push('warn'), error: push('error') };
}

function unknownTableError() {
  const err = new Error(
    'Code: 60. DB::Exception: Table journey_events.ae_page_render_current does not exist. (UNKNOWN_TABLE)',
  );
  err.type = 'UNKNOWN_TABLE';
  return err;
}

/**
 * Gateway double keyed on the SQL text. `captures` are the pending
 * ae_page_capture_current rows; `renders`/`nodes` are Maps of
 * `${idsite}:${idsitehsr}` to ae_page_render_current / ae_render_node_current
 * rows.
 */
function fakeGateway({ captures = [], renders = new Map(), nodes = new Map(), failUnknownTable = false } = {}) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    /** @param {string} sql @param {object} [params] */
    async query(sql, params = {}) {
      calls += 1;
      if (failUnknownTable) throw unknownTableError();
      if (sql.includes('DISTINCT idsite')) {
        return [...new Set(captures.map((c) => Number(c.idsite)))].map((idsite) => ({ idsite }));
      }
      if (sql.includes('ae_page_capture_current')) {
        return captures.filter((c) => Number(c.idsite) === Number(params.idsite));
      }
      if (sql.includes('ae_page_render_current')) {
        return renders.get(`${params.idsite}:${params.idsitehsr}`) ?? [];
      }
      if (sql.includes('ae_render_node_current')) {
        return nodes.get(`${params.idsite}:${params.idsitehsr}`) ?? [];
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
}

/**
 * Memory persistence plus a recording decorator around writeSaliency: `calls`
 * captures the exact port arguments and the rows the real adapter wrote.
 */
function persistenceWithSpy() {
  const { adapter } = createMemoryAePersistence();
  /** @type {Array<{args: object, written: object[]}>} */
  const calls = [];
  const original = adapter.writeSaliency.bind(adapter);
  adapter.writeSaliency = async (args) => {
    const written = await original(args);
    calls.push({ args, written });
    return written;
  };
  return { persistence: adapter, calls };
}

const NODES = [
  { device_class: 'desktop', node_id: 's1' },
  { device_class: 'desktop', node_id: 'el:0' },
];

/**
 * Seeds a captured page with one desktop render through the real
 * completeCapture port call, so ae_page_capture has_render = 1 and the two
 * fixture render nodes exist in the memory store.
 *
 * @param {object} persistence
 * @param {{idsite: number, idsitehsr: number, screenshotUri: string}} key
 */
async function seedCapture(persistence, { idsite, idsitehsr, screenshotUri }) {
  await persistence.completeCapture({
    idsite,
    idsitehsr,
    url: 'https://example.test/p',
    capturedOn: '2026-10-04',
    hasRender: true,
    bindings: [],
    renders: [
      {
        device_class: 'desktop',
        viewport_w: 390,
        viewport_h: 844,
        page_height_px: 2000,
        fold_px: 844,
        screenshot_uri: screenshotUri,
        content_hash: 'sha256:a',
        dom_hash: 'sha256:b',
        rendered_at: '2026-10-04T00:00:00Z',
        renderer_version: 'fixture',
        sections: [{ id: 's1', top: 0, height: 500, type: 'hero', words: 10 }],
        elements: [
          {
            selector: '#cta',
            section_id: 's1',
            dom_order: 0,
            x: 16,
            y: 400,
            w: 200,
            h: 48,
            is_control: true,
            looks_clickable: true,
            sticky: false,
            visual_class: 'control',
            image_type: '',
            words: 2,
          },
        ],
      },
    ],
  });
}

function enabledEnv(overrides = {}) {
  return {
    AE_ENABLE_SALIENCY: '1',
    AE_SALIENCY_COMMAND: `${process.execPath} ${FIXTURE_MODEL} {screenshot} {device} {idsite} {idsitehsr}`,
    AE_SALIENCY_MODEL: 'fixture-model',
    ...overrides,
  };
}

describe('saliency worker', () => {
  it('no-ops with a single log line when AE_ENABLE_SALIENCY is unset', async () => {
    const gateway = fakeGateway();
    const { persistence, calls } = persistenceWithSpy();
    const logger = createLogger();

    await runSaliencyWorker({ persistence, gateway, logger, saliency: saliencyConfig({}) });

    expect(gateway.calls).toBe(0);
    expect(calls).toHaveLength(0);
    expect(logger.lines).toHaveLength(1);
    expect(logger.lines[0].level).toBe('info');
    expect(logger.lines[0].msg).toMatch(/disabled/);
  });

  it('idles with a warning when enabled without AE_SALIENCY_COMMAND', async () => {
    const gateway = fakeGateway();
    const { persistence, calls } = persistenceWithSpy();
    const logger = createLogger();

    await runSaliencyWorker({
      persistence,
      gateway,
      logger,
      saliency: saliencyConfig({ AE_ENABLE_SALIENCY: '1', AE_SALIENCY_COMMAND: '' }),
    });

    expect(gateway.calls).toBe(0);
    expect(calls).toHaveLength(0);
    expect(logger.lines).toHaveLength(1);
    expect(logger.lines[0].level).toBe('warn');
    expect(logger.lines[0].msg).toMatch(/AE_SALIENCY_COMMAND is empty/);
  });

  it('runs the model per device, writes saliency, and marks the capture done', async () => {
    const dir = await tmpDir();
    const screenshot = path.join(dir, 'shot.png');
    await writeFile(screenshot, 'fake png bytes');
    const { persistence, calls } = persistenceWithSpy();
    await seedCapture(persistence, { idsite: 3199, idsitehsr: 123, screenshotUri: screenshot });

    const gateway = fakeGateway({
      captures: [{ idsite: 3199, idsitehsr: 123 }],
      renders: new Map([['3199:123', [{ device_class: 'desktop', screenshot_uri: screenshot }]]]),
      nodes: new Map([['3199:123', NODES]]),
    });
    const logger = createLogger();

    // No AE_SALIENCY_SITES: the worker discovers sites through the gateway.
    await runSaliencyWorker({
      persistence,
      gateway,
      logger,
      saliency: saliencyConfig(enabledEnv()),
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].args).toMatchObject({
      idsite: 3199,
      idsitehsr: 123,
      device_class: 'desktop',
      model: 'fixture-model',
      nodes: [
        { node_id: 's1', saliency_share: 0.6, saliency_quartile: 3 },
        { node_id: 'el:0', saliency_share: 0.4, saliency_quartile: 2 },
      ],
    });
    expect(calls[0].written).toHaveLength(2);
    expect(calls[0].written.every((row) => row.saliency_model === 'fixture-model')).toBe(true);

    const status = await persistence.captureStatus({ idsite: 3199, idsitehsr: 123 });
    expect(status?.hasRender).toBe(true);
    expect(status?.hasSaliency).toBe(true);

    const drained = logger.lines.find((l) => l.msg === 'saliency worker drained');
    expect(drained).toBeDefined();
    expect(logger.lines.some((l) => l.msg === 'saliency complete')).toBe(true);
  });

  it('a bad model exit leaves has_saliency 0 on that page and continues the sweep', async () => {
    const dir = await tmpDir();
    // 'shot-missing.png' exists, so the fixture model's exit(1) path (not the
    // missing-screenshot path) fails the first page.
    const badShot = path.join(dir, 'shot-missing.png');
    const goodShot = path.join(dir, 'shot.png');
    await writeFile(badShot, 'fake png bytes');
    await writeFile(goodShot, 'fake png bytes');

    const { persistence, calls } = persistenceWithSpy();
    await seedCapture(persistence, { idsite: 3199, idsitehsr: 111, screenshotUri: badShot });
    await seedCapture(persistence, { idsite: 3199, idsitehsr: 222, screenshotUri: goodShot });

    const gateway = fakeGateway({
      captures: [
        { idsite: 3199, idsitehsr: 111 },
        { idsite: 3199, idsitehsr: 222 },
      ],
      renders: new Map([
        ['3199:111', [{ device_class: 'desktop', screenshot_uri: badShot }]],
        ['3199:222', [{ device_class: 'desktop', screenshot_uri: goodShot }]],
      ]),
      nodes: new Map([
        ['3199:111', NODES],
        ['3199:222', NODES],
      ]),
    });
    const logger = createLogger();

    await runSaliencyWorker({
      persistence,
      gateway,
      logger,
      saliency: saliencyConfig(enabledEnv({ AE_SALIENCY_SITES: '3199' })),
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].args.idsitehsr).toBe(222);
    expect((await persistence.captureStatus({ idsite: 3199, idsitehsr: 111 }))?.hasSaliency).toBe(false);
    expect((await persistence.captureStatus({ idsite: 3199, idsitehsr: 222 }))?.hasSaliency).toBe(true);

    const skip = logger.lines.find((l) => l.msg === 'saliency page skipped');
    expect(skip).toBeDefined();
    expect(skip.level).toBe('warn');
    expect(String(/** @type {{reason?: string}} */ (skip.obj)?.reason)).toMatch(/model command failed/);
    const drained = logger.lines.find((l) => l.msg === 'saliency worker drained');
    expect(drained).toBeDefined();
  });

  it('a missing screenshot marks the page skipped with the reason logged', async () => {
    const dir = await tmpDir();
    const absent = path.join(dir, 'absent.png');
    const { persistence, calls } = persistenceWithSpy();
    await seedCapture(persistence, { idsite: 3199, idsitehsr: 123, screenshotUri: absent });

    const gateway = fakeGateway({
      captures: [{ idsite: 3199, idsitehsr: 123 }],
      renders: new Map([['3199:123', [{ device_class: 'desktop', screenshot_uri: absent }]]]),
      nodes: new Map([['3199:123', NODES]]),
    });
    const logger = createLogger();

    await runSaliencyWorker({
      persistence,
      gateway,
      logger,
      saliency: saliencyConfig(enabledEnv({ AE_SALIENCY_SITES: '3199' })),
    });

    expect(calls).toHaveLength(0);
    expect((await persistence.captureStatus({ idsite: 3199, idsitehsr: 123 }))?.hasSaliency).toBe(false);
    const skip = logger.lines.find((l) => l.msg === 'saliency page skipped');
    expect(skip).toBeDefined();
    expect(skip.level).toBe('warn');
    expect(String(/** @type {{reason?: string}} */ (skip.obj)?.reason)).toMatch(/screenshot not found/);
  });

  it('returns quietly when the ae_ tables do not exist yet (pre-cutover)', async () => {
    const { persistence, calls } = persistenceWithSpy();
    const gateway = fakeGateway({ failUnknownTable: true });
    const logger = createLogger();

    await runSaliencyWorker({ persistence, gateway, logger, saliency: saliencyConfig(enabledEnv()) });

    expect(gateway.calls).toBe(1);
    expect(calls).toHaveLength(0);
    expect(logger.lines).toHaveLength(1);
    expect(logger.lines[0].level).toBe('warn');
    expect(logger.lines[0].msg).toMatch(/pre-cutover/);
  });
});

describe('saliencyConfig', () => {
  it('reads the four settings from the environment', () => {
    expect(saliencyConfig({})).toEqual({ enabled: false, command: '', model: '', sites: [] });
    expect(saliencyConfig({
      AE_ENABLE_SALIENCY: '1',
      AE_SALIENCY_COMMAND: '  run {screenshot} ',
      AE_SALIENCY_MODEL: ' m1 ',
      AE_SALIENCY_SITES: '3199, x, -2, 7.5, 12,',
    })).toEqual({ enabled: true, command: 'run {screenshot}', model: 'm1', sites: [3199, 12] });
    expect(saliencyConfig({ AE_ENABLE_SALIENCY: 'true' }).enabled).toBe(false);
  });
});
