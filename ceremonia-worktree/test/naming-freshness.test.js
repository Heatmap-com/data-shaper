import { describe, expect, it } from 'vitest';
import { isNamingFresh } from '../src/domain/naming-freshness.js';
import { TAXONOMY_VERSION } from '../src/domain/taxonomy.js';

describe('isNamingFresh', () => {
  it('accepts a complete record on the current taxonomy inside 14 days', () => {
    expect(
      isNamingFresh({ status: 'complete', taxonomyVersion: TAXONOMY_VERSION, namedOn: '2026-09-25' }, '2026-10-03').fresh,
    ).toBe(true);
  });

  it('rejects a missing record, an old record, and a previous taxonomy', () => {
    expect(isNamingFresh(null, '2026-10-03').fresh).toBe(false);
    expect(
      isNamingFresh({ status: 'complete', taxonomyVersion: TAXONOMY_VERSION, namedOn: '2026-09-01' }, '2026-10-03').reason,
    ).toMatch(/days old/);
    expect(
      isNamingFresh({ status: 'complete', taxonomyVersion: '2026-01-01', namedOn: '2026-10-02' }, '2026-10-03').reason,
    ).toMatch(/taxonomy/);
  });
});