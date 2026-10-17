# Loop Earplugs — analysis project

**Site:** Loop Earplugs, idsite `558`
**Goal:** the same stored maturity as Latico, Mellow, and Kurk Uk
**Started:** 2026-10-12 04:02 UTC
**Window:** 2026-09-12 through 2026-10-11 (30 days ending yesterday UTC)
**Deadline:** finished before 12:00 UTC

## Steps

| # | Step | Status | Wall clock |
| --- | --- | --- | --- |
| 1 | Create the batch and select the page | done | batch 04:02:02–04:02:21 UTC. qualify 04:02:26–04:04:13 UTC (1m 47s) |
| 2 | Naming requirements and naming bot | done | 04:05:25–04:09:05 UTC (3m 40s; bot 201s). The first pass exited before the bot because `--site-source` was missing. |
| 3 | Import the harvest | done | inside step 2 |
| 4 | Full analysis | done | 04:09:25–05:17:27 UTC (1h 8m). failed 0, pagesAnalyzed 1. Trigger hits and chains 875,274. |
| 5 | Correct and promote descriptors | done | 05:19:35 UTC |
| 6 | Replay gates and cards, then fill template-weekly | done | replay 05:19:45–05:22:02 UTC (2m 17s). template-weekly and kind-fleet were already filled by the run. |
| 7 | Trend rows and tag-trend rows | done | trends 05:22:34–05:25:03 UTC. tag-trend 05:25:14–05:26:23 UTC (1m 9s) |

## Batch

`0ad53e36-30fc-4394-a5df-f68dcf02e2ff`. Window 2026-09-12 through 2026-10-11. `static-idsites`, `prefer-non-home`, `primary-only`, catalogs LP PG PI PO TD TG TI. The first `--run` stopped at `awaiting_capture`, which is the expected gate.

| | |
| --- | --- |
| Page | `https://loopearplugs.com/pages/lp-homepage-lp2` |
| idsitehsr | `17315997` |
| Type | content |
| Entry sessions | 202,489 |
| Orders | 12,173 |
| Revenue | $654,400 |

## Naming and capture

Taxonomy `2026-10-04.2`, status `complete`, render on desktop and mobile. 1,827 harvested names, 278 bound. The first capture command exited before the bot because `--site-source` was omitted. The retry ran 201 seconds.

| Class | Bindings |
| --- | ---: |
| product_tile | 146 |
| nav_link | 69 |
| express_checkout | 33 |
| cart_checkout | 15 |
| nav_toggle | 10 |
| rewards_link | 1 |
| collection_tile | 1 |
| email_subscribe | 1 |
| bundle_checkout | 1 |
| bundle_product_add | 1 |

## Analysis

`--run` finished 04:09:25–05:17:27 UTC with failed 0 and pagesAnalyzed 1. Trigger hits and chains are both 875,274. Classification logged progress and finished the 30 days at 05:08 UTC.

`template-weekly` wrote 5 rows during the run. `kind-fleet-weekly` wrote 9 rows. The run wrote 311 cards before the descriptor corrections.

## Descriptors

All 17 drafts were re-read against the harvest. Thirteen rows were promoted unchanged, at confidence `high`, provenance `operator`, owner `operator`, `human_confirmed_by` `kennpalm`, template `url:17315997`.

Two drafts were wrong because the bot matches selector text or section type:

- `p08.commerce`, both devices: `add_to_cart` corrected from 0 to 1. The harvest has `Button - Add to Dream™ - Black` on the product tile. `express_checkout` stays 0: the 33 express-checkout bindings are PayPal cookie-policy text, not a checkout button. `variant_selector` stays 1 (product swatches). `cart_type` stays `unknown`.
- `p09.proof_risk`, both devices: `reviews_block` corrected from 0 to 1. The harvest has a Reviews section and product-tile review stars. `returns_policy_link` corrected from 0 to 1 (`Footer Returns Link`). `faq_block` stays 0 (the FAQ control is a nav link). `brag_bar` stays 0.

Store row added, with no template key: `s30.platform` = `{platform: shopify, shop_domain: loopearplugs.myshopify.com}`, from `Shopify.shop` on the captured page.

Import file `/tmp/loop-558/descriptors.json`, 18 rows, dry-run then import at 05:19:35 UTC.

## Replay

Replay datasets were `descriptor-snapshot`, `structural-screen`, `kind-fleet-weekly`, `requirement-status`, and the seven `cards-*` catalogs. `bot-draft` was left out. Replay ran 05:19:45–05:22:02 UTC, recollected 478 rows, and rewrote 311 cards.

Cards: 26 include, 166 conditional, 11 silent, 108 blocked. Structural screen: 4 present, 3 blocked, 35 not evaluable. `template-weekly` is 5 rows, family `content`. `kind-fleet-weekly` is 9 rows.

## Trends

Window 2026-09-12 through 2026-10-11, Monday weeks 2026-09-07 through 2026-10-05. Both checks returned `ok: true`.

The first `--trend` wrote journey and page rows only (6,720) at 05:22:34–05:23:23 UTC. Five bound controls on the landing page were stored as active trend selectors, then `--trend` was run again at 05:24:14–05:25:03 UTC.

| Row type | Rows |
| --- | ---: |
| journey | 5,320 |
| page | 1,400 |
| element | 1,400 |
| total | 8,120 |

Paths: `content > pdp`, `plp > pdp`, `pdp > plp > pdp`. URL paths led by `/ > /products/dream`. Pages: the paid collection, Switch, Dream, home, and the landing page. Element selectors: Shop Now, Shop Earplugs, the header menu, the modal close button, and the country selector.

Tag trend, selector `traffic-variance`, lookback 30 days, 2,185,961 sessions: 28,000 rows at 05:25:14–05:26:23 UTC. Seven keys selected (`utm_source`, `utm_medium`, `utm_content`, `utm_term`, `utm_campaign`, `ad_id`, `campaign_id`). Six keys rejected: `tw_campaign` (one value with 100+ sessions), `tw_source` (178 tagged visits, under 200), and `variant`, `variant_1`, `subdomain`, `view` (not traffic keys). Check `ok: true`.
