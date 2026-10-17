import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBotRunner } from '../src/capture/bot-runner.js';
import { createHarvester } from '../src/capture/harvester.js';
import { runCaptureAgents } from '../src/capture-consumer.js';
import { createMemoryAePersistence } from '../src/adapters/persistence/memory.js';

const harvester = createHarvester({ botRunner: createBotRunner({ env: process.env }) });

/**
 * Capture consumer with the render contract (data-capture-plan.md §9.3,
 * Phase 4 task 3): a stub bot writes names.json + render.<device>.json +
 * screenshots; the consumer validates each device artifact, lands the
 * screenshots per the Q9 default, and completeCapture writes bindings,
 * ae_page_render rows and ae_render_node rows. A bad or missing device
 * artifact failCaptures naming the device. Render drift (a changed
 * content_hash on a later completeCapture) writes one ae_change_log
 * content_drift row.
 */

const logger = { info() {}, warn() {}, error() {} };
const clock = { todayUtc: () => '2026-10-04' };
const STUB = path.resolve('test/fixtures/stub-capture-bot.mjs');

let tmp;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), 'capture-consumer-test-'));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
  delete process.env.CAPTURE_STUB_ROOT;
  delete process.env.CAPTURE_STUB_BAD_BOX;
  delete process.env.CAPTURE_STUB_OMIT_RENDER;
  delete process.env.CAPTURE_STUB_GARBAGE_RENDER;
});

function captureConfig(root) {
  return {
    agents: { naming: 1 },
    naming: {
      command: `node ${STUB} {url} {idsite}`,
      botDir: '',
      datasetRoot: root,
      botTimeoutMs: 30_000,
    },
  };
}

async function enqueueTwoDeviceJob(adapter) {
  await adapter.enqueueCapture({
    idsite: 3199,
    idsitehsr: 63918696,
    url: 'https://x.com/pages/builder',
    pageType: 'content',
    deviceClasses: ['desktop', 'mobile'],
    want: ['naming', 'render'],
  });
}

