import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deepFreeze } from '../domain/freeze.js';
import { checkSourceKind } from '../domain/shaping/sources.js';

const here = path.join(path.dirname(fileURLToPath(import.meta.url)), 'sources');

/**
 * The shipped source kinds, one JSON file per id in `src/catalog/sources/`.
 * A key that maps onto an attribute the catalog does not have is refused.
 * @param {ReadonlyArray<{id: string, inQuery: boolean}>} attributes the shipped attributes
 * @param {string} [dir]
 * @returns {ReadonlyArray<import('../domain/shaping/sources.js').SourceKind>}
 */
export function loadSourceKinds(attributes, dir = here) {
  const known = new Map(attributes.map((attr) => [attr.id, attr]));
  const kinds = [];
  for (const file of readdirSync(dir).filter((name) => name.endsWith('.json')).sort()) {
    const where = `sources/${file}`;
    let doc;
    try {
      doc = JSON.parse(readFileSync(path.join(dir, file), 'utf8'));
    } catch (err) {
      throw new Error(`${where}: ${err instanceof Error ? err.message : String(err)}`);
    }
    const kind = checkSourceKind(doc, where);
    if (`${kind.id}.json` !== file) throw new Error(`${where}: the file name must be ${kind.id}.json`);
    for (const mapping of kind.role === 'facts' ? kind.keys : [kind.key]) {
      const attr = known.get(mapping.attribute);
      if (!attr?.inQuery || attr.type !== 'string') throw new Error(`${where}: key ${mapping.column} maps onto ${mapping.attribute}, which is not a string attribute the query computes`);
    }
    kinds.push(kind);
  }
  return deepFreeze(kinds);
}
