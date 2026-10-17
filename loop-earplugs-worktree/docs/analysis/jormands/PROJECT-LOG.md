# Jormands project log

Site: Jormands (`jormands.com.co`), idsite 6136. Queue item `q20261013t060517360-jormands-com-co`.

Window: 2026-09-13 through 2026-10-12. Batch `affc9f9d-66fd-45a3-9e7b-99c8cdd513d0`.

## Naming

Homepage harvest is `dataset/6136/landing/index`: 704 names, both renders, `naming.complete`. Live origin is `https://jormands.com.co/` (apex 200; `www` returns 403).

## Stored analysis

Focus page: `https://jormands.com.co/collections/promo`, idsitehsr 64389009, page type collection. Site queue after the completed run: 18,553 entry sessions, 112 orders, revenue about $8,909.59, one page analysed.

Capture of the promo collection: 716 names, 275 bindings, both devices, 89s, then the page was released back to the batch (`requeued: 1`). Harvest directory `dataset/6136/collection/promo/`.

The first analysis `--run` stopped at `awaiting_capture`. The second `--run` failed when ClickHouse hit its 28.51 GiB memory ceiling during parallel product-grid queries, and the site row was left `failed`. A plain retry did not claim it. The site was set back to `queued` and the third `--run` resumed from checkpoints: product-grid wrote 356 rows, trigger hits and chains were 31,400 each, and the batch finished with `pagesAnalyzed: 1` and `failed: 0`.

## Descriptors

Seventeen bot drafts were reviewed against the promo harvest. `p08.commerce` already had `add_to_cart` at 1 (23 names containing Agregar). `variant_selector` and `express_checkout` stay 0. `cart_type` stays `unknown`.

`p09.proof_risk`, both devices: `faq_block` 0→1 (Preguntas frecuentes links) and `returns_policy_link` 0→1 (Footer Refund Policy Link). Reviews and brag stay 0.

`s30.platform`: `{platform: shopify, shop_domain: jormands-co.myshopify.com}` from `Shopify.shop` on the captured page. Dry-run then import: 18 operator rows.

## Replay and trends

Replay left `bot-draft` out. Recollected 474 rows and wrote 311 cards.

First trend: 9,408 rows, `check.ok` true, no selectors yet. Five active selectors stored for 6136 / 64389009:

- Announcement bar: `div#header-group > section.shopify-section.shopify-section-group-header-group.cm-hs-bar-section.heatmap-com__hidden-element > div > div.cm-hs-mini.heatmap-com__hidden-element`
- Collection link (early access): `div#header-group > section.shopify-section.shopify-section-group-header-group.cm-hs-bar-section > div > a.cm-hs-todo`
- Results pagination link: `div#ResultsList > div > nav > ul > li:nth-child(3) > a`
- Product link (Croco backpack): `a#HeaderDrawer-novedades-croco-backpack`
- Menu drawer (Canguros): `details#Details-menu-drawer-productos-canguros`

Second trend: 11,088 rows, `check.ok` true. Tag-trend selected `utm_source`, `utm_medium`, `utm_campaign`, `utm_content`, and `utm_term`: 21,600 rows, `check.ok` true. Seventeen other keys were rejected.
