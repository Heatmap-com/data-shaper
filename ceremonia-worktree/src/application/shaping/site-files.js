import path from 'node:path';
import { FIELDS } from '../../domain/segmentation/fields.js';
import { checkAttribute } from '../../domain/shaping/attributes.js';

/**
 * One site's `attributes.json`: `{ idsite, attributes: [...] }`. A site
 * declares visit attributes only, such as the custom variable its tag
 * fills with a customer tier; field and entry attributes are shipped.
 * @param {object} doc
 * @param {string} slug
 * @param {string} where
 * @returns {{slug: string, idsite: number, attributes: ReadonlyArray<import('../../domain/shaping/attributes.js').Attribute>}}
 */
export function siteAttributesSpec(doc, slug, where) {
  const idsite = siteIdsite(doc, where);
  for (const key of Object.keys(doc)) if (key !== 'idsite' && key !== 'attributes') throw new Error(`${where}: unknown key "${key}" (idsite, attributes)`);
  if (!Array.isArray(doc.attributes)) throw new Error(`${where}: attributes must be a list`);
  return { slug, idsite, attributes: doc.attributes.map((entry) => checkAttribute(entry, { fields: FIELDS, kinds: ['visit'], where })) };
}

/**
 * One site's `sources.json`: `{ idsite, connections: { <kind>: { adapter, ...options } } }`.
 * A relative `dir` option is resolved against the site's folder.
 * @param {object} doc
 * @param {string} slug
 * @param {string} where
 * @param {string} siteDir
 * @returns {import('../../ports/external-source.js').SiteSourcesSpec}
 */
export function siteSourcesSpec(doc, slug, where, siteDir) {
  const idsite = siteIdsite(doc, where);
  for (const key of Object.keys(doc)) if (key !== 'idsite' && key !== 'connections') throw new Error(`${where}: unknown key "${key}" (idsite, connections)`);
  if (!doc.connections || typeof doc.connections !== 'object' || Array.isArray(doc.connections)) throw new Error(`${where}: connections must map source kinds to { adapter, ...options }`);
  const connections = Object.entries(doc.connections).map(([source, entry]) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || typeof entry.adapter !== 'string' || !entry.adapter) {
      throw new Error(`${where}: connections.${source} needs an adapter id`);
    }
    const { adapter, ...options } = entry;
    if (typeof options.dir === 'string') options.dir = path.resolve(siteDir, options.dir);
    return { source, adapter, options };
  });
  return { slug, idsite, connections };
}

function siteIdsite(doc, where) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error(`${where}: must be an object`);
  if (!Number.isInteger(doc.idsite) || doc.idsite <= 0) throw new Error(`${where}: idsite must be a positive integer`);
  return doc.idsite;
}
