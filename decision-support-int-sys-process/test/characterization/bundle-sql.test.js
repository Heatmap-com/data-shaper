// Characterization baseline (R0.1): the exact SQL text each builder emits for
// every bundle site is pinned in test/fixtures/bundle/bundle-sql.snapshot.json.
// Sites come from orchestration/sites/<slug>/site.json and their recorded
// windows from test/fixtures/bundle/windows.json.
// A change to this fixture is a reviewed behaviour change, not a refactor.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  exportSpec,
  visitSql,
  ordersSql,
  pagePeriodSql,
  hvSql,
  pipelineSql,
  triggerSql,
  dwellSql,
  rageTotalsSql,
} from '../../py/bundle-export.mjs';

const fixturePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../fixtures/bundle/bundle-sql.snapshot.json',
);
const snapshot = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
const windows = JSON.parse(fs.readFileSync(path.join(path.dirname(fixturePath), 'windows.json'), 'utf8'));
const sitesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../orchestration/sites');
const SITES = Object.entries(windows).map(([slug, window]) =>
  exportSpec(JSON.parse(fs.readFileSync(path.join(sitesDir, slug, 'site.json'), 'utf8')), window),
);

function regenerate() {
  const out = {};
  for (const site of SITES) {
    out[site.slug] = {
      visitSql: visitSql(site),
      ordersSql: ordersSql(site),
      pagePeriodSql: pagePeriodSql(site),
      'hvSql(hv=100)': hvSql(site, 100),
      pipelineSql: pipelineSql(site),
      triggerSql: triggerSql(site),
      dwellSql: dwellSql(site),
      rageTotalsSql: rageTotalsSql(site),
    };
  }
  return out;
}

describe('bundle-export SQL builders (characterization)', () => {
  it('regenerated SQL matches the recorded snapshot for every site and builder', () => {
    expect(regenerate()).toEqual(snapshot);
  });

  it('the snapshot covers every bundle site with every builder', () => {
    expect(Object.keys(snapshot).sort()).toEqual(SITES.map((s) => s.slug).sort());
    for (const site of SITES) {
      expect(Object.keys(snapshot[site.slug]).sort()).toEqual(
        [
          'visitSql',
          'ordersSql',
          'pagePeriodSql',
          'hvSql(hv=100)',
          'pipelineSql',
          'triggerSql',
          'dwellSql',
          'rageTotalsSql',
        ].sort(),
      );
    }
  });
});
