# Ceremonia — analysis project

**Site:** Ceremonia.com, idsite `4820`, `https://ceremonia.com` (Shopify, USD)
**Goal:** the same stored maturity as Latico, Mellow, Kurk Uk, and Loop Earplugs
**Started:** 2026-10-12 18:39 UTC
**Window:** 2026-09-12 through 2026-10-11 (30 days ending yesterday UTC)
**Run settings:** `--site-source static-idsites`, qualifier `prefer-non-home`, page selector `primary-only`, catalogs LP PG PI PO TD TG TI, `--agents 1`, `TELEMETRY=0`, heap `--max-old-space-size=32768` for `--run`. Logs in `/tmp/ceremonia-4820/`.

## Starting state

No engine state for this site except two earlier audit batches (`d12b2dba-…` 10,847 rows, `f7cdd67e-…` 12,617 rows, the Roswell extract). No site queue, page target, capture, bindings, descriptors, cards, trends, triggers, or exclusion model.

Window volume: 18,184 visits (18,665 visit rows), 339 orders, $26,900 revenue. Mellow had about 250 times the visits, so this run should be short.

## Steps

| # | Step | Status | Wall clock |
| --- | --- | --- | --- |
| 0 | Inventory and this plan | done | 18:39–18:41 UTC |
| 1 | Create the batch and select the page | done | batch 18:41:03–18:41:22 UTC (19s). qualify 18:41:28–18:41:51 UTC (23s) |
| 2 | Naming requirements and naming bot | done after 1 crash and 1 fix | first attempt 18:42:20–18:52:41 (killed at 600s). Diagnosis and fix 18:53–19:07. Successful capture 19:10:10–19:11:45 (bot 76s) |
| 3 | Import the harvest | done (in the capture) | 282 bindings, 2 renders at 19:11:45 |
| 4 | Full analysis | done, first attempt | 19:11:55–19:13:27 UTC (1m 32s) |
| 5 | Correct and promote descriptors | done | checked 19:13–19:15. dry-run 19:15:17, import 19:15:21 UTC |
| 6 | Replay gates and cards, then fill template-weekly and kind-fleet-weekly | done (no fill needed) | 19:15:27–19:15:52 UTC (25s) |
| 7 | Trend rows and tag-trend rows | done | trend 19:16:22–19:16:42 (20s). selectors stored 19:17:42. trend again 19:17:47–19:18:08 (21s). tag-trend 19:18:25–19:18:47 UTC (22s) |

**Total:** 18:39 to 19:19:00 UTC, 40 minutes. The naming bot hang and its fix took 28 of them (18:42:20 to 19:10:10). From the successful capture to the last tag-trend row took 8.5 minutes.

## Batch

`94796d57-46f0-447e-ac08-83ec9fd0a34f`. Window 2026-09-12 through 2026-10-11. The first `--run` stopped at `awaiting_capture`, which is the expected gate.

The qualifier prefers a non-home page. None cleared the bar, so it chose the homepage, as it did for DVF.

| | |
| --- | --- |
| Page | `https://ceremonia.com` |
| idsitehsr | `24748723` |
| Type | home |
| Entry sessions | 4,465 |
| Orders | 133 |
| Revenue | $10,732 |

## Capture

The first capture never finished. The naming engine's tile price pass recursed exponentially on Ceremonia's deeply nested product cards and pinned the page's main thread. The event log has the diagnosis. The successful capture ran on a patched copy of the engine bundle: bot 76.2s, 1,337 elements harvested, 282 named, desktop and mobile renders with 10 sections each. Capture queue row `done`. Harvest in `cnn-ai-bot/dataset/4820/landing/index`.

| Class | Bindings |
| --- | ---: |
| product_tile | 105 |
| offer_add_to_cart | 80 |
| nav_toggle | 53 |
| nav_link | 27 |
| bundle_product_add | 6 |
| collection_tile | 5 |
| cart_drawer_close, cart_upsell, announcement_bar, express_checkout, email_subscribe, cart_checkout | 1 each |
| **total** | **282** |

