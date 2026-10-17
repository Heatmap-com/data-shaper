// Architecture rule (R0.2): process.env only in composition roots (adapters are
// not exempt); adapters/persistence/* only from adapters/ or composition;
// @clickhouse/client only from adapters/persistence/ or composition, across
// src/, py/, and scripts/. Today's hits live in allowlists.json. A copied
// line needs its own entry, so the count must not grow.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compositionHits, counts, hitKey } from './_scan.js';

const allowlistPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'allowlists.json');
const allowlist = JSON.parse(fs.readFileSync(allowlistPath, 'utf8'))['composition-only'];

const fmt = (h) => `${h.file}:${h.line} [${h.rule}] ${h.snippet}`;

describe('composition-only env and persistence access', () => {
  it('fails when a module outside composition reads process.env or imports adapters/persistence', () => {
    const allowed = counts(allowlist);
    const seen = new Map();
    const fresh = compositionHits().filter((h) => {
      const key = hitKey(h);
      seen.set(key, (seen.get(key) ?? 0) + 1);
      return seen.get(key) > (allowed.get(key) ?? 0);
    });
    expect(
      fresh.map(fmt),
      'new composition violations found; move the access to a composition root or allowlist a pre-existing hit',
    ).toEqual([]);
  });

  it('fails on stale allowlist entries (delete them as refactors land)', () => {
    const current = counts(compositionHits());
    const seen = new Map();
    const stale = allowlist.filter((e) => {
      const key = hitKey(e);
      seen.set(key, (seen.get(key) ?? 0) + 1);
      return seen.get(key) > (current.get(key) ?? 0);
    });
    expect(stale.map(fmt), 'allowlist entries no longer match; delete them').toEqual([]);
  });
});