describe('capture consumer with render artifacts', () => {
  it('a stub bot run lands bindings + 2 renders + nodes, with screenshots copied', async () => {
    const root = path.join(tmp, 'dataset');
    process.env.CAPTURE_STUB_ROOT = root;
    const { adapter, snapshot } = createMemoryAePersistence();
    await enqueueTwoDeviceJob(adapter);

    await runCaptureAgents({ persistence: adapter, config: captureConfig(root), logger, clock, harvester });

    const state = snapshot();
    expect(state.captureQueue[0].status).toBe('done');

    // the naming harvest mapped 3 rows (nav_toggle, nav_link, offer_add_to_cart)
    expect(state.elementBindings).toHaveLength(3);
    expect(state.elementBindings.map((b) => b.element_class).sort()).toEqual([
      'nav_link',
      'nav_toggle',
      'offer_add_to_cart',
    ]);

    // one ae_page_render row per device, hashes carried, has_render set
    expect(state.pageRenders).toHaveLength(2);
    const desktop = state.pageRenders.find((r) => r.device_class === 'desktop');
    expect(desktop.content_hash).toBe('sha256:desktop-1');
    expect(desktop.section_order).toEqual(['s1']);
    const capture = state.pageCaptures.find((r) => Number(r.idsitehsr) === 63918696);
    expect(Number(capture.has_render)).toBe(1);
    expect(Number(capture.has_saliency)).toBe(0);
    expect(capture.capture_id).toBe(desktop.capture_id);

    // ae_render_node: one section node + 3 element nodes per device
    expect(state.renderNodes).toHaveLength(8);
    const sectionNode = state.renderNodes.find((n) => n.device_class === 'desktop' && n.node_id === 's1');
    expect(sectionNode.node_kind).toBe('section');
    expect(Number(sectionNode.h)).toBe(420);
    const elementNode = state.renderNodes.find(
      (n) => n.device_class === 'mobile' && n.node_kind === 'element' && n.selector === 'button.atc',
    );
    expect(elementNode.parent_section_id).toBe('s1');
    expect(elementNode.saliency_share ?? null).toBeNull();

    // coverage folds the naming and render summaries
    const coverage = JSON.parse(capture.coverage);
    expect(coverage).toEqual({
      named_selectors: 3,
      devices: ['desktop', 'mobile'],
      elements_bound: 3,
      sections_found: 2,
    });

    // Q9 default: screenshots copied to <datasetRoot>/../captures/...
    const desktopShot = path.join(tmp, 'captures', '3199', '63918696', 'desktop.screenshot.desktop.png');
    const mobileShot = path.join(tmp, 'captures', '3199', '63918696', 'mobile.screenshot.mobile.png');
    expect(existsSync(desktopShot)).toBe(true);
    expect(existsSync(mobileShot)).toBe(true);
    expect(state.pageRenders.find((r) => r.device_class === 'desktop').screenshot_uri).toBe(
      path.join('..', 'captures', '3199', '63918696', 'desktop.screenshot.desktop.png'),
    );
  }, 20000);

  it('a device list of [] stays naming-only: no render files required', async () => {
    const root = path.join(tmp, 'dataset-naming-only');
    process.env.CAPTURE_STUB_ROOT = root;
    const { adapter, snapshot } = createMemoryAePersistence();
    await adapter.enqueueCapture({
      idsite: 3207,
      idsitehsr: 9307614,
      url: 'https://y.com',
      pageType: 'home',
      deviceClasses: [],
      want: ['naming'],
    });

    await runCaptureAgents({ persistence: adapter, config: captureConfig(root), logger, clock, harvester });

    const state = snapshot();
    expect(state.captureQueue[0].status).toBe('done');
    expect(state.elementBindings).toHaveLength(3);
    expect(state.pageRenders).toHaveLength(0);
    expect(state.renderNodes).toHaveLength(0);
    const capture = state.pageCaptures[0];
    expect(Number(capture.has_render)).toBe(0);
    expect(JSON.parse(capture.coverage).devices).toEqual([]);
  }, 20000);

  it('retries a failed bot once and keeps the capture when the second try lands', async () => {
    const root = path.join(tmp, 'dataset-retry');
    process.env.CAPTURE_STUB_ROOT = root;
    const { adapter, snapshot } = createMemoryAePersistence();
    await enqueueTwoDeviceJob(adapter);
    let calls = 0;
    const flaky = {
      harvestNames(job, naming, log) {
        calls += 1;
        if (calls === 1) throw new Error('timed out after 600000ms');
        return harvester.harvestNames(job, naming, log);
      },
    };

    await runCaptureAgents({ persistence: adapter, config: captureConfig(root), logger, clock, harvester: flaky });

    expect(calls).toBe(2);
    expect(snapshot().captureQueue[0].status).toBe('done');
  }, 20000);

  it('failCaptures only after the bot has failed twice', async () => {
    const { adapter, snapshot } = createMemoryAePersistence();
    await enqueueTwoDeviceJob(adapter);
    let calls = 0;
    const flaky = {
      async harvestNames() {
        calls += 1;
        throw new Error('timed out after 600000ms');
      },
    };

    await runCaptureAgents({ persistence: adapter, config: captureConfig(tmp), logger, clock, harvester: flaky });

    expect(calls).toBe(2);
    expect(snapshot().captureQueue[0].status).toBe('failed');
    expect(snapshot().captureQueue[0].reason).toMatch(/timed out after 600000ms/);
  });

  it('a mobile artifact with a bad box failCaptures naming mobile', async () => {
    const root = path.join(tmp, 'dataset-bad-box');
    process.env.CAPTURE_STUB_ROOT = root;
    process.env.CAPTURE_STUB_BAD_BOX = 'mobile';
    const { adapter, snapshot } = createMemoryAePersistence();
    await enqueueTwoDeviceJob(adapter);

    await runCaptureAgents({ persistence: adapter, config: captureConfig(root), logger, clock, harvester });

    const state = snapshot();
    expect(state.captureQueue[0].status).toBe('failed');
    expect(state.captureQueue[0].reason).toMatch(/device "mobile"/);
    expect(state.captureQueue[0].reason).toMatch(/box w\/h must be >= 0/);
    expect(state.pageCaptures).toHaveLength(0);
    expect(state.pageRenders).toHaveLength(0);
  }, 20000);

  it('a requested render file that is missing fails, naming the device', async () => {
    const root = path.join(tmp, 'dataset-missing-render');
    process.env.CAPTURE_STUB_ROOT = root;
    process.env.CAPTURE_STUB_OMIT_RENDER = 'mobile';
    const { adapter, snapshot } = createMemoryAePersistence();
    await enqueueTwoDeviceJob(adapter);

    await runCaptureAgents({ persistence: adapter, config: captureConfig(root), logger, clock, harvester });

    const state = snapshot();
    expect(state.captureQueue[0].status).toBe('failed');
    expect(state.captureQueue[0].reason).toMatch(/render artifact for device "mobile" not found/);
  }, 20000);

  it('an unparseable render file fails, naming the device', async () => {
    const root = path.join(tmp, 'dataset-garbage-render');
    process.env.CAPTURE_STUB_ROOT = root;
    process.env.CAPTURE_STUB_GARBAGE_RENDER = 'desktop';
    const { adapter, snapshot } = createMemoryAePersistence();
    await enqueueTwoDeviceJob(adapter);

    await runCaptureAgents({ persistence: adapter, config: captureConfig(root), logger, clock, harvester });

    const state = snapshot();
    expect(state.captureQueue[0].status).toBe('failed');
    expect(state.captureQueue[0].reason).toMatch(/device "desktop" is not parseable JSON/);
  }, 20000);
});

