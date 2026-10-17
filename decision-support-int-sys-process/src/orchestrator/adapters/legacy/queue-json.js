import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { DescriptorError, NotFoundError } from '../../domain/errors.js';

/**
 * @param {{file: string, root: string}} options
 * @returns {import('../../ports/legacy-queue.js').LegacyQueuePort}
 */
export function createLegacyQueueFile({ file, root }) {
  const full = path.resolve(root, file);
  return {
    location: path.relative(root, full) || full,
    async items() {
      let raw;
      try {
        raw = await readFile(full, 'utf8');
      } catch (err) {
        if (err?.code === 'ENOENT') throw new NotFoundError(`no legacy queue at ${full}`);
        throw err;
      }
      let body;
      try {
        body = JSON.parse(raw);
      } catch (err) {
        throw new DescriptorError(`${full}: not valid JSON`, { cause: err });
      }
      if (body?.version !== 1 || !Array.isArray(body.items)) throw new DescriptorError(`${full}: expected {version: 1, items: [...]}`);
      return body.items;
    },
  };
}
