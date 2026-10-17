import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createRunResolver } from '../../src/orchestrator/application/resolve-run.js';
import { createFsDescriptorSource } from '../../src/orchestrator/adapters/descriptors/fs.js';
import { renderValues } from '../../src/orchestrator/domain/template.js';

/**
 * Each analysis profile has a general run: the page profiles over the full
 * run, and the non-page profiles as the analysis stage alone. The analysis
 * stage passes the profile, its criteria, the site, and the job window to
 * the analysis command.
 */

const root = path.join(import.meta.dirname, '../../orchestration');
const descriptors = createFsDescriptorSource({ root });
const resolver = createRunResolver({ descriptors });
const site = { slug: 'fixture', domain: 'fixture.example', origin: 'https://fixture.example', idsite: 4879 };
const ids = ({ run }) => run.stages.map((stage) => stage.id);
const analysis = ({ run }) => run.stages.find((stage) => stage.id === 'analysis');

describe('profile runs', () => {
  it('runs a page profile through naming, analysis, the bundles, and the site opportunity report', async () => {
    for (const profile of ['pdp', 'collection', 'quiz']) {
      const resolved = await resolver.resolve({ site, ref: `general:${profile}-full` });
      expect(ids(resolved)).toEqual(['naming', 'analysis', 'bundle', 'bundle-4mb', 'chart-render', 'site-opportunity-report', 'style-pdf']);
      expect(analysis(resolved).params).toEqual({ profile, select: {} });
    }
  });

  it('runs a non-page profile as the analysis stage alone', async () => {
    for (const profile of ['experiment', 'funnel', 'journey']) {
      const resolved = await resolver.resolve({ site, ref: `general:${profile}` });
      expect(ids(resolved)).toEqual(['analysis']);
      expect(analysis(resolved).params).toEqual({ profile, select: {} });
    }
  });

  it('renders the analysis command over the profile, criteria, site, and window', async () => {
    const stage = JSON.parse(await readFile(path.join(root, 'stages', 'analysis.stage.json'), 'utf8'));
    const values = {
      stage: { params: { ...stage.params, profile: 'funnel', select: { funnel: 'checkout' } } },
      site: { idsite: 4879 },
      window: { start: '2026-09-14', end: '2026-10-13' },
      run: { dir: '/runs/j1/analysis/1' },
    };
    const args = stage.handler.args.map((arg) => renderValues(arg, values));
    expect(stage.handler.command).toBe('node');
    expect(args).toEqual([
      'bin/analyze-site.mjs', '--profile', 'funnel', '--select', JSON.stringify({ funnel: 'checkout' }, null, 2),
      '--idsite', '4879', '--window-start', '2026-09-14', '--window-end', '2026-10-13', '--batch-file', '/runs/j1/analysis/1/batch.json',
    ]);
    expect(renderValues(stage.check.batchFile, values)).toBe('/runs/j1/analysis/1/batch.json');
    expect(stage.resources).toEqual(['clickhouse-heavy']);
  });
});
