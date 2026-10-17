/**
 * @typedef {import('./query-gateway.js').QueryGateway} QueryGateway
 * @typedef {import('./persistence.js').BatchSpec} BatchSpec
 */

/**
 * @typedef {Object} Clock
 * @property {() => string} todayUtc ISO date string, e.g. '2026-10-03'
 */

/**
 * Carried through every adapter call for one batch run.
 *
 * @typedef {Object} RunContext
 * @property {string} batchId
 * @property {string} windowStart YYYY-MM-DD
 * @property {string} windowEnd YYYY-MM-DD
 * @property {QueryGateway} gateway
 * @property {import('./persistence.js').AePersistencePort} [persistence] schema-2 writes/reads; site datasets may run without it
 * @property {object} logger pino logger
 * @property {Clock} clock
 * @property {Object<string, Dataset>} datasets datasets already collected for this page
 * @property {Map<string, object>} batchNotes column-check and coverage notes shared across a site's datasets
 * @property {Map<string, object>} [pageNotes] one page's shared loads, cleared after the page's datasets; see _lib/page-memo.js
 * @property {RunSites} [sites] what the site source lists: the given idsites, or a platform and status
 * @property {string | null} [elementNamesPath] optional element-names.json for selector names
 * @property {SessionSource} [sessionSource] set by the day scan's page pass; fetchSessionRows reads it in place of the window query
 * @property {{select: (idsite: number, grain: import('./segmentation.js').SegmentationGrain) => ReadonlyArray<import('./segmentation.js').Segmentation>} | null} [segmentations]
 *   the segmentation registry; without it a readout reads the shipped default
 */

/**
 * The sessions a page pass collected for one page: its entry sessions, and
 * with `viewed` the sessions that viewed it anywhere. Rows match
 * fetchSessionRows, including the chosen page's scroll fields when
 * `idsitehsr` is the page.
 *
 * @typedef {Object} SessionSource
 * @property {(idsite: number, opts?: {idsitehsr?: number, viewed?: boolean}) => Promise<object[]>} rows
 */

/**
 * A reduction over session rows that the day scan can feed a day at a time.
 * `collect` is open, fold the window's rows, finish; the site pass opens the
 * folder once per site, folds each day's closed visits, and finishes it per
 * page (or once, for a site dataset). `fold` may run any number of times and
 * `finish` may run more than once on the same folder.
 *
 * A folder with a `lane` reads closed visits on a lane of its own instead
 * of folding session rows: its own start day (before the window, for a
 * preface), the extra event names its facts need, and a hook after each
 * day with the lane's open visits.
 *
 * @typedef {Object} SessionFolder
 * @property {(sessions: object[]) => void} [fold]
 * @property {boolean} [partnerTags] the session rows `fold` reads carry `arms`, the visit's A/B arm keys
 * @property {{start: string, events?: string[], onClosed: (visits: object[], day: string) => void, onDay?: (day: string, open: {earliestOpen: () => string | null}) => void}} [lane]
 * @property {() => void} [settle] called once the pass has read its last day; a folder may reduce its
 *   state to what finish reads and drop the rest, since nothing folds into it after
 * @property {(page: QualifiedPage | {idsite: number, idsitehsr: number, siteName?: string}, ctx: RunContext) => Dataset | Promise<Dataset>} finish
 */

/**
 * @typedef {Object} RunSites
 * @property {number[]} [idsites]
 * @property {string} [platform]
 * @property {string} [status]
 */

/**
 * One dataset adapter's output. Dims and metrics are plain JSON objects;
 * adapters do not write SQL results straight to disk.
 *
 * @typedef {Object} Dataset
 * @property {string} id
 * @property {Array<{dims: object, metrics: object}>} rows
 * @property {object} [notes] merged into the analysis row metadata
 * @property {AnalysisPatch} [analysis] atomic analysis columns, filled by strategy-triggers
 * @property {Array<{key: string, status: string, rowCount?: number, detail?: string}>} [requirements]
 *   explicit requirement statuses (e.g. a known blocker); the runner merges
 *   these into ae_requirement_status, overriding the presence-based status
 *   that requirement-status derives from PROVIDERS
 */

/**
 * Atomic columns for analysis.landing_page_analysis. Any dataset may
 * contribute a patch; the runner merges, it does not recompute.
 *
 * @typedef {Object<string, *>} AnalysisPatch
 */

/**
 * A flattened row for analysis.landing_page_dataset.
 *
 * @typedef {Object} DatasetRow
 * @property {string} batchId
 * @property {number} idsite
 * @property {number} idsitehsr
 * @property {string} datasetId
 * @property {string} [botFilter] 'none' | 'exclude_confirmed'; empty when not session-based
 * @property {string} [dimWeek] YYYY-MM-DD
 * @property {string} [dimDevice]
 * @property {string} [dimReferer]
 * @property {string} [dimSelector]
 * @property {object} [dimExtra]
 * @property {object} metrics
 */

/**
 * @typedef {import('./qualifier.js').QualifiedPage} QualifiedPage
 */

/**
 * @typedef {Object} DatasetPort
 * @property {string} id
 * @property {import('../discover.js').AdapterDescriptor} descriptor purpose and the meaning of the rows, from the sibling descriptor file
 * @property {string[]} dependsOn
 * @property {(page: QualifiedPage, ctx: RunContext) => Promise<Dataset>} collect
 * @property {'site'} [pass] 'site' when the dataset folds the day scan's site pass: every session of the site, page-independent
 * @property {(page: object, ctx: RunContext) => SessionFolder | Promise<SessionFolder>} [open] the folder behind collect, for `pass: 'site'` datasets
 * @property {'viewed' | 'targets'} [sessions] which sessions the page pass serves the dataset: a page dataset
 *   reads its page's entry sessions, or with 'viewed' the sessions that viewed the page; a site dataset
 *   with 'targets' reads the entry sessions of every target. Other site datasets read the window query.
 */
