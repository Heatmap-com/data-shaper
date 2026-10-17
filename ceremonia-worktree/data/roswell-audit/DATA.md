# Roswell audit extract

This folder is `data/roswell-audit` in the analysis-engine repository. It is the stored output of one audit run: evidence for five ecommerce sites, aggregated in ClickHouse and written to `journey_events.ae_dataset_row`. It is not a narrative report. Rates, revenue, and rankings below are already computed. Do not re-aggregate a query that is already grouped, and do not treat a click-row's revenue as caused by the click. The project vision and the procedure for analyzing this extract are in `docs/VISION.md`.

## Files

| File | Rows | What it is |
|---|---:|---|
| `audit-readiness.jsonl` / `.csv` | 288 | Site identity, freshness, gaps, revenue trust, template coverage, click-match coverage |
| `audit-funnel.jsonl` / `.csv` | 16,704 | Session, funnel, path, timing, and abandonment series |
| `audit-template.jsonl` / `.csv` | 22,223 | Template KPIs, scroll, leagues, checkout, and element scorecards |
| `audit-context.jsonl` / `.csv` | 3,940 | Traffic mix, campaigns, seasonality, and the Heatmap-wide industry series |
| `audit-rank.jsonl` / `.csv` | 835 | Cross-brand pilot, medians, change points, and ranked revenue at stake |
| `catalog.json` |  | Row counts and the dimension and metric keys actually present on each query id |

JSONL is the canonical extract: one JSON object per line. CSV is the same rows with dimensions and metrics flattened. A metric that does not apply to a row is an empty CSV cell. Nested values (`by_template`, `gap_sample`, `reasons`, `events`, `by_event`) are JSON strings inside the CSV cell.

## Batch

- Batch id: `f7cdd67e-88dc-496a-a9f9-66ccb7af1a8c`
- Run clock: 2026-10-06 UTC
- Bot exclusion: portal data-model §11.4, stored as `bot_filter = portal_11_4` on every source row. This is a city and referrer predicate. It is not a fingerprint bot flag.
- Grain of every stored row: one site (`idsitehsr = 0`, `scope = site`). Page ids were used only to constrain the scans. They are not columns in this extract.
- Currency is the site currency from R1. Ceremonia, DVF, Hyperlite, and Peter Thomas Roth are USD. Denny's R1 currency is USD as well. Do not convert.

`audit-rank` rows are physically stored under idsite 4820. The `brand` field on those rows is the brand the rank describes. On every other file, `idsite` and `brand` refer to the same site.

## Brands

| Brand | idsite | Readiness | Notes that change interpretation |
|---|---:|---|---|
| Ceremonia | 4820 | partial | 34 days in the trend window have no kept sessions, clustered at the start. 12.9% of orders do not join to a visit in the same window. |
| Peter Thomas Roth | 6278 | blocked | `log_conversion` has no orders in the fresh window or the 52-week revenue window. Revenue metrics are zero. Only 6 days in the trend window have kept sessions. |
| DVF | 5795 | partial | Kept sessions on 67 of 364 trend days. 25.6% of orders do not join to a visit in the same window. Chosen as the pilot because F14 revenue at stake is the largest among brands that are not blocked. |
| Hyperlite | 3207 | partial | One empty trend day, 2025-12-31. 5.6% of orders do not join to a visit. Closest to the 5% unmatched bar. |
| Denny's | 4554 | partial | Two empty trend days (2025-12-04, 2025-12-31). R5 reports every snapshot pageview as unclassified because that classification threw `Maximum call stack size exceeded` over the page list. The template queries classify in ClickHouse and do contain home, collection, product, cart, and search rows. Checkout-completed visits are 11.8% below orders. 17.3% of orders do not join to a visit. |

Readiness is partial when any of these fail: a day in the 52-week trend has no kept sessions (R3), revenue trust is dirty rather than clean (R4), home / plp / pdp / cart_page are not all present (R5), checkout-completed visits differ from orders by more than 10% (R6), or named selectors match under 80% of snapshot clicks (R9). Blocked stops at a missing site, a stale required table, or untrusted revenue. This run still collected funnel, template, and context for the blocked brand.

