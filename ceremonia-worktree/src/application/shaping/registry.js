import { deepFreeze } from '../../domain/freeze.js';

/** @typedef {import('../../domain/shaping/attributes.js').Attribute} Attribute */
/** @typedef {import('../../domain/shaping/sources.js').SourceKind} SourceKind */

/**
 * What a shaped dataset can read for each site: the shipped attributes and
 * the site's own, a lookup attribute `<kind>.<column>` for every column of
 * every lookup kind, the source kinds, and the site's connections. Every
 * site file is checked when the registry is built, so a bad one fails
 * before any query.
 *
 * @param {{attributes: ReadonlyArray<Attribute>, kinds: ReadonlyArray<SourceKind>,
 *   adapters: ReadonlyArray<import('../../ports/external-source.js').ExternalSourceAdapter>,
 *   siteAttributes?: ReadonlyArray<{slug: string, idsite: number, attributes: ReadonlyArray<Attribute>}>,
 *   siteSources?: ReadonlyArray<import('../../ports/external-source.js').SiteSourcesSpec>}} input
 */
export function createShapingRegistry({ attributes, kinds, adapters, siteAttributes = [], siteSources = [] }) {
  const kindById = new Map(kinds.map((kind) => [kind.id, kind]));
  const adapterById = new Map(adapters.map((adapter) => [adapter.id, adapter]));
  const lookups = kinds.filter((kind) => kind.role === 'lookup').flatMap((kind) => Object.entries(kind.attributes).map(([column, text]) => deepFreeze({
    id: `${kind.id}.${column}`,
    kind: 'lookup',
    type: 'string',
    label: text.label,
    purpose: kind.purpose,
    data: text.data,
    needs: [],
    inQuery: false,
    lookup: { source: kind.id, column, key: kind.key.attribute, fallback: kind.fallback },
  })));
  const shipped = new Map([...attributes, ...lookups].map((attr) => [attr.id, attr]));

  const bySite = new Map();
  const slugs = new Map();
  const siteOf = (idsite, slug) => {
    if (slugs.has(idsite) && slugs.get(idsite) !== slug) throw new Error(`idsite ${idsite} has files in sites/${slugs.get(idsite)} and sites/${slug}`);
    slugs.set(idsite, slug);
    if (!bySite.has(idsite)) bySite.set(idsite, { slug, attributes: new Map(shipped), connections: new Map() });
    return bySite.get(idsite);
  };
  for (const spec of siteAttributes) {
    const site = siteOf(spec.idsite, spec.slug);
    for (const attr of spec.attributes) {
      if (site.attributes.has(attr.id)) throw new Error(`sites/${spec.slug}/attributes.json: attribute ${attr.id} is already defined${shipped.has(attr.id) ? ' by the catalog' : ''}`);
      site.attributes.set(attr.id, attr);
    }
  }
  for (const spec of siteSources) {
    const where = `sites/${spec.slug}/sources.json`;
    const site = siteOf(spec.idsite, spec.slug);
    for (const connection of spec.connections) {
      if (!kindById.has(connection.source)) throw new Error(`${where}: unknown source kind "${connection.source}" (${[...kindById.keys()].join(', ')})`);
      if (!adapterById.has(connection.adapter)) throw new Error(`${where}: unknown adapter "${connection.adapter}" for ${connection.source} (${[...adapterById.keys()].join(', ') || 'none discovered'})`);
      site.connections.set(connection.source, connection);
    }
  }
  const empty = { slug: null, attributes: shipped, connections: new Map() };

  return {
    kinds: kindById,
    /**
     * @param {number} idsite
     * @returns {{slug: string | null, attributes: ReadonlyMap<string, Attribute>, connections: ReadonlyMap<string, import('../../ports/external-source.js').SiteConnection>}}
     */
    forSite: (idsite) => bySite.get(Number(idsite)) ?? empty,
    /**
     * One kind's rows for one site, through the adapter its connection names.
     * @param {number} idsite @param {string} source @param {{start: string, end: string} | null} range
     * @returns {Promise<import('../../ports/external-source.js').FetchResult>}
     */
    async fetch(idsite, source, range) {
      const connection = (bySite.get(Number(idsite)) ?? empty).connections.get(source);
      if (!connection) throw new Error(`idsite ${idsite} has no ${source} connection`);
      return adapterById.get(connection.adapter).fetch({ kind: kindById.get(source), idsite: Number(idsite), options: connection.options, range });
    },
  };
}
