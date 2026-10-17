import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadCatalog } from '../../src/catalog/index.js';
import { loadProfiles } from '../../src/composition/registries.js';
import { parseProfile, PROFILE_STEPS, ProfileError, profileFingerprint, profilesById } from '../../src/domain/profile.js';
import { STEPS } from '../../src/site-analysis/steps.js';

const CATALOGS = Object.keys(loadCatalog().strategies);
const PAGE_STEPS = ['qualify', 'capture-gate', 'page-datasets', 'descriptors', 'site-datasets', 'analysis'];
const base = {
  id: 'pdp',
  subject_type: 'page',
  label: 'Product detail pages',
  selector: { use: 'page-by-kind', criteria: { kinds: ['product'] } },
  datasets: { include: ['provides'], exclude: [] },
  catalogs: ['PI'],
  steps: PAGE_STEPS,
};
const parse = (overrides) => parseProfile({ ...base, ...overrides }, { file: 'pdp.profile.json', catalogIds: CATALOGS });
const dirs = [];

afterEach(async () => {
  while (dirs.length > 0) await rm(dirs.pop(), { recursive: true, force: true });
});

describe('execution profiles', () => {
  it('loads the shipped profiles', async () => {
    const profiles = await loadProfiles(path.resolve('profiles'), CATALOGS);
    expect([...profiles.keys()]).toEqual(['collection', 'experiment', 'funnel', 'journey', 'lp', 'pdp', 'quiz']);
    const lp = profiles.get('lp');
    expect(lp).toMatchObject({ subjectType: 'page', selector: null, catalogs: ['LP', 'PG', 'PI', 'PO', 'TD', 'TG', 'TI'], steps: PAGE_STEPS });
    expect(Object.isFrozen(lp.steps)).toBe(true);
    expect(profiles.get('pdp').selector).toEqual({ use: 'page-by-kind', criteria: { kinds: ['product'], minEntrySessions: 100 } });
  });

  it('names every problem with a profile', () => {
    const problems = (overrides) => {
      try {
        parse(overrides);
        return [];
      } catch (err) {
        expect(err).toBeInstanceOf(ProfileError);
        return err.errors;
      }
    };
    expect(problems({ id: 'Bad_Id' })).toEqual(['id must be kebab-case']);
    expect(problems({ subject_type: 'widget' })[0]).toMatch(/^subject_type must be one of page, quiz, experiment/);
    expect(problems({ catalogs: ['PI', 'ZZ'] })[0]).toMatch(/^unknown catalogs ZZ; loaded: /);
    expect(problems({ steps: ['qualify', 'bake'] })[0]).toMatch(/^unknown step "bake"; steps: qualify, capture-gate/);
    expect(problems({ steps: ['qualify', 'page-datasets'] })).toEqual(['step "page-datasets" runs after "capture-gate"']);
    expect(problems({ steps: ['site-datasets', 'qualify'] })).toEqual(['step "qualify" runs before "site-datasets"']);
    expect(problems({ steps: ['site-datasets', 'site-datasets'] })).toEqual(['step "site-datasets" appears twice']);
    expect(problems({ subject_type: 'experiment', steps: ['qualify', 'analysis'] })).toEqual([
      'subject_type experiment needs the "select-subjects" step',
      'step "qualify" needs page subjects; subject_type is experiment',
    ]);
    expect(problems({ steps: ['qualify', 'select-subjects', 'analysis'] }))
      .toEqual(['step "select-subjects" needs subjects other than pages; subject_type is page']);
    expect(problems({ subject_type: 'experiment', steps: ['subject-datasets', 'select-subjects'] })).toEqual([
      'step "subject-datasets" runs after "select-subjects"',
      'step "select-subjects" runs before "subject-datasets"',
    ]);
    expect(problems({ subject_type: 'experiment', steps: ['select-subjects', 'subject-datasets', 'site-datasets', 'analysis'] })).toEqual([]);
    expect(problems({ datasets: { include: ['provides', 'coverage'] } })).toEqual(['datasets.include is ["provides"] alone or explicit ids']);
    expect(problems({ selector: { use: 'page-by-kind', limit: 3 } })).toEqual(['selector: unknown field "limit"']);
    expect(problems({ owner: 'me' })).toEqual(['unknown field "owner"']);
  });

  it('refuses a duplicate id and a file named for another id', () => {
    const documents = [{ file: 'p/pdp.profile.json', raw: base }, { file: 'q/pdp.profile.json', raw: base }];
    expect(() => profilesById(documents, CATALOGS)).toThrow(/q\/pdp.profile.json: duplicate profile id "pdp"/);
    expect(() => profilesById([{ file: 'p/item.profile.json', raw: base }], CATALOGS)).toThrow(/id "pdp" differs from the file name "item"/);
  });

  it('names the file of a profile that is not JSON', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'profiles-'));
    dirs.push(dir);
    await writeFile(path.join(dir, 'pdp.profile.json'), '{ "id": ');
    await expect(loadProfiles(dir, CATALOGS)).rejects.toThrow(/pdp\.profile\.json: /);
  });

  it('fingerprints a profile so an edit shows', () => {
    expect(profileFingerprint(parse({}))).toBe(profileFingerprint(parse({})));
    expect(profileFingerprint(parse({ catalogs: ['PG'] }))).not.toBe(profileFingerprint(parse({})));
  });

  it('runs a handler for every step a profile may name', () => {
    expect(Object.keys(STEPS)).toEqual(Object.keys(PROFILE_STEPS));
  });
});
