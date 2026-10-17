// Stub capture bot for tests: writes names.json, render.<device>.json and
// screenshots into the dataset root at the path the consumer resolves.
// Usage:
//   CAPTURE_STUB_ROOT=<datasetRoot> node stub-capture-bot.mjs <url> <idsite>
// Env switches for failure paths:
//   CAPTURE_STUB_BAD_BOX=mobile        the mobile artifact carries a negative box
//   CAPTURE_STUB_OMIT_RENDER=desktop   skip that device's render file
//   CAPTURE_STUB_GARBAGE_RENDER=mobile write unparseable JSON for that device
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const [url, idsite] = process.argv.slice(2);
const root = process.env.CAPTURE_STUB_ROOT;
if (!root || !url || !idsite) {
  console.error('CAPTURE_STUB_ROOT, url, and idsite are required');
  process.exit(1);
}

let pathname;
try {
  pathname = new URL(url).pathname;
} catch {
  pathname = '/';
}
const segments = pathname.split('/').filter((s) => s.length > 0);
const slug = segments.length > 0 ? segments[segments.length - 1].toLowerCase() : 'index';
const dir = path.join(root, idsite, 'landing', slug);
mkdirSync(dir, { recursive: true });

writeNameRows();
for (const device of ['desktop', 'mobile']) {
  if (process.env.CAPTURE_STUB_OMIT_RENDER === device) continue;
  writeRender(device);
  writeFileSync(path.join(dir, `screenshot.${device}.png`), `png-bytes-${device}`);
}
console.log(`stub capture bot wrote artifacts for ${url}`);

function writeNameRows() {
  writeFileSync(
    path.join(dir, 'names.json'),
    JSON.stringify([
      { name: 'Hamburger Menu Button', type: 'page', selector: 'header > button.menu', rollup: false, attention: false, tags: '', notes: '', linkClass: '' },
      { name: 'Primary Nav Item - Shop', type: 'page', selector: 'header nav a.shop', rollup: false, attention: false, tags: '', notes: '', linkClass: '' },
      { name: 'Add to Cart Button', type: 'page', selector: 'button.atc', rollup: false, attention: false, tags: '', notes: '', linkClass: '' },
    ]),
  );
}

function writeRender(device) {
  if (process.env.CAPTURE_STUB_GARBAGE_RENDER === device) {
    writeFileSync(path.join(dir, `render.${device}.json`), '{ not json');
    return;
  }
  const mobile = device === 'mobile';
  const badBox = process.env.CAPTURE_STUB_BAD_BOX === device;
  const artifact = {
    url,
    device_class: device,
    viewport: mobile ? { w: 390, h: 844 } : { w: 1440, h: 900 },
    page_height_px: mobile ? 9120 : 3200,
    fold_px: mobile ? 844 : 900,
    rendered_at: '2026-10-04T12:00:00.000Z',
    renderer_version: 'stub-capture-bot 1.0',
    content_hash: `sha256:${device}-1`,
    dom_hash: `sha256:${device}-dom-1`,
    screenshot: `screenshot.${device}.png`,
    sections: [{ id: 's1', selector: 'header', top: 0, height: mobile ? 640 : 420, type: 'hero', words: 14 }],
    elements: [
      {
        selector: 'header > button.menu',
        section_id: 's1',
        dom_order: 0,
        x: mobile ? 16 : 24,
        y: mobile ? 16 : 24,
        w: badBox ? -1 : mobile ? 32 : 40,
        h: mobile ? 32 : 40,
        is_control: true,
        looks_clickable: true,
        sticky: false,
        visual_class: 'control',
        image_type: '',
        words: 0,
      },
      {
        selector: 'header nav a.shop',
        section_id: 's1',
        dom_order: 1,
        x: mobile ? 64 : 120,
        y: mobile ? 20 : 30,
        w: mobile ? 60 : 80,
        h: 24,
        is_control: false,
        looks_clickable: false,
        sticky: false,
        visual_class: 'text',
        image_type: '',
        words: 1,
      },
      {
        selector: 'button.atc',
        section_id: 's1',
        dom_order: 2,
        x: mobile ? 16 : 600,
        y: mobile ? 420 : 800,
        w: mobile ? 358 : 220,
        h: 56,
        is_control: true,
        looks_clickable: true,
        sticky: false,
        visual_class: 'control',
        image_type: '',
        words: 3,
      },
    ],
  };
  writeFileSync(path.join(dir, `render.${device}.json`), JSON.stringify(artifact));
}
