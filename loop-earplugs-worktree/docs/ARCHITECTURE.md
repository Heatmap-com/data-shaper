# Analysis Engine — Architecture

**Package:** `analysis-engine` (Node.js ≥ 22, ESM, dependencies: `@clickhouse/client`, `pino`; tests: `vitest`)
**Purpose:** A behavioral-measurement pipeline. It queues ecommerce sites, qualifies subjects (a landing page per site today), pulls quantitative datasets from ClickHouse, evaluates strategy-applicability rules, and stores the results. Downstream consumers (report generators, an LLM "Facet" writer, client-facing reports) read the stored rows — they never recompute the numbers. The platform direction beyond landing pages is documented in §14.

---

## 1. System at a glance

The system has four cooperating subsystems:

```text
                        ┌────────────────────────────────────────────┐
                        │                 ClickHouse                  │
                        │  udp_* fact tables (measurement spine)      │
                        │  analysis.* v1 tables  (landing_page_*)     │
                        │  disp.ae_*             (schema 2, 55 tables)│
                        └───────▲───────────────────────▲───────────┘
                                │ gateway (guarded SQL) │ persistence ports
┌───────────────┐   ┌───────────┴───────────────────┐   ┌────────┴─────────────────┐
│  Core engine   │   │  src/adapters/*               │   │  Orchestrator             │
│  runner.js /   │──▶│  55 dataset adapters          │   │  src/orchestrator/        │
│  runner-ae.js  │   │  + the src/scan/ day engine   │   │  declarative stages/runs  │
│  src/scan/     │   │  (ports & adapters)           │   │                           │
└───────────────┘   └───────────────────────────────┘   └───────┬─────────────────┘
                                                                │ shells out
                              ┌─────────────────────────────────┼──────────────────┐
                              ▼                                 ▼                  ▼
                        py/ report workers              naming bot (docker)   skills/ (agent
                        (charts, bundles,               + Heatmap extension    know-how for the
                         PDF styling)                    capture pipeline       Kimi CLI fallback)
```

1. **Core engine** (`src/runner.js`, `src/runner-ae.js`, `src/scan/`, `src/site-analysis/`) — the measurement pipeline, including the day-at-a-time scan that makes 30-day windows of very large sites fit an 8 GB heap (the orchestrator's analysis stage gives it half the machine's memory, 8 to 32 GB, or `ANALYSIS_HEAP_MB`).
2. **Ports & adapters** (`src/ports/`, `src/adapters/`) — the extensibility mechanism everything else hangs off.
3. **Orchestrator** (`src/orchestrator/`, `orchestration/`) — a declarative, crash-safe job runner that chains stages (naming → analysis → bundles → charts → reports → PDF) and falls back to coding agents when a deterministic step fails.
4. **Report side** (`py/`, `skills/`, `scripts/report-style/`) — stateless workers that turn stored analysis rows into charts, bundles, and client documents.

The engine **measures**; it never writes findings, prose, or rankings. The report side **writes**; it never queries the raw fact tables to rebuild a number. That seam is deliberate (see §11).

---

## 2. The ports-and-adapters core

### 2.1 Ports

Ports are JSDoc typedefs in `src/ports/` — no port file imports ClickHouse, the filesystem, or another adapter. Adapters depend on ports; the runner depends on ports; nothing depends on adapters.

| Port | Contract (essence) |
| --- | --- |
| `site-source.js` | `listSites(ctx)` → `[{idsite, siteName}]` |
| `qualifier.js` | `qualify(site, ctx)` → `Qualification` (status, chosen page, volumes, reason) |
| `dataset.js` | `collect(page, ctx)` → `{ id, rows, notes?, analysis?, requirements? }`; also the scan-era contracts: `SessionFolder` (`fold(sessions)` / `finish`, or a self-laning `{lane}` variant), `SessionSource`, and the optional `open()` entry point adapters implement to ride the day scan instead of querying whole windows |
| `persistence.js` | v1 batch/queue/analysis/dataset lifecycle + schema-2 (`AePersistencePort`, ~30 typedefs) |
| `query-gateway.js` | `query(sql, params, label)` — the **only** SQL surface a dataset adapter sees |
| `external-source.js` | `fetch({kind, idsite, options, range})` → `{rows, coverage}` — one source kind's rows for one site (Meta Ads, GA4, a site catalog) |
| `quality.js` | `QualityMethodAdapter.screen({subject, rows, params, totals})` → `{candidates, stats, skipped?}`, and `QualityTriageAdapter.triage({candidate, impact, params})` → `{ask, why}` — how suspect rows are found, and whether a person must decide on them |
| `importance.js`, `session-tag-selector.js`, `traffic-exclusion.js`, `telemetry.js` | Declarative selectors and telemetry for the schema-2 pipeline |

`RunContext` carries `batchId`, `windowStart`, `windowEnd`, `gateway`, `logger`, `clock`, the `datasets` map already collected for the page, and (scan era) `sessionSource`/`pageNotes` — shared per-site loads the day scan provides and per-page memos, so adapters never re-query the same rows.

### 2.2 Adapter discovery

Adapters live in role directories under `src/adapters/`:

```text
src/adapters/site-sources/   qualifiers/   datasets/   persistence/   segmentations/   external-sources/
             quality-methods/   quality-triage/
```

`segmentations/` holds the computed segmentations, such as `return-intent`. The declared ones are JSON files in `src/catalog/segmentations/`, and a site's overrides are in `orchestration/sites/<slug>/segmentations.json`. `src/composition/segmentations.js` builds one registry from all three.

`external-sources/` holds the transports of data from outside the warehouse. A source kind, in `src/catalog/sources/`, is the contract: its columns, the attributes its keys map onto, and its measures or lookup attributes. An adapter only fetches a kind's rows. A site names its connections in `orchestration/sites/<slug>/sources.json`. The one adapter shipped, `synthetic-file`, reads local JSONL files, so a dataset request that joins Meta Ads, GA4, or a catalog can be built and tested before a real connector exists. `src/composition/shaping.js` builds the shaping registry from the attribute catalog (`src/catalog/attributes.json`), the kinds, the adapters, and the site `attributes.json` and `sources.json` files.

`quality-methods/` (`iqr-fence`, `robust-z`, `dead-cohort`) and `quality-triage/` (`impact`, `always-ask`) are the data-quality adapters (§3.5). A screen, in `src/catalog/quality/`, names one of each with its constants; `src/composition/quality.js` builds the quality registry from the screens, the adapters, and the site `quality.json` and `quality-decisions.json` files.

