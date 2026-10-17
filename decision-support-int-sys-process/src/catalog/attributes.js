import { readFileSync } from 'node:fs';
import { deepFreeze } from '../domain/freeze.js';
import { FIELDS } from '../domain/segmentation/fields.js';
import { checkAttribute } from '../domain/shaping/attributes.js';

const shipped = new URL('./attributes.json', import.meta.url);

/**
 * The shipped attributes, checked. Every registered segmentation field is
 * one, so a field added to the registry without an attribute is refused here.
 * @param {URL | string} [file]
 * @returns {ReadonlyArray<import('../domain/shaping/attributes.js').Attribute>}
 */
export function loadAttributeCatalog(file = shipped) {
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  const where = 'catalog attributes.json';
  if (!Array.isArray(doc?.attributes)) throw new Error(`${where}: needs an attributes list`);
  const byId = new Map();
  for (const entry of doc.attributes) {
    const attr = checkAttribute(entry, { fields: FIELDS, where });
    if (byId.has(attr.id)) throw new Error(`${where}: attribute ${attr.id} is declared twice`);
    byId.set(attr.id, attr);
  }
  const missing = Object.keys(FIELDS).filter((id) => byId.get(id)?.kind !== 'field');
  if (missing.length > 0) throw new Error(`${where}: segmentation fields without a field attribute: ${missing.join(', ')}`);
  return deepFreeze([...byId.values()]);
}
