import path from 'node:path';
import { NotFoundError, OrchestratorError } from '../domain/errors.js';
import { createJob, windowFor } from '../domain/job.js';
import { resolvePages } from '../domain/pages.js';

const PLACEHOLDER = { slug: 'general', domain: 'example.com', origin: 'https://example.com/' };

/**
 * Resolves and validates every run file for every site (or one site), as a
 * job would be validated at enqueue. Throws with every problem at once.
 */
export function createLibraryValidator({ descriptors, resolver, validator, clock }) {
  return async function validateLibrary({ site: selector } = {}) {
    const problems = [];
    try {
      await descriptors.resilience();
    } catch (err) {
      problems.push(err.message);
    }
    for (const id of await descriptors.stageIds()) {
      try {
        await descriptors.stage(id);
      } catch (err) {
        problems.push(`stage ${id}: ${err.message}`);
      }
    }
    let sites = await descriptors.sites();
    if (selector) sites = sites.filter((site) => site.slug === selector || site.domain === selector);
    if (!sites.length) {
      if (selector) throw new NotFoundError(`no site "${selector}"`);
      sites = [PLACEHOLDER];
    }
    let runs = 0;
    for (const site of sites) {
      for (const file of await descriptors.runFiles(site.slug)) {
        runs += 1;
        try {
          const resolved = await resolver.resolve({ site, ref: file });
          const now = clock.now();
          const job = createJob({
            id: 'validate',
            site,
            pages: resolvePages({ runPages: resolved.run.pages, site }),
            window: windowFor(resolved.run.defaults.window, now),
            priority: resolved.run.defaults.priority ?? 'normal',
            resilience: resolved.run.defaults.resilience ?? 'standard',
            resolved,
            now,
          });
          for (const problem of await validator.validateJob(job)) problems.push(`${site.slug}/${resolved.run.id}: ${problem}`);
        } catch (err) {
          problems.push(`${site.slug}/${path.basename(file)}: ${err.message}`);
        }
      }
    }
    if (problems.length) throw new OrchestratorError(`validation failed:\n- ${problems.join('\n- ')}`);
    return `valid: ${runs} run(s) for ${sites.length} site(s)`;
  };
}
