// Architecture rule (R0.2): no site data (absolute /Users/ or /tmp/ paths,
// known client domains, numeric idsite literals) may appear in src/, py/,
// bin/, or scripts/ — today's hits live in allowlists.json and must shrink,
// never grow.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { counts, hitKey, siteLiteralHits } from './_scan.js';

const allowlistPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'allowlists.json');
const allowlist = JSON.parse(fs.readFileSync(allowlistPath, 'utf8'))['no-site-literals'];

const fmt = (h) => `${h.file}:${h.line} [${h.rule}] ${h.snippet}`;

describe('no site literals outside the allowlist', () => {
  it('fails when a new hard-code appears', () => {
    const allowed = counts(allowlist);
    const seen = new Map();
    const fresh = siteLiteralHits().filter((h) => {
      const key = hitKey(h);
      seen.set(key, (seen.get(key) ?? 0) + 1);
      return seen.get(key) > (allowed.get(key) ?? 0);
    });
    expect(
      fresh.map(fmt),
      'new site literals found; remove them or, if truly pre-existing, add them to test/architecture/allowlists.json',
    ).toEqual([]);
  });

  it('fails on stale allowlist entries (delete them as refactors land)', () => {
    const current = counts(siteLiteralHits());
    const seen = new Map();
    const stale = allowlist.filter((e) => {
      const key = hitKey(e);
      seen.set(key, (seen.get(key) ?? 0) + 1);
      return seen.get(key) > (current.get(key) ?? 0);
    });
    expect(stale.map(fmt), 'allowlist entries no longer match; delete them').toEqual([]);
  });
});