A file is an adapter when it ends in `.js`, doesn't start with `_`, and isn't a test. Each module exports `adapter` (or `adapters`) and ships a sibling `<module>.descriptor.json` stating its purpose and what its rows mean — the descriptor is enforced by the loader. `src/discover.js`:

- imports every adapter by `pathToFileURL` and **fails startup** on a missing or duplicated id;
- topologically sorts dataset adapters on `dependsOn` (a cycle or missing dependency names the ids);
- selects the running adapter **by id only** — env vars or CLI flags per role. There is no `switch`; an unknown id prints the ids that were found and exits. External-source adapters are not selected per run: each site's `orchestration/sites/<slug>/sources.json` names the adapter for each source kind it connects, and an unknown kind or adapter id fails the registry load.

Adding a dataset is one new file in `src/adapters/datasets/` — no other file changes, and no new table is needed (§5). `src/discover.js`, `src/runner.js`, `src/page-type.js`, `src/bot-flag.js`, and `src/ports/*` are the closed set: they do not gain a line when a dataset appears.

### 2.3 Query gateway and governance

`src/adapters/persistence/clickhouse.js` is the only production file that imports `@clickhouse/client`. It exposes a `QueryGateway` that binds parameters, sets `max_execution_time`, logs label/rows/seconds, and enforces two static contracts:

- **Fact-table guard** — every query touching a fact table (`udp_hsrce_*`, `udp_conversions`, `log_*`, …) must carry the batch `{idsite}` parameter: one site per query. Only `fleet:`-labelled queries skip the guard, "by design and obvious in logs". The fleet variant of the conversions query is deliberately non-`FINAL` because the FINAL merge exhausts server memory on 30-day windows.
- **Query bounds** (`src/governance/query-bounds.js`) — `audit:` / `trend:` / `experiment:` / `shape:` labelled queries may not join a fact table unless every joined alias bounds its own `server_date` (and `idsite`/`idsitehsr` when known). A join equality between two dates does not count as a bound. This is enforced both at runtime and by static architecture tests (§10).

`src/domain/` holds the pure twins of these rules — e.g. page-class and channel classifiers emit identical SQL so the JS classifier and the ClickHouse query can never disagree — and the G1–G9 gate pipeline used by the schema-2 runner. Domain code imports only domain code and no Node built-ins; this direction is pinned by architecture tests.

---

## 3. The measurement pipeline

There are two generations of the pipeline, running in parallel with cutover deliberately deferred:

### 3.1 v1 pipeline (`src/index.js` → `src/runner.js`)

One batch is one window and one set of rules; a batch owns many queue rows; a qualified queue row owns one analysis row and many dataset rows. The runner is a single Node process; a failed site is recorded and the batch continues.

1. Parse flags → `loadConfig` → discover adapters → select by id.
2. `computeWindow(clock)` — **seven complete UTC days ending yesterday**; the partial current day is excluded.
3. `createBatch` writes the `landing_page_batch` row (`status = running`).
4. `runBatch`: `siteSource.listSites(ctx)` → `persistence.enqueue(batchId, sites)` → N parallel agent claim loops (`config.agents.analysis`, default 1). `claimNext` is token-exclusive with a 15-minute TTL so a crashed worker's site is reclaimed.
5. `processSite` per claimed site:
   - `qualifier.qualify(site, ctx)` → queue status `qualified` / `skipped_volume` / `skipped_no_page`.
   - **Naming gate** — a qualified page without fresh element naming is parked as `awaiting_naming` and enqueued; `completeNaming` re-queues it later (see §7).
   - For each dataset adapter **in topological order**: `collect(page, ctx)` → result stored in `ctx.datasets` → rows written via `persistence.writeDataset` → `analysis` patches merged into the analysis row. **The runner merges; it does not recompute.**
   - `persistence.writeAnalysis` (status `analyzed`) + queue update.
6. Batch completion rewrites the batch row with counts; promised column-check notes land in batch `metadata`.

### 3.2 Schema-2 pipeline (`src/cli.js` → `src/runner-ae.js`)

The multi-page, multi-catalog evolution (Phase 3). Same claim protocol, extended:

- A **page selector** adapter (`primary-only`, `default-six`) expands each qualified site into up to six page targets (`ae_page_target`: primary page, sisters, template members).
- A **capture freshness gate** runs per target before datasets (§7).
- Page-scope datasets run per target; site-scope datasets run exactly once per site.
- Results flow through requirement statuses → G1–G9 gates → **strategy cards** (`ae_strategy_card`), the schema-2 replacement for the v1 strategy counts.
- Each site runs through the stage handlers in `src/site-analysis/handlers.js`: `qualify` (with the page selector), `captureGate`, `collectDatasets` with `scope: 'page'`, `draftDescriptors`, `collectDatasets` with `scope: 'site'`, and `writeAnalysis`. The bot drafts between the two scopes because `descriptor-snapshot` reads the descriptors it writes. `runAeBatch` is their composition.
- Dataset descriptors carry the roles: `"role": "card"` with a `catalogId` for the card datasets, and `"role": "requirements"` for the dataset that refreshes after the site datasets. Descriptor sources are discovered from `src/adapters/descriptor-sources/`. Site-pass datasets additionally declare `"pass": "site"` and implement `open()` to ride the scan (§3.3).
- Every committed dataset writes a checkpoint (`ae_analysis_checkpoint`); a restarted run hydrates from stored rows instead of re-querying ClickHouse. A handler started on its own reloads earlier stages the same way.
- `src/replay.js` rebuilds dataset rows and cards from `ae_dataset_row` idempotently — re-derivation without touching the source. Each dataset descriptor's `"replay"` field (`keep`, `restamp`, or `recollect`) sets its part in the plan.

CLI surface (`src/cli.js`): `--batch`, `--run`, `--replay`, `--capture`, `--saliency`, `--trend`, `--tag-trend`, `--audit`, `--segmentation-check`, `--shape` (dataset requests: plan, read sources, screen, build to files; writes no table), `--quality-decide` (records a person's answer to a data-quality finding in the site's `quality-decisions.json`), plus validated import commands (`--descriptor-import`, `--governance-import`, `--tool-registry-import`) that write operator-supplied reference rows only after validation against the catalog schemas.

### 3.3 The scan engine — day-at-a-time execution (`src/scan/`)

The scale initiative (Part D of `docs/plans/scale-and-profiles-initiative.md`, phases D1–D6, all built) replaced whole-window queries with a streaming scan so a 30-day analysis of a very large site finishes on an 8 GB heap. Everything lives in `src/scan/`; the **handlers own the scan** (`src/site-analysis/handlers.js`, gated on `deps.dayScan`, default on via `analysis.config.json` / `ANALYSIS_DAY_SCAN=0` to disable), and the old window-query path remains as fallback.

