import { OrchestratorError } from '../domain/errors.js';
import { chooseDirectoryRow, siteFromDirectory, siteFromDomain } from '../domain/site.js';

/**
 * The site a selector names: its `site.json`, else the one active
 * `default.sites` row for the domain. `found` is that row when the site came
 * from the directory, so the caller can write its `site.json`.
 *
 * @param {{descriptors: import('../ports/descriptor-source.js').DescriptorSourcePort,
 *   directory?: import('../ports/site-directory.js').SiteDirectoryPort}} deps
 */
export function createSiteResolver({ descriptors, directory }) {
  return async function resolveSite(selector, { lookup = true } = {}) {
    const known = await descriptors.site(selector);
    if (known) return { site: known, found: null };
    const base = siteFromDomain(selector);
    if (!lookup || !directory) return { site: base, found: null };
    let rows;
    try {
      rows = await directory.lookup(base.domain);
    } catch (err) {
      throw new OrchestratorError(`cannot look up ${base.domain} in default.sites: ${err.message}`, { cause: err });
    }
    const choice = chooseDirectoryRow(base.domain, rows);
    if (choice.problem) {
      throw new OrchestratorError(`${choice.problem}. Add orchestration/sites/${base.slug}/site.json with its idsite and name.`, { exitCode: 2 });
    }
    return { site: siteFromDirectory(base.domain, choice.row), found: choice.row };
  };
}
