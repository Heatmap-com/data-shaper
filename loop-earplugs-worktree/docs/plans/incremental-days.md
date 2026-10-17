# Plan: incremental days

**Written:** 14 October 2026, revised the same day before building
**Builds on:** Part D (day scan, folders, trigger lane) and Part T (incremental trends) of `docs/plans/scale-and-profiles-initiative.md`

A site's first analysis reads every day of its window from the warehouse. Each later analysis reads only the days it has not stored, and replays the stored days through the same scan. The day becomes the unit of storage, of reuse, and of resume.

On Mellow, the 75 day queries took 1,353 of the run's 2,500 query seconds. On a site of average size the same share holds at a smaller scale. A weekly rerun after this plan reads seven new days plus a short overlap from the warehouse.

## The design: store the day record, replay it

The day scan already reduces a site's day to one compact row per visit (`daySql` in `src/scan/day-record.js`), and every folder, lane, and pass reads only those rows and the chosen pages' facts (`pageFactsSql`). So the stored unit is the day record itself:

- **Day rows**: the parsed `daySql` rows of one site and one day.
- **Page facts**: the parsed `pageFactsSql` rows of one site, one day, and one page.

The scan reads each day through a **day-records source**. The live source runs the two queries, as the scan does now. The stored source answers from a **day store** when it holds the day, and otherwise reads live and writes what it read.

A replayed day is the same input the warehouse returns, so every consumer computes what it computes today: the open-visit merge, the one-day hold, the spread visits, the reporting lanes' window edges, the trigger lane's preface, the bot tiers, and every folder's `finish`. Equality with a full run holds by construction, and the folders, datasets, and triggers keep their code.

**Departure from the first draft.** The first draft stored each folder's reduction of a day and merged the days. That needed a merge for every folder and dataset. It also needed bot tiers moved to whole weeks, a behaviour change, because a stored reduction bakes in tiers that depend on the window. And it needed edge rules at both ends of the window, because a reporting lane sees a visit from its first in-window row. Storing the inputs removes all three. The cost is that Node folds every day of the window on each run. That is seconds for a site of average size, and the trigger lane is the place to cut it on the largest sites (I4).

### Shape and versions

A day's rows depend on two inputs beyond the day: the event names the query keeps, and whether it reads A/B arms. A stored day records both. It serves a request when it holds every requested event name, and the arms when they are asked for. The source then narrows the rows to the request: it filters each row's events to the requested names, drops the arms when they were not asked for, and drops a row left with no fact. That is the row set the narrower query returns. When a stored day lacks a requested event name, the source reads the day live with the union of both shapes and stores that, so a store only widens.

Each entry carries the day-record format version. Changing `daySql`'s columns or reductions bumps it, and every stored day is read again on its next use.

### Final days and the overlap

Late rows land in the warehouse after their day. A stored day is **final** when it is older than the overlap (`overlapDays`, default 2): on a run whose clock reads `today`, days on or before `today − overlapDays − 1` are final. A run uses a final stored day as stored. It reads a non-final day live and stores it again, marked final once it is old enough. Within one run, a day read live is reused by the later pass (the page pass reads the same days as the site pass), so even a first run halves its day queries.

### What stays a warehouse read

- The spread-visit lookup and the spread visits' rows: two range queries per pass, small on every site measured.
- The bot classification's aggregate queries.
- The per-page window loads the page datasets run (clicks, pageview sequences, session tags, zones, events, viewport heights) and the experiment queries. On Mellow they were the next 900 query seconds after the day queries. Storing them per day is a follow-up, measured in I5 on the two sites.
- The trigger lane's prior-purchase reads over the lookback (I4).

## Storage

The day store is a port, `src/ports/day-store.js`, with three adapters in `src/adapters/day-store/`:

| Adapter | Where | For |
| --- | --- | --- |
| `memory` | process memory | tests |
| `local` | one gzip JSON file per entry under a directory | a single machine; the default |
| `clickhouse` | `analysis.ae_scan_day` | runs that share a store across machines |

```sql
CREATE TABLE IF NOT EXISTS analysis.ae_scan_day (
  idsite UInt32,
  kind LowCardinality(String),          -- 'day' | 'page-facts'
  key String,                           -- '' for day rows; the idsitehsr for page facts
  server_date Date,
  version UInt16,
  final UInt8,
  shape String,                         -- JSON: {events, partnerTags}
  part UInt16,
  parts UInt16,
  rows UInt32,
  payload String CODEC(ZSTD(3)),        -- JSON rows, at most 8 MB per part
  generated_at DateTime64(3)
) ENGINE = ReplacingMergeTree(generated_at)
ORDER BY (idsite, kind, key, server_date, part)
TTL server_date + INTERVAL 400 DAY;
```