- **Day record** (`src/scan/day-record.js`) — one query per site per `server_date` returning one row per `idvisit` with every per-visit fact as a *column* (visit fields via `argMin`, pageview counts/hsrs/times/scroll, funnel and trigger events, orders, click count, first tag JSON; with `partnerTags: true`, an `arms` column carries `(week, experience_id, variant_id)` from `udp_partner_tags`, eliminating the 39M-row tag pull). Node never sees raw pageview/click/tag rows.
- **Open-visit merge** (`src/scan/open-visits.js`) — row-days fold into visits; Node holds ≈1–2 days of open visits plus folder folds, never the window.
- **Two passes** (`src/scan/passes.js`) — a **site pass** feeds the qualifier and page selector (both ride it as named folders) plus the `pass: 'site'` datasets; a **page pass** runs once over all target pages, two queries per day (day record + page facts), keeping compact per-page session rows and exposing them as a `SessionSource` (`sourceFor(idsitehsr)`).
- **Folders** (`SessionFolder` in `src/ports/dataset.js`) — each site-pass dataset declares `{fold(sessions), finish(...)}` and folds every day into its own accumulator; `trigger-chains` instead owns a **lane** (`{start, events, onClosed, onDay}`) because chains span day boundaries, with prior purchases loaded separately and the purchase predicate now in SQL. `experiments-weekly`, `entry-by-channel`, `trigger-chains`, and `site-baselines` are the shipped folder datasets.
- **Page memos and column tables** (`src/adapters/_lib/page-memo.js`, `click-table.js`) — per-page shared loads (clicks, pageview sequences, session tags, viewport heights, scroll-eff) are memoized in `ctx.pageNotes` per page and restricted to the page's visits; clicks are held dictionary-interned by column and iterated one at a time, read a day at a time.
- **Day cursor** (`passes.js`) — a resumable scan state (64 MB cap) snapshotted through `src/scan/snapshot.js` (a node-reference JSON codec preserving Maps, Sets, and shared object identity) into `ae_analysis_checkpoint` rows (`day-scan:site` / `day-scan:page` at `idsitehsr 0`); a pass restores saved state only when it holds every lane and folder for the same site/window/pages/version. Cursors are cleared once the site's datasets are stored. **No new tables** — the cursor reuses checkpoints.
- **Acceptance** (`scripts/scan-acceptance.mjs`) — a read-only harness (`readOnlyClient` refuses writes and `system.` reads; the gateway answers `system.tables`/`columns` probes with `EXISTS TABLE`/`DESCRIBE`) that runs a site against a stored batch and reports per-phase rss/heap (with live heap after `gc`), peak memory, per-label query counts/rows/seconds, cursor sizes, and dataset/trigger row parity against the stored run. Measured on Mellow: qualify 3,185 s, page datasets 1,214 s, peak RSS 8,293 MB, 29/33 datasets matching; the cursor never saved because state exceeded the cap.

The known boundary differences versus the window path (per-consumer start days, `argMin` tie-breaks, `campaign-weekly` tag-row choice, `dwell-model-inputs` cut order) are documented in the initiative plan. **Incremental days** (`docs/plans/incremental-days.md`, I0–I5 built) store each day's day-record rows and page facts behind a day-store port (`src/ports/day-store.js`; adapters `memory`, `local` — gzip JSON files, the default — and `clickhouse` on `ae_scan_day`). A later run replays the stored days through the same scan and reads live only the days it lacks plus a two-day overlap, so an incremental run equals a full run by construction; I0 made the remaining arrival-order reads deterministic. The day cursor stays: it saves folder state within a run. `ANALYSIS_DAY_STORE=off` turns the store off, and local stores drop days older than 400.

### 3.4 Dataset requests (`--shape`)

A dataset request is a JSON document saying what rows are wanted: a site, a window, a period (day, Monday or Sunday week, month, quarter, or the window; rolling day sums; the previous period beside each measure), up to three attributes to key by, up to eight segmentations, a filter, measures, derived ratios, a rank, and the external sources it may read partially. `src/application/shaping/plan.js` answers each request `invalid`, `needs_person` (with the level — declare, extend, new grain — and the file the change goes in), `blocked` (with what is missing), `read` (the stored `ae_trend_row_current` query), or `ready`; `build.js` builds the ready ones with one `shape:`-labelled query per segmentation group over the trend's session CTEs, merges external source rows onto `segment = all`, and checks partition (every segmentation's values sum to `all`) and conservation (every source total is in the rows) before anything is written. Output is files — `data.csv`, `dataset.json`, `DATA.md` per request, `ANSWER.md` for the set — never a table.

The vocabulary is data: the attribute catalog (`src/catalog/attributes.json`: segmentation fields, visit columns from an allow-list, the landing page, and `<kind>.<column>` lookups, with site visit attributes in `orchestration/sites/<slug>/attributes.json`), the source kinds (`src/catalog/sources/`), and the segmentation registry. Period rules exist as SQL/JS twins (`src/domain/shaping/period.js`) tested to agree. External sources come through the `external-source` port; the one adapter shipped, `synthetic-file`, reads local JSONL, and `scripts/synthetic-sources.mjs` generates it. `skills/dataset-requests/SKILL.md` is the agent procedure; `docs/plans/data-shaping-initiative.md` the plan and as-built.

### 3.5 Data-quality screens

Before `--shape` builds a request, every screen the dataset runs reads the site's kept sessions over the query window: the orders, or one attribute's values with their sessions, buyers, orders, revenue, and checkout sessions. A screen (`src/catalog/quality/<id>.json`) declares its subject, a method adapter and its constants, a triage adapter and its bars, a question template, and three dispositions: what it proposes, what the build applies while a finding waits for a person, and what it applies when triage says no person is needed. `scope` says whether an order screen drops the orders or their whole sessions.

