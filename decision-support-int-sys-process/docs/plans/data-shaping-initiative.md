# Plan and as-built: data shaping

**Written:** 14 October 2026
**Status:** built on `initiative/data-shaping` (local, not pushed), off `integration/segmentation-on-scale-11` at b1a0786
**Builds on:** the segmentation registry (`docs/plans/segmentation-implementation.md`), the trend session CTEs (`src/enrichment/trend-sql.js`), and the query gateway's bound check

The second driver in `docs/VISION.md` is agility: a new question should cost as little as the engine allows. Before this work the engine answered a question at one grain only, Monday weeks of the trend row, and an analyst who wanted days, a month against the month before, sessions by landing product type, or Meta spend beside campaign revenue had to write SQL. This initiative adds four things:

1. **Dataset requests.** A JSON request says what rows are wanted. `--shape` plans it, answers what it cannot build with the reason and the level of change, and builds the rest to files with a column dictionary.
2. **Declarative time structure.** Day, week (Monday or Sunday), month, quarter, or one window; rolling sums; the previous period beside each measure.
3. **An attribute layer.** One catalog of what a row can be keyed or filtered by, including visit columns and the session's landing page, with site attributes declared in a file.
4. **External sources through a port.** Source kinds for Meta Ads, GA4, and a site catalog, an `external-sources` adapter role, and a simulated adapter that reads local files.

No real connector is built. The `synthetic-file` adapter reads JSONL files from the local disk, so each feature is exercised end to end against `clickhouse local` and a synthetic warehouse.

## Working rules kept

- Nothing writes a table. `--shape` reads the warehouse through the gateway and writes files. Tests run against `clickhouse local` and memory.
- The stored weekly `ae_trend_row` is unchanged. The session CTEs take a period function whose default is `toMonday`, so the trend's SQL text is identical when it is not passed, and the parity snapshots do not move.
- Every fact query is labelled `shape:<id>`, and the gateway now bound-checks that label as it does `audit:`, `trend:`, and `experiment:`.
- A missing input is a result, never a guess: `blocked` with the reason.

---

## 1. Dataset requests

### The request

`src/domain/shaping/request.js` checks the request's shape. Keys: `id`, `question`, `idsite`, `window`, `period`, `subject`, `by`, `segmentations`, `filter`, `measures`, `derived`, `rank`, `floor`, `sources`. The skill `skills/dataset-requests/SKILL.md` documents each for the agent that writes them. Limits: `by` at most 3 attributes, `segmentations` at most 8, `rank.limit` at most 1000, and the query reads at most 400 days including any lead-in.

### The answer

`src/application/shaping/plan.js` `planRequest(doc, deps)` returns an answer with a status:

| Status | Meaning | Carries |
|---|---|---|
| `invalid` | The request is malformed. | `reasons` the requester fixes |
| `needs_person` | It asks for vocabulary the engine lacks. | `needs`, each `{name, level, change}` with level `declare`, `extend`, or `new_grain` and the file the change goes in |
| `blocked` | The vocabulary is there and the data is not. | `reasons`: a window not yet over, a missing connection, a missing warehouse column, source days missing, rows that are not rows of the kind, a split or filter a source cannot make |
| `read` | Stored trend rows hold it. | `read: {table, sql}` |
| `ready` | It can be built. | `plan` |
| `built` / `failed` | After a build; `failed` means a check did not pass. | |

`level` on the answer is the lowest level that answers it: `read` or `declare`.

