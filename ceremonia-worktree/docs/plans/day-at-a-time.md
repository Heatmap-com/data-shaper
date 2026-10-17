# Day-at-a-time analysis

**Date:** 13 October 2026
**Status:** plan. Do not start it in the same change as this document.
**Reads with:** `docs/ARCHITECTURE.md` (ports, the dataset loop, checkpoints), `docs/TRIGGER-CHAINS.md` (predicates, chain identity, how far a run reads).

The reporting window stays 30 days. What changes is that a run no longer materialises those 30 days, plus the trigger lookback, as one object graph. One shared scan reads a day, every dataset folds that day into a counter or a small piece of visitor state, and the day's rows are dropped.

This is the change that makes a 32 GB machine able to finish a site the size of Mellow, and a site several times larger, on an 8 GB heap.

## What the month path does

`computeAeWindow` in `src/runner-ae.js` picks the last 30 complete UTC days. `RunContext` carries that pair as `windowStart` and `windowEnd`. Almost every session-level dataset then calls `fetchSessionRows` (`src/adapters/_lib/session-stream.js`), which runs one query for the whole pair and returns one JavaScript object per session.

The query joins visits, journey events, orders, and pageviews for every session in the window. Callers that pass `idsitehsr` also join that page's scroll and on-page time. Bot tiers are applied in JavaScript. The bot context itself is memoised on `ctx.batchNotes`. The session rows are not. Each caller issues the query again.

These callers each fetch the full window:

| Caller | What it reduces the sessions to |
| --- | --- |
| `prefer-non-home` | Entry sessions, orders, and revenue per URL |
| `default-six` | The same totals, plus channel mix, when more than one page is selected |
| `entry-by-channel` | Sessions, orders, revenue, single-pageview count per entry page and referrer |
| `page-country` | Sessions by country |
| `sister-pages` | Entry totals used to name sisters |
| `site-baselines` | Site-wide rates |
| `campaign-weekly`, `campaign-coverage` | Campaign cells, joined to the raw `session_tags` map |
| `journey-weekly`, `funnel-sequence-weekly`, `forms-weekly` | Funnel and form cells |
| `exposure-weekly`, `dwell-model-inputs`, `scroll-decile` | Page exposure, time, scroll |
| `viewport-weekly`, `selector-weekly`, `tap-geometry-weekly`, `nav-next-page`, `rage-clicks` | Geometry and click cells, joined to raw click rows |
| `product-grid` | Entry sessions on the chosen page, joined to raw clicks |
| `experiments-weekly` | Orders and revenue joined onto partner-tag assignments |

`page-segment-weekly` does not call `fetchSessionRows`. It pastes the same CTEs into its own query and adds the dominant viewport, still over the whole window.

`fetchSessionTags` (`src/adapters/_lib/session-tags.js`) is memoised, and it still loads every non-empty `udp_session_tags` blob in the window into a `Map` keyed by `idvisit`. `getClickRows` is memoised per page, and it still returns one object per click on that page for the whole window.

### The trigger load is a second copy of the month

`trigger-chains` does not use `fetchSessionRows`. `loadTriggerFacts` in `src/triggers/load.js` reads visits, pageviews, clicks, events, orders, and tags itself.

`factWindow` starts the fact read at `windowStart - (chain_window_days + window_days)`. Both shipped windows are 14, so a 30-day batch reads 58 days of visit facts. Prior purchase is a further read, from 365 days before that start through the day before it, and only sessions that purchased. That prior read stays.

On Mellow (idsite 4879, batch `6b5f8c7f-1ff8-46cf-9279-ef04a69a61c4`, window 2026-09-11 through 2026-10-10) the fact queries returned:

| Query | Rows |
| --- | --- |
| `trigger-chains:visits` | 9,905,198 |
| `trigger-chains:pages` | 12,578,928 |
| `trigger-chains:tags` | 7,841,833 |
| `trigger-chains:clicks` | 4,544,664 |
| `trigger-chains:events` | 2,069,447 |
| `trigger-chains:orders` | 266,365 |
| `sessions:entry` | 4,659,744 |

