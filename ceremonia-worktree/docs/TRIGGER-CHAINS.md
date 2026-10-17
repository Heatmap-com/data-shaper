# Trigger-based chained session analysis

**Date:** 10 October 2026
**Code:** `src/triggers/`, `src/adapters/datasets/trigger-chains.js`, `ae_trigger_*` in `src/persistence/schema2.sql`

A trigger is a named rule that marks a session or a visitor. For every hit, the same visitor's later sessions are followed for a configurable number of days, and the return and purchase outcome is stored on the hit. Every trigger is reportable by week, with week-over-week deltas and any combination of the stored dimensions.

"High intent" is no longer a single hardcoded concept. It is the Abandoned Cart trigger. Showed Interest and Super-Shopper ship beside it. A new trigger whose predicate is one of the three types below is a config row.

## What a run produces

One site batch does three things.

1. It resolves the trigger definitions for that site, including any site override, and records the version that the thresholds imply.
2. It writes one `ae_trigger_hit` row for each session or visitor that qualifies on each day of the batch window.
3. It writes one `ae_trigger_chain` row per hit in the batch window, evaluated on the day the chain window closes, or on the batch's last day when that window is still open. The last day also refreshes hits from before the window that are still open. `final` is 0 until the window's last day has been reached. A later day replaces that row.

The same day with the same sessions produces the same hits and chains. Identity is `(idsite, trigger_key, server_date, idvisit, config_id)`. A rerun replaces the row because the tables are `ReplacingMergeTree(generated_at)`.

Rates are not stored. `queryTriggerTrends` computes them from hits, chains, and the sessions in the segment.

## The three triggers

Shipped thresholds are in `src/triggers/defaults.json`. Evaluators read those fields. A missing field throws. Nothing in `evaluate.js` repeats the numbers.

### Abandoned cart — `abandoned_cart`, level `session`

Predicate type `session_events`. This is the high-intent rule, renamed.

A session qualifies when it has any event in `intent_events` and it has not purchased. The shipped intent events are `add_to_cart` and `checkout_started`. A purchase is any event in `purchase_events` (`checkout_completed`), and an order when `purchase_also_counts_order` is true. Orders come from `udp_conversions`, deduplicated to one row per `(idvisit, idorder)`.

The minimum statement of this rule is "an `add_to_cart` and no purchase." Checkout start is in the shipped list because the analysis this trigger renames counted it as intent. It is a config value. A site removes it by replacing `intent_events`.

`recover` is true only on this trigger. `recovered` on the chain is `recover && purchased`. Other triggers still record `purchased`; their `recovered` stays 0.

`chain_window_days` defaults to 14.

### Showed interest — `showed_interest`, level `session`

Predicate type `session_interest`. A session qualifies when either side is true. Every comparison is strictly greater-than.

- Distinct pages viewed > `min_pages` (default 3), or
- clicks > `min_clicks` (default 3), and max scroll > `min_scroll_pct` (default 50), and duration > `min_duration_sec` (default 60).

Exactly 3 pages, exactly 3 clicks, exactly 50 percent scroll, or exactly 60 seconds does not qualify. Four pages qualifies on its own, with no clicks.

Pages viewed are distinct `idsitehsr` values. Two pageviews of the same page count once. Scroll depth is the maximum `scroll_y_max_relative` on any page in the session. That column is on a 0–1000 scale; the fact layer divides by 10, so 500 is 50 percent and does not pass, and 510 is 51 percent and does. Duration is the sum of per-page time in seconds. Each page is capped at 1,800,000 ms before the sum, the same cap as the rest of the session stream (`TIME_ON_PAGE_CAP_MS`).

### Super-Shopper — `super_shopper`, level `visitor`

Predicate type `visitor_window`. A visitor qualifies on a day when they have a session that day and the rolling window ending that day matches all of the following. The window is inclusive: a session exactly `window_days` before the day counts, and a session one day further back does not. Default `window_days` is 14.

- Distinct sessions ≥ `min_sessions` (default 2).
- Sessions that pass the named `interest_trigger` ≥ `min_interest_sessions` (default 1). The shipped name is `showed_interest`, and the test uses that trigger's current predicate, so a threshold edit there changes who qualifies here.
- Either sessions containing `atc_event` ≥ `min_atc_sessions` (default event `add_to_cart`, count 1), or distinct product pages ≥ `min_product_pages` (default 3). A product page is an `idsitehsr` whose `site_hsr` URL classifies as `product` in `src/page-type.js`.