The planner resolves, in order: the window, the `by` attributes, the segmentations (a registry id, or an inline declaration checked with the shared checker against the attribute vocabulary; a computed one is an `extend` need), the filter (with named lists resolved), the measures, the connections, whether each source can be split and filtered as asked, the warehouse columns of any visit attribute (from the gateway's column list), and the periods. It adds `notes` a reader must know: periods the window cuts, a day grain splitting visits at midnight, source measures on `segment = all` only, `returning` as a browser id, and Meta's attribution beside the tracker's orders.

A `journeys`, `pages`, or `elements` request reads `ae_trend_row_current` when the stored rows hold it: whole Monday weeks, `by` empty or `device`, no filter, segmentations within the site's trend defaults, and trend measures. Anything else is a `new_grain` need, since those subjects are only stored weekly. The planner then reads the first and last stored week of each subject on segment `all` (`readTrendWeekRange`). When no subject of the request's row type overlaps the requested weeks, the answer is `blocked`, and the reason names the `--trend` run that stores them; that run writes `ae_trend_row`. Stored rows that cover only part of the weeks are a note. An empty store means the trend job has not run for the site. It does not mean the site has no journeys.

### The build

`src/application/shaping/build.js`:

- `readSources(plan, shaping)` fetches each fact source for the query window and each lookup source whole, types the rows, and checks them. Days the source's coverage does not vouch for block the request unless the request sets `sources.<kind>.partial` to `allow`. A rejected row or a failed fetch blocks it. Lookup keys listed twice with different values are a note, and the first row wins.
- `buildShape(plan, sources, {gateway, kinds})` runs one query per segmentation group (the fan-out plan the trend uses), then:
  1. reads the rows into cells (period, segment, value, keys, measures) and maps lookup keys;
  2. sums each fact source onto `segment = all` cells at the request's period and keys, with the filter applied to the source's mapped keys;
  3. merges them: a source measure is 0 on an `all` cell no row reached and null off `all`; spend on a campaign no session arrived from becomes an `all` cell with zero sessions;
  4. checks the **partition** (each segmentation's values hold the sessions, orders, and revenue of `all` in every period and key, and only declared values appear) and **conservation** (each source measure summed over the reported periods' `all` cells equals the source's own total over those periods); either failing makes the request `failed`, and nothing is written;
  5. ranks key combinations over the window on `segment = all`, folding the rest into `(other)`;
  6. rolls trailing day sums, dense over the output days;
  7. computes the ratios after every sum;
  8. adds `<m>_previous` and `<m>_change` when comparing;
  9. keeps the output periods.

A query returning more than 50,000 cells blocks the request with advice to rank, coarsen, or drop a key.

### The output

`src/application/shaping/output.js` and `src/application/commands/shape.js`:

```bash
node src/cli.js --shape <requests.json> --plan
node src/cli.js --shape <requests.json> --out <dir>
```

The file holds one request or `{ "requests": [...] }`. Each built request writes `<dir>/<id>/data.csv`, `dataset.json` (columns with their meaning, rows, segmentations, sources read with coverage, checks, notes, and the request), and `DATA.md` (the question, what one row is, the column dictionary from the descriptors, the segmentations, the sources, the checks, the caveats, and the request). `<dir>/ANSWER.md` and `answer.json` list every request under its status. Rows sort by period, then `all` before the segmentations in declared order, then values in declared order, then rank order or key, with `(other)`, `(unmatched)`, `(unknown)`, and empty last. Exit 0 when every request is answered, including blocked and needs-a-person; 1 when one is invalid or failed; 2 on a usage error.

## 2. Time structure

`src/domain/shaping/period.js` holds the spec and both twins of every rule:

| Grain | SQL (`periodSql`) | Notes |
|---|---|---|
| `day` | `toDate(x)` | A visit crossing midnight is a session on each day. |
| `week` | `toMonday(x)` or `toStartOfWeek(x, 0)` | `weekStart` monday (as the trend row) or sunday (as GA4 and Meta). |
| `month` | `toStartOfMonth(x)` | |
| `quarter` | `toStartOfQuarter(x)` | |
| `window` | `{s0:Date}`, or `if(x >= {s0:Date}, {s0:Date}, {ps0:Date})` with compare | One row for the window. |

`periodOf` is the JavaScript twin, used for source rows, and a test runs both over thirteen months of days on every grain. `queryWindow` adds the lead-in: `rolling - 1` days before the window, or the previous period when comparing. `periodsIn` lists the reported periods, each with its end and whether the window holds it whole; `partial: drop` leaves out the cut ones. Compare refuses a window that cuts a period, since the lead-in would fill the cut period with days outside the window.

`sessionCtes` in `src/enrichment/trend-sql.js` now takes `{ragers, period, extra}`. `period` replaces `toMonday` in the visits, orders, checkout, and ragers CTEs, and the session key column keeps the name `week` so every join reads the same. `extra` appends attribute columns to `visits`.

## 3. Attributes

`src/domain/shaping/attributes.js` and `src/catalog/attributes.json`. An attribute has an id, kind, type, label, purpose, and data. Kinds:

| Kind | What it reads | Declared in |
|---|---|---|
| `field` | A registered segmentation field, from the trend column map. Every field in `FIELDS` must have one; the loader refuses the catalog otherwise. | the catalog |
| `visit` | One column of `udp_hsrce_visits` from `VISIT_COLUMNS`, picked over the session's rows (`first`, `last`, `min`, `max`; NULLs skipped), normalized (`trim`, `lower`), typed, and optionally labelled by code. No SQL in the declaration. | the catalog, or a site's `attributes.json` |
| `entry` | The session's first recorded page in the period: `template`, `path`, or `page` id. Adds the entry CTEs only when read. | the catalog |
| `lookup` | `<kind>.<column>` for every column of a lookup source kind, found by the kind's key attribute after the query. No condition can read it. | built from the kinds |

Shipped beyond the fields: `device` (labelled codes), `browser`, `city`, `region` (`location_region`), `operating_system` (`config_os`), `landing_template`, `landing_path`, `landing_page`. A visit column the warehouse lacks blocks the request that reads it, so a deployment without `location_region` answers `region` requests as blocked.

`referer_type` and `referer_name` are not in `VISIT_COLUMNS`: the visits CTE aliases them, so an aggregate over them would nest. Their field attributes read them.

The condition language gained `gt`, `gte`, `lt`, and `lte` on number fields, so a filter or a declaration can test `landing_page > 0` or `visit_total_actions >= 3`.

## 4. External sources

### Kinds are the contract

`src/domain/shaping/sources.js` and `src/catalog/sources/*.json`. A kind names its columns and their types, and is either:

- `facts`: day-grain rows with `keys` (a column mapped onto an attribute through `transform` steps and a `map` of spellings) and additive `measures`;
- `lookup`: one `key` mapping and string `attributes`, with a `fallback` for unmatched sessions.

| Kind | Role | Keys | Measures or attributes |
|---|---|---|---|
| `meta_ads` | facts | `campaign_name` → `utm_campaign` (trim) | spend, impressions, clicks, purchases, purchase_value |
| `ga4` | facts | `session_source` → `source_or_referrer` (trim, lower, `(direct)` → empty); `session_medium` → `utm_medium` (`(none)`, `organic`, `referral` → empty) | sessions, engaged_sessions, conversions, purchase_revenue |
| `site_catalog` | lookup | `path` → `landing_path` (trim, lower) | product_type, collection, price_band |

`src/catalog/sources.js` refuses a kind whose file name differs from its id, or whose key maps onto anything other than a string attribute the query computes.

### Adapters are the transport

`src/ports/external-source.js` defines `fetch({kind, idsite, options, range})` → `{rows, coverage}`. The role directory is `src/adapters/external-sources/`, discovered like every other role. A site names its connections:

```json
{ "idsite": 5795, "connections": { "meta_ads": { "adapter": "synthetic-file", "dir": "synthetic" } } }
```

in `orchestration/sites/<slug>/sources.json`; a relative `dir` resolves against the site folder. `src/application/shaping/registry.js` builds, per site, the attribute map (shipped, lookups, the site's own) and the connections, and refuses an unknown kind, an unknown adapter, or an attribute id defined twice. `src/composition/shaping.js` loads it, and the engine context exposes it as `shaping()`.

### The simulation

`src/adapters/external-sources/synthetic-file.js` reads `<dir>/<kind>.jsonl`. Coverage is `<dir>/<kind>.coverage.json` when present, else the first to last date in the file. A facts read keeps rows inside the range, and every row whose date is not a day, so the type check reports it.

`scripts/synthetic-sources.mjs` writes the three files from a seeded generator:

```bash
node scripts/synthetic-sources.mjs --out orchestration/sites/<slug>/synthetic --from 2026-08-01 --to 2026-10-11 \
  --campaigns fall_sale,retarget,brand [--gaps 2026-09-10] [--coverage-end 2026-10-01] [--clean]
```

By default it spells keys as exports do (padded campaign names, `Google` for google, upper-case catalog paths) so the key transforms are exercised. `--coverage-end` simulates a connection that has not refreshed. Campaign names should match the site's `utm_campaign` values.

### Where real connectors go

A real connector is one adapter file and descriptor in `src/adapters/external-sources/`, returning the same rows and coverage. When fetching on every request is too slow or rate-limited, the connector should land rows in an `ae_src_*` table, record the days each run covered in `ae_ingest_run`, and keep the site's connection in `ae_source_connection`; the adapter then reads those tables. `src/persistence/schema2.sql` already declares `ae_ingest_run`, `ae_source_connection`, and 22 `ae_src_*` tables (Shopify-style orders and catalog, ad creatives, search queries, and others), but none holds daily Meta Ads insights or GA4 sessions, so those two kinds each need a new `ae_src_<kind>` table. The DDL of `ae_source_connection` and `ae_src_order` stops partway in the file and the schema migrator skips it, so both need finishing before a connector writes them. The gateway counts `ae_src_*` and `ae_source_connection` as fact tables, so an adapter's reads of them carry `{idsite}`. Shopify orders would be a third fact kind keyed by `utm_campaign` and landing path; its order totals reconcile against `udp_conversions`.

---

## Files

| Area | Files |
|---|---|
| Domain | `src/domain/shaping/{dates,period,attributes,sources,measures,request,cells}.js`; `src/domain/segmentation/conditions.js` (number operators) |
| Catalog | `src/catalog/attributes.json`, `src/catalog/attributes.js`, `src/catalog/sources/{meta_ads,ga4,site_catalog}.json`, `src/catalog/sources.js` |
| SQL | `src/enrichment/shape-sql.js`; `src/enrichment/trend-sql.js` (`sessionCtes` options, `measureJoins` exported) |
| Port and adapter | `src/ports/external-source.js`; `src/adapters/external-sources/synthetic-file.js` and descriptor |
| Application | `src/application/shaping/{site-files,registry,plan,build,output}.js`; `src/application/commands/shape.js` |
| Composition | `src/composition/shaping.js`; `src/composition/registries.js` (`loadSiteFiles`); `src/composition/engine.js` (`shaping()`) |
| Gateway | `src/adapters/query-gateway/clickhouse.js` (`shape:` bound check) |
| Tools and docs | `scripts/synthetic-sources.mjs`, `scripts/lib/synthetic-sources.mjs`, `examples/shaping/`, `skills/dataset-requests/SKILL.md`, `.cursorrules`, `docs/VISION.md`, `docs/ARCHITECTURE.md` |

## Tests

| File | What it proves |
|---|---|
| `test/domain/shaping-period.test.js` | Period checks, lead-ins, and periods; `periodSql` equals `periodOf` on every grain over thirteen months, in `clickhouse local`. |
| `test/domain/shaping-catalog.test.js` | The attribute catalog covers every field; bad declarations are refused; visit SQL is never null and picks, normalizes, and labels as declared; number operators agree in SQL and JavaScript; kinds map spellings, type rows, and build lookups; measures resolve and refuse a ratio of ratios; request checks. |
| `test/domain/shaping-cells.test.js` | Lookups, source sums and filters, the merge, rank folding, rolling sums, comparison, and both checks, on hand-built cells. |
| `test/shape.test.js` | Every status and level from the planner; the example request set plans as the skill says; stale, malformed, and missing source files block; the shaped SQL has no bound gaps; and against `clickhouse local` with `test/support/shaping-fixture.js` and synthetic files: parity with `--segmentation-check` on a Monday week, Meta spend conserved onto campaigns, GA4 reconciled by source and medium, rolling sums equal summed days, midnight visits counted once a week and once per day, window and Sunday-week periods, catalog lookups with rank, a site attribute and a warehouse column, the command's files and exit codes, and site files loaded from an orchestration root. |

`test/support/local-warehouse.js` takes optional extra columns per table, so a test can give the warehouse `location_region` without changing the shared tables.

## Not done, and why

- **Real connectors and stored source tables.** Asked to simulate. The port and kinds are the contract a connector meets.
- **A cohort grain.** It needs visitor history before the window, as `return_intent` reads it. The planner answers it as an `extend` need.
- **Journeys, pages, and elements at other grains.** They read the stored weekly rows; another grain is a `new_grain` need, reviewed by a person.
- **Computed segmentations in a shaped dataset.** `return_intent` reads history before the window; adding its CTEs and parameters to `shape-sql.js` is an `extend` need.
- **A live run.** Nothing here has read the production warehouse. The first live check is `--shape --plan` on the example set for one site, then a build of one request whose numbers can be compared with the trend row for the same Monday week.