The constants are layered and each override is recorded with where it came from: the shipped screen, the screen's `datasets.<id>` block, the site's `quality.json` (`rules` for every dataset, `datasets.<id>.rules` for one, `add` for a site's own screens), the request's `quality` block (`off`, `rules`, `add`), and then the reprocess decisions a person recorded. The registry checks every site file and every resolved screen against its adapters when it is built, so a bad constant fails before a query runs.

Each candidate a method returns becomes a finding with a stable id (the site, the screen, and its members). Its members are split by the decisions in `orchestration/sites/<slug>/quality-decisions.json`. A member's own decision wins over a standing decision on the screen (`applies: rule`), and a decision for one dataset wins over a site-wide one. Undecided members go to triage, which either asks (status `awaiting_decision`, with the pending disposition applied) or does not (status `auto`). The run always completes: findings that wait for a person exit 0 like any other answer. Excluded orders leave the `orders` CTE by id; excluded sessions leave by visit id or by `NOT (<attribute> IN values)`, so partition and conservation are checked on the cleaned rows. Each built request also gets `QUALITY.md` (findings, evidence, impact, what was applied, the constants and their layers, the decide commands) and `quality.json` (what `--quality-decide` reads). `--no-quality` builds without screening. `docs/plans/data-quality-screens.md` is the plan.

---

## 4. Qualification — choosing the landing page

The shipped qualifier (`src/adapters/qualifiers/prefer-non-home.js`) implements one deterministic rule set per site over the batch window. In scan mode it rides the site pass as a folder (`open()`), folding the same candidate statistics day by day; in fallback mode it queries the window directly.

1. Build entry pages (entry id `0` is not a page; entry URL resolved via `argMin(visit_entry_idaction_url, visit_first_action_time)` — `any()` is forbidden).
2. Resolve `idsitehsr` through `site_hsr.screenshot_url`/`name`; classify the URL with `pageType()` (`src/page-type.js`, ported from the extract-2 `page_type.py` and tested against its branches).
3. Split candidates into home vs non-home (`product`, `collection`, `content`, …).
4. Prefer a non-home page when it has ≥ 1 order and its entry sessions are at least half the homepage's (or the site has no homepage row). Config: `minShareOfHome: 0.5`, `minHits: 100`, `minSessions: 100`, `minOrders: 0`.
5. Among preferred non-home pages take the most entry sessions.
6. Otherwise take the homepage.
7. Apply the volume gate to that one page: **pageview hits on the chosen page ≥ 100**. Pass → `qualified`; fail → `skipped_volume`; no page → `skipped_no_page`. The gate is not a search — a preferred page that fails is not replaced by the homepage.

Entry sessions and orders are always stored for evidence; they are not the gate. The thresholds used are recorded on the batch row (`min_share_of_home`, …) so a rerun is auditable.

---

## 5. Persistence and the data model

Database: `CLICKHOUSE_DATABASE` (v1 default `analysis`, schema 2 default `disp`). Every table is `ReplacingMergeTree(generated_at)`; schema-2 reads go through a `*_current` view (`SELECT ... FINAL`); v1 reads use `argMax(..., generated_at)` views. **Inserts are idempotent for a batch rerun**: a later write with the same key replaces the earlier one.

### 5.1 v1 tables (DDL inline in `clickhouse.js`)

| Table | Grain | Contents |
| --- | --- | --- |
| `landing_page_batch` | batch | Window, adapter ids + thresholds (`min_share_of_home`, …), status, site counts, metadata JSON (schema version, column-check notes) |
| `site_queue` | (batch, idsite) | Status (`queued`…`analyzed`/`failed`), chosen `idsitehsr`, URL, page type, entry sessions/orders/revenue, reason, claim token |
| `landing_page_analysis` | (batch, idsite, idsitehsr) | Atomic columns a reader needs without parsing JSON: volumes, RPS, single-pageview share, scroll reaches, device RPS, bot-excluded and unfiltered totals, four strategy-state counts, metadata JSON with per-strategy rule records |
| `landing_page_dataset` | (batch, idsite, idsitehsr, dataset_id, row_key) | Every dataset row from every adapter, ever. `row_key` is a stable md5 of the sorted dims; promoted dim columns (week, device, referer, selector) plus `dim_extra`/`metrics` JSON |
| `page_naming`, `naming_queue`, `page_element_name` | naming lifecycle | The naming-before-analysis contract (§7) |

The key extensibility property: **a new dataset adapter needs no new table** — its `{dims, metrics}` rows land in `landing_page_dataset` / `ae_dataset_row` as-is. Promoting a dim key to a real column is the one rare, non-zero-touch persistence edit.

### 5.2 Schema-2 tables (`src/persistence/schema2.sql`, ~55 tables + views)

- **Bookkeeping/queues:** `ae_batch`, `ae_site_queue`, `ae_page_target`, `ae_capture_queue`, `ae_page_capture`, `ae_analysis_checkpoint` (also stores day-cursor scan state, §3.3), `ae_schema_version`, `ae_ingest_run`.
- **Reference (seeded from the catalog):** `ae_requirement`, `ae_strategy_catalog`, `ae_strategy_crosswalk`, `ae_screen_rule`, `ae_trigger_definition`.
- **Identity:** `ae_element_binding`, `ae_page_render`, `ae_render_node`, `ae_page_descriptor`, `ae_store_descriptor`, `ae_tool_registry`, `ae_change_log`, `ae_source_connection`.
- **Source extracts (`ae_src_*`):** Shopify-style orders, order lines, refunds, customers, inventory, fulfillments, disputes, abandoned checkouts, subscriptions, store credit, returns, messages/tickets, reviews, ad creatives, search queries, page performance, JS errors — the commercial-context spine beside the behavioral `udp_*` spine.
- **Dataset requests:** `--shape` adds no table. When real connectors arrive, these are where their rows land: an `ae_src_<kind>` table per kind (none exists yet for Meta Ads daily insights or GA4 sessions), `ae_ingest_run` for the days each run covered, and `ae_source_connection` per site. The DDL of `ae_source_connection` and `ae_src_order` stops partway in `schema2.sql` and the migrator skips it, so both need finishing first.
- **Experiments:** `ae_experiment`, `ae_experiment_descriptor`, `ae_experiment_row`, `ae_review_verdict`.
- **Outputs:** `ae_dataset_row`, `ae_trend_row` (the one already subject-generic table: `row_type` ∈ journey/page/element/experiment × `row_key` grain), `ae_session_tag_trend`, `ae_traffic_exclusion_model`, `ae_trigger_hit`, `ae_trigger_chain`, `ae_requirement_status`, `ae_page_analysis`, `ae_site_analysis`, `ae_strategy_card`.

Schema safety: `ensureAeSchema` refuses destructive DDL — the template must contain no DROP/TRUNCATE/ALTER…DELETE, guarded by regex. `ae_trend_row` is additionally protected: never dropped, only replaced when empty and column-less.

### 5.3 Strategy triggers and cards

`strategy-triggers` is a **pure** dataset adapter: it queries nothing, depends on every other dataset, reads `ctx.datasets`, and applies the catalog's trigger table (encoded as data, not prose). Each rule resolves to one of four states:

| State | Meaning |
| --- | --- |
| `blocked` | The dataset or column the rule needs is absent (or a unit check failed) |
| `below_floor` | The pattern is visible but the volume floor failed |
| `triggered` | The comparison holds and the floor passed |
| `silent` | The data exists and the comparison does not hold |

Floors: within-class comparisons need ≥ 10 clicking sessions on each element; page-level rates need ≥ 30 entry sessions in the slice; partial weeks are excluded. Fourteen rules cover the strategy catalog (weekly share steps, shallow-scroll + bounce, deep-scroll + low RPS, CTA reach, same-class click/order gaps, hero-CTA order rate, high-click-zero-revenue selectors, rage clicks, mobile/desktop RPS gap, nav leakage, drawer-close vs checkout, campaign/country lags, cross-URL RPS comparisons, order-value bunching below round thresholds). A strategy is `triggered` when any of its rules trigger, `blocked` when all are blocked, `below_floor` when none trigger and any are below floor, otherwise `silent`. Every rule result is kept in metadata so the rollup can be audited.

Schema 2 generalizes this into per-catalog cards (`cards-lp/pg/pi/po/td/tg/ti`), each a dataset adapter that emits an `AnalysisPatch`; `defaultAnalysisPatch()` zero-fills all atomic columns so an analysis row is always complete.

---

## 6. Datasets

55 dataset adapters, grouped by concern:

- **Sessions & scroll:** `page-segment-weekly` (the workhorse: sessions, bounce, funnel flags, orders, revenue, scroll reaches by week × device × referer × returning × bot-filter), `page-country`, `viewport-weekly`, `scroll-decile`, `returning-history`, `dwell-model-inputs`, `recordings-sample`, `forms-weekly`.
- **Orders & clicks:** `selector-weekly` (clicks, clicking sessions, orders, revenue, median geometry per selector), `rage-clicks`, `nav-next-page`, `tap-geometry-weekly`, `order-value-hist`, `line-items`, `product-grid` (product-tile blocks and the cells that clear the click gate).
- **Elements & identity:** `element-binding`, `exposure-weekly`, `kind-fleet-weekly`, `render-snapshot`, `descriptor-snapshot`, `structural-screen`, `saliency`.
- **Speed & experiments:** `page-speed` (from `page_speed_cache`), `experiments-weekly` (site-pass folder reading `arms` from the day record), `experiment-analysis`, `experiment-readout` (one experiment subject's lifecycle and arm readout, Part P).
- **Journeys & comparisons:** `journey-weekly`, `trigger-chains` (site-pass folder with its own lane), `funnel-sequence-weekly`, `entry-by-channel` (site-pass folder), `sister-pages`, `template-weekly`, `site-baselines` (site-pass folder), `coverage`, `funnel-steps` and `journey-path` (one funnel or journey subject's step or path readout, Part P).
- **Campaigns & tooling:** `campaign-coverage`, `campaign-weekly`, `ad-creative`, `custom-event-inventory`, `tool-registry`.
- **Cards:** `strategy-triggers`, the seven per-catalog card adapters (`cards-lp/pg/pi/po/td/tg/ti`), the four Part P subject card adapters (`cards-fn`, `cards-jr`, `cards-qz`, `cards-xp`), `requirement-status`, and `card-history`.

Each adapter declares `scope` (page/site), `dependsOn`, the catalog requirements it `provides`, and (for site-pass datasets) `pass: 'site'` with an `open()` folder. Dims and metrics are plain JSON — adapters never write raw SQL results to disk, and scan-mode adapters receive their rows from the shared `SessionSource` instead of issuing window queries.

---

## 7. Capture before analysis

A page is not analyzed until its **capture** is fresh. A capture is: element naming (`names.json` from the naming bot) + a render snapshot (`render.<device>.json` + screenshot) + saliency (flagged, disabled behind `AE_ENABLE_SALIENCY` pending a model/licence decision — D-08).

Contract (schema 2):

1. The runner's capture gate checks `ae_page_capture` freshness against `TAXONOMY_VERSION` (`2026-10-04.2`) and `NAMING_MAX_AGE_DAYS = 14`. Stale or missing → the target is enqueued on `ae_capture_queue` with `want: ['naming','render']` and the site waits.
2. `src/capture-consumer.js` (run as a fleet of agents via `node src/cli.js --capture --agents N`) claims jobs, runs the naming bot (`cnn-ai-bot`) as a **configured external command** (docker container on the server, host process on the Mac), validates the `render.<device>.json` payload (`src/capture-artifact.js`), and calls `completeCapture` — writing bindings, renders, and re-queueing the site.
3. `src/naming-mapper.js` conservatively maps bot output onto the 54-class element taxonomy (`src/domain/taxonomy.js`). Unmapped elements **stay unnamed**, so strategies that need a class read `blocked` — "which is a result, not a failure".
4. Saliency (`src/saliency-worker.js`) with no chosen model emits zero rows and an explicit requirement override (`model_not_selected`), never a throw.

The naming bot is deliberately not a library dependency: it runs as an external process so the engine stays testable and the bot can be patched/replaced independently (resilience tiers in the orchestrator govern how far an agent may go when repairing it).

---

## 8. The orchestrator

`src/orchestrator/` is a separate subsystem — a declarative job runner built on the same ports/adapters discipline — that chains the end-to-end site workflow: naming → analysis → data bundle → trimmed bundle → chart render → three reports → styled PDF → optional remote enhancement.

### 8.1 Declarative descriptors (`orchestration/`)

- **`stages/*.stage.json`** — the stage library. Each stage declares its `phase`, a `handler` (`command` | `agent` | `chart-render`), a completion `check` (the check decides success, **not the exit code**), error regexes mapped to failure classes (`blocked` | `defect` | `transient`), and a `fallback` naming an agent plus a prompt template.
- **`general/runs/*.run.json`** — ordered stage lists. `full` runs everything; `reports-only` assumes an existing bundle; `naming-only` is the default. Site-level `orchestration/sites/<slug>/runs/` overrides general runs; `site.json` holds per-site identity (idsite, platform, currency, page collection).
- **`agents/kimi-cli.agent.json`** — the single agent adapter: Kimi Code CLI in non-interactive mode, prompt delivered as a file, `skillsDirs: ["skills"]`, 45-minute timeout.
- **`general/prompts/`** — Mustache-templated prompts (agent rules, result contract, fallback and report prompts); site prompt files override general ones.

### 8.2 Engine internals

- `domain/` — pure: run-descriptor resolution (snapshotted at enqueue), capacity, retry, failure classification, templating.
- `application/` — `execute-stage` (handler first, check adjudicates), `stage-worker`, `agentic-fallback` (hands the failure to a coding agent, then re-runs the **same check** — the agent's claim is never trusted), `governor` (resource leases: `chromium` limit 1 machine-wide, `clickhouse-heavy: 1`), `settle`, `status`.
- `ports/` + `adapters/` — queue (`node:sqlite` with leased messages; a Postgres `FOR UPDATE SKIP LOCKED` adapter is planned), job store, journal, event log, coding-agent, completion checks, descriptor/prompt sources (layered filesystem).

### 8.3 Crash-safety model

Motivated by the failure of the predecessor JSON queue — "a status field is not a worker" (`docs/ORCHESTRATOR-PLAN.md`). Every stage is idempotent: it checks whether work is already done before doing it. A dead worker loses its lease and the message returns; `status` reports a stage as **stalled** when a lease exists with no live owner. Resilience tiers (`orchestration/general/resilience.json`): `standard` = one fallback attempt, repo-local repairs only; `top` = three attempts, may patch the naming bot or Chrome extension.

The legacy JSON queue is retired. `bin/orchestrator import-legacy` brought `process/queue/queue.json` into the orchestrator DB under the same ids, the file stays as history, and the `skills/analysis-queue-*` skills drive `bin/orchestrator`.

---

## 9. Report side (stateless workers)

The orchestrator's stages shell out; state stays in the engine and ClickHouse.

- **`py/`** — pandas/matplotlib workers: `bundle-export.mjs` (ClickHouse → JSON extracts), `bundle-build.py` (full analyst bundle), `bundle-trim.py` (~4 MB trimmed bundle), `chart-render.py` (reads a `charts.json` spec written by the orchestrator's chart handler; renders only declared charts and records skipped+reason so report agents cite real charts), `hypothesis-*.py` (DVF pilot briefs with live PDP scrapes).
- **`scripts/report-style/`** — brand-styled PDF conversion via headless Chrome (`style-reports.mjs`, HTML builder, design tokens).
- **`scripts/remote-llm-projects/`** — upload bundle + reports to a remote LLM project and save enhanced copies (the `enhance` run).
- **`skills/`** — the executable know-how the agent fallback and report handlers load: queue management, `resilient-naming` (drives the naming bot and Heatmap extension through hangs), `site-analysis`, bundle builders, the three report writers (`site-opportunity-report`, `today-opportunities`, `user-journey-opportunity-analysis`), `style-reports`, `kimi-analysis`, plus shared doc standards.

---

## 10. Testing and architecture enforcement

144 vitest files, run with `npm test`. The distinctive layer:

- **Architecture tests** (`test/architecture/`) — `layers.test.js` pins dependency direction (domain ← application ← adapters; domain imports no Node built-ins; adapters never reach application/composition). `composition-only.test.js` pins where `process.env` and `@clickhouse/client` may appear (allowlist pinned per-line; it must not grow and must not go stale). `no-site-literals.test.js` bans hardcoded idsites/URLs.
- **Contract tests** — every persistence adapter (memory + ClickHouse) runs the same script (`persistence-contract.test.js`, `ae-persistence-contract.test.js`): batch, claim, analysis row, dataset row round trip, and idempotent re-write. The queue contract is shared by the memory and SQLite queue adapters.
- **Characterization tests** (`test/characterization/`) — exact SQL text and page-type outputs pinned as snapshots; a fixture change is a reviewed behaviour change, not a refactor. The scan era added characterization for the session folders, page memos, click datasets, and prior-purchase reads.
- **Scan tests** (`test/scan/`) — day-scan and snapshot-codec units; `scripts/scan-acceptance.mjs` is the read-only live harness comparing a scan run against a stored batch (per-phase heap, per-label query accounting, dataset/trigger parity).
- **Gateway/governance tests** — fact-table guard, query-bounds registry, and a static audit that every backtick SQL segment referencing a fact table carries that table's bounds in the same segment.
- **End-to-end over memory adapters** — v1 and schema-2 runners, dataset groups, checkpoints, gates.
- **Domain tests** — frozen rule tables, classifier SQL twins, report verification (`src/domain/report-check/` parses generated markdown and checks number/date consistency).
- **Shaping tests** (`test/shape.test.js`, `test/domain/shaping-*.test.js`) — every planner status and level, period SQL/JS twin agreement over thirteen months, and end-to-end builds on `clickhouse local` with synthetic Meta Ads, GA4, and catalog files: parity with `--segmentation-check` on a Monday week, source conservation, GA4 reconciliation, rolling sums, midnight-crossing visits, lookups with rank, and the command's files and exit codes.

The live acceptance check for a real batch is reconciliation: `sessions_unfiltered` and `orders_unfiltered` stored on the analysis row must match a fresh `bot_filter=none` query within 0.5% / 5 sessions. A miss is stored, not fatal.

---

## 11. The measurement contract (the rules that keep numbers honest)

These rules are normative and enforced by tests, not conventions:

- **Sessions** — distinct `(idsite, idvisit)` from `udp_hsrce_visits`, grouped before counting. Entry page by `argMin(visit_entry_idaction_url, visit_first_action_time)`; id `0` is not a page; `any()` is forbidden.
- **Orders & revenue** — one deduplicated row per `(idsite, idvisit, idorder)` from `udp_conversions FINAL`. Never `visit_goal_buyer`, `visit_revenue`, or `log_conversion`.
- **Window** — seven complete UTC days ending yesterday (schema 2: configurable, default 30 days); `server_date <= window_end`; the `Clock` port supplies "today".
- **Bot filter** — the extract-3 fingerprint rules ported unchanged (fingerprint = country/city/resolution/browser/version/device per Monday week; tiers `confirmed` / `suspect` / `null`). Applicability numbers use `exclude_confirmed`; each analysis row also stores `bot_filter=none` totals for reconciliation. This module does not tune them.
- **Returning flag** — comparisons using `visitor_returning` are split at the 2026-09-07 semantics change (`returning_era` dim).
- **Scroll** — max `scroll_y_max_relative` per pageview on the chosen `idsitehsr`; the 0–1000 scale must be confirmed via `system.columns` before a 25%/70% rule is stored as a rate. Scroll rules stay `blocked` until that note exists.
- **Element revenue** — revenue of entry sessions that clicked the selector. Not additive, not causal.
- **Click match** — exact `idselector`, no prefix match.
- **Shaped datasets** — a built request's segmentation values must sum to `segment = all` for sessions, orders, and revenue in every period and key, and each external source's total over the reported periods must equal its merged cells; a miss fails the request and nothing is written. Source measures appear on `segment = all` only and never as a ratio of ratios.
- **Data-quality exclusions** — a shaped dataset leaves out only what a screen's disposition or a person's recorded decision excludes, and its `QUALITY.md` names each exclusion, the finding it came from, and who decided. Screens judge the whole site in the query window, never only the request's filter, so one order or cohort is judged the same in every dataset of a run.

Facet (the downstream writer) deliberately uses a **different** spine (`log_visit`, `log_conversion`, its own bot predicate) so its numbers will not match this engine's — that is why the landing-page document reads only the analysis row. A reader must never see two RPS figures for the same page.

---

## 12. Configuration and deployment

### 12.1 Configuration

`analysis.config.json` (env > file > defaults, via `src/config.js`):

```json
{ "agents": { "analysis": 1, "naming": 1 },
  "dayScan": true,
  "naming": { "botDir": "...", "assetsDir": "...", "container": "...",
              "command": "...", "datasetRoot": "...", "botTimeoutMs": 2700000 } }
```

`dayScan` defaults to on; `ANALYSIS_DAY_SCAN=0` disables it (the window-query fallback). Other key env: `CLICKHOUSE_HOST/PORT/USER/PASSWORD/DATABASE`, `ANALYSIS_SITE_SOURCE`, `ANALYSIS_QUALIFIER`, `ANALYSIS_PAGE_SELECTOR`, `ANALYSIS_PERSISTENCE`, `ANALYSIS_ELEMENT_NAMES`, `ANALYSIS_AGENTS`, `NAMING_*`, `AE_ENABLE_SALIENCY`, `LOG_LEVEL`. The ClickHouse password is never logged or written into metadata.

`orchestrator.config.json`: descriptor root (`orchestration/`), workspace (`process/runs`), journal dir, SQLite store (`process/orchestrator.db`), governor capacities and lease TTL, worker polling/heartbeat/redelivery, and template values (`analysisRoot`, naming paths, report tooling).

### 12.2 Deployment

`deploy/` holds systemd units for the EC2 analysis box (repo at `~/analysis-engine`, env from `.env`):

| Unit | Runs |
| --- | --- |
| `analysis-capture.service` | `node src/cli.js --capture --agents 3` (capture consumer; restart always) |
| `analysis-naming.service` | `node src/index.js --naming-agents 1` (v1 naming consumer) |
| `analysis-saliency.service` | `node src/cli.js --saliency --once` — **masked** until the model decision lands |

Merging to `main` triggers Bitbucket Pipelines → `scripts/ci-deploy.sh` (reset to `origin/main`, `npm install`) on the box. Runtime state lives in `process/` (orchestrator SQLite DB, per-job run dirs with attempt logs and fallback transcripts, per-job journals) and is gitignored.

---

## 13. Adjacent subsystems

- **Roswell audit** (`src/audit/`) — a five-brand pilot (ceremonia, peter-thomas-roth, DVF, Hyperlite, Denny's) that validated the schema-2 direction: a full F1–X6 acquisition query plan over the *legacy* `default.log_*` tables with the portal §11.4 bot predicate, statistical readouts (z-tests, change points, regression), and ranked revenue-at-stake. Output persisted as `ae_dataset_row` rows and exported under `data/roswell-audit/` (the evidence base behind `ae_trend_row` in the vision docs).
- **Trend enrichment** (`src/enrichment/`) — site-scoped week × device × segmentation scans (`ae_trend_row`) plus session-tag trends with an ANOVA/Wilson–Hilferty spread test. The segmentations come from the registry (`src/application/segmentation/registry.js`), are fanned out in one scan, and are versioned in `ae_segmentation_definition`; a changed definition rewrites its stored weeks. The product vision is that "coach vs everyone" comparisons become facet filters on one canonical grain, not new code.
- **Experiments** (`src/experiments/`) — partner-experiment lifecycle (active period inferred from daily assignment share: "last-seen is not the end"), arm normalization, SRM and lift readouts.
- **Traffic exclusion** (`src/traffic-exclusion/`) — viewport-signature dead-traffic models, versioned in `ae_traffic_exclusion_model`.
- **Product grid** (`src/product-grid/`) — product-gallery strategy logic (entry session → one grid cell).
- **Audit inputs** (`audit-inputs/`) — per-site seed material mapping element classes to human names for the naming bot.

---

## 14. Direction — the platform initiative

`docs/VISION.md` (rewritten 2026-10-14) reframes the product: this is the **Enterprise data-enrichment program**. The raw behavioral log "is not the shape anyone asks a question in" — the product is the transformed rows. Two operating modes define the platform:

- **Routine** — every transformation already known to be needed runs on a schedule; the stored rows are the reliable answer. `ae_trend_row` is the first routine grain.
- **Agile** — a question nobody has asked before becomes a new dataset with very little effort, built by an agent, because the engine's extension points are declarations and single files with checks, not rewrites. "The engine does not trust the agent" — an agent's work is accepted only when the check passes.

The four effort levels (Read / Declare / Extend / New grain) are the vocabulary: *declaring* a new segmentation or profile must be data, and only a genuinely new grain justifies new code.

`docs/plans/scale-and-profiles-initiative.md` sequences the work:

| Part | Phases | Status on the integrated line |
| --- | --- | --- |
| **D — day-at-a-time scale** | D1–D6 | Built (§3.3); the Mellow rerun and Loaded Tea are deferred to the massive-site phase |
| **I — incremental days** | I0–I8 | I0–I5 built; incremental runs equal full runs on Latico and Seat Cover; the store's table is `ae_scan_day` and exists on `journey_events`; I4 (trigger-lane cuts) waits for the massive-site phase |
| **T — incremental trends** | T1–T4 | Built and merged; the live check passes on Latico and Seat Cover |
| **SG — declarative segmentation** | SG0–SG12 | Built; merged into `scale/11-completion` (560bd5f); `ae_segmentation_definition` exists on `journey_events`; SG12 passes on DVF |
| **P — execution profiles** | P1–P7 | Built and merged; the schema migration ran on `journey_events` (subject columns on five tables, `ae_subject_target`, the chain dims); the fleet run follows the massive-site phase |
| **DS — data shaping** | — | Built: `--shape`, the time structure, the attribute catalog, the external-source port with a simulated adapter; no real connector, no live run yet (`docs/plans/data-shaping-initiative.md`) |

**Declarative segmentation** (requirements R1–R27, `docs/plans/segmentation-requirements.md`): a segmentation is *one way of cutting sessions into a closed list of values*, stored as the `segment`/`segment_value` column pair — "a new way of cutting the data does not add a column and does not add a table." A **declared** segmentation is a rule table over a typed field registry (data, agent-authorable, with SQL/JS twin parity tests and a read-only `--segmentation-check`); a **computed** segmentation needs adapter code (e.g. lookbacks). Definitions are versioned with backfill on change (`ae_segmentation_definition` table, `metrics.segmentation_version` on rows) so old and new cuts are "never mixed silently." Cost grows with the **sum** of value counts, not the product — crossed cuts stay in the trigger tables. All five grains (trend, tag-trend, experiments, bundle, trigger read path) read one registry; profiles (Part P) name segmentations from it. Built (SG0–SG12); see `docs/plans/segmentation-implementation.md` for the as-built notes.

**Data shaping** (`docs/plans/data-shaping-initiative.md`, §3.4): a question arrives as a dataset request and is answered at the lowest level that serves it — read a stored row, build from a declaration, or name the person and file a new grain needs. Periods are a time structure (day, Monday or Sunday week, month, quarter, window, rolling sums, the previous period) with SQL/JS twins; attributes and source kinds are data in `src/catalog/`; external sources are kinds plus adapters behind the `external-source` port, with only the simulated `synthetic-file` adapter shipped so far.

The component map (`docs/plans/segmentation-implementation.md`, phases SG0–SG12):

| Component | Location | Role |
| --- | --- | --- |
| Segmentation domain | `src/domain/segmentation/` | Pure rule language: typed **fields** and **facts**, named **lists** (`@meta_utm_sources`), declaration checker, compiler to both JS and SQL twins. The condition language lives in `src/domain/segmentation/conditions.js`; `src/domain/channel-rules/conditions.js` re-exports it so the channel classifier's callers are unchanged; `canonical` is in `src/domain/canonical.js` |
| Declarations | `src/catalog/segmentations/*.json` | One JSON document per segmentation (shipped: `traffic_source`, `returning`, `buyer`, `rager`, `channel`, `link_channel`), loaded and validated with the catalog bundle; site overrides in `orchestration/sites/<slug>/segmentations.json` (prepend/remove/append/fallback on shipped tables — no forks) |
| Segmentation port | `src/ports/segmentation.js` | The adapter contract for **computed** segmentations |
| Computed adapters | `src/adapters/segmentations/` (role directory) | First: `return-intent` (needs a lookback earlier visits can't express as a rule) |
| Registry | `src/application/segmentation/registry.js` | One definition read by every grain; `src/composition/registries.js` gains `loadSegmentationSpecs` |
| Fan-out SQL | `src/enrichment/segmentation-sql.js` | `arrayJoin` tuple fan-out replacing per-segmentation named columns; `planGroups` for the per-run budget |
| Definition store | `ae_segmentation_definition` table (+ `_current` view, in `schema2.sql`) and `src/ports/persistence/segmentation-store.js` | Versioned definitions; `idsite = 0` is the shipped default |
| Grain hook points | existing modules, generalized | `pathAggregateSql`/`pageAggregateSql`/`selectorAggregateSql`/`tagTrendAggregateSql` in `src/enrichment/trend-sql.js`; `cellsOf`/`tagCellsOf` in the aggregators; `expandTrendRows` rollup; `verifyTrend` partition checks; the experiment path in `src/experiments/sql.js` (`experimentFactSql` still hardcodes `tuple('traffic_source', …)` — the pre-state); trigger read path in `src/triggers/facts.js` (`assembleSessions`) and `queryTriggerTrends` |
| Run surface | `--segmentations` flag (subset), `--segmentation-check` read-only CLI (`src/application/commands/segmentation-check.js`), `skills/segmentation-authoring/SKILL.md` | Agent-authorable with engine validation: "the agent's check is a query, not a claim" |
| Budget & backfill | `trend.segmentationBudget` (default 48, set by a probe), `trend.maxBackfillWeeks` (26) | Backfill (SG9) rides on Part T's `readTrendWeeks` and per-subject start weeks |

SG9 (version-change backfill) was built on Part T2/T3, after the shipped segmentations matched the former hardcoded `TREND_STRATEGIES`/`TAG_STRATEGIES`/`TRAFFIC_VALUES` cuts byte for byte.

**Execution profiles** (`docs/plans/execution-profiles.md`): a profile binds a subject type (page today; quiz/experiment/funnel/journey planned), a selection criteria schema, an adapter set, and the handler step list — data over existing ports, no profile registry in the runner. The 10-13 plan's step-registry proposal was adapted when the steps it targeted became the real handlers in `src/site-analysis/handlers.js` (R2.4), so profiles will parameterize the handler list rather than introduce a second registry.

This document describes the `scale/11-completion` line (scale 7–11, declarative segmentation, data shaping). `main` (9a7d8f7) has none of Parts D–P or data shaping until that line merges.

---

## 15. Design principles (the load-bearing ideas)

1. **Ports in, adapters out.** Everything extensible is a port; the runner knows none of the adapters' contents. Selection is by id; there is no switch.
2. **Discovery over registration.** Dropping a file in a role directory mounts it on next start; a cycle, duplicate id, or unknown selection fails startup loudly, naming the ids.
3. **The runner merges; adapters compute.** Atomic analysis columns arrive as patches from pure adapters (`strategy-triggers`, cards). No special-case recompute in the runner.
4. **Idempotent everything.** ReplacingMergeTree + `_current` views, stable `row_key`s, token-exclusive claims with TTL reclaim, checkpointed dataset collection (including scan cursors), idempotent stages. A rerun is safe by construction.
5. **Blocked is a result.** Missing data, failed unit checks, unnamed elements, and thin coverage surface as explicit states (`blocked`, requirement overrides, zero rows) — never invented values, never throws. A dataset request the engine cannot build yet is answered the same way: `blocked` with what is missing, or `needs_person` with the level and the file.
6. **One site per query; every fact bounded.** The gateway and the query-bounds registry make expensive/misjoined SQL structurally impossible, with static tests to prove it.
7. **Measure here, write there.** The engine stores states and numbers; prose lives in consumers that quote stored states and may not move them.
8. **Deterministic first, agent second.** The orchestrator runs commands, lets checks adjudicate, and distrusts agent claims — an agent's work is accepted only when the same check passes.
9. **Uncertainty stays visible.** Unmapped naming stays unnamed, saliency without a model stays disabled, and every rule keeps its full result record so rollups can be audited.
10. **Scale by streaming, not by RAM.** The scan engine reads a day at a time and folds it into every dataset (§3.3) — memory footprint is ~days, not windows; a 64 MB cursor cap trades resume granularity for a hard bound, and acceptance is measured on a live site with a read-only harness, not assumed.