Page rows are already grouped by `(idvisit, idsitehsr)`. Click rows are already grouped by `idvisit`. Tag rows are one JSON blob per visit. The process holds all of them at once, then `assembleSessions` builds a session object per visit, including the parsed tag blob and the per-page map.

`collectTriggerWindow` then walks every day of the batch. Each day calls `buildTriggerBatch`, which groups every session by date and rebuilds the full `config_id` index, then walks every visitor for Super-Shopper. A 30-day window does that 30 times over the same array. The checkpoint for `trigger-chains` is written after `collect` returns, so a run that dies inside this walk resumes from nothing.

Mellow's attempt 7 died here with a 24 GB heap (`Ineffective mark-compacts near heap limit`). Attempt 10 died later, writing the chain rows, with `Invalid string length` inside the ClickHouse encoder. The 50,000-row chunks in `writeTriggerBatch` fixed the write. They do not shrink the classify step.

### One fat pull that is not the session stream

`experiments-weekly` selects every `udp_partner_tags` row in the window (`experiments-weekly:partner-tags`) so it can apply bot tiers in JavaScript. On that same Mellow attempt the query returned 39,463,316 rows. The cells it actually stores are per Monday week, experience, and variant. `experiment-analysis` is already aggregated (`experiment:facts` returned 39,674 rows on a later attempt) and is not this problem.

### What a dataset checkpoint does not cover

`runSite` in `src/runner-ae.js` checkpoints per `(idsitehsr, dataset id)` after `collect` returns. Resume skips a finished dataset. It cannot resume a dataset that died mid-query or mid-fold, and it cannot share one scan across datasets, because each `collect` owns its own read.

## What stays

The 30-day measurement window stays. `ae_dataset_row`, `ae_trigger_hit`, `ae_trigger_chain`, and `ae_trigger_definition` stay at the same grain. `queryTriggerTrends` stays the read path.

These stay as pure functions, called on one session or one visitor's open window, never on the month array:

- `abandonedCart`, `showedInterest`, `superShopper`, `qualifies`, `chainOutcome` in `src/triggers/evaluate.js`
- `resolveDefinitions` and the predicate stamp in `src/triggers/definitions.js`
- Shipped thresholds in `src/triggers/defaults.json`
- Catalog ids, descriptor JSON, and `dependsOn`
- The checkpoint key `(batch, idsite, idsitehsr, dataset id)`
- Bot tiers. `getBotContext` stays a grouped fingerprint query, memoised once per site. `applySafety` still runs per session. The fleet-wide zero-order scan stays off (`bot_fleet_scan: 'not_run'`).
- The prior-purchase read. It stays a lookup of purchase sessions over `prior_purchase_lookback_days`, not a day scan of every visit in that year.
- One site in flight against ClickHouse, and one or two queries in flight. A day scan that fans out across adapters recreates the 28.51 GiB ceiling seen on Jormands.

A rerun of the same day with the same sessions still produces the same hits and chains. Identity remains `(idsite, trigger_key, server_date, idvisit, config_id)`.

## The scan

One new module, `src/scan/day-scan.js`, owns the read. The runner calls it once per site. Adapters do not call `fetchSessionRows`, `fetchSessionTags`, or `getClickRows` for a window read.

```text
for each day from factStart through windowEnd:
    read that day's visit facts (one query family, one or two queries in flight)
    close visits whose rows are finished
    hand closed visits to every registered folder
    drop the day's rows
write each folder's dataset rows
write the day cursor
```

`factStart` is the trigger preface: 28 days before `windowStart` with the shipped predicates. Folders whose totals are the reporting window ignore a day before `windowStart`. The trigger folder uses those days to fill the 14-day visitor window and to refresh chains that are still open. A site with no active visitor trigger and no chain window can start at `windowStart`. The shipped three triggers cannot.

Thirty shared day reads replace about twenty full-window session scans plus the seven trigger fact queries. A loop inside each adapter, each re-reading the day, multiplies the query count by the number of adapters and is the shape this plan rejects.

### The day record

ClickHouse returns one row per `idvisit` that has any fact on that `server_date`. The row is already the session the predicates and the weekly cells read. Node does not see pageview rows or tag JSON.

