# Analysis engine implementation plan

**Prepared:** 2026-10-03  
**Package:** `analysis-engine` (Node, ESM, Node 20)  
**Location:** `~/Work/analysis-engine`  
**Consumes:** the measurement contract in `~/Work/landing-pages` and the dataset list in `~/Work/landing-pages/DATA-GENERATION-PLAN.md`  
**Does not implement yet.** This document is the plan.

This engine and Facet are two stages of one system. The engine decides which page qualifies and writes the strategy-applicability record. Facet reads that record and writes the human-readable document. Facet does not recompute the numbers. The engine does not write the document.

Success means a single Node process can do three things, in order, and leave the result in ClickHouse:

1. Queue sites.
2. Choose one landing page per site, and keep the page only when the last 7 complete days have at least 100 pageview hits on that page.
3. Run the quantitative dataset pulls those pages need for strategy-applicability rules, and store the result.

The process does not write findings, rank strategies, or call a model. Those belong to the Facet consumer in section 9.

## 1. Pipeline

```text
site source  →  site_queue  →  qualifier  →  dataset adapters  →  trigger adapter  →  analysis row
                     ↑                                                              ↓
                     └──────────── landing_page_batch ──────────── ClickHouse ──────┘
                                                                                      ↓
                                                                         Facet reads the row
                                                                         and writes the document
```

One batch is one window and one set of rules. A batch owns many queue rows. A queue row that qualifies owns one analysis row and many dataset rows.

The runner is single-process. One site at a time. One `idsite` per query. A failed site is recorded and the batch continues. Two workers are out of scope; ClickHouse is not a lock manager.

## 2. Measurement contract

This engine uses the landing-page contract, not the facet metric canon.

| Term | Definition |
| --- | --- |
| Session | Distinct `(idsite, idvisit)` from `default.udp_hsrce_visits`, grouped before counting |
| Entry page | `argMin(visit_entry_idaction_url, visit_first_action_time)`. Id `0` is not a page. `any()` is forbidden |
| Device, referrer, returning | `argMin` on `visit_first_action_time`. Device 1 desktop, 2 tablet, 3 mobile. Referrer 1 direct, 2 search, 3 website, 6 campaign, 7 social. Returning 0 new, 1 returning |
| Orders and revenue | `default.udp_conversions FINAL`, then one row per `(idsite, idvisit, idorder)`. Do not use `visit_goal_buyer`, `visit_revenue`, or `log_conversion` |
| Visit in the volume gate | A pageview hit on the chosen page (`udp_hsrce_pageviews`). The figure is 100 hits, not entry sessions |
| Transaction | One deduplicated order on an entry session |
| Page type | The function in `~/Work/User-Journey-analysis/data/extract2/page_type.py`, ported to `src/page-type.js` and tested against that file's branches |
| Window | Seven complete UTC days ending yesterday. `server_date <= window_end`. The partial current day is excluded. A `Clock` port supplies "today" so tests do not call `Date.now()` |
| Bot filter | The existing extract-3 fingerprint rules, ported, not retuned. Applicability numbers use `exclude_confirmed`. Each analysis row also stores the `bot_filter=none` session and order totals for reconciliation |
| Returning flag | Comparisons that use `visitor_returning` are split at 2026-09-07 |
| Scroll | Max `scroll_y_max_relative` on pageviews of the chosen `idsitehsr`. The 0–1000 scale is confirmed in the column check before a 25% or 70% rule is stored as a rate |
| Element revenue | Revenue of entry sessions that clicked the selector. Not additive. Not causal |
| Click match | Exact `idselector`. No prefix match |

Facet's `src/metrics/sessions.js` bans `udp_hsrce_*` and defines sessions on `log_visit` with a different bot predicate. Facet's orders are `log_conversion FINAL`. Those numbers will not match this engine. Section 9 is the seam. Do not import facet code.

## 3. Landing-page choice

For each queued site, over the batch window:

1. Build entry pages. Drop entry id `0`. Resolve `idsitehsr` through `site_hsr.screenshot_url` and `site_hsr.name`. Classify with `pageType(url)`.
2. Attach deduplicated orders and revenue for those entry sessions.
3. Split candidates into home (`page_type = home`) and non-home (every other type, including `product`, `collection`, and `content`).
4. A non-home page is preferred when it has at least one order and its entry sessions are at least half the homepage's entry sessions, or greater than the homepage's. If the site has no homepage row, any non-home page with at least one order is preferred.
5. Among preferred non-home pages, take the one with the most entry sessions. PDP and collection are eligible. They are not a special case above other non-home types.
6. If no non-home page is preferred, take the homepage.
7. Apply the gate to that one page: pageview hits on that page `>= 100` (`minHits`). Pass: status `qualified`. Fail: status `skipped_volume`. No page at all: status `skipped_no_page`. Entry sessions and orders are still stored. They are not the volume gate.

