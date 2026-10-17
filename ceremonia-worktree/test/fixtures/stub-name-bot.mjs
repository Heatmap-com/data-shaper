// Stub naming bot for tests: writes a fixture names.json into the dataset
// root at the path the consumer resolves. Usage:
//   NAMING_STUB_ROOT=<datasetRoot> node stub-name-bot.mjs <url> <idsite>
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const [url, idsite] = process.argv.slice(2);
const root = process.env.NAMING_STUB_ROOT;
if (!root || !url || !idsite) {
  console.error('NAMING_STUB_ROOT, url, and idsite are required');
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
writeFileSync(
  path.join(dir, 'names.json'),
  JSON.stringify([
    { name: 'Hamburger Menu Button', type: 'page', selector: 'header > button.menu', rollup: false, attention: false, tags: '', notes: '', linkClass: '' },
    { name: 'Primary Nav Item - Shop', type: 'page', selector: 'header nav a.shop', rollup: false, attention: false, tags: '', notes: '', linkClass: '' },
    { name: 'Section - Footer', type: 'site', selector: 'footer', rollup: false, attention: false, tags: '', notes: '', linkClass: '' },
  ]),
);
console.log(`stub bot wrote names.json for ${url}`);
