import { describe, expect, it } from 'vitest';
import { normalizeRenderArtifact, summarizeArtifact, validateRenderArtifact } from '../src/capture-artifact.js';

/**
 * Render artifact validation (data-capture-plan.md §9.3 / §13): the recorded
 * artifact shape validates; the binding contract (every bound selector is in
 * elements), box bounds with the -1 px clipping tolerance, and hash presence
 * each throw a precise message on the first violation. Device-file handling
 * (missing / unparseable) is the consumer's job — see capture-consumer.test.js.
 */

/** The §9.3 example artifact, recorded. */
function goodArtifact(over = {}) {
  return {
    url: 'https://store.example/products/scout',
    device_class: 'mobile',
    viewport: { w: 390, h: 844 },
    page_height_px: 9120,
    fold_px: 844,
    rendered_at: '2026-10-04T12:00:00.000Z',
    renderer_version: 'cnn-ai-bot 2.4.0',
    content_hash: 'sha256:contentaaa',
    dom_hash: 'sha256:domaaa',
    screenshot: 'screenshot.mobile.png',
    sections: [
      { id: 's1', selector: '#hero', top: 0, height: 820, type: 'hero', words: 31 },
      { id: 's3', selector: '#reviews', top: 1688, height: 1210, type: 'reviews_block', words: 412 },
    ],
    elements: [
      {
        selector: '#buy',
        section_id: 's1',
        dom_order: 41,
        x: 16,
        y: 420,
        w: 358,
        h: 48,
        is_control: true,
        looks_clickable: true,
        sticky: false,
        visual_class: 'control',
        image_type: '',
        words: 3,
      },
      {
        selector: '#reviews .item:first-child',
        section_id: 's3',
        dom_order: 42,
        x: 16,
        y: 1720,
        w: 358,
        h: 96,
        is_control: false,
        looks_clickable: false,
        sticky: false,
        visual_class: 'text',
        image_type: '',
        words: 58,
      },
    ],
    ...over,
  };
}

const BINDINGS = [
  { selector: '#buy', element_class: 'offer_add_to_cart', name: 'Buy' },
  { selector: '#reviews .item:first-child', element_class: 'review_item', name: 'First review' },
];

describe('validateRenderArtifact', () => {
  it('validates the recorded good artifact for each device class', () => {
    expect(() => validateRenderArtifact(goodArtifact(), BINDINGS)).not.toThrow();
    expect(() =>
      validateRenderArtifact(
        goodArtifact({
          device_class: 'desktop',
          viewport: { w: 1440, h: 900 },
          fold_px: 900,
          screenshot: 'screenshot.desktop.png',
        }),
        BINDINGS,
      ),
    ).not.toThrow();
    // naming-only jobs bind nothing: [] bindings always satisfy the contract
    expect(() => validateRenderArtifact(goodArtifact(), [])).not.toThrow();
  });

  it('accepts an off-canvas box origin', () => {
    expect(() =>
      validateRenderArtifact(
        goodArtifact({ elements: [{ selector: '#buy', x: -2400, y: -40, w: 358, h: 48 }] }),
        [{ selector: '#buy' }],
      ),
    ).not.toThrow();
  });

  it('throws on a negative box size', () => {
    expect(() =>
      validateRenderArtifact(
        goodArtifact({ elements: [{ selector: '#buy', x: 0, y: 0, w: -10, h: 48 }] }),
        [{ selector: '#buy' }],
      ),
    ).toThrow(/elements\[0\] box w\/h must be >= 0/);
    expect(() =>
      validateRenderArtifact(
        goodArtifact({ elements: [{ selector: '#buy', x: 0, y: 0, w: 358, h: -1 }] }),
        [{ selector: '#buy' }],
      ),
    ).toThrow(/elements\[0\] box w\/h must be >= 0/);
  });

  it('throws when a bound selector is not among elements, naming the selector', () => {
    expect(() =>
      validateRenderArtifact(goodArtifact(), [{ selector: '#nav a.hidden' }]),
    ).toThrow(/bound selector "#nav a\.hidden" is not among elements\[\] selectors/);
  });

  it('throws on a missing or empty hash', () => {
    expect(() => validateRenderArtifact(goodArtifact({ content_hash: '' }), BINDINGS)).toThrow(
      /missing required field "content_hash"/,
    );
    expect(() => validateRenderArtifact(goodArtifact({ content_hash: '   ' }), BINDINGS)).toThrow(
      /"content_hash" must be a non-empty string/,
    );
    expect(() => validateRenderArtifact(goodArtifact({ dom_hash: undefined }), BINDINGS)).toThrow(
      /missing required field "dom_hash"/,
    );
  });

  it('throws on each missing required top field', () => {
    for (const field of [
      'url',
      'device_class',
      'viewport',
      'page_height_px',
      'fold_px',
      'rendered_at',
      'renderer_version',
      'content_hash',
      'dom_hash',
    ]) {
      const artifact = goodArtifact();
      delete artifact[field];
      expect(() => validateRenderArtifact(artifact, BINDINGS), field).toThrow(
        new RegExp(`"${field}"`),
      );
    }
  });

  it('rejects a non-positive viewport', () => {
    expect(() => validateRenderArtifact(goodArtifact({ viewport: { w: 0, h: 844 } }), BINDINGS)).toThrow(
      /"viewport\.w"/,
    );
    expect(() => validateRenderArtifact(goodArtifact({ viewport: { w: 390 } }), BINDINGS)).toThrow(
      /"viewport\.h" must be a number/,
    );
  });

  it('validates section geometry', () => {
    expect(() =>
      validateRenderArtifact(goodArtifact({ sections: [{ id: 's1', top: -5, height: 100 }] }), BINDINGS),
    ).toThrow(/sections\[0\]\.top must be a number >= 0/);
    expect(() =>
      validateRenderArtifact(goodArtifact({ sections: [{ id: 's1', top: 0, height: -1 }] }), BINDINGS),
    ).toThrow(/sections\[0\]\.height must be a number >= 0/);
    expect(() =>
      validateRenderArtifact(goodArtifact({ sections: [{ top: 0, height: 100 }] }), BINDINGS),
    ).toThrow(/sections\[0\]\.id/);
    // selector is optional on sections
    expect(() =>
      validateRenderArtifact(goodArtifact({ sections: [{ id: 's1', top: 0, height: 100 }] }), BINDINGS),
    ).not.toThrow();
  });

  it('throws on the first violation with a precise message', () => {
    const artifact = goodArtifact({ content_hash: '', elements: [{ selector: '', x: -99, y: 0, w: 1, h: 1 }] });
    expect(() => validateRenderArtifact(artifact, [])).toThrow(/"content_hash"/);
  });
});