| Field | How it is reduced in SQL |
| --- | --- |
| `idvisit`, `server_date`, `started_at`, `config_id` | `min(server_date)`, `argMin` on `visit_first_action_time`, same as `visitsSql` today |
| device, referrer, returning, country, entry page, utm source, fingerprint hash, browser | `argMin` on the same columns `VISITS_CTE` already uses |
| `saw_product`, `saw_atc`, `saw_checkout`, `saw_purchase`, and the event-type set the triggers name | `max` / `groupUniqArray` of `event_type` filtered to the predicate list |
| orders, revenue | the existing `ORDERS_CTE` dedup, one row per `(idvisit, idorder)` |
| pageviews | `uniqExact(idsitehsr)` |
| capped time, scroll | sum of per-page time each capped at `TIME_ON_PAGE_CAP_MS`, max `scroll_y_max_relative` |
| clicks | `count()` from `udp_clicksce_clicks` |
| product pages | `groupUniqArray` of `idsitehsr` whose `site_hsr` URL classifies as `product` |
| medium | the tag value whose key matches `/medium/i`, extracted in SQL. The rest of `session_tags` is not selected |
| dominant viewport height | one height per visit, so `page-segment-weekly` can drop its private copy of the session query |

`site_hsr` URLs are a small lookup, already loaded by `fetchHsrPages`. Product-page classification can run in Node over that lookup and the visit's product-page ids. Those ids are a handful per visit. They are not the 12 million `(idvisit, idsitehsr)` rows.

Bot tier is applied when the visit is closed, from the memoised fingerprint map. A session with add-to-cart, checkout, or an order is still never flagged.

### A visit that crosses midnight

Today's window query groups by `idvisit` across the whole range, so a visit with rows on two `server_date` values becomes one session dated on `min(server_date)`, and its pageviews and events from both days are included.

A query for a single `server_date` splits that visit. The scan keeps an open-visit map keyed by `idvisit`.

- Rows for the day merge into the open visit. Sums add. Maximums take the max. Sets union. `server_date` on the session stays the first day seen.
- A visit closes when a later day has been read and the visit received no row on that day, or when the window ends.
- Closed visits are handed to the folders and removed from the map.

The open map holds the visits that touched the current day and the previous day. It does not hold the month. A visit whose rows span more than one quiet day would close early. Before the hold is fixed at one quiet day, measure the maximum `server_date` span per `idvisit` on Mellow. If that span is longer than a day, the hold is that span, not a guess.

Days before `windowStart` still close and are handed to the trigger folder. Reporting folders drop them.

### Two passes, both shared

The chosen page is not known until the qualifier has entry totals. Those totals come from the site pass, so the qualifier and the page selector no longer fetch sessions.

1. **Site pass.** One row per visit per day, fields in the table above. Qualifier, page selector, site datasets, and any page dataset that only needs the session row fold this pass.
2. **Chosen-page pass.** After the page is chosen, one day loop for that `idsitehsr`: scroll, on-page time, and the click rows that geometry datasets actually aggregate (selector, x, y, week). `scroll-decile`, `dwell-model-inputs`, `rage-clicks`, `selector-weekly`, `tap-geometry-weekly`, `nav-next-page`, and `product-grid` share it. Click rows are folded into weekly selector cells inside the day. They are not kept for the month.

`primary-only` selection (`maxPages = 1`) skips the sister scan inside `default-six` today. It still needs the site pass, because the qualifier does.

## Folders

A folder is the part of a dataset that today walks the session array. `collect` becomes three calls. Discovery is unchanged: a dataset file still exports `adapter`, and a folder is extra methods on that same object. Datasets that never read the session stream keep a normal `collect`.

```js
{
  id: 'entry-by-channel',
  open(page, ctx) {},
  fold(day, visits) {},
  finish() { return { id, rows, notes, requirements } },
}
```

`fold` receives visits closed on that day. Each visit is the day record after bot safety. `finish` applies the dataset's existing caps (the top 25, the 20-session floor, the chosen page kept even when small) and returns the same `{ id, rows, notes }` that `collect` returns now.