The 0.5 share is the definition of "relatively high traffic". It is stored on the batch row as `min_share_of_home`. Changing it is a new qualifier adapter or a change to that adapter's exported config, and the batch records which value it used.

The gate is not a search. A preferred page that fails 100 hits is skipped. The homepage is not substituted after that failure. The homepage is only the choice when step 6 selected it, and it then faces the same gate.

## 4. Ports

Ports are JSDoc typedefs in `src/ports/`. No port file imports ClickHouse, the filesystem, or another adapter. Adapters depend on ports. The runner depends on ports.

```js
/**
 * @typedef {Object} SiteSourcePort
 * @property {string} id
 * @property {(ctx: RunContext) => Promise<Array<{idsite:number, siteName:string}>>} listSites
 */

/**
 * @typedef {Object} QualifierPort
 * @property {string} id
 * @property {QualifierConfig} config
 * @property {(site: {idsite:number}, ctx: RunContext) => Promise<Qualification>} qualify
 */

/**
 * @typedef {Object} DatasetPort
 * @property {string} id
 * @property {string[]} dependsOn
 * @property {(page: QualifiedPage, ctx: RunContext) => Promise<Dataset>} collect
 */

/**
 * @typedef {Object} PersistencePort
 * @property {string} id
 * @property {(batch: BatchSpec) => Promise<void>} createBatch
 * @property {(batchId: string, sites: object[]) => Promise<void>} enqueue
 * @property {(batchId: string) => Promise<object[]>} claimNext
 * @property {(row: QueueUpdate) => Promise<void>} updateQueue
 * @property {(row: AnalysisRecord) => Promise<void>} writeAnalysis
 * @property {(rows: DatasetRow[]) => Promise<void>} writeDataset
 */

/**
 * @typedef {Object} QueryGateway
 * @property {(sql: string, params: object, label: string) => Promise<object[]>} query
 */
```

`Qualification` is `{ status, idsitehsr, url, pageType, entrySessions, orders, revenue, reason }`.  
`Dataset` is `{ id, rows }` where each row is `{ dims, metrics }`. Dims and metrics are plain JSON objects. Adapters do not write SQL results straight to disk.

`RunContext` carries `batchId`, `windowStart`, `windowEnd`, `gateway`, `logger`, `clock`, and `datasets` already collected for this page (so a later adapter can read an earlier one without a second query).

`Clock` is `{ todayUtc(): string }`. Tests pass a fixed day.

## 5. Auto-discovery

Four directories. The runner never lists the modules inside them.

```text
src/adapters/site-sources/
src/adapters/qualifiers/
src/adapters/datasets/
src/adapters/persistence/
```

A file is an adapter when it ends in `.js`, does not start with `_`, and does not end in `.test.js`. Each file exports `adapter`. The loader (`src/discover.js`) reads the directory, imports each file by `pathToFileURL`, and rejects the process if `adapter.id` is missing or duplicated. Discovery order is filename order, then dataset adapters are topologically sorted on `dependsOn`. A cycle or a missing dependency fails startup. The error names the ids.

Selecting which site source, qualifier, and persistence adapter runs is an environment variable (`ANALYSIS_SITE_SOURCE`, `ANALYSIS_QUALIFIER`, `ANALYSIS_PERSISTENCE`). The runner looks up the id in the discovered list. There is no `switch`. An unknown id fails startup and prints the ids that were found.

Adding a dataset is one new file in `src/adapters/datasets/`. No other file changes. The persistence adapter writes whatever `{ id, rows }` that file returns. Adding a persistence backend is one new file in `src/adapters/persistence/`.

`src/discover.js`, `src/runner.js`, `src/page-type.js`, `src/bot-flag.js`, and `src/ports/*.js` are the closed set. They do not gain a line when a dataset appears.

## 6. Adapters shipped in the first build

### Site sources

