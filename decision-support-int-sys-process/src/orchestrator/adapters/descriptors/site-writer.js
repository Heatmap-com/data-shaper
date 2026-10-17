import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DescriptorError } from '../../domain/errors.js';

const ID = /^[a-z][a-z0-9-]{0,47}$/;

/**
 * Writes `sites/<slug>/site.json` under the descriptor root, once.
 *
 * @param {{root: string}} options
 * @returns {import('../../ports/site-directory.js').SiteRegistryPort}
 */
export function createSiteWriter({ root }) {
  return {
    async register(site) {
      if (!ID.test(site.slug ?? '')) throw new DescriptorError(`invalid site slug "${site.slug}"`);
      const dir = path.join(root, 'sites', site.slug);
      const file = path.join(dir, 'site.json');
      await mkdir(dir, { recursive: true });
      try {
        await writeFile(file, `${JSON.stringify(site, null, 2)}\n`, { flag: 'wx' });
      } catch (err) {
        if (err?.code === 'EEXIST') throw new DescriptorError(`${file} already exists for another domain; name the site by its slug or edit that file`);
        throw err;
      }
      return file;
    },
  };
}
