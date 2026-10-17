# Latico Leathers — analysis project

**Site:** Latico Leathers, idsite `1425`, `https://laticoleathers.com`
**Goal:** the same stored maturity as DVF (idsite `5795`, batch `9bbe0ed1-184c-469a-9f56-cae8426b94c2`)
**Started:** 2026-10-11 09:20 UTC
**Window:** 2026-09-11 through 2026-10-10 (30 days ending yesterday UTC, the engine's `computeAeWindow`)

Token figures below are approximate. They count text this session reads and writes for the step, at about 4 characters per token. They are not the provider's billed total, and they do not include the naming bot's own model calls.

## DVF bar this run has to match

| Artifact | DVF |
| --- | --- |
| Batch shape | `static-idsites`, `prefer-non-home`, `primary-only`, 30 days, catalogs LP PG PI PO TD TG TI |
| Capture | 1 page, status `complete`, taxonomy `2026-10-04.2`, render present, captured 2026-10-10 |
| Bindings | 258 rows, 8 element classes, homepage only |
| Page descriptors | 13 low `bot_draft` rows (8 paths) and 4 high `operator` rows (`p08.commerce`, `p09.proof_risk`) |
| Store descriptors | 1 high `operator` row (`s30.platform`) |
| Dataset rows | 44 datasets on the batch, including `product-grid` and `trigger-chains` |
| Trend rows | 8,512, three row types |
| Trigger hits and chains | 61,038 each |
| Strategy cards | 311 |

Latico starts at zero on every one of those tables. Sitewide visits in the window: 715,514.

## Steps

| # | Step | Status | Wall clock | Tokens (approx) |
| --- | --- | --- | --- | --- |
| 0 | Inventory and this plan | done | 09:20–09:25 UTC | ~35,000 (context already in the session, plus the inventory queries) |
| 1 | Create the batch and select the page | done | 09:23:26–09:44:50 UTC (21m 24s) | ~8,000 new (log tails and the page lookup). The fleet scan is ClickHouse time, not tokens. |
| 2 | Naming requirements and naming bot | done | 09:46:25–09:52:14 UTC (5m 49s) | ~6,000 (harvest summary and the mapper change). The bot's own model calls are not in this count. |
| 3 | Import the harvest, then remap add-to-bag | done | first import inside step 2. Remap 09:53:37–09:53:57 UTC (20s) | included in step 2 |
| 4 | Full analysis, which also drafts descriptors | done | 09:54:03–10:29:51 UTC (35m 48s) | ~10,000 (log tails and the draft read). The fleet scan and the fact queries are ClickHouse time. |
| 5 | Correct and promote descriptors | done | 10:31:32–10:31:34 UTC (2s write; the review is the prior read) | ~18,000 (every draft, the Okendo and returns checks, the 18-row import) |
| 6 | Replay gates and cards, then fill template-weekly | done | replay 10:31:34–10:32:14 UTC (40s). template-weekly under 2s | ~4,000 |
| 7 | Trend rows and tag-trend rows for the same window | done | trend 10:33:21–10:33:45 UTC (24s). Tag trend 10:33:45–10:34:09 UTC (24s). Selector seed and element rerun 10:34:53–10:35:17 UTC (24s) | ~8,000 (result JSON and the five selectors) |

## Batch

`bfb4544b-b1a8-4ff5-9965-2ea40714abba`. Window 2026-09-11 through 2026-10-10. The first `--run` stopped at `awaiting_capture`, which is the expected gate.

The qualifier preferred a non-home page, the same rule that selected the DVF homepage when no other page cleared the bar. Here the product page cleared it.

| | |
| --- | --- |
| Page | `https://laticoleathers.com/products/callie-sling-crossbody` |
| idsitehsr | `1314502` |
| Type | product |
| Entry sessions | 28,537 |
| Orders | 381 |
| Revenue | $89,515 |

Qualification cost: `site_hsr` 0.09s (3,929 pages), `sessions:entry` 1.91s (709,761 rows), then the fleet bot-fingerprint scan, about 20 minutes across 5,128 sites. Page-hit check 0.28s. Bot classification for this site: 110 confirmed fingerprints, 264,890 long-tail sessions.

## Naming requirements for this page

Taxonomy `2026-10-04.2`, 54 classes. The capture asks for naming and render, desktop and mobile. `completeCapture` binds a class only through `mapNameRows`. A harvested name becomes a class only when it is clearly the control a visitor clicks. An uncertain name stays unbound, and the strategy that needs that class stays blocked. That is the same mapper DVF used (8 classes on the homepage).

Classes this mapper can bind when the harvest names the control:

- `offer_add_to_cart` from "add to cart" or "buy now"
- `product_tile` from a product card, or `linkClass: product` (the recommendation row)
- `quick_add`
- `nav_link`, `nav_toggle`
- `cart_checkout`, `express_checkout`, `cart_drawer_close`, `cart_upsell`
- `faq_item` from `FAQ Question - ` or a question mark on an FAQ node
- `collection_tile`, `announcement_bar`, `promo_cta`, `email_subscribe`, `rewards_link`
- `hero_cta` from `Hero CTA - ` or a hero-banner button. A product page often has none.

Classes a product page often has, which this mapper will leave unbound even if the bot describes them: `gallery_item`, `variant_option`, `review_item`, `review_summary`, `product_price`, `quantity_control`, `size_guide`, `sticky_atc`, `reassurance_item`, `breadcrumb`, `policy_link`, carousel classes. Extending the mapper is outside this run. The bar is the harvest DVF had, read by this mapper.

## Capture

Taxonomy `2026-10-04.2`, status `complete`, render on desktop (1440×900, page 9,939px) and mobile (390×844, page 13,459px). 12 sections per device, 2,073 harvested names, 651 bound.

| Class | Bindings |
| --- | --- |
| nav_toggle | 360 |
| nav_link | 229 |
| product_tile | 36 |
| faq_item | 12 |
| announcement_bar | 5 |
| email_subscribe | 4 |
| offer_add_to_cart | 3 |
| cart_upsell | 1 |
| collection_tile | 1 |

The harvest named the buy control `Button - Add To Bag`. `mapNameRows` only treated "add to cart" as `offer_add_to_cart`, so the first import bound 648 names and missed the three bag buttons (the form button, its buy-buttons wrapper, and the sticky bar). The mapper now treats "add to bag" the same way, covered by a test, and the harvest was re-read without launching the bot again. Gallery thumbs, swatches, and the variant picker are in the harvest and stay unbound: this mapper has no rule for them, which is the same limit DVF ran under.

## Analysis

`--run` on batch `bfb4544b-b1a8-4ff5-9965-2ea40714abba` finished with one page analyzed, nothing skipped or failed. The fleet fingerprint scan ran again inside this process, which is most of the 35m 48s. The write at the end stored 263,768 dataset rows, 311 cards, and 106,884 trigger hits with the same number of chains. `bot-draft` wrote 17 page descriptors, all confidence `low`.

`template-weekly` collected 0 rows during that run because it reads `page-segment-weekly` from `ae_dataset_row_current`, and those rows are written once at the end. `kind-fleet-weekly` also wrote 0: the click join ran before the selector rows were stored. Both were filled afterward (below).

Datasets with rows after that fill: 42. Adapters that correctly wrote nothing, because the source is empty: `forms-weekly`, `saliency`, `ad-creative`, `card-history`, `tool-registry`, `returning-history`. DVF's "44 datasets" counts the same stored-row set for a site that had a couple more of those sources.

## Descriptors

All 17 drafts were re-read against the render and the measurements. Fifteen values were already right and were promoted unchanged, at confidence `high`, provenance `operator`, owner `operator`, `human_confirmed_by` `kennpalm`, template `url:1314502`.

Two drafts were wrong because the bot matches selector text, and this page's controls are named in the harvest rather than the selector:

- `p08.commerce`, both devices: `add_to_cart` corrected from 0 to 1. The control is `Button - Add To Bag` on `buy-buttons > button`. `express_checkout` stays 0, `variant_selector` stays 1, `cart_type` stays `unknown`.
- `p09.proof_risk`, both devices: `reviews_block` corrected from 0 to 1 (Okendo widget `div.shopify-section.okendo-reviews-widget`, plus the star group on the product). `returns_policy_link` corrected from 0 to 1 (header and footer "Shipping And Returns", and the returns FAQ). `faq_block` stays 1, `brag_bar` stays 0.

Store row added, with no template key: `s30.platform` = `{platform: shopify, shop_domain: laticoleathers.myshopify.com}`, from `sites.platform` and `Shopify.shop` on the page. Fields the schema forbids a bot to draft stay absent.

Import file `/tmp/latico-1425/descriptors.json`, 18 rows, dry-run then `node src/cli.js --descriptor-import`. Current page descriptors are 17 high operator. The store descriptor is 1 high operator.

## Replay

Replay datasets were `descriptor-snapshot`, `structural-screen`, `kind-fleet-weekly`, `requirement-status`, and the seven `cards-*` catalogs. `bot-draft` was left out so a later draft could not replace the operator rows. Replay reloaded 263,768 stored rows, recollected 477, and rewrote 311 cards in 40s.

`kind-fleet-weekly` is now 1 row (the click join saw the stored bindings). `template-weekly` was collected from the stored `page-segment-weekly` rows and written the same way the runner writes a site dataset: 5 rows, family `product`, weeks of 2026-09-07 through 2026-10-05. DVF has 5 template-weekly rows and 1 kind-fleet row.

Cards after the promoted descriptors: 20 include, 167 conditional, 13 silent, 111 blocked. Of the blocked cards, 93 are structurally blocked and 18 are present but blocked on a trigger or a requirement. Structural screen: 4 present, 3 blocked, 35 not evaluable (those rules name inputs this page does not have, such as V15/S10 and V13/T09). Included cards that were checked (LP A1, A2, A6) have `structural_state` present and `trigger_state` triggered.

## Trends

Window 2026-09-11 through 2026-10-10, Monday weeks 2026-09-07 through 2026-10-05. Both checks returned `ok: true`.

The first `--trend` wrote journey and page rows only (7,280). Element rows need selectors stored for the page, and the only seed in code is the DVF homepage. Five bound controls on the Callie page were stored as active trend selectors, then `--trend` was run again. The second write replaces the same keys and adds the element rows.

| Row type | Rows |
| --- | --- |
| journey | 5,880 |
| page | 1,400 |
| element | 1,400 |
| total | 8,680 |

Paths: `plp > pdp`, `pdp > plp > pdp`, `home > plp > pdp`. URL paths led by `/collections/best-sellers > /products/callie-sling-crossbody`. Pages: home, Callie, best-sellers, crossbody, new-arrivals. Element selectors: the product Add To Bag button, the sticky Add To Bag button, the announcement-bar next button, the first FAQ disclosure, and `button#BIS_trigger`.

Tag trend, selector `traffic-variance`, lookback 30 days, 658,403 sessions: 33,200 rows. Nine keys selected (`utm_source`, `utm_medium`, `utm_campaign`, `utm_content`, `utm_term`, `campaign_id`, `ad_id`, `tw_source`, `tw_campaign`). Eight other keys rejected as not traffic keys. 17 selection rows.

## Maturity against DVF

| Artifact | DVF | Latico 1425 |
| --- | --- | --- |
| Batch | static-idsites, prefer-non-home, primary-only, 30 days, seven catalogs | same. Batch `bfb4544b-b1a8-4ff5-9965-2ea40714abba` |
| Capture | 1 page, complete, taxonomy 2026-10-04.2, render | same, page 1314502, desktop and mobile, saliency absent |
| Bindings | 258, 8 classes | 651, 9 classes |
| Page descriptors | 13 low bot drafts plus 4 high operator | 17 high operator (the drafts promoted, two corrected) |
| Store descriptors | 1 high `s30.platform` | 1 high `s30.platform` (Shopify) |
| Dataset rows | 44 datasets | 42 datasets with rows. Empty sources wrote nothing |
| Trend rows | 8,512, three row types | 8,680, three row types, plus 33,200 tag-trend rows |
| Trigger hits and chains | 61,038 each | 106,884 each |
| Strategy cards | 311 | 311 (20 include, 167 conditional, 13 silent, 111 blocked) |

## Notes

- The engine will not analyze a page until capture is `complete` on taxonomy `2026-10-04.2`. The first `--run` is expected to stop at `awaiting_capture`.
- `bot-draft` writes every draft at confidence `low`. A low field counts as unknown. Promotion is a separate operator row with `human_confirmed_by` set, and only for a value checked against the render or a measured dataset.
- Fields the schema forbids a bot to draft (`p02.context`, `p13.constraints`, `p15.revenue_join`, `p16.assets`, `p17.calendar`, `s20`, `s26`, `s31`, `s33`) stay absent. Absence is the correct state.