| File | id | Behavior |
| --- | --- | --- |
| `static-idsites.js` | `static-idsites` | Reads `ANALYSIS_IDSITES` (comma-separated). Default for the first run: `3199,3207,3228` |
| `active-ecommerce-sites.js` | `active-ecommerce-sites` | Reads `default.sites` for active ecommerce sites. Confirms the status column via `system.columns` before the query and fails closed if the expected column is absent. Not the default |

### Qualifier

| File | id |
| --- | --- |
| `prefer-non-home.js` | `prefer-non-home` |

Implements section 3. `config` is `{ minShareOfHome: 0.5, minHits: 100, minSessions: 100, minOrders: 0 }`. The volume gate reads `minHits`.

### Datasets

These are the pulls in `DATA-GENERATION-PLAN.md`, one adapter each. Each receives the qualified page and returns rows. None of them interpret a strategy.

| id | dependsOn | Grain of `dims` | What `metrics` holds |
| --- | --- | --- | --- |
| `page-segment-weekly` | — | week, device, referer, returning, returning_era, bot_filter | sessions, single-pageview, sub-5-second, zero-time, funnel flags, checkout-without-product-view, orders, revenue, scroll reaches, median time |
| `entry-by-channel` | — | idsitehsr, referer, bot_filter | sessions, orders, revenue, single-pageview. Same site, top 25 URLs per referrer with at least 20 sessions, plus the chosen page |
| `order-value-hist` | — | bot_filter, bucket | orders, revenue. $10 buckets through $200, plus p25/p50/p75 on a second row kind |
| `page-country` | — | country, bot_filter | sessions, orders, revenue. Countries with at least 30 entry sessions |
| `scroll-decile` | — | week, device, referer, depth_bin, bot_filter | sessions reached, sessions whose max sits in the bin |
| `selector-weekly` | — | week, selector, device, bot_filter | clicks, clicking sessions, orders, revenue, median x/y, click-time median, clicks under 8 seconds, exact-match label and element class |
| `rage-clicks` | `selector-weekly` | week, selector, device, bot_filter | rage sessions. Empty if `time_since_load`'s unit was not confirmed |
| `nav-next-page` | `selector-weekly` | element class, next page type, bot_filter | clicking sessions, orders, revenue |
| `campaign-coverage` | — | tag source | entry sessions, tagged sessions, distinct tags |
| `campaign-weekly` | `campaign-coverage` | week, utm source, medium, campaign, bot_filter | sessions, single-pageview, orders, revenue. Emits no rows when tagged share is under 5 percent. Campaigns under 30 sessions roll into `other` |
| `line-items` | — | order, sku, item source | quantity, line revenue. `udp_conversion_product_items`, else `conversion_item` for that site |
| `coverage` | — | source | row count and date range for `page_speed_cache`, `udp_partner_tags`, `udp_custom_events`, and viewport null share |
| `strategy-triggers` | every dataset above | strategy id | state, metric, value, threshold, floor result |

`strategy-triggers` is pure. It does not query. It reads `ctx.datasets` and applies the thresholds in section 8. It is still an adapter, so a replacement rule file is a new adapter that depends on the same datasets.

Selector rows are kept when the selector has at least 20 clicks, or at least one order, or it is an exact selector in the page's element-name file if one is later supplied. This build does not require `element-names.json`. Unmatched labels stay blank.

### Persistence

| File | id |
| --- | --- |
| `clickhouse.js` | `clickhouse` |
| `memory.js` | `memory` |

`memory` is the test double. It implements the same port. Contract tests run every persistence adapter against the same script.

`clickhouse.js` is the only production file that imports `@clickhouse/client`. Dataset adapters see `QueryGateway` only. The gateway binds parameters, sets `max_execution_time`, logs label, rows, and seconds, and refuses a query that does not contain the batch `idsite` parameter.

## 7. ClickHouse tables

> **Schema 2 supersedes this section.** The table set rebuilt for the
> multi-catalog engine — 49 `ae_` tables + 47 `_current` views in
> `journey_events` — is specified in
> `~/Work/research2/output/data-capture-plan.md` §8 (DDL in
> `src/persistence/schema2.sql`); what follows is the original v1 layout.

Database: `analysis`. Engine: `ReplacingMergeTree(generated_at)`. Reads go through a `_current` view that uses `argMax(..., generated_at)`, the same idea as facet's persistence adapter. Inserts are idempotent for a batch rerun.

### `analysis.landing_page_batch`

One row per batch.

