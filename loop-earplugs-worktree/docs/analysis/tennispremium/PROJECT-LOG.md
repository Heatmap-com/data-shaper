# Tennis Premium — analysis project

**Site:** Tennis Premium, idsite `6213`, `https://www.tennispremium.co/`
**Slug:** `tennispremium`
**Window:** 2026-09-13 through 2026-10-12 (30 days ending yesterday UTC)
**Batch:** `d7b79e2f-d947-4b4c-b947-cfb0571f0a17`

## Batch

`static-idsites`, `prefer-non-home`, `primary-only`, catalogs LP PG PI PO TD TG TI. The first `--run` stopped at `awaiting_capture` (queued 1, awaitingCapture 1). That gate was expected.

| | |
| --- | --- |
| Page | `https://tennispremium.co/search` |
| idsitehsr | `65706970` |
| Type | search |
| Entry sessions | 11,473 |
| Orders | 29 |
| Revenue | $2,058.75 |

## Naming and capture

Homepage harvest, from the naming step: `dataset/6213/landing/index`, 831 names, desktop and mobile renders, `naming.complete`.

The batch's page is search, so capture ran the configured harvest for `https://tennispremium.co/search`. Capture status `complete`, taxonomy `2026-10-04.2`, render present. 426 harvested names, 87 bindings, desktop and mobile renders. Bindings: product_tile 49, nav_toggle 31, nav_link 6, email_subscribe 1.

## Analysis

The second `--run` finished with failed 0 and pagesAnalyzed 1. Trigger hits and chains both stored: 46,860.

## Descriptors

17 bot drafts, all confidence `low`, were checked against the search-page harvest. Fifteen were promoted unchanged at confidence `high`, provenance `operator`, owner `operator`, `human_confirmed_by` `kennpalm`, template `url:65706970`.

Two drafts were wrong because the bot matches selector text, and this page's controls are named in Spanish inside the cart drawer and the footer:

- `p08.commerce`, both devices: `add_to_cart` corrected from 0 to 1. The harvest has 48 `+ADD` controls in `div#cart-drawer-upsell`. `variant_selector` corrected from 0 to 1. The harvest has 24 `Input - Select variant` controls in the same drawer. `express_checkout` stays 0. `cart_type` stays `unknown`.
- `p09.proof_risk`, both devices: `returns_policy_link` corrected from 0 to 1. The harvest names the footer link `Envíos y devoluciones`. `reviews_block`, `brag_bar`, and `faq_block` stay 0.

Store row added, with no template key: `s30.platform` = `{platform: shopify, shop_domain: tennispremiumco.myshopify.com}`, from `sites.platform` and `Shopify.shop` on the captured page. Dry-run then import: 18 operator rows.

## Replay

Replay datasets were `descriptor-snapshot`, `structural-screen`, `kind-fleet-weekly`, `requirement-status`, and the seven `cards-*` catalogs. `bot-draft` was left out. Replay recollected 473 rows and rewrote 311 cards. `template-weekly` was already stored by the analysis run (4 rows) and was kept.

## Trends

The first `--trend` wrote journey and page rows only (10,080) and `check.ok` was true. Element rows need selectors stored for this page. The built-in seed is the DVF homepage and does not apply here. Five bound controls on the search page were stored as active trend selectors:

- `Button - Búsqueda`
- `Form - Búsqueda`
- `Link - Iniciar sesión`
- `Form - Email`
- `Product Link - Otros clientes también compraron - ADIDAS ADIZERO ADIOS PRO`

The second `--trend` wrote 11,760 rows, including those selectors, and `check.ok` was true.

`--tag-trend` with `traffic-variance` and a 30-day lookback wrote 24,480 rows. `check.ok` was true. 145,268 kept sessions. Six keys selected: `utm_content`, `utm_medium`, `utm_source`, `ad_id`, `utm_term`, `utm_campaign`. `campaign_id` was rejected on variance. `variant`, `view`, `subdomain`, and the `pr_*` keys were rejected as not traffic keys.
