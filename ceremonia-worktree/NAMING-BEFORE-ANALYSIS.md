# Name the page before analysis

> **Superseded by `docs/CAPTURE-BEFORE-ANALYSIS.md`** (schema 2: the capture
> gate reads `ae_page_capture`; the capture consumer replaces the naming
> consumer; naming + render + saliency per the data-capture plan §9.3).

This is the integration contract for the coding agent working in `/Users/kennpalm/source/heatmap/cnn-ai-bot`.

The analysis engine at `/Users/kennpalm/Work/analysis-engine` did not call the naming bot. Selector classes came from an optional `element-names.json` (`ANALYSIS_ELEMENT_NAMES`) and from `udp_am_elements.role`. On the last batch that left almost every selector untyped, so FAQ, product-tile, and menu strategies stayed blocked. The engine now refuses to analyze a qualified page until a naming record for that page is fresh. The bot is the producer of that record. The engine does not import the bot and does not run `pnpm cnn-name`.

## Sequence

1. The engine qualifies a landing page (non-home preference, then at least 100 pageview hits on that page over the last 7 complete UTC days).
2. It reads `journey_events.page_naming_current` for that `idsite` + `idsitehsr`.
3. The name is fresh only when `status = complete`, `taxonomy_version` equals the engine constant `TAXONOMY_VERSION` (`2026-10-03` in `src/domain/taxonomy.js`), and `named_on` is within 14 days of the engine clock (`NAMING_MAX_AGE_DAYS`).
4. If the name is missing, incomplete, on an older taxonomy, or older than 14 days, the engine inserts `journey_events.naming_queue` with `status = queued` and sets `site_queue` to `awaiting_naming`. It does not run datasets.
5. The naming consumer polls `naming_queue_current` for `status = queued`, runs the bot, writes element rows, then calls the engine CLI below.
6. `completeNaming` writes `page_naming` (`status = complete`), writes `page_element_name`, and sets every `site_queue` row for that `idsite` + `idsitehsr` that is `awaiting_naming` back to `queued`.
7. The next `node src/index.js --resume <batch_id>` claims that site and runs analysis. `claimNext` does not claim `awaiting_naming`.

Fail closed. A qualified page with no fresh name is not analyzed. Posting to `/heatmaps/savenaming` does not satisfy the check. The engine does not read that API.

## What the bot already is, and what it is not

`cnn-ai-bot` is a CLI (`pnpm cnn-name site|rename|page|seed|eval`). It harvests a name table and can POST `{idsite, url, pageKind, rows}` to `{apiBase}/heatmaps/savenaming` when persist policy is automation. That POST is not this integration.

`NameRow.type` is the page kind (`page | site | pdp | collection | landing`). It is not an element class. Do not put `product_tile` or `faq_item` in `type`.

`MUST_NAME_FAMILIES` is an Impact-theme CSS coverage list (skip-link, announcement bar, header, nav, product cards, and so on). It is not the strategy taxonomy. Keep using it as the harvest checklist, then map each harvested control onto one `element_class` from the list below.

`udp_am_elements.role` stays unused for these strategies. The analysis datasets read `page_element_name` first and the optional JSON file second, exact selector match only.

## Taxonomy

`element_class` must be one of these strings. `completeNaming` throws and does not mark the page complete if any row uses another string.

`product_tile`, `faq_item`, `nav_link`, `nav_toggle`, `hero_cta`, `promo_cta`, `offer_add_to_cart`, `bundle_product_add`, `bundle_slot`, `bundle_checkout`, `cart_checkout`, `express_checkout`, `cart_drawer_close`, `cart_upsell`, `collection_tile`, `content_section`, `rewards_link`, `email_subscribe`, `announcement_bar`

Add an `element_class` field on the persisted row. Leave `type` as page kind. `name` stays the human label.

When `TAXONOMY_VERSION` changes, every stored name becomes stale and the engine queues the page again. Ship the new class list in the same change as the version bump in `src/domain/taxonomy.js`.

## Coverage bar before you call complete

The engine does not re-score coverage. Call `--naming-complete` only when all of the following hold:

