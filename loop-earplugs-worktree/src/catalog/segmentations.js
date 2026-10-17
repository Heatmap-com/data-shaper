import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deepFreeze } from '../domain/freeze.js';
import { SEGMENTATION_VOCABULARY, checkDeclaration } from '../domain/segmentation/index.js';

const here = path.join(path.dirname(fileURLToPath(import.meta.url)), 'segmentations');

/**
 * The shipped segmentations, one JSON file per id in
 * `src/catalog/segmentations/`, checked and resolved. A file whose name is
 * not its id, or two files with one id, is refused.
 *
 * @param {string} [dir]
 * @returns {ReadonlyArray<import('../domain/segmentation/declaration.js').ResolvedSegmentation>}
 */
export function loadSegmentationCatalog(dir = here) {
  const files = readdirSync(dir).filter((file) => file.endsWith('.json')).sort();
  const byId = new Map();
  for (const file of files) {
    let doc;
    try {
      doc = JSON.parse(readFileSync(path.join(dir, file), 'utf8'));
    } catch (err) {
      throw new Error(`segmentations/${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
    const seg = checkDeclaration(doc, SEGMENTATION_VOCABULARY, `segmentations/${file}`);
    if (`${seg.id}.json` !== file) throw new Error(`segmentations/${file}: the file name must be ${seg.id}.json`);
    if (byId.has(seg.id)) throw new Error(`segmentations/${file}: duplicate id ${seg.id}, also in ${byId.get(seg.id).file}`);
    byId.set(seg.id, { file, seg });
  }
  return deepFreeze([...byId.values()].map((entry) => entry.seg));
}