Some binding names are wrong even where the class is right. The menu drawer button (`details#Details-menu-drawer-container > div:nth-child(2) > button`, class `nav_toggle`) is named `Product Button Ceremonia Guava Gloss Drops …`, and a footer "Bundle & Save" link is classed `bundle_product_add`. That is naming quality on this page. The mapper was not changed.

## Analysis

`--run` finished first time in 92s: failed 0, pagesAnalyzed 1. 106 queries, 59.6 query seconds; the slowest was `sessions:entry` at 2.12s, and none went over 60s. 40 datasets wrote 46,405 rows. Traffic exclusion: one model, default constants, 2 rules, 2,907 dead sessions of 18,184, no viewport-pattern exclusions. Trigger chains: 3 definitions, 6,335 hits and 6,335 chains. Requirement status 98 rows. 311 cards.

## Descriptors

All 17 drafts were checked against the harvest names, the render, and `page.html`. Fifteen were promoted unchanged (the two `p09.proof_risk` rows were corrected) at confidence `high`, provenance `operator`, owner `operator`, `human_confirmed_by` `kennpalm`, template `url:24748723`.

`p09.proof_risk` was wrong on both devices. The bot reads section types, and this page's render types its sections as `hero` and `other` only.

- `reviews_block` 0 → 1. The harvest has `Section - Testimonials`, `Section - See real reviews`, and 8 review-star groups on the ritual product cards.
- `brag_bar` 0 → 1. `page.html` has a "Featured in" press logo slider (`rs-logo-slider`) with Refinery29 and Allure logos. The slider wrapper is marked `classification-skip`, so the harvest has no names for it.
- `returns_policy_link` 0 → 1. The harvest has `Footer Returns Link`.
- `faq_block` stays 0. Only a footer FAQ link exists, with no FAQ block on the page.

`p08.commerce` stays as drafted. `add_to_cart` is 1 (80 "Add to bag" bindings on the product cards). `express_checkout` is 1 ("Checkout With Shop Pay" in the Rebuy cart drawer). `variant_selector` is 0, because no picker was harvested. `cart_type` is `unknown`.

`p04.first_viewport` was promoted as observed. Its first entries are the Shopify consent banner (`section#shopify-pc__banner`), which is what a new visitor sees on top of the hero.

Store row added: `s30.platform` = `{platform: shopify, shop_domain: ceremoniastore.myshopify.com}`, from `Shopify.shop` on the page.

Import file `/tmp/ceremonia-4820/descriptors.json`, 18 rows. Dry-run, then import at 19:15:21 UTC.

## Replay

Replay datasets: `descriptor-snapshot`, `structural-screen`, `kind-fleet-weekly`, `requirement-status`, and the seven `cards-*` catalogs. `bot-draft` was left out so the operator rows stand. 25s, exit 0, 479 rows recollected, 311 cards rewritten. Neither weekly dataset needed a manual fill. The run wrote `template-weekly` (5 rows) at 19:13:11, and the replay wrote `kind-fleet-weekly` (1 row) once the bindings were stored. On Latico both were empty after the run and had to be filled.

Cards after the promoted descriptors: 15 include, 166 conditional, 22 silent, 108 blocked. Structural screen: 4 present, 3 blocked, 35 not evaluable.

| Catalog | include | conditional | silent | blocked |
| --- | ---: | ---: | ---: | ---: |
| LP | 15 | 1 | 22 | 3 |
| PG | | 77 | | 4 |
| PI | | | | 52 |
| PO | | | | 41 |
| TD | | 23 | | |
| TG | | 35 | | |
| TI | | 30 | | 8 |

## Trends

Window 2026-09-12 through 2026-10-11, Monday weeks 2026-09-07 through 2026-10-05. All three checks returned `ok: true`.