Sums, counts, and distinct-page counts add. Rates, ranks, and top-N are computed in `finish`, when the window is complete. A folder that needs a percentile keeps a histogram or a reservoir, sized to the number of bins, not to the number of sessions.

`ctx.datasets` still carries finished datasets for `dependsOn`. The runner calls `finish` in the existing topological order, after the scan. A folder that reads another dataset's rows does so in `finish`, which runs after that dependency has finished.

### Which datasets fold

**Site pass.** `prefer-non-home`, `default-six`, `entry-by-channel`, `page-country`, `sister-pages`, `site-baselines`, `campaign-weekly`, `campaign-coverage`, `journey-weekly`, `funnel-sequence-weekly`, `forms-weekly`, `exposure-weekly`, `experiments-weekly` (the order and revenue join), `page-segment-weekly`, `trigger-chains`.

**Chosen-page pass.** `scroll-decile`, `dwell-model-inputs`, `viewport-weekly` if the site pass did not already carry the height, `selector-weekly`, `tap-geometry-weekly`, `nav-next-page`, `rage-clicks`, `product-grid`.

**Leave as one window query.** The result is already a small aggregate or a capture snapshot: `coverage`, `custom-event-inventory`, `line-items`, `order-value-hist`, `recordings-sample`, `page-speed`, `render-snapshot`, `descriptor-snapshot`, `element-binding`, `saliency`, `template-weekly`, `kind-fleet-weekly`, `card-history`, `ad-creative`, `tool-registry`, `strategy-triggers`, the card adapters, `requirement-status`, `experiment-analysis` (its SQL is already grouped; see the fat-pull rule below).

`product-grid`'s 120-day template start is already `dailyCounts`, one small series per block. That query stays. The session fetch and the raw click fetch inside the same adapter move onto the two passes.

### Fat pulls

A query that returns one row per fact, rather than one row per visit or one row per cell, is folded or aggregated. Three of them matter.

**Partner tags, `experiments-weekly`.** The stored grain is `(week, experience, variant)` with assignment counts per bot tier, plus orders and revenue. The day query groups to `(experience, variant, idvisit)` for that day. The folder adds the visit into the week cell once, using the visit's tier from the site pass. The `Set` of every `idvisit` in the month is the memory cost. Deduping a visit that is tagged on two days needs a set per open week cell, not a set for the whole history: when the week closes, the set is dropped and the counts remain. A week cell whose set would dominate the heap is counted with `uniqExact` in SQL for that week instead, and the session join is only the visits that ordered.

**Session tags.** Medium is a column on the day record. `campaign-weekly` and `campaign-coverage` fold the dimensions they read off the tag (source, campaign, the keys they already parse) as columns extracted in SQL. The JSON blob is not loaded.

**Page clicks.** The chosen-page pass groups to the cell the dataset emits (selector and week, or decile, or grid slot) plus the visit id for the order join. The order join uses the site-pass visit, which is still in hand only for visits closed that day. The click's orders and revenue are copied onto the cell that day and the click row is dropped.

`experiment-analysis` queries `udp_partner_tags` over `SCAN_DAYS` (60) through grouped SQL (`tagDaysSql`, `tagSurfaceSql`, `experimentFactSql`). Those stay grouped. If a later edit selects raw tag rows for that adapter, the same day rule applies. The 39 million row pull is `experiments-weekly`, not this adapter.

## Trigger state

`buildTriggerBatch` and `collectTriggerWindow` rebuild the world each day because they are pure functions of the full session array. The production path stops calling them with that array. The functions stay for tests that pass a fixture of a few sessions.

The production folder walks days from `factStart` through `windowEnd`, oldest first. After each day it holds only this:

**Per `config_id`, the sessions still inside the visitor window.** A compact record per session: `idvisit`, `serverDate`, `startedAt`, whether it passed Showed Interest, whether it contained `atc_event`, the product-page ids, whether it purchased, orders, revenue. Blank `config_id` is not entered. A blank id does not chain, which is the rule in `chainOutcome` today. Records older than `window_days` (14) are dropped at the start of each day.

