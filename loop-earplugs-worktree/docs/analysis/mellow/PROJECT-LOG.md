# Mellow Sleep — analysis project

**Site:** Mellow, idsite `4879`, `https://mellowsleep.com`
**Goal:** the same stored maturity as Latico (idsite `1425`, batch `bfb4544b-b1a8-4ff5-9965-2ea40714abba`) and DVF (idsite `5795`, batch `9bbe0ed1-184c-469a-9f56-cae8426b94c2`)
**Started:** 2026-10-11 16:39 UTC
**Window:** 2026-09-11 through 2026-10-10 (30 days ending yesterday UTC)

Token figures below are approximate. They count text this session reads and writes for the step, at about 4 characters per token. They are not the provider's billed total, and they do not include the naming bot's own model calls.

## Bar this run has to match

| Artifact | Latico 1425 |
| --- | --- |
| Batch shape | `static-idsites`, `prefer-non-home`, `primary-only`, 30 days, catalogs LP PG PI PO TD TG TI |
| Capture | 1 page, status `complete`, taxonomy `2026-10-04.2`, render present |
| Bindings | named controls the mapper can bind |
| Page descriptors | high `operator` rows after the drafts are checked |
| Store descriptors | high `s30.platform` |
| Dataset rows | datasets with a source write rows; empty sources write nothing |
| Trend rows | journey, page, and element |
| Trigger hits and chains | one chain per hit |
| Strategy cards | 311 |
| Traffic exclusion | one model version for the window |

Mellow starts at zero on every one of those tables. No prior batch, capture, or queue row.

## Steps

| # | Step | Status | Wall clock | Tokens (approx) |
| --- | --- | --- | --- | --- |
| 0 | Inventory and this plan | done | 16:39 UTC | ~4,000 (site lookup and this journal) |
| 1 | Create the batch and select the page | done | 16:39:32–17:05:10 UTC (25m 38s) | ~2,000 (log tail and the page row) |
| 2 | Naming requirements and naming bot | done | 17:05:39–17:07:36 UTC (1m 57s; bot 99s) | ~3,000 (capture log and the harvest names) |
| 3 | Import the harvest | done | inside step 2 | included in step 2 |
| 4 | Full analysis | done | Attempts 5 and 6 were cancelled with the terminal while datasets were still only in memory, so nothing from those passes was stored. Attempt 7 ran 21:27:05–23:07:26 UTC and died with exit 134: the 24 GB heap filled during trigger-chain classification (about 24,174 MB, mark-compact could not free enough). Page datasets and site datasets through tool-registry are checkpointed. Trigger-chains was not written. Attempt 8 ran 23:18:45–23:29:32 UTC with a 32 GB heap, restored the checkpoints, and failed while collecting experiments-weekly: `experiment:elements` returned 133,217 rows in 224 seconds, then the insert got `socket hang up` (`ECONNRESET`). The batch completed with failed 1 and pagesAnalyzed 0. Experiments-weekly was not checkpointed. Attempt 9 ran 23:40:17–00:45:08 UTC with a 32 GB heap, restored the checkpoints, collected experiment-analysis (5,087 rows), classified trigger chains, and failed while inserting them: `write EPIPE`. The batch completed with failed 1 and pagesAnalyzed 0. Trigger-chains was not checkpointed. Attempt 10 ran 01:15:25–02:15:32 UTC. Connection retries were not needed. Trigger hits and chains both inserted (963,425 rows each, in chunks of 50,000). The following dataset-row insert built one string for all 963,425 chain rows and died with `RangeError: Invalid string length`. The batch completed with failed 1 and pagesAnalyzed 0. Trigger-chains was not checkpointed. Attempt 11 ran 02:17:07–03:17:26 UTC (60m 19s) and finished with failed 0 and pagesAnalyzed 1. Trigger hits and chains both stored (963,425). The dataset-row insert of those chains succeeded in chunks of 50,000. `ae site analyzed` followed. | |
| 5 | Correct and promote descriptors | done | 03:19:51 UTC | |
| 6 | Replay gates and cards, then fill template-weekly | done | replay 03:23:10–03:25:14 UTC (2m 4s). template-weekly under 2s | |
| 7 | Trend rows and tag-trend rows | done | trends 03:26:47–03:30:08 UTC. tag-trend 03:30:26–03:32:09 UTC (1m 43s) | |

## Batch

`6b5f8c7f-1ff8-46cf-9279-ef04a69a61c4`. Window 2026-09-11 through 2026-10-10. The first `--run` stopped at `awaiting_capture`, which is the expected gate. Two agents claimed the site: one lost the ClickHouse socket (`socket hang up`) and was counted failed; the other wrote the page and the queue. The current site row is `awaiting_capture`.

The qualifier preferred a non-home page.

