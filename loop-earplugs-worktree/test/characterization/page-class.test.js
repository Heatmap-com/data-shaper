// Characterization baseline (R0.1): pageType output for a fixed URL set is
// pinned in test/fixtures/bundle/page-class.snapshot.json. The set covers the
// Shopify classes (home, product, collection, cart, search, content, checkout,
// account) plus branch boundaries: bare domains, queries, fragments, uppercase
// paths, prefix collisions (/accounting, /blog), and cart/checkout overlap.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pageType } from '../../src/page-type.js';

const fixturePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../fixtures/bundle/page-class.snapshot.json',
);
const snapshot = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

describe('pageType classification (characterization)', () => {
  it('every recorded URL still classifies the same', () => {
    const regenerated = {};
    for (const url of Object.keys(snapshot)) regenerated[url] = pageType(url);
    expect(regenerated).toEqual(snapshot);
  });

  it('the snapshot covers the expected URL count', () => {
    expect(Object.keys(snapshot).length).toBe(46);
  });
});