A read takes the parts of the latest `generated_at` for the entry and checks it has all of them. `ensure('ae')` creates the table with `CREATE TABLE IF NOT EXISTS`. As with Part P's migration, the adapter is tested on a fake client and the table is created on ClickHouse by the user. The default adapter is `local`, which writes nothing to the warehouse.

Config: `dayStore` in `analysis.config.json` (`{"adapter": "local", "dir": "...", "overlapDays": 2}`), with `ANALYSIS_DAY_STORE` (`local`, `clickhouse`, or `off`), `ANALYSIS_DAY_STORE_DIR`, and `ANALYSIS_DAY_OVERLAP`. The local default directory is `~/.cache/analysis-engine/day-records`.

## Phases

Each phase is a commit, or a few, on `scale/10-day-records`, merged into the initiative with `--no-ff`. A refactor records a characterization test on the old code first. A behaviour change writes its failing test first.

### I0. A day reads the same twice

Two reads of one day must give identical rows, or a stored day and a fresh read differ for reasons unrelated to the data.

- `daySql` takes `min(session_tags)` where it took `any(session_tags)`, and `max(revenue)` per order where it took `any(revenue)`.
- `parseDayRow` sorts each row's `hsrs`, `events`, `orders` (by `idorder`), and `arms`, and the scan sorts a day's rows by `idvisit`, so the order a visit closes in is fixed.
- `fetchSessionTags` takes each visit's smallest tag row. Today it keeps whichever row ClickHouse returns last, which made `campaign-weekly` differ between runs of the same window on Mellow (20,826, 20,910, and 21,656 rows).

This changes which tag a visit with several tag rows carries, so `campaign-weekly`, `campaign-coverage`, and `page-country` counts can move by those visits. A test with a visit that has two tag rows, returned in both orders, gives one answer.

### I1. The day store

The port, the three adapters, and one contract test that runs on memory, on a temporary directory, and on the ClickHouse adapter over a fake client. The contract covers a write and read, a part split, a newer write replacing an older one with more parts, a missing entry, and a version mismatch. The ClickHouse schema test and `ensure` gain the table.

### I2. The day-records source and the scan

- `src/scan/day-records.js`: `createLiveDayRecords(gateway, idsite)` and `createStoredDayRecords({live, store, idsite, finalThrough, logger})`, both with `day(day, {events, partnerTags})` and `pageFacts(day, pages)`.
- `scanDays` reads through a `records` source in place of the gateway, and `runSitePass` and `runPagePass` pass theirs. The spread queries stay on the gateway.
- The pass stats count the days served from the store, read live, and stored.

Tests: the shape rules (narrowing, widening, a dropped row), finality, within-run reuse, page facts per page with a page added between runs. And on `clickhouse local`, the handlers run a 20-day window and then a window shifted by 7 days on the first run's store. The second run stores the same rows as a full run of the shifted window, and reads only the new days and the overlap.

### I3. Composition

`loadConfig` gains `dayStore`. The engine builds the selected adapter, and the batch command and the orchestrator's `analysis` stage pass it to the handlers with `finalThrough` from the clock. The site and page pass logs and the site's analysis notes record the days stored and read.

### I4. Triggers

The trigger lane already replays from the store through I2. What remains is compute and the prior-purchase reads. Measured on the two sites in I5, then:

- if the trigger lane's Node time or the prior-purchase reads are a material share of a stored run, reuse final chains (a chain is final 14 days after its hit and never changes) and store the prior-purchase rows per day;
- otherwise they wait for the massive-site phase, with the numbers recorded.

### I5. Live acceptance, read-only

`scripts/scan-acceptance.mjs` gains `--window-start`/`--window-end` (for a site with no stored batch), `--day-store <dir>` (a local store in a scratch directory), and `--overlap-days`. A new `scripts/compare-rows.mjs` compares two runs' dataset rows by content and their trigger identities.

For Latico Leathers (idsite 1425) and Seat Cover Solutions (idsite 2501), each on its own, one heavy query in flight:

1. Window A, 30 days, on an empty store: time, queries, peak RSS.
2. Window B, 7 days later, on A's store: the days read live, time, queries.
3. Window B with no store: the reference. Every dataset row and every trigger hit and chain from step 2 equals step 3.
4. Window C, 7 more days, on the store: repeats step 2, to show the store keeps working run after run.