The verdict row is `query = readiness` in `audit-readiness`.

## Windows

All brands share these UTC dates. Weeks are ISO weeks stored as the Monday date.

| Name | Start | End | Used for |
|---|---|---|---|
| Trend | 2025-10-06 | 2026-10-04 | Weekly KPIs, funnel, scroll, checkout, abandonment |
| Extended | 2024-10-07 | 2026-10-04 | F1, so the latest 52 weeks have a year-ago partner inside the same pull |
| Element | 2026-04-06 | 2026-10-04 | Intended window for click trends |
| Snapshot | 2026-09-08 | 2026-10-05 | Paths, leagues, scorecards, R5 pageviews, R8, R9 |
| Prior snapshot | 2026-08-11 | 2026-09-07 | F4 and K2 comparison |
| Year-ago snapshot | 2025-09-08 | 2025-10-05 | F4 and K2 comparison |

`dim_week` is that Monday, or null when the row is not weekly. F1 also has one rollup row per brand with `dim_device = all`, `dim_returning = all`, `dim_channel = all`, and `dim_week = 2026-10-04`. That row carries `slope_13w_cr_pct`, `yoy_cr_change`, and `trend`. Do not add it into weekly totals.

## Row fields

JSONL fields:

- `batch_id`, `idsite`, `brand`, `dataset_id`, `query`
- `dim_week`, `dim_device`, `dim_returning`, `dim_channel`, `dim_template`, `dim_element_class`
- `dims`: the remaining dimensions for that query (`step`, `path`, `band`, `page`, `measure`, `utm_source`, `utm_medium`, `utm_campaign`, `next_template`, `entry_template`, and so on)
- `metrics`: numeric and short text measures
- `row_key`, `generated_at`

Device is `Mobile` when `config_device_type = 3`. Tablet is reported as `Desktop`. Returning is `returning` or `new`. Channel comes from the visit referrer type: Direct, Search, Referral, Paid, Social, Other.

Template values are `home`, `plp` (collection), `pdp` (product), `cart_page`, `cart_drawer`, `checkout`, `search`, `global`, and `unclassified`. Classification is Shopify path rules on the page URL: `/` is home, a path containing `/products` is pdp, `/collections` is plp, `/cart` is cart_page, `/checkout` is checkout, `/search` is search. No brand supplied extra URL rules. Denny's H1 rows use those rules and include home, plp, pdp, cart_page, and search. The R5 row for Denny's does not: its `error` is `Maximum call stack size exceeded`, and `unclassified_share` is 1 because that failed pass never classified the page list.

## Units and rules that apply across queries

- `sessions`, `buyers`, `orders`, `clicks`, and `pageviews` are counts. `uniqExact` is the distinct-session count behind session metrics.
- `cr` on F1, F13, H1, L1, P1, C1, and X6 is a percent: buyers ÷ sessions × 100. `page_rps` and `rps` are revenue per session in site currency. `aov` is revenue ÷ orders.
- `prog_rate_*` on F2, `rate` on F4 and K2, `exit_rate`, `progression_rate`, `click_rate`, and `past_fold` are ratios from 0 to 1, not percents.
- `directional: true` means the cell is too small for a stable rate. On session KPIs that is under 1,000 sessions or under 30 conversions. On element scorecards it is under 1,000 clicking sessions. `directional: false` clears that floor.
- Funnel step order is session, then homepage_viewed, collection_viewed, product_viewed, add_to_cart, cart_viewed, checkout_started, checkout_completed. `reach_*` is visits with the event. `prog_*` is visits whose first time for that event is after the previous step. The first step's progression equals its reach.
- Revenue on a click or element row is the full visit's order revenue, attached to every clicked selector in that visit. `attribution` is `correlational` on scorecards. `lift` is clicker revenue per clicking session divided by non-clicker revenue per viewing session. It is not an incremental effect.
- `revenue_at_stake` on F14 is sessions lost between funnel steps × revenue per session among sessions that reached the step. X9's `revenue_at_stake` is the sum of that brand's F14 stakes. X10 also values F12 and C12 abandoned sessions at the completed-order average. Every stored X10 `trend` is `insufficient`. The rank is a sort of that stake, not evidence of a trend.
- A query that returned no rows is absent from these files. It was not stored as an explicit empty row, except element scorecards, which emit a zero-click row for each required class.

