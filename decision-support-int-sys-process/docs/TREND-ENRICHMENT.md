# Trend enrichment

**Date:** 10 October 2026
**Status:** built and proven on DVF. Not committed.
**Reads with:** `docs/VISION.md` (why one trend grain exists), `src/persistence/schema2.sql` (`ae_trend_row`, `ae_trend_selector`).

This is the week-over-week reading a coach can filter by traffic mix, returning, buyer, rager, and device without a new warehouse query per question. Heatmap already records the visits, pageviews, clicks, and orders. Nothing in the older `ae_dataset_row` extracts can be mined for these correlations: those grains split path from source, source from path, and clicks from both. This job writes one table, `ae_trend_row`.

## What a run writes

One site, one date window, one batch. The trend reads the whole Monday-to-Sunday weeks inside the window and stores each as its Monday. The days before the first Monday and after the last Sunday are left out, and the run's `edges` names them, so a later run never replaces a complete week with part of one.

For DVF the proven window is 2026-09-14 through 2026-10-09. Mondays: 2026-09-14, 2026-09-21, 2026-09-28, 2026-10-05.

Each run writes four families:

| Family | `row_type` | `row_key` | `row_key_1` | `row_key_2` | `idsitehsr` |
|---|---|---|---|---|---|
| Template money path | `journey` | `path` | `plp > pdp` | empty | 0 |
| Template step | `journey` | `step` | `1:plp`, `2:pdp` | the full template path | 0 |
| URL money path | `journey` | `url_path` | `/collections/dresses > /products/wrap` | empty | 0 |
| URL step | `journey` | `url_step` | `1:/collections/dresses` | the full URL path | 0 |
| Top page | `page` | `page` | page id string | page URL | that page id |
| Selector | `element` | `selector` | the selector | empty | the page id |

Both path grains are kept. Template paths answer "which page types make money." URL paths answer "which actual URLs." They are ranked separately and never mixed in one `row_key_1`.

The step index is part of the identity. `pdp > plp > pdp` has two `pdp` steps. Without `1:` and `3:`, ReplacingMergeTree collapses them into one row. The same happens for a URL that repeats, such as home appearing at both ends.

`metrics.rank` is the path's rank (1-based), not the step's position. Steps also store `metrics.step_index`. Selector rows store `metrics.attribution = 'correlational'` because the revenue on a selector row is the visit's revenue, not revenue caused by the click.

## How to read a row

One subject, one Monday, one `viewport_type`, one segmentation.

Segmentations are not crossed with each other. `segment = 'all'` and `segment_value = 'all'` is the unsegmented total. Each other segmentation is stored on its own rows, with `segment` set to its id. The rules live in the segmentation registry, not in this doc: declared ones in `src/catalog/segmentations/<id>.json`, computed ones in `src/adapters/segmentations/`, and a site's overrides in `orchestration/sites/<slug>/segmentations.json`. Every segmented row stores `metrics.segmentation_version`, the version of the definition that wrote it. The shipped default selection for `--trend` is:

| `segment` | `segment_value` | Rule |
|---|---|---|
| `traffic_source` | `meta`, `direct`, `search`, `website`, `campaign`, `social`, `other` | `meta` when the UTM source (the session tags' `utm_source`, else `custom_var_k5`) is facebook, ig, fb, instagram, or facebookads. Otherwise referrer type: 1 direct, 2 search, 3 website, 6 campaign, 7 social. Anything else is `other`. |
| `returning` | `new`, `returning` | `visitor_returning` on the visit, taken at the first action. |
| `buyer` | `buyer`, `non_buyer` | The visit has at least one order. This describes how buyers moved. It is not a rate to optimize. |
| `rager` | `rager`, `non_rager` | Any click in the window on that visit has `meta1 = 'rage'`. |

`channel`, `link_channel`, and `return_intent` are shipped too and are read when a run or a site selects them. See "Segmentations" below.

`viewport_type` is a column, not a segmentation. Values are `all`, `desktop`, `tablet`, `mobile`, and `unknown` only when a visit has no device. Device codes are `config_device_type`: 1 desktop, 2 tablet, 3 mobile. This is not the viewport-height class used by `viewport-weekly` (small / medium / large).

Do not sum `viewport_type = 'all'` together with the device rows. Do not sum `segment = 'all'` together with a segmentation. Within one segmentation, the values partition the sessions and add up to `all`. Device rows plus `unknown` add up to `all`. On the DVF proof there were no unknown-device visits, so desktop + tablet + mobile equals `all`.

Shared measures:

| Column | Meaning |
|---|---|
| `sessions` | Visits in the cell. |
| `buyers` | Visits with at least one order. |
| `orders` | Distinct orders. One row per `(idvisit, idorder)` before the sum, so a repeated conversion row is not counted twice. |
| `revenue` | Sum of order revenue, rounded to cents on the stored row. |
| `clicks` | Clicks on that selector. 0 on path, step, and page rows. |
| `progressed` | On a path row, visits that reached `checkout_started`. On a step row, visits that reached the next step of that same path. The last step uses `checkout_started`. |

A path row counts only visits whose compacted sequence equals that path exactly. A step row also counts visits that continued past the path with the same prefix, so the last step can be larger than the path row. A sibling does not count: `home > plp` is not a step of `home > pdp > cart`.

## Money paths

Default list length is 3 (`--path-limit`). A path must contain ` > ` (at least two steps). Rank is revenue, then sessions, then the path string. The list is frozen after the first rank. A later run without `--rerank` keeps the stored order, read back by `metrics.rank`, and fills a list shorter than its limit from a fresh rank, behind the stored subjects. `--rerank` replaces the list. Template paths and URL paths freeze independently, and so do the top pages (limit 5). The rank runs only on `--rerank` or when a list is short, so a run over full lists issues no `trend:path-rank` or `trend:page-rank` query. It reads `--rank-days` days (default 30) ending on the run's last Sunday, apart from the weeks it writes, so a one-week run ranks on a month.

Consecutive duplicate pages are compacted (`arrayCompact`) before the path is formed. Home to home with nothing between them is one step.

**Template path.** Page type from `screenshot_url`, same branch order as `src/page-type.js`: home, pdp, plp, cart, search, content, checkout, account, other. `templateSql` in `src/enrichment/trend-sql.js`.

**URL path.** The URL path only. Host, query, and hash are stripped, the remainder is lowercased, and a trailing slash is removed except for the root `/`. An empty URL becomes `(unknown)`. `urlPathSql` in the same file. The stored key is `/collections/dresses > /products/wrap`, not `https://dvf.com/collections/dresses`. `idsitehsr` is not the path identity: the same URL can be recaptured under a new page id, and the URL path merges those captures. Page rows still keep the page id plus the full URL.

Because URL cardinality is much higher than template cardinality, ranking and aggregation are separate queries. The rank query returns one row per path (`kind` is `template` or `url`) with sessions and revenue only. The aggregate query then keeps the chosen paths and the prefixes needed for step progression: every exact prefix, plus any journey that starts with `{full path} > `. `pathMatchList` builds those two arrays. The two grains are aggregated separately so a template group-by is not crossed with every URL under it.

## Pages and selectors

Pages are the top 5 by viewing sessions (`PAGE_LIMIT`). Also frozen, ordered by `metrics.rank`. A page is one row per visit per `idsitehsr` before orders are joined. Joining orders onto raw pageviews multiplies revenue.

Selectors come from `ae_trend_selector`: `idsite`, `idsitehsr`, `trend_selectors Array(String)`, `status`. `status` is `active` or `paused`. An empty array or a paused page writes no element rows. The table is not dropped when `ae_trend_row` is rebuilt.

The DVF homepage is seeded only when that `idsitehsr` is absent. The five selectors are content, not chrome. Header, mobile nav, the cookie banner (`csm-cookie-consent`), and chat widgets were the highest click counts and were left out.

1. Editorial heading, mostly mobile.
2. Dresses carousel next arrow. Mobile is zero. This is the proof shape.
3. Hero text link.
4. Form submit, spread across devices. `button#md-btn__form__onSubmit`.
5. Lower section text link, almost all mobile. Second proof shape.

The exact selectors are `TREND_SELECTOR_SEEDS` in `src/enrichment/trend-seed.js`.

## Sort key

`ae_trend_row` is `ReplacingMergeTree(generated_at)`. On ClickHouse Cloud the live engine is rewritten to `SharedReplacingMergeTree`. The sort key is the row identity and cannot be altered in place:

```text
(idsite, row_type, row_key, row_key_1, row_key_2, viewport_type, segment, segment_value, week, idsitehsr)
```

`viewport_type` sits after the subject and before the strategy so a device filter is a primary-key prefix once the subject is fixed. Read through `ae_trend_row_current` (`SELECT * FROM ae_trend_row FINAL`). A later `generated_at` replaces the same key. `batch_id` is not in the key, so a rerun replaces the week rather than stacking batches.

`schema2.sql` must not contain `DROP` (ddl lint). `ensureTrendTables` drops `ae_trend_row` only when the table exists, `viewport_type` is missing, and the table is empty. If rows exist and the column is missing, it throws. The column is present now, so that function will not rebuild the table again. Changing the path identity (template keys versus URL keys) does not collide in the sort key, and old keys are not replaced by new ones. To discard a grain, drop `ae_trend_row` and `ae_trend_row_current` explicitly, leave `ae_trend_selector`, and rerun. `ensureAeSchema` recreates the table from `schema2.sql`.

## Warehouse facts

Every fact alias is bounded by `idsite` and `server_date`. The gateway rejects a `trend:` label that misses those bounds. `idsitehsr` is required only on the selector scan, where the page is known. Site-level path and page queries must not pass a parameter named `idsitehsr`.

| Table | Use |
|---|---|
| `default.udp_hsrce_visits` | Week, device, referrer, returning, UTM source, city and referrer name for the bot filter. `argMin` by `visit_first_action_time`, then one row per visit. |
| `default.udp_hsrce_pageviews` | Page sequence and page traffic. Join `site_hsr` with `toUInt64(idsitehsr)`. |
| `default.site_hsr` | `screenshot_url` is the page URL, not a screenshot CDN URL. Homepage is `https://dvf.com`. |
| `default.udp_conversions` | Orders and revenue. `server_date` is nullable; `BETWEEN` drops nulls. |
| `default.journey_events_map` | `checkout_started` for `progressed`. |
| `default.udp_clicksce_clicks` | Rage sessions, and selector click counts. |

Bot filter is the portal predicate from `botPredicate` in `src/audit/sql.js`: Social Circle, and datacenter cities when `referer_name` is Facebook. It is applied after the visit is collapsed. The fingerprint fleet scan is not used.

Checkout is joined as `ck`. The clicks CTE also uses `c`. Using `c` for checkout marks every clicker as progressed.

Heavy queries append `max_execution_time = 180` and `max_bytes_before_external_group_by = 2147483648`. The client timeout is 600 seconds. A full DVF run of both grains is about 20 seconds.

## DVF proof

idsite `5795`, homepage idsitehsr `51247422`. Window 2026-09-14 through 2026-10-09. Totals below are `viewport_type = all`, `segment = all`, summed across the four Mondays.

Template paths:

| Path | Sessions | Revenue |
|---|---:|---:|
| `plp > pdp` | 4,891 | $41,463.81 |
| `pdp > plp > pdp` | 1,608 | $20,400.26 |
| `home > plp > pdp > home` | 30 | $18,268.47 |

URL paths, ranked by revenue, so they are a few high-ticket journeys rather than the common routes:

| Path | Sessions | Revenue |
|---|---:|---:|
| `/ > /collections/dresses > /collections/dresses/products/davina-dress-in-tabac > /` | 4 | $17,877.72 |
| `/collections/dresses > /collections/dresses/products/isobel-dress-in-black > /` | 1 | $13,559.40 |
| `/ > /collections/new > /products/antonia-dress-in-chinti > /cart > /products/antonia-dress-in-chinti > /cart` | 1 | $12,616.57 |

Top pages, in stored rank order: `51247422` `https://dvf.com`, `51307654` `https://dvf.com/collections/all-clothing`, `51308179` `https://dvf.com/collections/new`, `51307762` `https://dvf.com/collections/dresses`, `51307498` `https://dvf.com/collections/wrap-dresses`.

The dresses next arrow has desktop and tablet sessions and zero mobile sessions. The section-5 link has more mobile sessions than desktop. `verifyTrend` throws if either shape fails while that selector is in the plan.

The last successful run wrote 8,512 rows and `check.ok` was true. The grid with no unknown-viewport extras is subjects × 4 weeks × 4 viewports × 14 segment values (224 rows per subject). Subjects were 3 template paths + 9 template steps + 3 URL paths + 13 URL steps + 5 pages + 5 selectors.

## How to run

```bash
node src/cli.js --trend --sites 5795 --window-start 2026-09-14 --window-end 2026-10-09
node src/cli.js --trend --sites 5795 --window-start 2026-09-14 --window-end 2026-10-09 --path-limit 3 --rerank
```

`--trend` requires one site, and either both dates as `YYYY-MM-DD` or `--next-weeks`. ClickHouse env is already in the shell (`CLICKHOUSE_HOST`, database `disp` unless `CLICKHOUSE_DATABASE` is set). Telemetry listens on `127.0.0.1:9474` unless `TELEMETRY=0`. Pino writes JSON to stdout ahead of the result, so the result is the last line.

A second run without `--rerank` must return the same template paths, the same URL paths, and the same page ids, in the same order. `readTrendSubjects` orders by `min(JSONExtractInt(metrics, 'rank'))`, then `row_key_1`.

### Next weeks

```bash
node src/cli.js --trend --sites 5795 --next-weeks
node src/cli.js --trend --sites 5795 --next-weeks --overlap-weeks 1 --backfill-weeks 8
node src/cli.js --tag-trend --sites 5795 --next-weeks
```

`--next-weeks` adds the weeks since the last run, so a weekly job reads one or two weeks rather than the whole history. Every subject ends on the last Sunday before today. Each subject starts from its own latest stored week (`readTrendWeeks`), moved forward one week and back `--overlap-weeks` weeks (default 1). The overlap rereads the last stored week, so late data for it lands. A subject with nothing stored, such as a new selector or a path a rerank brought in, backfills `--backfill-weeks` whole weeks (default 8). Subjects that share a start are read in one query, so a run that adds one selector reads eight weeks for it and one or two for the rest. A skipped run is caught up by the next one. A step row starts with its path. The run result names the `window` it read, from the earliest subject start.

`--tag-trend` reads every key over one window, because its check holds each key's weekly totals to the window's kept sessions. A frozen selection starts at the earliest start of its keys (`readTagTrendWeeks`) and reads nothing when every key is current. A new selection, on the first run or `--rerank`, starts at the backfill.

The orchestrator's run JSON asks for this with `defaults.window: {"mode": "next-weeks", "overlapWeeks": 1}`. The job's `window.end` is that Sunday, and `window.start` is where a current site begins.

### Segmentations

```bash
node src/cli.js --trend --sites 5795 --next-weeks --segmentations traffic_source,returning,buyer,rager,channel
node src/cli.js --tag-trend --sites 5795 --next-weeks --backfill-all
node src/cli.js --segmentation-check --sites 5795 --week 2026-10-05 --segmentation channel
node src/cli.js --segmentation-check --sites 5795 --week 2026-10-05 --segmentation-file orchestration/sites/dvf/segmentations.json
```

A run reads `--segmentations id,id` when given, else the site file's `defaults` for its grain (`trend`, `tagTrend`, `experiments`), else the shipped defaults. The list replaces the default; it does not add to it. The run result names where the list came from in `segmentationSource` (`run`, `site`, or `shipped`). All segmentations of a query are fanned out in one scan. When their values pass `trend.segmentationBudget` (default 48, env `ANALYSIS_SEGMENTATION_BUDGET`) the run splits them into several queries, and the query labels gain `:g<n>`.

Each run stamps the definition of every segmentation it read into `ae_segmentation_definition`. A segmentation whose definition changed gets the next version. When stored rows already exist for it, the run rewrites that segmentation's rows for each stored subject's weeks, from its first stored week to the day before this run reads it. A value the new definition no longer has gets zero rows with `metrics.retired = true`. The rewrite is capped at `trend.maxBackfillWeeks` (default 26, env `ANALYSIS_MAX_BACKFILL_WEEKS`). Over the cap the run stops before any query and says so; `--backfill-all` lifts the cap. The other segmentations' rows are not touched.

`--segmentation-check` runs one query per segmentation over the week that starts on the given Monday and writes nothing. It prints sessions, share, orders, and revenue per value, the partition against all, and the version the definition would get. Exit 1 when the values do not add up to all, one value holds over 98% of sessions, or the week has no sessions. Exit 2 on a usage error. The authoring steps are in `skills/segmentation-authoring/SKILL.md`.

## Code map

| File | Role |
|---|---|
| `src/enrichment/trend-row.js` | `buildTrendRow`, `VIEWPORT_TYPES`, `KEY_GUIDE`. Rejects an unknown viewport. |
| `src/enrichment/trend-aggregate.js` | Rank, freeze, prefix match, expand the zero grid, journey / page / selector rows. |
| `src/enrichment/trend-sql.js` | `templateSql`, `urlPathSql`, `TREND_COLUMNS`, rank SQL, aggregate SQL, page SQL, selector SQL. |
| `src/enrichment/segmentation-sql.js` | `fanoutSql`, `planGroups`: the (segment, value) fan-out every segmented aggregate shares. |
| `src/enrichment/trend-run.js` | `runTrend`, `verifyTrend`. Seed, rank, aggregate, write. |
| `src/enrichment/trend-seed.js` | DVF homepage selectors. |
| `src/enrichment/trend-schema.js` | `ensureTrendTables`. |
| `src/adapters/persistence/clickhouse.js` | `writeTrendRows`, `writeTrendSelectors`, `readTrendSelectors`, `readTrendSubjects`. |
| `src/ports/persistence.js` | Row and port types. |
| `src/governance/query-bounds.js` | Fact bounds for the `udp_*` tables used here. |
| `src/cli.js` | `--trend`. |
| `test/trend-aggregate.test.js` | Rank, freeze, prefix match, partition, SQL bounds, DVF device shape. |
| `test/trend-row.test.js` | Viewport required. |
| `test/ddl-lint.test.js` | 55 tables, 53 views, after `ae_trend_selector` was added. |

Memory persistence was not given the trend writers. The live path is ClickHouse only.

## Invariants another change has to keep

- One segmentation per row. Do not cross `traffic_source` with `buyer` in the stored grain.
- `viewport_type = all` is a total, not a fourth device to add to the others.
- Step `row_key_1` stays `{index}:{step}`. Dropping the index silently deletes repeated steps.
- Path aggregate stays filtered to the frozen list. Grouping every URL path by every segment will blow up the scan.
- Page and selector revenue are joined after one row per visit (and per page, or per selector). Do not sum orders onto ungrouped pageviews or clicks.
- Checkout alias stays `ck`.
- `schema2.sql` stays free of `DROP`.
- A new site does not get the DVF selectors. The seed matches idsite 5795 only, and only when that page has no config row yet.
- `verifyTrend` is the acceptance check. It confirms both path families, step counts, page count, every configured selector, the partition of the first template path and the first URL path, and the two DVF device shapes when those selectors are in the plan.

## Session-tag trend

`--tag-trend` writes `ae_session_tag_trend`: one row per `(tag_key, tag_value, viewport_type, segment, segment_value, week)`. It uses the same weeks, bot filter, and viewports as `--trend`. Its shipped selection is the four trend defaults plus `return_intent`.

```bash
node src/cli.js --tag-trend --sites 5795 --window-start 2026-09-14 --window-end 2026-10-09
node src/cli.js --tag-trend --sites 5795 --window-start 2026-09-14 --window-end 2026-10-09 --rerank --lookback-days 30 --tag-selector traffic-variance
```

Key selection is an adapter role, `src/adapters/session-tag-selectors/`. `traffic-variance` keeps keys that name a traffic family (source, medium, campaign, ad, content, term, channel, affiliate) and drops click ids and identity keys. It then needs two or more values with 100+ sessions, 25% coverage of kept sessions, and a one-way ANOVA on revenue per session (or per order for AOV) whose z clears a Bonferroni bar across the candidates, with a weighted spread of at least 20% (RPS) or 15% (AOV). The verdicts go to `ae_session_tag_selection`, selected and rejected, with the reason. The selection is frozen per site until `--rerank`.

Each selected key carries up to 8 values by sessions. Every kept session lands in exactly one of those values, `other`, or `(none)`. The tag value is the first non-empty value in the visit, by `idloghsr`.

`return_intent` looks back `--lookback-days` (default 30) over the same visitor (`config_id`), in this order:

| Value | Meaning |
|---|---|
| `prior_buyer` | Bought on an earlier visit. |
| `open_cart` | An earlier visit added to cart or started checkout after the last purchase. |
| `prior_high_intent` | The previous visit met the `showed_interest` thresholds stored for the site. |
| `prior_browse` | Seen before, none of the above. |
| `returning_unseen` | Flagged returning, no earlier visit in the lookback. |
| `new` | Everything else. |

`verifyTagTrend` checks that every key sums to the kept sessions, every value has rows, and each segmentation partitions a sample cell.

DVF, 2026-09-14..10-09: 161,639 kept sessions, 9 keys selected (`utm_source`, `utm_medium`, `utm_campaign`, `utm_content`, `utm_term`, `campaign_id`, `tw_source`, `tw_medium`, `tw_campaign`), 24,000 rows, `check.ok` true. `ad_id` was rejected on variance (RPS z 2.00 against a bar of 2.81). `tw_profile_id` was rejected as identity, and `variant`, `subdomain`, and `view` as non-traffic.

Code: `src/enrichment/tag-trend-sql.js`, `tag-trend-aggregate.js`, `tag-trend-run.js`, `tag-stats.js`, `src/ports/session-tag-selector.js`, `test/tag-trend.test.js`.

## Not done

- No minimum session count on the URL rank. Revenue rank is what produced the one-session URL paths above. A popular-URL list is a different rank.
- Full `https://` URLs are not stored on the path. The page row keeps the full URL.
- Experiments are a `row_type` the builder accepts and this job does not write.
- The job is one site per invocation. There is no fleet loop.
- This work is uncommitted.