| Row type | Rows |
| --- | ---: |
| journey | 7,280 |
| page | 1,400 |
| element | 1,400 |
| total | 10,080 |

Paths: `pdp > plp`, `home > plp > pdp`, `home > plp`. Pages: the homepage and four others (`24749648`, `32709757`, `27616548`, `30598124`).

The five element selectors are the highest-click bound controls, one for each job:

| Control | Class | Clicks in window |
| --- | --- | ---: |
| Menu drawer button | nav_toggle | 274 |
| Footer Contact link | nav_link | 128 |
| Rebuy cart close | cart_drawer_close | 70 |
| First predictive-search result | product_tile | 52 |
| Guava Leave-In "Add to bag" (hero slideshow quick add) | offer_add_to_cart | 40 |

Tag trend: selector `traffic-variance`, lookback 30 days, 17,801 sessions, 16,400 rows. Six keys selected: `utm_source` (facebook, google, klaviyo, ig, chatgpt.com), `utm_medium`, `utm_campaign`, `utm_content`, `campaign_id`, `utm_term`. Seven keys rejected: `ad_id` and `tw_campaign` (values earn alike), `tw_source` (only one value with 100+ sessions), `tw_medium` (9 tagged visits), `tw_profile_id` (identity key), and `variant` and `subdomain` (not traffic keys).

## Bug fixes and follow-ups

1. **Naming engine: exponential price-leaf recursion (fixed in source, not deployed).** `Heatmap-extension/onsite-heatmap/src/naming/tilePrices.ts` now memoizes `isPriceLeaf` and `hasPriceBearingChild` for each tile, and `tileCardComponents.test.ts` has a regression test. Uncommitted. The deployed bundle in `landing-page-analysis/deploy/context/naming-assets/main.global.js` still has the bug. Any site with deeply nested product cards will hang the bot until the 600s kill. Rebuild and redeploy the bundle; the kimi naming-bot container needs it too. The checkout `Heatmap-extension-naming-sequence` has the same code.
2. **Bot timeouts do not cover a busy page.** The 180s pass wait in `PlaywrightNamingSeedRunner` polls through `page.evaluate`, which cannot run while the main thread is blocked. A Node-side deadline that closes the tab would turn a 10-minute silent kill into a fast, labelled failure.
3. **`p09.proof_risk` drafting** keys off section types. On themes whose render types every section `other` (Ceremonia, and Mellow before it), `reviews_block` and `brag_bar` always draft 0.

## Maturity compared with earlier sites

| Artifact | Latico 1425 | Mellow 4879 | Loop 558 | Ceremonia 4820 |
| --- | --- | --- | --- | --- |
| Capture | complete, render | complete, render | complete, render | complete, render (patched engine) |
| Bindings | 258, 8 classes | yes | yes | 282, 12 classes |
| Page descriptors | high `operator` | 17 high `operator` | high `operator` | 17 high `operator` |
| Store descriptor | `s30.platform` | `s30.platform` | `s30.platform` | `s30.platform` |
| Trigger hits and chains | 61,038 each | 963,425 each | 875,274 each | 6,335 each |
| Strategy cards | 311 (20 / 167 / 13 / 111) | 311 (22 / 166 / 11 / 112) | 311 (26 / 166 / 11 / 108) | 311 (15 / 166 / 22 / 108) |
| Structural screen | 4 / 3 / 35 | 4 / 3 / 35 | 4 / 3 / 35 | 4 / 3 / 35 |
| template-weekly / kind-fleet-weekly | 5 / 1 | 5 / 1 | 5 / 9 | 5 / 1 |
| Trend rows | 8,680 | 8,400 | 8,120 | 10,080 |
| Tag-trend rows | 33,200 | 36,000 | 28,000 | 16,400 |
| Full `--run` | 35m 48s | 11 attempts, last 60m 19s | 1h 8m | 1m 32s |

