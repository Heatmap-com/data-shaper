# Kurk Uk — analysis project

**Site:** Kurk Uk, idsite `3616`
**Goal:** the same stored maturity as Latico and Mellow
**Started:** 2026-10-12 03:32 UTC
**Window:** 2026-09-12 through 2026-10-11 (30 days ending yesterday UTC)

## Steps

| # | Step | Status | Wall clock |
| --- | --- | --- | --- |
| 1 | Create the batch and select the page | done | batch 03:32:49–03:33:08 UTC. qualify 03:33:14–03:33:43 UTC (29s) |
| 2 | Naming requirements and naming bot | done | 03:49:00–03:53:19 UTC (3m 59s; bot 239s). Earlier passes timed out or lost the page to a navigation. |
| 3 | Import the harvest | done | inside step 2 |
| 4 | Full analysis | done | 03:53:39–03:57:03 UTC (3m 24s). failed 0, pagesAnalyzed 1. Trigger hits and chains 13,913. Classification logged one line per day. |
| 5 | Correct and promote descriptors | done | 03:58:33 UTC |
| 6 | Replay gates and cards, then fill template-weekly | done | replay 03:58:38–03:59:04 UTC (26s). template-weekly and kind-fleet were already filled by the run. |
| 7 | Trend rows and tag-trend rows | done | trends 03:59:24–04:00:40 UTC. tag-trend 04:00:58–04:01:22 UTC (24s) |

## Batch

`7cb8cac9-0871-47cd-b963-0cd42fe46ee3`. Window 2026-09-12 through 2026-10-11. `static-idsites`, `prefer-non-home`, `primary-only`. The first `--run` stopped at `awaiting_capture`, which is the expected gate.

| | |
| --- | --- |
| Page | `https://kurk.life/pages/layne-beachley-routine-curcumin-bundle` |
| idsitehsr | `64391386` |
| Type | content |
| Entry sessions | 15,602 |
| Orders | 165 |
| Revenue | $13,374 |

## Naming and capture

Taxonomy `2026-10-04.2`, status `complete`, render on desktop and mobile. 957 harvested names, 338 bound. The first two retries failed because the page navigates after load and the script inject lost its execution context. The seed now retries that inject. The pass that landed ran 239 seconds.

| Class | Bindings |
| --- | ---: |
| bundle_product_add | 134 |
| faq_item | 104 |
| nav_toggle | 67 |
| nav_link | 22 |
| email_subscribe | 7 |
| collection_tile | 2 |
| rewards_link | 1 |
| cart_checkout | 1 |

## Analysis

`--run` finished 03:53:39–03:57:03 UTC with failed 0 and pagesAnalyzed 1. Trigger hits and chains are both 13,913. Classification printed one progress line per day and finished the 30 days in about 10 seconds.

`template-weekly` wrote 5 rows during the run, family `content`. `kind-fleet-weekly` wrote 1 row.

## Descriptors

All 17 drafts were re-read against the harvest. Fifteen values were promoted unchanged, at confidence `high`, provenance `operator`, owner `operator`, `human_confirmed_by` `kennpalm`, template `url:64391386`.

Two drafts were wrong because the bot matches selector text or section type:

- `p08.commerce`, both devices: `add_to_cart` corrected from 0 to 1. The control is `Product Button The Layne Beachley Routine` (23 bindings) plus the purchase-type buttons. `express_checkout` stays 0, `variant_selector` stays 1, `cart_type` stays `unknown`.
- `p09.proof_risk`, both devices: `reviews_block` corrected from 0 to 1. The harvest has the dynamic review carousel, the community review articles, and a Trustpilot link. `faq_block` stays 1, `brag_bar` stays 0, `returns_policy_link` stays 0.

Store row added, with no template key: `s30.platform` = `{platform: shopify, shop_domain: kurk-life.myshopify.com}`, from `Shopify.shop` on the page.

Import file `/tmp/kurk-uk-3616/descriptors.json`, 18 rows, dry-run then import at 03:58:33 UTC.

## Replay

Replay datasets were `descriptor-snapshot`, `structural-screen`, `kind-fleet-weekly`, `requirement-status`, and the seven `cards-*` catalogs. `bot-draft` was left out. Replay ran 03:58:38–03:59:04 UTC, recollected 476 rows, and rewrote 311 cards.

Cards: 19 include, 167 conditional, 14 silent, 111 blocked. Structural screen: 4 present, 3 blocked, 35 not evaluable. `template-weekly` is 5 rows, family `content`. `kind-fleet-weekly` is 1 row.

## Trends

Window 2026-09-12 through 2026-10-11, Monday weeks 2026-09-07 through 2026-10-05. Both checks returned `ok: true`.

The first `--trend` wrote journey and page rows only (7,000) at 03:59:24–03:59:45 UTC. Five bound controls on the Layne Beachley page were stored as active trend selectors, then `--trend` was run again at 04:00:19–04:00:40 UTC.

| Row type | Rows |
| --- | ---: |
| journey | 5,600 |
| page | 1,400 |
| element | 1,400 |
| total | 8,400 |

Paths: `home > pdp`, `pdp > plp > pdp`, `plp > pdp`. URL paths led by `/ > /products/kurk-essential`. Pages: home, the Layne Beachley bundle, and three Kurk Essential product views. Element selectors: the flavour button, an FAQ question, the gallery image, the shop link, and the purchase button.

Tag trend, selector `traffic-variance`, lookback 30 days, 85,455 sessions: 32,000 rows at 04:00:58–04:01:22 UTC. Nine keys selected (`tw_source`, `utm_medium`, `utm_source`, `utm_campaign`, `utm_term`, `utm_content`, `ad_id`, `campaign_id`, `tw_campaign`). Four keys rejected: `adset_id` (alike at z 2.81), and `view`, `variant`, `subdomain` (not traffic keys). Check `ok: true`.