describe('render drift (§9.3)', () => {
  const render = (over = {}) => ({
    device_class: 'desktop',
    viewport_w: 1440,
    viewport_h: 900,
    page_height_px: 3200,
    fold_px: 900,
    screenshot_uri: '',
    content_hash: 'sha256:one',
    dom_hash: 'sha256:dom-one',
    rendered_at: '2026-10-04T12:00:00.000Z',
    renderer_version: 'stub 1.0',
    sections: [{ id: 's1', top: 0, height: 420, type: 'hero', words: 14 }],
    elements: [{ selector: 'button.atc', section_id: 's1', dom_order: 0, x: 600, y: 800, w: 220, h: 56 }],
    ...over,
  });

  it('a second completeCapture with a changed content_hash writes one content_drift row', async () => {
    const { adapter, snapshot } = createMemoryAePersistence();
    const page = { idsite: 1, idsitehsr: 2, url: 'https://x.com/', capturedOn: '2026-10-04' };
    await adapter.completeCapture({ ...page, bindings: [], renders: [render()] });
    expect(snapshot().changeLog).toHaveLength(0);

    await adapter.completeCapture({
      ...page,
      capturedOn: '2026-10-04',
      bindings: [],
      renders: [render({ content_hash: 'sha256:two', rendered_at: '2026-10-04T13:00:00.000Z' })],
    });
    const drift = snapshot().changeLog;
    expect(drift).toHaveLength(1);
    expect(drift[0].change_kind).toBe('content_drift');
    expect(drift[0].change_id).toBe('render_drift:2:desktop:sha256:two');
    expect(drift[0].source).toBe('render_diff');
    expect(drift[0].subject).toBe('https://x.com/');
    expect(JSON.parse(drift[0].detail)).toEqual({
      old_hash: 'sha256:one',
      new_hash: 'sha256:two',
      device_class: 'desktop',
    });

    // the same hash again is not drift; the row count holds
    await adapter.completeCapture({
      ...page,
      capturedOn: '2026-10-04',
      bindings: [],
      renders: [render({ content_hash: 'sha256:two', rendered_at: '2026-10-04T14:00:00.000Z' })],
    });
    expect(snapshot().changeLog).toHaveLength(1);
  });
});