**Per `config_id`, the hits whose chain window is still open.** Each hit stores the dimensions `hitFrom` already stores, plus the running chain fold: later-session count, whether any later session exists, the index of the first later purchase, purchased, revenue sum, the purchasing session's `startedAt`. `chainOutcome` is the definition of that fold. Updating it with one new later session is the same arithmetic the filter in `chainOutcome` performs, applied to one session instead of a rescan. A hit leaves this list when `asOf` reaches `window_closes`. It is written with `final: 1`. Until then it is written with `final: 0` and replaced on the next day, which `ReplacingMergeTree(generated_at)` already does.

**Prior purchases, by `config_id`.** Loaded once, before the day loop, by the existing `loadPriorPurchases` query. The map stores the purchase date and the fact of the purchase, not the visit's pages. Super-Shopper's prior-purchaser clause reads that date: the purchase is strictly before the first Showed Interest session in the 14-day window, and within `prior_purchase_lookback_days` of `asOf`. Purchase sessions inside the fact window are already on the compact session record.

Super-Shopper for a day is `superShopper` over that visitor's compact sessions and the prior-purchase date. The predicate is not reimplemented.

Session triggers (`abandoned_cart`, `showed_interest`) test the closed visit and append a hit. The hit's chain starts empty. Later days of the same `config_id` update it.

Hits for the day are written at the end of the day, in the existing 50,000-row chunks. Chains that changed that day are written the same way: new hits, and open hits that gained a later session or that closed. A day no longer accumulates 963,425 chain objects and encodes them in one insert. Mellow's attempt 10 died on that insert.

The last day of the batch still refreshes hits from before `windowStart` that are open, which is the rule `collectTriggerWindow` documents. Those hits were created on preface days and live in the open list.

### Memory this state actually holds

For a reporting day the process holds:

- the open-visit map, about one day of visits plus the previous day's stragglers
- the folder cells (weekly counters; small)
- the trigger visitor window: compact sessions for visitors seen in the last 14 days, and the open hits

Mellow's batch produced 963,425 hits and the same number of chains across the whole window. The open set on any one day is the hits whose 14-day window has not closed, which is a fraction of that, plus 14 days of compact session records. That is a few hundred megabytes for Mellow. A site at three times Mellow's sessions, which is the top of the paying list, stays under a gigabyte if the compact record stays the fields listed above. The 12 million page rows and the 8 million tag blobs are the objects this state does not contain.

The heap target for the acceptance run is 8 GB (`--max-old-space-size=8192`). The 32 GB machine has room for the process, the browser that naming uses, and the operating system. The heap is not set to 24 or 32 GB.

## Runner

`runSite` gains one scan step in place of the per-dataset session reads.

1. Traffic exclusion, as today, checkpointed.
2. `getBotContext` once.
3. Prior-purchase lookup once.
4. Site pass from `factStart` through `windowEnd`. Qualifier folder and page-selector folder fold with the datasets. After the pass, `finish` the qualifier and select pages. A page that fails the volume gate (`minHits` 100) skips the page pass, as it does today.
5. Chosen-page pass, one page at a time when several targets were selected. `primary-only` is one page.
6. `finish` page folders, then site folders, in dependency order. `commitCollected` and the dataset checkpoint run here, unchanged.
7. Descriptors, requirement status, and cards, unchanged. They read finished datasets from `ctx.datasets`.

`fetchSessionRows` remains for tests and for a dataset that has not moved yet. A moved dataset does not call it. The migration is done when a production `collect` path has no full-window session fetch. `rg fetchSessionRows src` should find tests and the deprecated helper, not adapters.

### Day cursor

The dataset checkpoint still means "this dataset's rows for the batch are written." In addition, the scan writes a cursor after each day: `(batchId, idsite, day, pass)` plus the folder snapshots that are expensive to rebuild. The trigger open-hit list and the open week-cell sets are those snapshots. Weekly counters are cheap to rebuild and can be recomputed from the cursor's day by replaying earlier days. Replaying 14 days is the recovery path if a snapshot is missing. Replaying 58 days of a top site is what the cursor exists to avoid.

A resume loads the cursor and starts at the next day. Days already committed are not read again. Trigger rows for a resumed day are replaced by `generated_at`, so a day that was written and then retried converges.

