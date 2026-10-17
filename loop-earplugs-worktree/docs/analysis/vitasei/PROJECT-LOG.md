# Vitasei — analysis project

**Site:** Vitasei, idsite `5933`, `https://www.vitasei.com.co/`
**Slug:** `vitasei`
**Window:** 2026-09-13 through 2026-10-12 (30 days ending yesterday UTC)
**Batch:** `b689b030-c4e9-4d98-9345-2180ff086691`

## Batch

`static-idsites`, `prefer-non-home`, `primary-only`, catalogs LP PG PI PO TD TG TI. The first `--run` stopped at `awaiting_capture` (queued 1, awaitingCapture 1). That gate was expected.

| | |
| --- | --- |
| Page | `https://vitasei.com.co` |
| idsitehsr | `59744352` |
| Type | home |
| Entry sessions | 6,503 |
| Orders | 0 |
| Revenue | $0 |

The qualifier kept the homepage. No non-home page cleared the order and session-share bar.

## Naming and capture

Homepage harvest, from the naming step: `dataset/5933/landing/index`, both renders, `naming.complete`.

Capture ran the configured harvest for `https://vitasei.com.co`. Capture status `complete`, taxonomy `2026-10-04.2`, render present. 2,183 harvested names, 459 bindings, desktop and mobile renders, 102.99 seconds. `requeued: 1` released the page back to the batch. Bindings: product_tile 427, collection_tile 23, promo_cta 3, nav_link 3, announcement_bar 1, email_subscribe 1, nav_toggle 1.

## Analysis

The second `--run` finished with failed 0 and pagesAnalyzed 1. Trigger hits and chains both stored: 13,993.

## Descriptors

17 bot drafts were checked against the homepage harvest. Thirteen were promoted unchanged at confidence `high`, provenance `operator`, owner `operator`, `human_confirmed_by` `kennpalm`, template `url:59744352`.

Two field paths were wrong because the bot matches selector text, and this page names the controls in Spanish:

- `p08.commerce`, both devices: `add_to_cart` corrected from 0 to 1. The harvest has 98 `Product Button Agregar al carrito` controls. `variant_selector` stays 0. `express_checkout` stays 0. `cart_type` stays `unknown`.
- `p09.proof_risk`, both devices: `reviews_block` corrected from 0 to 1. The harvest names review stars on product tiles (`Review Star Group` and product-tile review stars). `brag_bar`, `faq_block`, and `returns_policy_link` stay 0.

`p03.offer` stays `{aov_measured: null}` because this page's entry sessions placed no orders.

Store row added, with no template key: `s30.platform` = `{platform: shopify, shop_domain: vitasei-col.myshopify.com}`, from `sites.platform` and `Shopify.shop` on the captured page. Dry-run then import: 18 operator rows.

## Replay

Replay datasets were `descriptor-snapshot`, `structural-screen`, `kind-fleet-weekly`, `requirement-status`, and the seven `cards-*` catalogs. `bot-draft` was left out. Replay recollected 474 rows and rewrote 311 cards. The analysis run had already stored `kind-fleet-weekly` (5 rows) and `template-weekly` (6 rows). Replay recollected `kind-fleet-weekly` and kept `template-weekly`.

## Trends

The first `--trend` wrote journey and page rows only (8,064) and `check.ok` was true. Element rows need selectors stored for this page. The built-in seed is the DVF homepage and does not apply here. Five bound controls on the homepage were stored as active trend selectors:

- `Section - Announcement Bar`
- `Email Link`
- `Link - MÉXICO`
- `Button - Create Your Mobile Categories Menu Sidebar And Config From Section > Mobile Categories`
- `Product Link - Slideshow Group - astroderma crema facial noche`

The second `--trend` wrote 9,744 rows, including those selectors, and `check.ok` was true.

`--tag-trend` with `traffic-variance` and a 30-day lookback wrote the selection and zero trend rows. No traffic key cleared the bar. `utm_medium`, `utm_source`, `utm_campaign`, `utm_content`, `utm_term`, `campaign_id`, and `ad_id` were rejected because the values earn alike (RPS z 0.00, spread 0.00, AOV too few orders). `subdomain`, `variant`, `view`, and the `pr_*` keys were rejected as not traffic keys. `check` is null because there were no rows to check. That is the engine result when the selector selects nothing.
