/**
 * Segmentations. A segmentation splits every set of visits into a closed,
 * ordered list of values; its id is stored in `segment` and its value in
 * `segment_value`. A declared segmentation is data (the shipped catalog or
 * a site file). A computed one is an adapter in `src/adapters/segmentations`
 * whose value needs SQL beyond the condition language, such as history
 * before the window.
 *
 * A grain is a family of queries with one column map: `trend` (paths,
 * pages, selectors), `tagTrend`, and `experiments`.
 *
 * @typedef {'trend' | 'tagTrend' | 'experiments'} SegmentationGrain
 *
 * @typedef {Object} RunInputs   what a computed segmentation's parameters and stamp read
 * @property {string} [start]          the run's first day
 * @property {number} [lookbackDays]
 * @property {object} [interest]       the site's showed-interest predicate
 *
 * @typedef {Object} Segmentation
 * @property {string} id
 * @property {'declared' | 'computed'} kind
 * @property {string} label
 * @property {readonly string[]} values           closed, ordered; never `all`
 * @property {readonly string[]} needs            shared CTEs the value reads: 'orders', 'checkout', 'ragers'
 * @property {readonly string[]} fields           registered fields a declared value reads; empty for a computed one
 * @property {readonly SegmentationGrain[]} grains the grains it can be read in
 * @property {readonly string[]} inputs           RunInputs keys a computed one reads; empty for a declared one
 * @property {(columns: Readonly<Record<string, string>>) => string} sql   the value expression in the grain's query
 * @property {((row: Record<string, unknown>) => string) | null} classify  the JavaScript twin, or null
 * @property {(inputs: RunInputs) => string} stamp the canonical definition, the version input
 * @property {(inputs: RunInputs) => string} ctes  extra CTEs, or ''
 * @property {(inputs: RunInputs) => string} joins extra joins onto `k`, or ''
 * @property {(inputs: RunInputs) => Record<string, unknown>} params extra query parameters
 * @property {(inputs: RunInputs) => object} definition what is recorded with a version: the resolved rules, or the code version and inputs
 * @property {{id: string, purpose: string, data: string}} descriptor
 *
 * @typedef {Object} SegmentationAdapter        a module in src/adapters/segmentations
 * @property {string} id
 * @property {string} label
 * @property {readonly string[]} values
 * @property {readonly SegmentationGrain[]} grains
 * @property {readonly string[]} needs
 * @property {readonly string[]} inputs
 * @property {number} codeVersion               bumped by hand when the SQL changes meaning
 * @property {(columns: Readonly<Record<string, string>>) => string} sql
 * @property {(inputs: RunInputs) => string} ctes
 * @property {(inputs: RunInputs) => string} joins
 * @property {(inputs: RunInputs) => Record<string, unknown>} params
 * @property {(inputs: RunInputs) => object} stampInputs   what, besides the code version, changes the meaning
 * @property {{id: string, purpose: string, data: string}} [descriptor]  attached by discovery
 *
 * @typedef {Object} SiteSegmentationSpec       one site's `segmentations.json`
 * @property {string} slug
 * @property {number} idsite
 * @property {Partial<Record<SegmentationGrain, string[]>>} [defaults]
 * @property {Record<string, import('../domain/segmentation/declaration.js').Override>} [overrides]
 * @property {import('../domain/segmentation/declaration.js').Declaration[]} [declarations]
 */

export {};