The cursor lives in the same checkpoint table, with a dataset id of `day-scan`, `idsitehsr` 0, and the day and the snapshot reference in `notes`. It is not a new table.

## ClickHouse

Each day is one site and a single `server_date`. The fact-table guard is unchanged: `{idsite}` is required. The query-bounds rule is unchanged: every fact alias carries `idsite` and `server_date`.

The day query is one statement, or two when the chosen-page pass runs, not one statement per adapter. Labels stay specific (`day-scan:visits`, `day-scan:page`). `max_execution_time` stays.

Two analysis processes share that budget. One query in flight is the safe default. A second is allowed when the first is a small aggregate (the prior-purchase lookup, `site_hsr`, bot fingerprints). Two heavy day scans at once are the Jormands failure. The queue already runs one site at a time per worker. A second machine folds days that this machine has already fetched, or it waits. It does not open its own scan of a second giant.

Query count per site, shipped triggers, 30-day window:

| Read | Count |
| --- | --- |
| Bot fingerprints and the version lookback | the queries `getBotContext` already runs, once |
| Prior purchases | the three purchase-only queries, once |
| Site pass | 58 days (28 preface + 30) |
| Chosen-page pass | 30 days, and only for pages that were selected |
| Left-as-is aggregates | however many they issue today, each returning a small result |

The preface days are trigger state. They are not a second copy of the reporting datasets.

## Acceptance

Unit tests, no ClickHouse:

- A fixture window that includes a visit with rows on two dates folds to the same session `fetchSessionRows` would have built, and to the same `assembleSessions` fact.
- `entry-by-channel` cells over the fixture match a fold of the same visits.
- A scripted visitor across 20 days produces the same hits and chains as `collectTriggerWindow` on the full array: the 14-day edge, a chain that closes inside the batch, a chain still open on the last day, a blank `config_id`, a prior purchase before the first Showed Interest session, and a purchase on the hit day that does not count as a later purchase.
- A resume from day 10 replays nothing before day 10 and replaces day 10's chain rows rather than duplicating them.

One live site, before any fleet run:

- Mellow, same window as batch `6b5f8c7f-1ff8-46cf-9279-ef04a69a61c4`, heap capped at 8 GB, one query in flight.
- The run finishes. Peak RSS stays under 8 GB.
- Trigger hit and chain counts match the stored batch (963,425 of each on the successful attempt). A sample of chain identities matches field for field, including `final` and `revenue`.
- `entry-by-channel` and `experiments-weekly` row counts match the stored datasets for that batch.
- `experiments-weekly` does not log a partner-tag result in the tens of millions of rows.

Loaded Tea (idsite 5769, about 15 million sessions in the same calendar window) is the second live site. It is the one that does not fit a 32 GB heap if memory scales with the month array. The 8 GB cap applies there too.

## Order of work

Each step is shippable on its own. Later steps depend on earlier ones.

1. **Day record and visit close.** `src/scan/day-scan.js` reads one day and closes visits. A test proves midnight visits match the window query. No adapter moves yet.
2. **Runner scan, reporting folders.** Qualifier, page selector, and the site-pass datasets fold the shared scan. `fetchSessionRows` stays until each caller has moved. Trigger-chains stays on `loadTriggerFacts` for this step.
3. **Trigger folder.** Incremental visitor state, day writes of hits and changed chains, prior-purchase map. `collectTriggerWindow` remains for fixtures.
4. **Fat pulls.** `experiments-weekly`, session-tag columns, chosen-page click fold.
5. **Day cursor.** Resume from the next day. The dataset checkpoint behaviour is unchanged.
6. **Mellow at 8 GB, then Loaded Tea at 8 GB.**

## Non-goals

- Changing the 30-day reporting window, the 14-day chain, the 14-day visitor window, or the 365-day prior-purchase lookback.
- Editing predicate thresholds, catalog rules, or report prose.
- A per-adapter day loop.
- Running two heavy scans at once, on one machine or across two.
- Raising the heap, caching the month on disk, or compressing the session array in place.
- Turning the fleet bot scan back on.
- Changing naming, capture, or the report styler.