Card columns are include / conditional / silent / blocked. Ceremonia reaches the same stored maturity as the other three sites.

## Event log

Every start, finish, restart, crash, slow query (over 60 seconds), and code fix, in UTC.

| Time (UTC) | Kind | Event |
| --- | --- | --- |
| 18:39 | start | Inventory. Site row, engine tables, window volume. |
| 18:40:48 | start | 5-minute poll loop started. |
| 18:41:03 | start | Step 1, `--batch`. |
| 18:41:22 | finish | Batch `94796d57-46f0-447e-ac08-83ec9fd0a34f` created, window 2026-09-12 to 2026-10-11. |
| 18:41:28 | start | Step 1, first `--run` (qualify). |
| 18:41:51 | finish | Exit 0, stopped at `awaiting_capture` as expected. 7 queries, 3.2 query seconds, slowest `sessions:entry` 1.74s (18,184 rows). Bot classification: 1 fingerprint, 0 confirmed, fleet scan not run. |
| 18:42:20 | start | Step 2, `--capture` (naming bot, desktop and mobile). Claimed page 24748723 at 18:42:40. |
| 18:52:41 | crash | Naming bot killed at the 600-second `botTimeoutMs`: `bot command failed (bin/seed-named-page.sh https://ceremonia.com 4820)`, no stderr. The bot process sat at 0% CPU with a live headless Chromium the whole time and wrote nothing under `cnn-ai-bot/captures/4820`. Capture queue row not completed. |
| 18:53:04 | restart | Manual `bin/seed-named-page.sh https://ceremonia.com 4820` in the background, to reproduce outside the engine. It hung the same way: no output after 7 minutes, its Chromium renderer at 99% CPU. Killed at 19:00. |
| 18:54:20 | diagnosis | Probe (`/tmp/ceremonia-4820/probe.mjs`): load the page, inject the 3 engine assets, run `init`, `waitForDescriptorsReady`, `startNamingAiPass` with a timeout on each. All three returned within 7.2s, so setup, descriptor fetch (3 expected 404s, no saved names yet), and the CSP were not the cause. |
| 18:55 | diagnosis | Second probe waited for the pass to finish. The pass logged `heuristicQa.done` at +23s and then went silent with the renderer pinned at 99% CPU. A busy main thread also blocks every `page.evaluate`, so the bot's own 180-second pass wait never fired, and only the engine's 600-second kill ended it. The 0% CPU seen at 18:50 was the Node process; the renderer was the busy one. |
| 19:00:57 | diagnosis | Third probe paused the debugger inside the loop. Every stack sample sat in the same two minified functions in `main.global.js`. They map to `isPriceLeaf` and `hasPriceBearingChild` in `Heatmap-extension/onsite-heatmap/src/naming/tilePrices.ts`. They call each other on the same subtree, so the work doubles at every nesting level. Ceremonia's product tiles nest deep enough that the tile price pass never ends. |
| 19:02 | bug fix | `tilePrices.ts`: memoize both results per element for each tile (`PriceLeafMemo`), so the tile is walked once. Added regression test `finds a price nested 40 wrappers deep without exponential recursion` in `tileCardComponents.test.ts`. 23/23 pass in the two tile test files. With the fix stashed, the new test hung until a 20-second kill. Not committed, and the deployed bundle is not rebuilt. |
| 19:03 | workaround | Same memo patched into a copy of the deployed bundle at `/tmp/ceremonia-4820/naming-assets/main.global.js` (3 anchored replacements, `node --check` clean). The shared assets in `landing-page-analysis/deploy/context/naming-assets` are untouched. Probe with the patched copy: pass reached `done: true` at 32s. |
| 19:07:17 | restart | Re-queued the capture row (status `queued`, reason `requeue after naming engine price-leaf recursion fix`). |
| 19:07:25 | crash | Step 2, `--capture` again with `NAMING_ENGINE_ASSETS=/tmp/ceremonia-4820/naming-assets` (`capture2.log`). Operator error: it ran as a subshell job inside a tool call and was killed when the call returned, right after the adapters mounted. Nothing was claimed and the queue row stayed `queued`. |
| 19:10:10 | restart | Step 2, `--capture` as a proper background job, same override (`capture3.log`). Claimed page 24748723 at 19:10:28. The bot process has the patched assets path in its environment. |
| 19:11:45 | finish | Capture complete, exit 0. Bot 76.2s: 1,337 elements harvested, 282 named, desktop and mobile renders (10 sections each), 282 bindings imported by `completeCapture`, site re-queued for analysis. Harvest in `cnn-ai-bot/dataset/4820/landing/index`. |
| 19:11:55 | start | Step 4, full `--run` (`analyze.log`). |
| 19:13:27 | finish | Exit 0 in 92s. 106 queries, 59.6 query seconds, slowest `sessions:entry` 2.12s, none over 60s, no errors. 50 dataset checkpoints, 311 cards, 17 descriptor drafts. |
| 19:15:17 | start | Step 5, descriptor import dry-run: 18 rows, all `operator`. |
| 19:15:21 | finish | Descriptor import, exit 0. 17 page rows now `operator`/`high`, plus the `s30.platform` store row. |
| 19:15:27 | start | Step 6, `--replay` without `bot-draft` (`replay.log`). |
| 19:15:52 | finish | Replay exit 0 in 25s. 15 queries, 3.9 query seconds, slowest `replay:rows` 2.48s (46,404 rows). 479 rows recollected, 311 cards rewritten. template-weekly (5 rows, from the run) and kind-fleet-weekly (1 row, from the replay) are both filled, so no manual fill. |
| 19:16:22 | start | Step 7, first `--trend` (`trend.log`). |
| 19:16:42 | finish | Trend exit 0 in 20s: 8,680 journey and page rows, no element rows (no selectors stored yet). Check `ok: true`. |
| 19:17:42 | write | 5 active trend selectors stored for page 24748723. |
| 19:17:47 | start | Second `--trend` (`trend2.log`). |
| 19:18:08 | finish | Trend exit 0 in 21s: 10,080 rows, now with element rows. Check `ok: true`. |
| 19:18:25 | start | `--tag-trend`, selector `traffic-variance`, lookback 30 days (`tag-trend.log`). |
| 19:18:47 | finish | Tag-trend exit 0 in 22s: 16,400 rows, 6 keys. Check `ok: true`. |
| 19:18:57 | stop | Poll loop stopped. |

## Progress polls

One line every 5 minutes while a step is running: the step, elapsed time, the last log line, and query load from that run's own log (query count, total query seconds, slowest query).

| Time (UTC) | Step | Elapsed | Progress | Load |
| --- | --- | --- | --- | --- |
| 18:45:48 | 2 naming bot | 3m 28s | bot claimed page, process alive | no queries (bot step) |
| 18:50:48 | 2 naming bot | 8m 28s | bot alive at 0% CPU, nothing written to captures/4820 | no queries |
| 18:55:48 | 2 diagnosis | — | capture crashed at 18:52:41. Manual seed hung; first probe showed the in-page setup works | no queries |
| 19:00:48 | 2 diagnosis | — | loop found by pausing the debugger: tile price-leaf recursion | no queries |
| 19:05:48 | 2 fix | — | source fix and test done, patched bundle copy finishes the pass in 32s | no queries |
| 19:10:48 | 2 naming bot (attempt 2) | 38s | page claimed 19:10:28, bot running on the patched bundle | no queries |
| 19:15:48 | 6 replay | 21s | analysis done 19:13:27, descriptors imported 19:15:21, replay writing cards | analysis 106 queries / 59.6s, slowest 2.12s. Replay 15 / 3.9s |