The warehouse is read through the read-only client, and persistence is in memory.

## As built

- I0. Besides the tag and revenue choices, three live reads outside the day record came back in arrival order, and the run-to-run compare found each: an experiment's tag surface (`inferSurface` now sorts its templates, pages, and arms), a selector's element label (`selector-weekly` takes the smallest non-empty label and role), and the recording sample (`recordings-sample` samples the smallest ids). Each has a test that feeds the rows in two orders.
- I1. `ae_scan_day` has an `ae_scan_day_current` view, as every ReplacingMergeTree table does. The schema counts are now 63 tables and 61 views.
- I2. The pass logs carry the source's counts (`records`: days stored and read live, page-days, entries written). One stored source serves both passes of a site state, so the page pass replays the site pass's live reads. Separate stages, each on a fresh state, each read the non-final days once.
- I3. The counts stay in the logs and the acceptance report. In the site's analysis notes they would make an incremental run's stored site row differ from a full run's. `ANALYSIS_DAY_STORE=off` turns the store off; the batch command passes it only with the day scan on.
- I4. Deferred to the massive-site phase. On Latico's incremental runs the prior-purchase reads are a few seconds (prior events 1.7 s in a 114 s run), and the largest warehouse cost left is the per-day `clicks:page` read (11 s over 30 calls).
- I5. `scripts/scan-acceptance.mjs` takes `--tag` for the output names and `--triggers-out on` for every hit and chain, last version by identity. Both sites ran on Latico's batch `bfb4544b` as the settings template, since Seat Cover has no stored batch.

Results, read-only, one site at a time (A 08-31..09-29, B 09-07..10-06, C 09-14..10-13; the clock is the window's last day, overlap 2):

| Site | Run | Days live / stored | Wall s | Compare with the full run |
| --- | --- | --- | --- | --- |
| Latico 1425 | A, empty store | 45 / 30 | 303 | |
| | B | 10 / 65 | 153 (full 321) | hits and chains equal; one row differed by template order, fixed |
| | batch window 09-11..10-10 | 7 / 68 | 118 (full 287) | hits and chains equal, and equal to the stored batch; 20 rows differed by label, fixed |
| | C | 6 / 69 | 114 (full 266) | hits and chains equal; one row differed by recording sample, fixed |
| | C again, all fixes | 3 / 72 | 113 (full 505) | 266,977 rows, 106,216 hits and chains, all equal |
| Seat Cover 2501 | A, empty store | 45 / 30 | 189 | |
| | B | 10 / 65 | 135 (full 225) | 553,037 rows, 72,688 hits and chains, all equal |
| | C | 10 / 65 | 146 (full 231) | 566,951 rows, 79,206 hits and chains, all equal |

Peak RSS stayed between 2.9 and 3.9 GB. The stores hold 110 MB (Latico, 80 days) and 85 MB (Seat Cover, 75 days).

The ClickHouse store, on `journey_events.ae_scan_day` after `ensure('ae')` created it (`--day-store clickhouse`; the run's client inserts into that table and nothing else):

| Site | Run | Days live / stored | Wall s | Compare with the full run |
| --- | --- | --- | --- | --- |
| Latico 1425 | A, empty store, then A again on its store | 4 / 71 on the repeat | 379 | |
| | B | 10 / 65 | 484 (full 530) | 297,761 rows, 119,586 hits and chains, all equal |

The store holds Latico's 52 days (08-16 to 10-06) in 716 MB of JSON parts. A day reads in 1.3 to 4.6 s, against well under a second from the local store, and these runs ran at a load average near 100, so the times are an upper bound. The gateway time of run B is 79 s, against 241 s for the full run. The local store stays the default for one machine; the ClickHouse store is for runs on several machines that share days.

## Decisions taken

- **Tag choice (I0).** A visit's smallest tag row, in the day record and in the per-page tag load, so runs repeat.
- **Bot tiers.** Unchanged. Tiers are computed each run over the window, as today, and applied to replayed rows.
- **The day cursor (D5).** Kept. It saves folder state within a run, and replaying stored days serves a resume once the cursor is over its cap.
- **Live writes.** The `local` adapter is the default. The ClickHouse table and its first writes are for the user to run.

## What stays the same

Batch rows, dataset ids, and every downstream reader. Predicate thresholds, report prose, naming, capture, and the styler. The folders, datasets, `qualifies`, and `chainOutcome`.