## Click evidence is empty

Every live selector in the naming matrices has `valid_from` of 2026-10-06. Click joins require the click's `server_date` to fall between `valid_from` and `valid_to`. The snapshot ends 2026-10-05 and the element window ends 2026-10-04, so no click in either window can match.

Consequences in this extract:

- R9 `matched` is 0 and `match_share` is 0 on all five brands. `clicks` is the real snapshot click count. `matrix_entries` is the count of naming rows, including absent ones.
- Element trends (H5 and its copies L5, P5, C5, G2) have no rows.
- Scorecards H4, L4, P4, C4, G1, and K4 have 480 rows and `clicks = 0` on every one. `absent: true` means the naming matrix has no live selector for that class (286 rows). `absent: false` means a selector exists and still matched nothing because of `valid_from` (194 rows). Do not read either as "shoppers never click this."
- Other click-only queries are absent for the same reason, including H6, H8, H9, L7, L9, P9, P10, P12, P13, P14, P15, C5, C6, C8, C11, C13, G2, G3, G4, G5, G7, K3, and K7.

Pageview, visit, and journey queries do not use `valid_from`. Those series are populated.

## Readiness queries

R1 is the site record: name, main URL, platform, currency, status. All five resolved.

R2 is one row per source table. `current` means `max_date` is on or after 2026-10-04. Required tables are `log_visit`, `log_hsr`, `log_conversion`, and `journey_events_map`. Peter Thomas Roth fails because `log_conversion.max_date` is null. Optional tables may be current or empty without blocking. `conversion_item` is dated on `server_time`. `page_speed_cache` is dated on `fetched_at`.

R3 counts trend days with at least one kept session, and lists gap days. `gap_sample` is the first 12 empty dates, not the full list. `gap_days` is the full count.

R4 is revenue trust over the trend window. `clean` requires orders, zero-revenue share under 5%, no duplicate order ids, and under 5% of orders whose visit is missing inside the same date window. `dirty` is the state of Ceremonia, DVF, Hyperlite, and Denny's: zero-revenue share is about 0 and there are no duplicate order ids; the failure is `unmatched_share`. `untrusted` is orders = 0, which is Peter Thomas Roth. Zero-revenue and unmatched shares are ratios.

R5 `by_template` is the share of snapshot pageviews on each template, plus `_pageviews` as the count. `covered` lists which of home, plp, pdp, and cart_page have a share above zero. Denny's `unclassified_share` is 1.0 and `error` is `Maximum call stack size exceeded`. That is a failed in-process classification of a very large page list, not a finding that the site has no home or product URLs. The ClickHouse template queries for Denny's are populated.

R6 compares `checkout_completed` visits in `journey_events_map` with `log_conversion` orders over the trend window. `reconcile_gap` is the absolute relative difference. `by_event` is sessions by journey event name. `cart_viewed` is that event's session count, not a page count.

R7 is the first date, page count, and element-row count in `udp_am_elements` from 2024-10-07 forward. This is exposure inventory, not click behavior.

R8 counts snapshot quadrants of device × returning × channel. `reportable` is how many of those quadrants have at least 1,000 sessions and 30 buyers. `reportable_share` is that count divided by the quadrant count.

R9 is described in the click-evidence section.

R10 is one row per trend week with raw visits and visits kept by the bot predicate, plus `removed_share`. There is also a parent row whose only metric is `weeks`.

R11 `weeks` is how many trend weeks have partner-tag rows. It is 0 for these brands. R12 `event_ids` is how many custom-event ids appear; it is 0. R13 `rows` is page-speed cache rows in the snapshot; it is 0.

## Funnel queries