| Column | Type | Role |
| --- | --- | --- |
| `batch_id` | UUID | Order key |
| `created_at` | DateTime | |
| `window_start`, `window_end` | Date | The seven days |
| `site_source` | LowCardinality(String) | Adapter id |
| `qualifier` | LowCardinality(String) | Adapter id |
| `min_sessions` | UInt32 | 1000 |
| `min_orders` | UInt32 | 5 |
| `min_share_of_home` | Float64 | 0.5 |
| `status` | LowCardinality(String) | `running`, `complete`, `failed` |
| `sites_queued`, `sites_qualified`, `sites_skipped`, `sites_failed` | UInt32 | Filled when the batch finishes |
| `metadata` | String | JSON. Schema version, adapter ids discovered, column-check notes |

`ORDER BY (batch_id)`.

### `analysis.site_queue`

The queue. One row per site per batch.

| Column | Type |
| --- | --- |
| `batch_id` | UUID |
| `idsite` | UInt32 |
| `site_name` | String |
| `status` | LowCardinality(String): `queued`, `qualifying`, `qualified`, `skipped_volume`, `skipped_no_page`, `analyzing`, `analyzed`, `failed` |
| `idsitehsr` | UInt64 |
| `landing_page_url` | String |
| `page_type` | LowCardinality(String) |
| `entry_sessions` | UInt64 |
| `orders` | UInt64 |
| `revenue` | Float64 |
| `reason` | String |
| `generated_at` | DateTime |

`ORDER BY (batch_id, idsite)`.

`claimNext` inserts a new row with status `qualifying` and a higher `generated_at`. The current view then shows that status. This is safe for one worker. It is not a lease.

### `analysis.landing_page_analysis`

One row per qualified page per batch. Written after datasets and triggers finish. Skipped sites do not get a row; their outcome stays on `site_queue`.

Atomic columns are the fields a later facet, or a SQL filter, needs without parsing JSON.

| Column | Type |
| --- | --- |
| `batch_id` | UUID |
| `idsite` | UInt32 |
| `idsitehsr` | UInt64 |
| `landing_page_url` | String |
| `page_title` | String |
| `page_type` | LowCardinality(String) |
| `window_start`, `window_end` | Date |
| `entry_sessions` | UInt64 |
| `orders` | UInt32 |
| `revenue` | Float64 |
| `rps` | Float64 |
| `single_pageview_share` | Float64 |
| `scroll_reach_25` | Float64 |
| `scroll_reach_70` | Float64 |
| `desktop_rps` | Float64 |
| `mobile_rps` | Float64 |
| `mobile_to_desktop_rps` | Float64 |
| `bot_sessions_excluded` | UInt64 |
| `sessions_unfiltered` | UInt64 |
| `orders_unfiltered` | UInt32 |
| `strategies_triggered` | UInt16 |
| `strategies_below_floor` | UInt16 |
| `strategies_blocked` | UInt16 |
| `strategies_silent` | UInt16 |
| `status` | LowCardinality(String): `analyzed` |
| `metadata` | String |
| `generated_at` | DateTime |

`ORDER BY (batch_id, idsite, idsitehsr)`.

