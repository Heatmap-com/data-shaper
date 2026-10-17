// bundle-build.py on a site that names its own calendar and reading notes in
// site.json: the recorded Sayii extract, copied to a temp dir with periods and
// readingNotes added to its meta.json. Skipped when python3 with pandas/numpy
// is unavailable.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sitePeriods } from '../py/bundle-export.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureDir = path.join(root, 'test/fixtures/bundle/sayii-raw');

function pythonAvailable() {
  try {
    execFileSync('python3', ['-c', 'import pandas, numpy'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!pythonAvailable())('bundle-build with a site calendar', () => {
  let work;
  let profile;
  let guide;
  let tables;

  beforeAll(() => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-calendar-'));
    const extract = path.join(work, 'extract');
    fs.cpSync(fixtureDir, extract, { recursive: true });
    const meta = JSON.parse(fs.readFileSync(path.join(extract, 'meta.json'), 'utf8'));
    meta.periods = sitePeriods(
      [
        { name: 'pre', end: '2026-09-12' },
        { name: 'full', end: '2026-09-26', baseline: true, about: 'Full price.' },
        { name: 'promo', end: '2026-10-04', about: 'Site-wide sale.' },
        { name: 'post' },
      ],
      meta,
    );
    meta.readingNotes = { profile: ['Amounts include tax.'], notIncluded: ['The wholesale store.'] };
    fs.writeFileSync(path.join(extract, 'meta.json'), JSON.stringify(meta));
    const out = path.join(work, 'full');
    execFileSync('python3', ['py/bundle-build.py', extract, out], { cwd: root, stdio: 'pipe' });
    profile = JSON.parse(fs.readFileSync(path.join(out, '00_site_profile.json'), 'utf8'));
    guide = fs.readFileSync(path.join(out, '00_README_data_guide.md'), 'utf8');
    tables = fs
      .readdirSync(out)
      .filter((f) => f.endsWith('.txt'))
      .map((f) => fs.readFileSync(path.join(out, f), 'utf8'))
      .join('\n');
  }, 300_000);

  afterAll(() => {
    if (work) fs.rmSync(work, { recursive: true, force: true });
  });

  it('the profile names the site periods and its reading notes', () => {
    expect(profile.periods).toMatchObject({
      pre: '2026-08-30 to 2026-09-12',
      full: '2026-09-13 to 2026-09-26',
      promo: '2026-09-27 to 2026-10-04',
      post: '2026-10-05 to 2026-10-12',
    });
    expect(profile.reading_notes).toContain('Periods follow the site calendar: pre, full, promo, post. marked_down uses full as the price baseline.');
    expect(profile.reading_notes.at(-1)).toBe('Amounts include tax.');
  });

  it('the guide lists each period, the baseline, and what is not included', () => {
    expect(guide).toContain('- **full:** 2026-09-13 through 2026-09-26. Full price. Markdown detection uses this period as the price baseline.\n');
    expect(guide).toContain('- **promo:** 2026-09-27 through 2026-10-04. Site-wide sale.\n');
    expect(guide).toContain('- Markdown flags use the full period of the site calendar as the price baseline.\n');
    expect(guide).toContain('- The wholesale store.\n');
  });

  it('visit tables carry the site period names', () => {
    const cohorts = tables.match(/^=== TABLE: visit_cohorts ===\n[\s\S]*?^--- END CSV ---$/m)[0];
    expect(cohorts).toContain('overlaps full or promo or post.');
    const periods = new Set(cohorts.split('--- BEGIN CSV ---\n')[1].split('\n').slice(1).filter((l) => l && !l.startsWith('@@') && !l.startsWith('---')).map((l) => l.split(',')[2]));
    expect([...periods].sort()).toEqual(['full', 'peak', 'post', 'pre', 'promo']);
  });
});