F1 is weekly site sessions, buyers, orders, revenue, CR, RPS, and AOV by device, returning, and channel, from the extended window. The `all` / `all` / `all` row is the 13-week CR slope and the year-over-year CR change for the latest 52 trend weeks.

F2 is the weekly funnel by device and returning, with reach, progression, and progression rate for each step after session. Revenue on F2 is visit revenue, not step revenue.

F3 is the same funnel by device, returning, and channel, in 91-day chunks over the trend. It also has `revenue_<step>`, the visit revenue of sessions that reached that step.

F4 is one row per step with snapshot progression, the rate, and a two-proportion z-test against the prior 28 days and the year-ago 28 days. `significant_*` is true when the absolute z is above 1.96. Peter Thomas Roth's year-ago snapshot has no kept sessions, so those z values are not a year-over-year change.

F5 is the template of the visit's first tracked page, weekly, with sessions, buyers, and revenue. The template dimension is `dim_template`.

F6 is the top 25 session paths in the snapshot. `dims.path` is templates joined with ` > `, consecutive duplicates removed. F7 is the weekly session count for those paths over the element window.

F8 is snapshot transitions from one template to the next (`dim_template`, `dims.next_template`) and `moves`.

F9 is weekly exits: the template of the visit's last tracked page. H1exit in the template file is the same scan and can disagree in row count where the page set differs. Exit rate on H1, L1, P1, and C1 was attached from F9.

F10 is weekly sessions that went product → collection, or cart → product, plus average product-page views for buyers and non-buyers.

F11 is weekly medians and 75th percentiles, in seconds, for product-view to add-to-cart, add-to-cart to checkout-started, and checkout-started to checkout-completed. A missing step makes the diff null and that visit drops out of that quantile.

F12 is weekly add-to-cart without checkout-started, checkout-started without checkout-completed, and completed orders' revenue and session count.

F13 is weekly revenue share, order share, and CR by returning versus new, built from F1.

F14 is snapshot sessions lost at each step and the revenue at stake, by device and returning. See the units section.

F15 is the mix-versus-rate split of the change in CR and in RPS, last four trend weeks against the four before them. `dims.measure` is `cr` or `rps`. Peter Thomas Roth is absent because it does not have eight trend weeks.

## Template queries

H1 is the weekly template KPI: sessions, buyers, revenue, CR, page RPS, and the directional flag, for home, plp, pdp, cart_page, checkout, and search. Exit rate and progression rate are attached when the matching exit and progress rows exist.

L1, P1, and the cart_page rows of C1 are copies of the H1 rows for plp, pdp, and cart_page. C1 rows with `dim_template = cart_drawer` are a different series: weekly visits with a `cart_viewed` journey event, not a cart URL. Checkout page rows stay on H1. K1 is not a copy of H1.

H1progress is sessions and how many progressed to another tracked template. H1exit is exit counts. Both are inputs to the rates on H1 and its copies.

H2, and its copies L2, P2, and C2, are weekly scroll depth (0–100 scale), share of pageviews that scrolled past the fold, time on page in seconds, and pageviews. Time on page is null unless it exceeds 5 seconds. C2 has no Peter Thomas Roth rows because that site has no cart page in the classified set.

H3, and its copies L3, P3, C3, and L8, put snapshot pageviews into scroll bands. `dims.band` is the band. L8 is the plp copy of H3.

H7 is where sessions that viewed home went next, with sessions and revenue. H10 is sessions, buyers, and revenue by the template of the entry page.

L6 and L13 are collection-page leagues for the snapshot, limited to 50 pages. `dims.page` is the page id as text. L6 has sessions, exits, buyers, and revenue. L13 has sessions and pogo sessions (collection to product and straight back). P6 is the product-page league: sessions, add-to-cart sessions, buyers, and revenue.

L12 is weekly search versus other sessions, search-to-product, and search revenue.

L10 is one snapshot row: filter clicks, filter sessions, rage clicks, and filter sessions that did not later see a product page. DVF has no row.

L11 compares quick-add sessions with sessions that added to cart only after a product view. Revenue figures are visit revenue.