A prior purchaser also qualifies when they return and trigger Showed Interest, without the cart or product-page clause. The purchase has to fall strictly before the earliest Showed Interest session in the window, and within `prior_purchase_lookback_days` (default 365) of the day being judged. What counts as a purchase is the predicate of `purchase_trigger` (shipped: `abandoned_cart`).

The visitor key is `config_id` on `udp_hsrce_visits`. Sessions with a blank `config_id` are not grouped, and a blank id does not chain to another blank id. `config_id` is a browser id: a person on two devices can be two visitors. D-02 still holds for `udp_hsrce_pageviews.visitor_id`, which is one value per visit. This feature does not use that column, `visitor_count_visits` (stuck at 1 on current rows), or `visit_goal_buyer`.

The hit's dimensions come from a session on the qualifying day. A Showed Interest session that day is preferred. Otherwise the latest session that day is used.

## The chain

`chainOutcome` in `src/triggers/evaluate.js` is the same function for every trigger key. Later sessions are those that share `config_id`, start after the hit, fall on a day from the hit date through `chain_window_days`, and fall on or before the batch's `asOf`. Sessions after `asOf` are not visible yet; the next day's run picks them up.

| Field | Meaning |
| --- | --- |
| `returned` | At least one later session in the window |
| `sessions_until_return` | 1 when any later session exists, otherwise 0. The next session is the return |
| `sessions_until_purchase` | 1-based index of the first later purchasing session, otherwise 0 |
| `purchased` | A later session purchased, using the purchase predicate |
| `revenue` | Sum of `revenue` on later sessions in the window |
| `seconds_to_purchase` | Seconds from the hit's `visit_first_action_time` to the purchasing session's, otherwise 0 |
| `recovered` | The hit's predicate has `recover: true` and `purchased` is true |
| `window_days`, `window_closes` | The predicate's window, and the hit date plus that many days |
| `final` | `asOf` is at least `window_days` after the hit |

Purchase for every chain is the active trigger that defines `purchase_events`. If none is active, the shipped Abandoned Cart predicate is used.

## Versions

`resolveDefinitions` in `src/triggers/definitions.js` merges three sources, in order:

1. The shipped file.
2. Predicate patches in `overrides` (a site's stored predicate, or a caller patch).
3. Triggers that exist only in `recorded` rows. That is how a trigger of a known type is added with no code change.

A canonical JSON stamp of the predicate is compared with the stamp already stored. An equal stamp keeps the stored version. A different stamp increments the stored version, or the shipped version when nothing is stored yet. Turning `active` off drops the trigger and does not by itself bump the version.

Super-Shopper's stamp includes the predicates named by `interest_trigger` and `purchase_trigger`. Editing Showed Interest's thresholds bumps Super-Shopper even when Super-Shopper's own JSON is unchanged. Hits store `trigger_version`, so a week that contains two versions, or a week whose version differs from the aligned prior week, is flagged by `versionChanged`.

## How far back a run reads

`factWindow` in `src/triggers/load.js` sets the read range from the predicates.

- Session facts (visits, pageviews, clicks, events, orders, tags) run from `windowStart - (chain_window_days + window_days)` through `windowEnd`. The chain window and the visitor window both have to be in hand so an open hit can be recomputed.
- Purchase sessions only, from `prior_purchase_lookback_days` before that start through the day before it. Those rows carry events and orders and no page counts, so they cannot qualify as Showed Interest by themselves. They exist so the prior-purchaser clause can see a purchase outside the 14-day window. The shipped lookback is 365 days. That is a year of purchase visits per site per batch.

Event names in the SQL `IN` list are collected from `intent_events`, `purchase_events`, and `atc_event`. The filter is that list.

## Facts

`assembleSessions` in `src/triggers/facts.js` turns the query rows into the object the predicates read.

| Fact | Source |
| --- | --- |
| `idvisit`, `serverDate`, `startedAt`, `configId` | `udp_hsrce_visits`, grouped by `idvisit`. `startedAt` parses `visit_first_action_time`, including the fractional suffix `toDateTime` rejects |
| `device`, `channel`, `returning` | `config_device_type`, `referer_type`, `visitor_returning`, through `deviceName`, `refererName`, `returningName` |
| `source` | the session tags' `utm_source`, else `custom_var_k5` |
| `medium` | A key matching `/medium/i` in `udp_session_tags`. Blank when the tag is absent |
| `country` | `location_country` |
| `landingPage`, `entryTemplate` | Entry `idsitehsr` joined to `site_hsr.screenshot_url`, then `pageType` |
| `events` | `journey_events_map` event types |
| `orders`, `revenue` | `udp_conversions` |
| `pageviews`, `scrollPct`, `durationSec`, `productPages` | `udp_hsrce_pageviews`, as described under Showed Interest |
| `clicks` | Row count from `udp_clicksce_clicks` |

`visitor_returning` is partial before 2026-09-07 (`RETURNING_ERA_SPLIT`). Those rows are still classified. A comparison that crosses that date is partial.

Channel names follow the measurement contract: 1 direct, 2 search, 3 website, 6 campaign, 7 social. Device names are desktop, tablet, mobile.

## The batch

`buildTriggerBatch({ asOf, idsite, sessions, overrides, recorded })` is pure. It does not talk to ClickHouse.

For each active definition it walks every day from `asOf - chain_window_days` through `asOf` and collects hits. The returned `hits` are only the `asOf` day, which is the incremental write. The returned `chains` are every hit in that open span, recomputed as of `asOf`. A chain that closed on an earlier day is not emitted again, so the last final write stands.

Session triggers test the session. Visitor triggers group by `config_id`, require a session on that day, and test the group.

The site adapter `trigger-chains` (`scope: 'site'`) is the daily job. `collect` loads recorded definitions, loads facts, assembles sessions, and calls `collectTriggerWindow` for `windowStart` through `windowEnd`. Hits are the union of those days. Each hit inside the window keeps the latest chain that still includes it, so a window that closed on an earlier day of the batch is stored as final instead of being dropped. The batch's last day also refreshes chains that started before `windowStart` and are still open; when the batch is a single day, that is the whole chain set. When `ctx.persistence.writeTriggerBatch` exists, the definitions, hits, and chains are written. The dataset rows are one per chain, so the outcome also lands in `ae_dataset_row`. Notes on the dataset record the definition versions, the lookback, and how many chains are still open.

`ae_trend_row` is a different grain: one segment per row, Monday weeks, and a fixed segment list. Device × channel trigger rates do not fit it. They stay on `queryTriggerTrends`.

## The read path

`queryTriggerTrends`, `listTriggers`, and `getTrigger` are exported from `src/adapters/datasets/trigger-chains.js`. That module is the import for the MCP, FACETs, and the dashboard. The query function itself does not open ClickHouse. The caller passes hits, chains, and sessions, normally from `readTriggerHits`, `readTriggerChains`, and the session facts.

```js
queryTriggerTrends({
  site_id,                         // alias of idsite
  trigger_key,
  date_range: { start, end },
  segment_by: ['device', 'channel'],
  filters: {},
  granularity: 'week',
  hits, chains, sessions,
})
```

`granularity` other than `week` throws. Weeks start Monday, UTC, the same rule as `ae_trend_row`.

A week that the range only partly covers is compared with those same weekdays of the previous week. Monday through Wednesday is compared with the previous Monday through Wednesday. Thursday of the previous week is not in that baseline. The caller has to pass the previous week's hits and sessions when the first week in range needs a delta. A percent delta whose baseline is zero is null.

Each output row is one week and one combination of segment values:

| Metric | Definition |
| --- | --- |
| `hits` | Hit rows in the aligned days |
| `sessions` | Distinct `idvisit` in the segment on those days |
| `hitRate` | hits ÷ sessions |
| `conversionRate` | chains with `purchased` ÷ hits |
| `recoveryRate` | chains with `recovered` ÷ hits |
| `revenue` | Sum of chain revenue |
| `rps` | Chain revenue ÷ sessions in the segment |
| `wow` | Absolute and percent delta versus the aligned prior week, for hits, hit rate, both rates, revenue, and RPS |
| `triggerVersions`, `versionChanged` | Versions on the week's hits. Changed when the week has more than one, or when a version was absent from the aligned prior week |
| `partial` | The week has fewer than seven aligned days inside the range |

Stored dimensions, usable together in `segment_by` and as equality `filters`: `device`, `channel`, `source`, `medium`, `returning`, `country`, `landingPage`, `entryTemplate`. `idvisit` is an allowed filter. Any other key throws, with the instruction to join it from the visit on `idvisit`. That join is what "arbitrary segmentation" means: the hit keeps `idvisit` so a dimension that was not denormalized is still reachable.

`listTriggers()` and `getTrigger(key)` return `{ key, name, level, version, active, predicate }` for the shipped definitions, with an optional override patch.

## Tables

Applied by `ensureAeSchema` from `src/persistence/schema2.sql`. There is no separate migration file. Each table has a `_current` view that reads `FINAL`.

`ae_trigger_definition` — `ReplacingMergeTree(generated_at)`, order `(idsite, trigger_key, version)`. `predicate` is a JSON string. `idsite` 0 is the shipped default. A row for a real `idsite` overrides that key for the site. The table is reference data: it is exempt from `AE_FACT_TABLE_RE`.

`ae_trigger_hit` and `ae_trigger_chain` — order `(idsite, trigger_key, server_date, idvisit, config_id)`. The requested prefix is the first three columns. `idvisit` and `config_id` follow so two hits on the same day are not collapsed. Both tables are per-site facts and are included in `AE_FACT_TABLE_RE`.

Warehouse names are `idsite`, `idvisit`, `config_id`, and `server_date`. The request's `site_id`, `session_id`, `visitor_id`, and `date` are those columns. `queryTriggerTrends` accepts `site_id` as an alias of `idsite`.

`writeTriggerBatch` on the memory and ClickHouse persistence adapters replaces definitions, hits, and chains on that identity. Reads of definitions return the latest version per key, and a site row wins over `idsite` 0.

## Adding a trigger

A new predicate type needs code in `qualifies`. A new trigger of an existing type does not.

The types are `session_events`, `session_interest`, and `visitor_window`. A config row supplies `name`, `level` (`session` or `visitor`), `version`, `active`, and a predicate that includes `chain_window_days`. A `visitor_window` also names `interest_trigger` and `purchase_trigger`, which must be active definitions.

Insert the row. The next batch loads recorded definitions and keeps the row. Use the site's `idsite` to override one site. Use `idsite` 0 to change the default for sites that have no row of their own. When the predicate changes, write a higher `version` in the same row. Hits from the old version stay on the old version.

```sql
INSERT INTO journey_events.ae_trigger_definition
  (idsite, trigger_key, name, level, version, predicate, active, generated_at)
VALUES
  (3199, 'loyal_browse', 'Loyal browse', 'session', 1,
   '{"type":"session_interest","min_pages":1,"min_clicks":0,"min_scroll_pct":0,"min_duration_sec":0,"chain_window_days":7}',
   1, now64(3));
```

`resolveDefinitions` also accepts that full definition as an override patch, which is what tests and an in-process caller use. The first time the predicate differs from the shipped or stored stamp, the version increments. An identical rerun keeps it.

## Where the code lives

| Piece | File |
| --- | --- |
| Shipped predicates | `src/triggers/defaults.json` |
| Versioning, list, get | `src/triggers/definitions.js` |
| The three predicates and the chain | `src/triggers/evaluate.js` |
| One day's hits and open chains, and the window merge | `src/triggers/batch.js` |
| Visit rows to session facts | `src/triggers/facts.js` |
| ClickHouse reads and the lookback | `src/triggers/load.js` |
| Week-over-week query | `src/triggers/query.js` |
| Monday weeks and visit timestamps | `src/triggers/time.js` |
| Site adapter | `src/adapters/datasets/trigger-chains.js` |
| Writes and reads | `writeTriggerBatch`, `readTriggerDefinitions`, `readTriggerHits`, `readTriggerChains` on both persistence adapters |

Tests in `test/triggers.test.js` cover the page boundary (3 does not qualify, 4 does), each arm of the Showed Interest AND, the Super-Shopper window including the 14-day edge and the prior-purchaser path, recovery only when `recover` is set, a blank `config_id`, idempotent reruns, version bumps, a config-only trigger, matched-weekday week-over-week alignment, and device × channel segmentation.

## Choices that the warehouse forced

These are recorded so a later reader does not treat them as silent guesses.

- The order key cannot be only `(idsite, trigger_key, server_date)` under `ReplacingMergeTree`. Two hits on one day would collapse. The identity columns follow the requested prefix.
- Definitions carry `idsite` so a threshold can change for one site without a deploy. The request's definition list had no site column.
- Medium is not on the visit row. It is taken from session tags when present.
- `sessions_until_return` is 1 whenever any later session exists.
- RPS in this report is chain revenue divided by sessions in the segment.
- The prior-purchaser clause costs a lookback of purchase visits up to `prior_purchase_lookback_days`.
- `config_id` repeats across visits and is populated on the live visit table. It is the visitor key this feature uses. It is not a person id.