| | |
| --- | --- |
| Page | `https://mellowsleep.com/products/marshmellow-comforter` |
| idsitehsr | `25897912` |
| Type | product |
| Entry sessions | 978,327 |
| Orders | 11,987 |
| Revenue | $1,911,849 |

Qualification also measured 4,659,744 session rows for the site. Bot classification: 4,803 fingerprints, 171 candidates, 168 confirmed, 3 suspect, 3,840,398 long-tail sessions. The fleet scan is most of the 25m 38s.

## Naming and capture

Taxonomy `2026-10-04.2`, status `complete`, render on desktop (1440×900, page 9,595px) and mobile (390×844, page 12,168px). 24 sections per device, 643 harvested names, 50 bound.

| Class | Bindings |
| --- | ---: |
| product_tile | 39 |
| nav_toggle | 6 |
| nav_link | 3 |
| collection_tile | 1 |
| bundle_product_add | 1 |

The product buy button is in the harvest at `product_buy_buttons > button`, named `Product Button Megan P.`. The mapper only treats "add to cart", "add to bag", and "buy now" as `offer_add_to_cart`, so that control stays unbound. That is the same mapper limit Latico ran under. Gallery, swatches, and FAQ questions stay unbound for the same reason.

## Descriptors

All 17 drafts were re-read against the render. Fifteen values were promoted unchanged, at confidence `high`, provenance `operator`, owner `operator`, `human_confirmed_by` `kennpalm`, template `url:25897912`.

Two drafts were wrong because the bot matches section type or selector text, and this page's controls sit in Shopify blocks:

- `p08.commerce`, both devices: `add_to_cart` corrected from 0 to 1. The control is the product form button in `product_buy_buttons`. `express_checkout` stays 0, `variant_selector` stays 1, `cart_type` stays `unknown`.
- `p09.proof_risk`, both devices: `reviews_block` corrected from 0 to 1. The render has the Loox block `product_reviews_loox` and its stars. `faq_block` stays 1, `brag_bar` stays 0, `returns_policy_link` stays 0.

Store row added, with no template key: `s30.platform` = `{platform: shopify, shop_domain: 3ed0wp-fx.myshopify.com}`, from `sites.platform` and `Shopify.shop` on the page.

Import file `/tmp/mellow-4879/descriptors.json`, 18 rows, dry-run then import at 03:19:51 UTC.

## Replay

The first replay, 03:20:23–03:22:27 UTC, loaded 1,677,639 stored rows and then exited 1: `parseObject is not defined` in `siteFromCh`. That helper is private to the row module, so replay now parses the site metadata itself. The retry ran 03:23:10–03:25:14 UTC (2m 4s) and exited 0.

Replay datasets were `descriptor-snapshot`, `structural-screen`, `kind-fleet-weekly`, `requirement-status`, and the seven `cards-*` catalogs. `bot-draft` was left out so a later draft could not replace the operator rows. The row load took 96 seconds. Replay recollected 473 rows and rewrote 311 cards.

`kind-fleet-weekly` is 1 row (the click join saw the stored bindings). `template-weekly` was collected from the stored `page-segment-weekly` rows and written the same way the runner writes a site dataset: 5 rows, family `product` (the target's page type; `template_family` was blank), weeks of 2026-09-07 through 2026-10-05.

Cards after the promoted descriptors: 22 include, 166 conditional, 11 silent, 112 blocked. Structural screen: 4 present, 3 blocked, 35 not evaluable.

## Trends

Window 2026-09-11 through 2026-10-10, Monday weeks 2026-09-07 through 2026-10-05. Both checks returned `ok: true`.

The first `--trend` wrote journey and page rows only (7,000) at 03:26:47–03:27:59 UTC. Element rows need selectors stored for the page, and the only seed in code is the DVF homepage. Five bound controls on the comforter page were stored as active trend selectors, then `--trend` was run again at 03:28:57–03:30:08 UTC. The second write replaces the same keys and adds the element rows.

| Row type | Rows |
| --- | ---: |
| journey | 5,600 |
| page | 1,400 |
| element | 1,400 |
| total | 8,400 |

Paths: `content > pdp`, `home > content > pdp`, `home > pdp`. URL paths led by `/ > /pages/shop > /products/marshmellow-comforter`. Pages: the comforter, shop, Cloud Alignment Pillow, home, and Mellow Puff Pillow. Element selectors: the two bundle color controls, the product section, the header search button, and the header menu button.

Tag trend, selector `traffic-variance`, lookback 30 days, 4,532,509 sessions: 36,000 rows. Nine keys selected (`tw_source`, `utm_medium`, `utm_source`, `utm_campaign`, `utm_content`, `utm_term`, `ad_id`, `campaign_id`, `tw_campaign`). Nine other keys rejected as not traffic keys. 18 selection rows. Check `ok: true`.
