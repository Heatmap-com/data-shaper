import { PROFILE_STEPS } from '../domain/profile.js';
import { captureGate, collectDatasets, createSiteState, draftDescriptors, qualify, selectSubjects, writeAnalysis } from './handlers.js';

/** The landing-page profile's steps: the handlers in their stage order. */
export const LP_STEPS = Object.freeze(['qualify', 'capture-gate', 'page-datasets', 'descriptors', 'site-datasets', 'analysis']);

/**
 * @typedef {Object} SiteRun
 * @property {import('./handlers.js').HandlerInput} base site, window, deps, and state
 * @property {import('./handlers.js').AnalysisPage[]} pages
 * @property {'running' | 'skipped' | 'awaitingCapture' | 'analyzed'} outcome
 * @property {number} pagesAnalyzed
 */

/**
 * Each profile step as a handler call over the site's run. A step that
 * stops the site sets `outcome`; the steps after it do not run.
 * @type {Record<string, (run: SiteRun) => Promise<void>>}
 */
export const STEPS = Object.freeze({
  async qualify(run) {
    const result = await qualify(run.base);
    if (result.facts.outcome !== 'qualified') {
      run.outcome = 'skipped';
      return;
    }
    run.base = { ...run.base, site: { ...run.base.site, qualification: result.facts.qualification } };
    run.pages = result.facts.pages;
  },
  async 'capture-gate'(run) {
    const gate = await captureGate({ ...run.base, pages: run.pages });
    if (gate.facts.outcome !== 'ready') {
      run.outcome = 'awaitingCapture';
      return;
    }
    run.pages = gate.facts.pages;
  },
  async 'page-datasets'(run) {
    await collectDatasets({ ...run.base, pages: run.pages, scope: 'page' });
  },
  async descriptors(run) {
    await draftDescriptors({ ...run.base, pages: run.pages });
  },
  async 'select-subjects'(run) {
    const result = await selectSubjects(run.base);
    if (result.facts.outcome !== 'selected') run.outcome = 'skipped';
  },
  async 'subject-datasets'(run) {
    await collectDatasets({ ...run.base, scope: 'subject' });
  },
  async 'site-datasets'(run) {
    await collectDatasets({ ...run.base, pages: run.pages, scope: 'site' });
  },
  async analysis(run) {
    const written = await writeAnalysis({ ...run.base, pages: run.pages });
    run.pagesAnalyzed = written.facts.pagesAnalyzed;
    run.outcome = 'analyzed';
  },
});

const unregistered = Object.keys(PROFILE_STEPS).filter((name) => !STEPS[name]);
if (unregistered.length > 0) throw new Error(`profile steps without a handler: ${unregistered.join(', ')}`);

/**
 * One site through the steps, in order, on one in-memory state.
 * @param {string[]} steps
 * @param {{site: object, window: object, deps: object}} input
 * @returns {Promise<SiteRun>}
 */
export async function runSiteSteps(steps, { site, window, deps }) {
  /** @type {SiteRun} */
  const run = { base: { site, window, deps, state: createSiteState() }, pages: [], outcome: 'running', pagesAnalyzed: 0 };
  for (const step of steps) {
    await STEPS[step](run);
    if (run.outcome !== 'running' && run.outcome !== 'analyzed') break;
  }
  return run;
}