- Every repeated product card, bundle option, or collection card is its own selector with `product_tile`, `bundle_product_add`, or `collection_tile`. One shared card selector cannot be split later.
- Every FAQ question that is its own DOM node is `faq_item`. If the click stream is one accordion selector, do not invent per-question classes. Leave that control as `content_section` or unnamed. Strategy P2 then stays `blocked`, which is the correct state.
- Every primary-menu link is `nav_link`. The menu button is `nav_toggle`.
- A class is applied only when the selector is the control a visitor clicks, exact string, no prefix match.

An empty `names` array still marks the page complete. Do not call complete with an empty file to skip the bot.

## Consumer

Poll:

```sql
SELECT idsite, idsitehsr, landing_page_url, page_type, reason
  FROM journey_events.naming_queue_current
 WHERE status = 'queued'
 ORDER BY requested_on
```

For each row:

1. `pnpm cnn-name page --url <landing_page_url>` with the site id the bot already requires.
2. Map the name table to a JSON array:

```json
[
  {"selector": ".product-card:nth-child(3) a", "element_class": "product_tile", "name": "Summit fleece"}
]
```

3. From `/Users/kennpalm/Work/analysis-engine`:

```bash
node src/index.js --naming-complete \
  --idsite 3199 \
  --idsitehsr 63918696 \
  --url 'https://example.com/pages/offer' \
  --names /absolute/path/names.json
```

That command writes the three tables and re-queues analysis. It does not run the datasets. Resume the batch after the queue is drained, or let the next scheduled engine run claim the site.

On bot failure, leave `naming_queue.status` as `queued` (or insert `failed` with a reason) and do not call `--naming-complete`. The page stays `awaiting_naming`.

## Tables

All in `journey_events`. ReplacingMergeTree, read the `_current` views.

| Table | Key | Written by |
| --- | --- | --- |
| `page_naming` | `idsite`, `idsitehsr` | engine `completeNaming` |
| `page_element_name` | `idsite`, `idsitehsr`, `selector` | engine `completeNaming` |
| `naming_queue` | `idsite`, `idsitehsr` | engine when the name is stale; consumer completion overwrites status to `complete` |

`page_naming` columns: `status`, `taxonomy_version`, `named_on`, `landing_page_url`, `coverage` (JSON, currently `{named_selectors: N}`).

## Strategies this unblocks

Rules live in `src/adapters/datasets/strategy-triggers.js`. A trigger is a threshold state (`blocked`, `below_floor`, `triggered`, `silent`). It is not a recommendation and it is not a cause.

| Id | Rule | When it fires |
| --- | --- | --- |
| P1 | 15 | Two or more `product_tile` selectors, each with at least 10 clicking sessions and a click `median_y`. The order-rate leader is at least 2× a sibling and sits at least 50 y-units lower on the page (larger `median_y`). |
| P2 | 16 | Same comparison for `faq_item`. One shared FAQ selector stays `blocked`. |
| P3 | 17 | Two or more `nav_link` selectors at the session floor. The order-rate leader is not the most-clicked item, and its order rate is at least 2× that item. |
| P4 | 18 | The same position test as P1, applied to every class that has two members. This is the general above-the-fold promotion: a class whose stronger member is buried under a weaker sibling. |

Fewer than two classed members is `blocked`. Two members under the 10-session floor is `below_floor`. Do not sum `clicking_sessions` across selectors to invent a type rate. Position uses click `median_y` on the 0–1000 scroll scale; smaller y is higher on the page.

## Files the engine side already changed

- `src/domain/taxonomy.js`, `src/domain/naming-freshness.js`
- `src/runner.js` gates analysis on freshness
- `src/adapters/persistence/clickhouse.js` and `memory.js` own the three tables and `completeNaming`
- `src/index.js` `--naming-complete`
- `src/adapters/_lib/element-names.js` `namesForPage` reads `page_element_name_current` before the JSON file
- `selector-weekly`, `rage-clicks`, and `nav-next-page` use that matcher
- Strategies P1–P4

Do not add a switch in the runner. Do not have the bot write analysis rows. Facet reads the analysis record later; it does not name the page.