describe('normalizeRenderArtifact', () => {
  it('flattens the naming bot viewport, screenshot, and box geometry', () => {
    const normalized = normalizeRenderArtifact({
      url: 'https://dvf.com',
      device_class: 'desktop',
      viewport: { width: 1440, height: 900 },
      page_height_px: 4000,
      fold_px: 900,
      rendered_at: '2026-10-10T12:00:00.000Z',
      renderer_version: 'cnn-ai-bot',
      content_hash: 'sha256:content',
      dom_hash: 'sha256:dom',
      screenshot_file: 'screenshot.desktop.png',
      sections: [{ id: 's1', type: 'hero', heading: 'Hero', top: 0, height: 800 }],
      elements: [
        {
          selector: '#buy',
          name: 'Buy',
          box: { x: 16, y: 420, width: 200, height: 48 },
          box_status: 'visible',
          is_control: true,
          looks_clickable: true,
          sticky: false,
          word_count: 2,
          in_first_viewport: true,
        },
        {
          selector: '#gone',
          name: 'Gone',
          box: null,
          box_status: 'missing',
          is_control: false,
          looks_clickable: false,
          sticky: false,
          word_count: 0,
          in_first_viewport: false,
        },
      ],
    });
    expect(() =>
      validateRenderArtifact(normalized, [
        { selector: '#buy' },
        { selector: '#gone' },
      ]),
    ).not.toThrow();
    expect(normalized.viewport).toMatchObject({ w: 1440, h: 900 });
    expect(normalized.screenshot).toBe('screenshot.desktop.png');
    expect(normalized.elements[0]).toMatchObject({ x: 16, y: 420, w: 200, h: 48, words: 2, in_first_viewport: true });
    expect(normalized.elements[1]).toMatchObject({ x: 0, y: 0, w: 0, h: 0, words: 0, in_first_viewport: false });
  });
});

describe('summarizeArtifact', () => {
  it('counts sections, elements, and collects selectors for coverage', () => {
    const summary = summarizeArtifact(goodArtifact());
    expect(summary.sections_found).toBe(2);
    expect(summary.elements_found).toBe(2);
    expect(summary.selectors).toEqual(['#buy', '#reviews .item:first-child']);
  });

  it('tolerates missing arrays', () => {
    expect(summarizeArtifact({})).toEqual({ sections_found: 0, elements_found: 0, selectors: [] });
  });
});
