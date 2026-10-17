/**
 * External sources: data from outside the Heatmap warehouse (ad platforms,
 * the client's analytics, the store's catalog) that a shaped dataset reads
 * beside the sessions. The kind is the contract, a JSON file in
 * src/catalog/sources/: its columns, the attributes its keys map onto, and
 * its measures or looked-up attributes. The adapter is the transport, a
 * module in src/adapters/external-sources: it fetches a kind's rows for one
 * site's connection. One adapter can serve many kinds; a site's
 * `sources.json` says which adapter serves each kind it has.
 *
 * A real connector (the Meta Marketing API, the GA4 Data API, a Shopify
 * catalog export) lands its rows in an ae_src_* table, records the run in
 * ae_ingest_run and the connection in ae_source_connection, and fetches
 * from there. The `synthetic-file` adapter reads JSON Lines from the local
 * disk, so the feature can be built and tested before any connector is.
 *
 * @typedef {Object} FetchRequest
 * @property {import('../domain/shaping/sources.js').SourceKind} kind
 * @property {number} idsite
 * @property {Record<string, unknown>} options  the connection's options, paths resolved by composition
 * @property {{start: string, end: string} | null} range the days a facts kind is read for; null for a lookup
 *
 * @typedef {Object} FetchResult
 * @property {Array<Record<string, unknown>>} rows  raw rows; the domain types and checks them
 * @property {{start: string, end: string} | null} coverage  the days the source vouches for, so a
 *   day with no row reads as zero rather than as missing; null for a lookup
 *
 * @typedef {Object} ExternalSourceAdapter
 * @property {string} id
 * @property {(request: FetchRequest) => Promise<FetchResult>} fetch
 * @property {{id: string, purpose: string, data: string}} [descriptor] attached by discovery
 *
 * @typedef {Object} SiteConnection           one entry of a site's sources.json
 * @property {string} source                  the kind id
 * @property {string} adapter                 the adapter id
 * @property {Record<string, unknown>} options
 *
 * @typedef {Object} SiteSourcesSpec          one site's sources.json
 * @property {string} slug
 * @property {number} idsite
 * @property {SiteConnection[]} connections
 */

export {};