`metadata` holds everything else: qualifier evidence (home sessions, chosen page's share of home), column-check unit for `time_since_load`, campaign tagged share, coverage counts, and the per-strategy records. It does not hold selector-level click rows.

### `analysis.landing_page_dataset`

Every dataset row, including a new adapter's rows, lands here. No new table when an adapter is added.

| Column | Type | Role |
| --- | --- | --- |
| `batch_id` | UUID | |
| `idsite` | UInt32 | |
| `idsitehsr` | UInt64 | |
| `dataset_id` | LowCardinality(String) | Adapter id |
| `bot_filter` | LowCardinality(String) | `none` or `exclude_confirmed`. Empty when the row is not session-based |
| `dim_week` | Nullable(Date) | |
| `dim_device` | LowCardinality(String) | |
| `dim_referer` | LowCardinality(String) | |
| `dim_selector` | String | |
| `dim_extra` | String | JSON for grain keys that are not promoted |
| `metrics` | String | JSON measures |
| `row_key` | String | Stable hash of the dims, so a rerun replaces the row |
| `generated_at` | DateTime | |

`ORDER BY (batch_id, idsite, idsitehsr, dataset_id, row_key)`.

Promoting a key from `dim_extra` to a real column is a schema change in `clickhouse.js`. That is the one persistence edit that is not zero-touch, and it is rare. A new dataset does not need it.

Atomic analysis columns are filled by `strategy-triggers` from `page-segment-weekly` (bot-filtered, summed). The runner does not recompute them in a special case of its own.

## 8. Strategy applicability

`strategy-triggers` reads the trigger table below. States:

| State | Meaning |
| --- | --- |
| `blocked` | The dataset or column the rule needs is absent, or the unit check failed |
| `below_floor` | The pattern is visible and the volume floor failed |
| `triggered` | The comparison holds and the floor passed |
| `silent` | The data exists and the comparison does not hold |

Floors, from the catalog: a within-class comparison needs at least 10 clicking sessions on each element in the week being read. A page-level rate needs at least 30 entry sessions in that slice. The 20-click / $0 rule keeps its own floor. Partial weeks (Monday week that is not seven days inside the window) are excluded from trigger rows.

The rules are the catalog's trigger table, encoded as data in the adapter, not as prose.

| Rule | Comparison | Needs |
| --- | --- | --- |
| 1 | Weekly session or single-pageview share steps and stays | `page-segment-weekly` |
| 2 | Under 30% reach 25% depth, or single-pageview share above the site's other entry URLs | `page-segment-weekly`, `entry-by-channel`. Scroll rate stays `blocked` until the scale check passes |
| 3 | Deep scroll and RPS below the site's other entry URLs | `scroll-decile`, `entry-by-channel` |
| 4 | Under 70% of sessions reach the primary CTA's median click depth | `scroll-decile`, `selector-weekly` |
| 5 | Same-class click-rate or order-rate gap, 10 clicking sessions each | `selector-weekly` and an element class. No class means `blocked`, not a guess |
| 6 | Hero-CTA clickers' order rate below the page rate | `selector-weekly` where class is `hero_cta` |
| 7 | 20 or more clicks and zero revenue | `selector-weekly` |
| 8 | 3 or more clicks on one selector inside 2 seconds | `rage-clicks` |
| 9 | Mobile RPS under 0.4 times desktop, bot-filtered | `page-segment-weekly` |
| 10 | Over 10% of entry sessions click a nav control; the order-rate comparison chooses the direction | `nav-next-page`, `page-segment-weekly` |
| 11 | Drawer-close clicks several times checkout clicks | `selector-weekly` only when those selectors are classed. Otherwise `blocked` |
| 12 | One campaign or country lags, with the volume floor | `campaign-weekly`, `page-country` |
| 13 | Another entry URL in the same referrer has higher RPS | `entry-by-channel` |
| 14 | Order revenue bunches in the bucket just below a round threshold | `order-value-hist`. The threshold is not invented; the row records the modal bucket |

Each strategy id in `lp-strategies.md` maps to one or more of these rules inside the adapter. The mapping is a table in that file (`strategyId → rule ids`). A strategy is `triggered` when any of its rules trigger, `blocked` when all are blocked, `below_floor` when none trigger and any are below the floor, otherwise `silent`. The metadata record keeps every rule result, so the rollup can be audited.

Counts of those four states are the atomic `strategies_*` columns.

## 9. Facet is the reader

The engine is the measurement stage. Facet is the writing stage. A page that reaches `status = analyzed` is ready for a facet. A skipped or failed queue row is not.

The facet query reads `analysis.landing_page_analysis_current` and `analysis.landing_page_dataset_current` for the latest `generated_at` of that `idsite`. It returns `{ scalars, tables }` in the shape `ClickHouseDataProvider.fetch` already uses. Scalars are the atomic columns: page URL, page type, sessions, orders, revenue, RPS, scroll reaches, device RPS, and the four strategy counts. Tables are the strategy records from `metadata` (id, state, rule, metric, value, threshold) and, for strategies whose state is `triggered` or `below_floor`, the dataset rows those rules cite. The facet does not join `udp_hsrce_*`, `log_visit`, or `log_conversion` to rebuild those figures.

The facet document may explain a triggered strategy, name the comparison, and say what a person could test. It quotes the stored state. It does not move a strategy from `triggered` to `silent`, fill a `blocked` rule, or invent a rate the metadata does not contain. `llm_enrichment` is allowed on that document because the numbers are already fixed.

This build does not add that facet and does not register anything in `hm-facet-node`. The engine does not import Facet, and it does not gain a persistence adapter that writes markdown. The document lives in Facet because that is Facet's job.

The measurement sources stay different on purpose. This engine uses `udp_hsrce_visits`, `udp_conversions FINAL`, and the extract-3 bot flag. Facet's own session spine is `log_visit`, and its order table is `log_conversion`. The landing-page document uses the analysis row, so a reader does not see two RPS figures for the same page.

A later selector-classification adapter implements `DatasetPort`, depends on `selector-weekly`, and fills `element_class` where it is blank. `strategy-triggers` treats a missing class as `blocked`. That adapter is not part of the first build.

## 10. Package layout

```text
analysis-engine/
  package.json
  IMPLEMENTATION-PLAN.md
  src/
    index.js              CLI: create batch, or resume a batch id
    runner.js             the pipeline in section 1
    discover.js
    page-type.js
    bot-flag.js
    ports/
      site-source.js
      qualifier.js
      dataset.js
      persistence.js
      query-gateway.js
    adapters/
      site-sources/
      qualifiers/
      datasets/
      persistence/
  test/
    discover.test.js
    page-type.test.js
    prefer-non-home.test.js
    strategy-triggers.test.js
    persistence-contract.test.js
    runner.test.js
```

Dependencies: `@clickhouse/client`, `pino`. Dev: `vitest`. No web framework. `"type": "module"`. `"engines": { "node": ">=20" }`.

CLI:

```text
node src/index.js --site-source static-idsites --idsites 3199,3207,3228
node src/index.js --resume <batch_id>
```

Environment: `CLICKHOUSE_HOST`, `CLICKHOUSE_USER`, `CLICKHOUSE_PASSWORD`, `CLICKHOUSE_DATABASE=analysis`. The password is not logged and not written into `metadata`.

## 11. Tests that define done

| Test | Proves |
| --- | --- |
| Discovery | A fixture directory with two adapters loads both. A duplicate id throws. A dataset file added to the fixture appears with no edit to the loader |
| Page type | The same URLs as `page_type.py`: `/`, `/products/x`, `/collections/x/products/y` (product), `/pages/x`, empty, `?` stripped |
| Qualifier | Homepage 2,000 sessions / 10 orders and a content page 1,200 sessions / 6 orders → content page. Content page at 400 sessions against a homepage of 2,000 → homepage, because 400 is under half. Chosen page at 900 sessions and 8 orders → `skipped_volume`. Entry id 0 never wins |
| Triggers | A fixture dataset with mobile RPS at 0.3× desktop → rule 9 `triggered`. The same with 20 desktop sessions → `below_floor`. Missing scroll unit → rule 2 `blocked`. Two bundle tiles, 136 vs 43 clicking sessions → rule 5 `triggered` |
| Persistence contract | `memory` and a ClickHouse test database (or a fake client) both round-trip a batch, a queue claim, an analysis row, and a dataset row. A second write of the same `row_key` leaves one current row |
| Runner | Three fixture sites through the memory persistence adapter. One qualifies, one fails the gate, one throws. Batch counts are 1 qualified, 1 skipped, 1 failed. The thrown site does not drop the batch |
| Reconciliation | On a live run, `sessions_unfiltered` and `orders_unfiltered` for the three known pages match a fresh `bot_filter=none` query within 0.5% or 5 sessions. A miss is stored on the analysis row and does not abort the other sites |

The live reconciliation is the acceptance check for the first real batch. The unit tests do not hit production ClickHouse.

## 12. Build order

1. Ports, discovery, memory persistence, page type, qualifier, runner. Fixture sites only. No ClickHouse.
2. ClickHouse persistence and the gateway. Create the four objects in section 7. Resume a batch.
3. `page-segment-weekly` and `entry-by-channel`. These fill the atomic analysis columns and rules 1, 2, 9, and 13.
4. Scroll, selector, rage, nav-next, order histogram, country. Rules 3 through 8, 10, 11, and 14 light up where the columns exist.
5. Campaign, line items, and coverage. Rules that need them stay `blocked` when coverage is thin. That is a result, not a failure.
6. `strategy-triggers`, then the first live batch for 3199, 3207, and 3228.

Column confirmation from Phase 0 of the data plan runs inside the gateway's first call per table (`system.columns`), and the notes land in batch `metadata`. Scroll rules stay `blocked` until that note says 250 means 25 percent.

## 13. Explicit non-goals

- No findings, no ICE scores, and no prose document. Facet writes those from the stored states.
- No Jev call, no recording download, no spend or margin.
- No edit to Facet in this build. The first live batch is done when the analysis rows exist for the qualified pages.
- No fleet scan unless `ANALYSIS_SITE_SOURCE=active-ecommerce-sites`.
- No second worker, no lease, no retune of the bot flag.