P7 is weekly product-view sessions and how many of those added to cart afterward.

P8 is one snapshot row: add-to-cart sessions, and how many had a variant, size guide, review, or gallery click earlier in the page view. The earlier action is correlational.

P11 compares sessions that clicked reviews with other product sessions. Denny's and Peter Thomas Roth have no row.

P16 is snapshot product sessions and add-to-cart sessions by the quartile of the session's average item price. `dims.band` is `q1` through `q4` or `unknown`. Quartiles are computed inside that brand's orders.

C7 is one snapshot row: sessions that saw the cart without a cart-icon click (`cart_without_icon`) versus sessions that clicked the icon and then saw the cart (`icon_then_cart`).

C10 is snapshot orders and revenue by order-value band: `0-25`, `25-50`, `50-75`, `75-100`, `100+`. These are fixed bands, not a merchant's free-shipping threshold. Orders with revenue at or below zero are excluded.

C12 is weekly abandoned cart-item value and abandoned sessions, beside completed revenue and completed sessions.

K1 is weekly visits with `checkout_started` and visits with `checkout_completed`.

K2 is checkout completion for the snapshot, the prior window, and last year (`dims.measure`), plus a comparison row with z-tests. `rate` is completed ÷ started.

K5 is weekly median and 75th percentile of checkout duration in minutes. Peter Thomas Roth has no row.

K6 is one snapshot row for sessions that started checkout, came back, and bought. `returned` is the return count.

G6 is the top unmatched click selectors in the snapshot (`dims.path` is the raw selector, `clicks` is the count), up to 50 per brand. These are clicks the naming matrix did not claim. Because of `valid_from`, the matrix claims nothing in this window, so G6 is effectively the most common click selectors overall.

## Context queries

X1 is the weekly share of trend sessions by device, returning, and channel, built from F1. Shares in a week sum to 1.

X2 is snapshot sessions, buyers, and revenue by `dims.utm_source`, `dims.utm_medium`, and `dims.utm_campaign`. The scan is limited to 100 combinations per brand. Empty UTM values appear when the tag is missing.

X6 is each trend week's sessions and CR divided by the week 52 weeks earlier. `session_index` and `cr_index` are those ratios. CR itself is a percent.

X8 is the `industry_insight` series over the snapshot. It has no site id and no category. The same dates are repeated on every brand. `conversion_rate`, `rps`, and `aov` are the fleet figures as stored. Do not compare a brand's CR with X8 as if X8 were that brand's peer set. There are 26 rows per brand because the column named `week` is the insight table's `server_date`, one row per day in the 28-day snapshot.

X3 (page speed) and X4 (experiments) returned no rows and are not in the files.

## Rank queries

X9 is one row per brand: verdict, F14 revenue at stake, share of snapshot quadrants that clear the sufficiency floor, pipeline completeness, and `pilot`. `pilot` is true only for DVF.

X7 is snapshot template CR against the cross-brand median for that template and device. A template needs at least two brands with sessions. `vs_median` is the brand CR minus the median, in percentage points. `cr` here is a percent.

X5 is a week where the four-week average of site CR sits more than two standard deviations from the prior eight weeks. `events` is an empty list for every row because none of the five matrices included calendar events. Ceremonia has six flags, Hyperlite two, Denny's two. DVF and Peter Thomas Roth have none.

X10 is the ranked list of F14, F12, and C12 stakes. `dims.source` is the query the stake came from. `dims.label` identifies the step or week. `rank` 1 is the largest stake in the whole extract, not within one brand.

## How to use this with a model

Filter to one `brand` and one `query` before interpreting a number. Weekly series are already one row per week and breakdown, so summing `sessions` across devices double-counts if you also keep a total you computed yourself, and the F1 `all` row must stay out of any sum. Snapshot queries are a single 28-day total, not a week. Denny's R5 row is a failed classification; its H1 and F5 rows are the template picture. Peter Thomas Roth revenue columns are a site with no orders in the window. Element scorecards are not a click analysis until the selector validity dates include the window being measured.
