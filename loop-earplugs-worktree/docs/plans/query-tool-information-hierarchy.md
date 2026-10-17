# The platform's data as an information hierarchy, for a CRO query tool

**Date:** 15 October 2026
**Status:** analysis. Nothing is built. This is the input to a dashboard and query-tool plan.
**Reads with:** `docs/VISION.md`, `docs/PROGRAM-VISION.md` §11 and §13 (snapshots and the tabular interface), `docs/ARCHITECTURE.md` §5–§6, `docs/TREND-ENRICHMENT.md`, `~/work/analysis/<slug>/00_README_data_guide.md`.

## 1. The question

A CRO opens the tool to ask how the site is performing. What can the platform show them, in what shape, and in what order should they meet it?

The answer has three parts:

1. **What the platform stores.** Two surfaces, nine shapes of data (§2, §3).
2. **What each shape answers, and which strategies read it** (§4, §5).
3. **The order a CRO asks in.** That order is the information hierarchy, and it becomes the dashboard's navigation (§6, §7).

The engine measures and the reports write prose. The query tool sits between the two. It shows stored rows as tables and never recomputes a number from the raw log. That is the same rule the report side follows.

## 2. Two surfaces, and what is on each today

### 2.1 Surface one: the warehouse output tables (`journey_events.ae_*`)

These are the stored, checked rows. Every table is `ReplacingMergeTree(generated_at)` and is read through a `_current` view. A rerun replaces rows rather than adding a second copy.

| Table | Grain | Sites with rows (15 Oct 2026) |
|---|---|---|
| `ae_trend_row` | subject × segmentation value × device × Monday week | 11 sites, 4–6 weeks each (7 Sep to 12 Oct). Not '47. |
| `ae_session_tag_trend` | tag key and value × segmentation value × device × week | 9 sites, 2–9 tag keys each |
| `ae_trigger_hit`, `ae_trigger_chain` | one visit that met a trigger, and its 14-day outcome | about 14 sites, 3 triggers each, about 30 days |
| `ae_experiment_row` | experiment × arm × basis × page/section/selector × segment × day | 8 sites, 1–25 experiments |
| `ae_dataset_row` | batch × page × dataset × row (dims and metrics as JSON) | 16 sites, 39–45 datasets each |
| `ae_strategy_card` | batch × page × catalog × strategy × segment | 13 sites, 311 cards per batch, 7 catalogs |
| `ae_requirement_status` | batch × page × requirement key | the same batches |
| `ae_page_analysis`, `ae_site_analysis` | batch × page, batch × site | the same batches |
| Reference: `ae_strategy_catalog`, `ae_requirement`, `ae_segmentation_definition`, `ae_trigger_definition`, `ae_element_binding`, `ae_render_node` | vocabulary and identity | shared |
| `ae_src_*` (orders, refunds, reviews, ad creatives, search, speed, …) | commercial context | DDL only. No connector writes them yet. |

Site ids seen: 558 Loop Earplugs, 1425 Latico Leathers, 2501 Seat Cover Solutions, 3616 Kurk, 4820 Ceremonia, 4879 Mellow, 5184 '47, 5680 Sayii, 5795 DVF, 5933 Vitasei, 6136 Jormands, 6213 Tennis Premium, plus 3199, 3207, 4554, 6277, and 6278, which have no site folder in `orchestration/sites/`.

### 2.2 Surface two: the analyst bundle (`~/work/analysis/<slug>/`)

The bundle is a file export: one window (30 days plus a 14-day lead-in), one analysed page, and about 60 tables across 9 files. It is what the three reports are written from. It holds crossed cubes the warehouse does not store as such (date × device × channel × campaign channel, for example), and it holds a page's pipeline datasets flattened from `ae_dataset_row`.

The bundle guide says it does **not** contain trend rows or tag-trend rows. The two surfaces overlap without matching: the bundle is wider (many crossed dimensions, one window), and the trend grain is deeper over time (one segmentation per row, every week).

### 2.3 Surface three: shaped datasets (on demand)

`node src/cli.js --shape <request>` builds crossed, segmented series on demand as files (`data.csv`, `dataset.json`, `DATA.md`). Nothing is stored in a table. To the query tool, this is how it answers "the table I need doesn't exist yet". It is not a source to browse.

## 3. The nine shapes

A shape is a grain family. Rows of one shape read the same way, need the same caveats, and want the same kind of view. Many tables share one shape.

### Shape 1. Weekly snapshot (subject × segment × device × week)

- **Tables:** `ae_trend_row` (subjects: template path, template step, URL path, URL step, page, selector), `ae_session_tag_trend` (subject: a tag value such as `utm_campaign = holiday_gg`), `ae_experiment_row` (the same idea per day, with arm and basis).
- **Keys:** `row_type`, `row_key`, `row_key_1`, `row_key_2`, `idsitehsr`, `viewport_type` (all, desktop, tablet, mobile, unknown), `segment`, `segment_value`, `week`.
- **Measures, the same on every row:** sessions, buyers, orders, revenue, clicks, progressed. Extras such as rank, step index and segmentation version sit in `metrics` JSON.
- **Segmentations:** `traffic_source` (meta, direct, search, website, campaign, social, other), `returning`, `buyer`, `rager`, plus `channel`, `link_channel` and `return_intent` where a site selects them. `all/all` is the stored total.
- **Invariant:** within one segmentation the values partition sessions and sum to `all`. Across segmentations they overlap. `viewport_type = all` is a total, not a fourth device.
- **Subjects are frozen lists:** the top 3 template paths and top 3 URL paths by revenue, the top 5 pages by sessions, and the selectors a site asked for (5 per page today).

This is the shape `PROGRAM-VISION.md` §13.1 describes: rows are subjects, columns are weeks, and a segmentation switcher re-cuts the table.

### Shape 2. Crossed period cube (several dimensions × one period)

- **Bundle tables:** `daily_site`, `daily_channel_device` (date × device × referrer channel × campaign channel), `campaign_daily`, `weekly_entry_cube` (week × device × channel × campaign channel × entry class × returning), `weekly_source_campaign`, `meta_creative_period`, `product_daily`, `product_entry_period`, `focus_entry_daily`, `page_period` (URL × period × device), `visit_cohorts` (behaviour family × value × period), `shopper_history_30d`.
- **Pipeline datasets (one page, from `ae_dataset_row`):** `page-segment-weekly` (week × device × source × returning × browser × viewport class), `campaign-weekly`, `entry-by-channel`, `site-baselines`, `template-weekly`, `page-country`, `sister-pages`.
- **Measures:** visits, buyer visits, orders, revenue, add-to-cart visits, checkout visits. Page-pipeline tables add single-pageview share, scroll reach shares, time on page and RPS.
- **Invariant:** dimensions are crossed, so a cell is filterable on several at once, but rows below a volume floor are rolled into catch-alls (`(small)`, `(pages under …)`, `(campaigns under …)`).
- **Periods:** `pre`, `first`, `second` and the three `peak` days, or the site's own `periods`. `peak` overlaps the others.

This is the pivot-table shape. A CRO filters and groups it, rather than reading it as a time series.

### Shape 3. Element interaction rows (page × selector × week × device)

- **Tables:** `selector-weekly` (clicks, clicking sessions, sessions with order, revenue, first-click timing, median position), `nav-next-page` (element → the page type visited next), `tap-geometry-weekly` (off-target taps, offset from centre, correction pairs), `rage-clicks` and `rage-clicks:totals`, `kind-fleet-weekly` (the same element class at different positions), `exposure-weekly` (exposed sessions, dwell, exposed revenue, RPeS per section), `product-grid` (tile cells with row reach, CTR baseline and a priority score), and `element-binding` with the `selectors` lookup.
- **Keys:** `selector_id`, `element_class` (54-class taxonomy, for example `pdp.gallery_main`), name, role, week, device.
- **Invariant:** element revenue is the revenue of sessions that clicked. It is correlational and not additive across elements. An unnamed element stays unnamed, and the strategies that need its class read `blocked`.

### Shape 4. Distributions (bins and percentiles)

- **Tables:** `scroll-decile` (depth bin × week × device × source), `viewport-weekly` (viewport class share), `order-value-hist` (bucket × kind, with p25, p50, p75), `dwell-model-inputs` (median and p75 engaged time), `high_value_page_reach` (share of high-value buyers who saw a page against all visitors, `over_index`), `email_multi_click` (visit-count bands).
- **Invariant:** a bin's share is only meaningful against its own total. Bins are not sessions to be summed into other tables.

### Shape 5. Flows and sequences

- **Tables:** `journey-weekly` (journey cluster × week × device), `funnel-sequence-weekly` (from step → to step, median minutes, checkout without add-to-cart), `nav-next-page`, `visit_cohorts` family `journey3` (page-class path, paths with 200+ visits), and the path and step rows of Shape 1.
- **Invariant:** a path row counts exact matches. A step row also counts visits that continued past the path, so the last step can exceed the path. Consecutive repeats are compacted.

### Shape 6. Cohort outcomes (an event, followed through a window)

- **Tables:** `ae_trigger_hit` and `ae_trigger_chain` (one row per triggering visit: returned, sessions until return, purchased, revenue, seconds to purchase, recovered, `final`), the bundle's `trigger-chains` (aggregated to date × trigger × device × level × final), `shopper_history_30d`, the `return_intent` segmentation, `email_multi_click`.
- **Triggers:** `abandoned_cart` (session added to cart or started checkout without buying), `showed_interest` (3+ pages, 3+ clicks, 50% scroll, 60 s), `super_shopper` (visitor: 2+ sessions in 14 days with interest, an add to cart and 3+ product pages).
- **Invariant:** only `final = 1` rows have a closed 14-day window. The visitor key is a browser (`config_id`), not a person, which undercounts returns from in-app browsers such as Meta's.
- **Crosses are allowed here.** Each chain row carries device, channel, source, medium, returning, country, landing page and entry template. This is the one stored grain where "Meta × mobile × new" is a filter, not a dataset request.

### Shape 7. Entity ledger (one row per thing)

- **Tables:** `01_orders.csv` (one row per order: revenue, top item, markdown flags, the matched visit's channel, entry, pages, clicks, shopper history, country), `line-items` (partial), `recordings-sample` (recording ids by population).
- **Future:** `ae_src_order`, `ae_src_refund`, `ae_src_review`, `ae_src_ad_creative` and the rest, once connectors exist.
- **Use:** drill-through. The anchors (order count, revenue, median order, high-value orders) are computed from this ledger, so it is also the reconciliation source.

### Shape 8. Verdicts (what the platform concludes)

- **Tables:** `requirement-status` / `ae_requirement_status` (101 requirement keys: available, partial, missing, unknown value), `structural-screen` (screen rule state), `strategy-triggers` (18 rules: triggered, silent, below floor, blocked, each with metric, value and threshold), `cards-lp/pg/pi/po/td/tg/ti` / `ae_strategy_card` (verdict, trigger state, gate failed, missing requirements, attribution label, confidence, impact proxy, score), `ae_page_analysis` and `ae_site_analysis` (rollups with card-state counts), `coverage`, `campaign-coverage`, `ae_traffic_exclusion_model`, quality findings from `--shape`.
- **Invariant:** `blocked` is a result and names what is missing. A verdict cites its rule record, and the rule record cites the dataset rows.

This is the "Beliefs" layer in `HYPOTHESIS-BUILDER-ARCHITECTURE.md` §5.1.

### Shape 9. Reference and identity

- **Tables:** the strategy catalogs (11 families, about 330 strategies), `ae_requirement`, `ae_segmentation_definition` (versioned), `ae_trigger_definition` (versioned), `selectors`, `element-binding`, `render-snapshot` (node geometry, is-control, looks-clickable, sticky, in first viewport), `ae_page_descriptor`.
- **Use:** labels and definitions. Every other view looks up its names here, and the tool's "what does this mean" panel reads from it.

## 4. What each shape answers

Each question below is one a CRO would actually ask. For each, the table names the shape and table that answer it, and the question that should come next.

### 4.1 Site health: "Am I OK?"

| Question | Shape and table | Next question |
|---|---|---|
| Orders, revenue, AOV and conversion this week against last, and against the lead-in | 2: `daily_site`; 1: `all/all` rows summed over a site's subjects; 8: `ae_site_analysis` | Which part moved? |
| Is the line steady because nothing changed, or because two things cancelled? | 1: journey path rows side by side, plus the traffic-mix strip (share of sessions per `segment_value`) | Which journey and which segment? |
| How much traffic is junk? | 2: `daily_site.bot_visits`; 8: `ae_traffic_exclusion_model` | Is a channel inflated by it? |
| Which days carried the month? | 2: `daily_site`, the `peak` period | Who bought on those days (channel, campaign)? |

### 4.2 Acquisition: "Who is coming, and are they worth it?"

| Question | Shape and table | Next question |
|---|---|---|
| Revenue per visit by channel, week over week | 1: `segment = traffic_source` or `channel`; 2: `weekly_entry_cube` | Which campaign inside the weak channel? |
| Which campaigns and creatives send volume that never buys? | 2: `weekly_source_campaign`, `meta_creative_period`, `campaign_daily`; 1: `ae_session_tag_trend` for `utm_campaign` and `utm_content` | Where do they land? |
| Which tag keys separate revenue at all? | 9 and 8: `ae_session_tag_selection` (ANOVA z and spread, selected or rejected) | — |
| Is paid traffic tagged? | 8: `campaign-coverage`; 2: `link_ch = meta_no_link` | — |
| Which countries lag on the same page? | 2: `page-country` | — |

### 4.3 Journeys: "How do visitors move, and which paths make money?"

| Question | Shape and table | Next question |
|---|---|---|
| The money paths, and how each moved week over week | 1: `row_key = path` and `url_path` | Is the move in one source or device? |
| Where does each path lose people? | 1: `row_key = step`, `progressed / sessions`; 5: `funnel-sequence-weekly` | Which page is that step? |
| Does a second product view change the outcome? | 2 and 5: `visit_cohorts` `journey3`, `n_prod`, `coll_to_prod` | Which collection pages create it? |
| Do people skip add-to-cart and go to checkout? | 5: `funnel-sequence-weekly.m_checkout_without_atc_sessions` | Is that quick-add, or an event break? |

A real example from '47 (second half of the window, `visit_cohorts` `journey3`): product-only visits were 520,941 at $0.67 per visit, collection-only 312,995 at $0.09, and product > collection > product 36,752 at $4.93. That is the "judge merchandising by the second product view" finding in the journey report, read from one table.

### 4.4 Pages: "Which pages take traffic, and which convert it?"

| Question | Shape and table | Next question |
|---|---|---|
| Top pages week over week, by source or device | 1: `row_type = page` | Which elements on it? |
| Landing pages that take volume and convert near zero, next to the page beside them that converts | 2: `entry-by-channel`, `sister-pages`, `page_period` | Is it message match or the page? |
| Bounce, scroll reach, time on page, mobile against desktop RPS | 2: `page-segment-weekly`; 8: `ae_page_analysis` | Where on the page do they stop? |
| Which pages do high-value buyers see more than everyone else? | 4: `high_value_page_reach.over_index` | — |
| Template performance (PDP against PLP against home) | 2: `template-weekly`; 1: template path and step rows | — |

### 4.5 Elements: "What on the page earns, and what is broken?"

| Question | Shape and table | Next question |
|---|---|---|
| Which elements earn the most per session, and has that moved? | 1: `row_type = element`; 3: `selector-weekly` | Is it reach or persuasion? |
| Is a drop visibility or persuasion? (reach down with revenue per clicker steady means visibility) | 3: `exposure-weekly`; 4: `scroll-decile`; 9: `render-snapshot` (in first viewport) | Which device? |
| Clicks with no revenue, rage, dead clicks, missed taps | 3: `selector-weekly`, `rage-clicks`, `tap-geometry-weekly` | Is it a real control or a false affordance? |
| Where does the navigation send people? | 3 and 5: `nav-next-page` | Is that leakage from a paid landing page? |
| Which product tiles earn their position? | 3: `product-grid` (row reach, CTR against baseline, priority) | — |

### 4.6 Visitors over time: "Do they come back and buy?"

| Question | Shape and table | Next question |
|---|---|---|
| Of the carts abandoned this week, how many came back, and how many bought? | 6: `ae_trigger_chain` where `trigger_key = abandoned_cart` and `final = 1` | By device and channel? |
| Do new visitors from Meta come back and buy, and on which visit? | 6: chains filtered by `channel` and `returning = new`, `sessions_until_purchase` | Do they come back in another browser? (identity limit) |
| Returning visitors' value by what they did before | 1 and 6: `return_intent` segmentation (prior buyer, open cart, prior high intent, prior browse, returning unseen, new) | — |
| Does email frequency convert? | 4 and 6: `email_multi_click` | — |

A real example from '47 (`trigger-chains`, closed windows): mobile abandoned carts were 78,593 chains, 55% returned and 11.6% bought. Desktop had 12,560 chains, 40% returned and 9.6% bought.

### 4.7 Orders and products: "What do they buy, and at what price?"

| Question | Shape and table | Next question |
|---|---|---|
| Revenue by product, and markdown share | 2: `product_daily`; 7: orders | Do discounts carry the month? |
| Do baskets bunch just under a shipping or gift line? | 4: `order-value-hist` | Is the line on the site? (live check) |
| Which product pages work as entry pages? | 2: `product_entry_period` | — |

### 4.8 Experiments: "Is the test real, and is it winning?"

| Question | Shape and table | Next question |
|---|---|---|
| Arm readout: sessions, orders, revenue, assigned against exposed | 1: `ae_experiment_row` by `basis` | Does it pass the sample-ratio check? |
| Which element moved with the treatment? | 1: `basis = clicked` rows | — |
| When did it really start and end? | 9: `ae_experiment_descriptor` (declared against observed) | — |

### 4.9 Verdicts: "What does the platform think I should do?"

| Question | Shape and table | Next question |
|---|---|---|
| Which strategies triggered on this page, on what evidence? | 8: `strategy-triggers`, `ae_strategy_card` | Show me the rows under it. |
| What can't the platform judge, and why? | 8: `requirement-status` (missing and partial), cards with `blocked` and `missing_requirements` | What would unblock it? |

A real example from '47 (`/collections/fall-collection`): of 41 landing-page strategies, 17 triggered, 16 were silent, 6 were blocked and 2 were below the floor. Of 101 requirements, 31 were available and 55 were missing. All 81 page-catalog cards were `conditional`.

## 5. The strategies tied to each shape

There are two layers of strategy. The 18 trigger rules read datasets directly. The card catalogs group about 330 strategies by surface and mechanism, and each catalog leans on particular shapes.

### 5.1 The trigger rules and the data each reads

| Rule | What it tests | Reads |
|---|---|---|
| 1 | Weekly single-pageview share steps up 5 points or more | 2: `page-segment-weekly` |
| 2 | Shallow scroll with bounce (reach to 25% under 30%) | 4: `scroll-decile`; 2: `page-segment-weekly` |
| 3 | Deep scroll but RPS below the other entry URLs | 4: `scroll-decile`; 2: `entry-by-channel` |
| 4 | Hero CTA above the fold for each session's viewport | 3: the `hero_cta` selector's position; per-session viewport height |
| 5 | Same-class elements with a 2× click gap and a different order gap | 3: `selector-weekly` and element classes |
| 6 | Hero CTA order rate below the page | 3: `selector-weekly` |
| 7 | Selectors with 20+ clicks and $0 revenue | 3: `selector-weekly` |
| 8 | Rage sessions (3+ clicks on one selector within 2 s) | 3: `rage-clicks` |
| 9 | Mobile RPS under 40% of desktop | 2: `page-segment-weekly` |
| 10 | Navigation clicks over 10% of entry sessions | 3 and 5: `nav-next-page` |
| 11 | Drawer close clicks several times checkout clicks | 3: `selector-weekly` |
| 12 | A campaign or country lags the others on RPS | 2: `campaign-weekly`, `page-country` |
| 13 | Another entry URL in the same referrer earns more | 2: `entry-by-channel`, `sister-pages` |
| 14 | Order values bunch just below a round threshold | 4: `order-value-hist` |
| 15–18 | Product tile and above-fold promotion | 3: `product-grid`; 9: `render-snapshot` |

### 5.2 The card catalogs and the shapes they lean on

| Catalog | Surface | Mechanism families | Leans on |
|---|---|---|---|
| LP (41) | The landing page | The rule-mapped strategies in 5.1 | 2, 3, 4 |
| PG (81), PI (52), PO (41) | Any page | Reorder and promote by revenue (PG:H, PI:A/B, PO:A/B) | 3: selector and exposure RPeS; `product-grid` |
| | | Attention against revenue (PG:A, PI:C, PO:C) | 9: `render-snapshot`; 3: exposure; 4: scroll. Saliency is disabled. |
| | | Friction and defects (PG:F, PI:D, PO:D) | 3: rage, tap geometry, zero-revenue clicks, `nav-next-page` |
| | | Offer and proof (PG:O, PI:E, PO:E) | 4: `order-value-hist`; 3: named proof elements |
| | | Source and journey match (PG:J, PI:F, PO:F) | 2: `entry-by-channel`, `campaign-weekly`, `sister-pages`; 1: `traffic_source` rows |
| FN (3), JR (3) | Funnel and journey subjects | Weakest step, slowest step, the week completion dropped | 1: step rows; 5: `funnel-sequence-weekly` |
| QZ (4) | Quiz subjects | Drop step, hesitation, restart loop | Quiz subject rows (planned) |
| XP (4) | Experiments | Sample ratio, order floor, exposed against assigned, the element that moved | 1: `ae_experiment_row` |
| TD (25), TG (35), TI (38) | Post-purchase, returns and upsell tools | Offer order, exchange against refund, recovery | `ae_src_*` tool events. Mostly blocked until connectors exist. |

The working consequence: the element shape (3) is behind about half the page strategies, and it depends on element naming. A site with weak naming will show most page cards as `blocked` or `conditional`, and the tool has to show that as a reason, not as an empty cell.

## 6. Traps the tool must carry with the numbers

These rules are in the measurement contract and the bundle guide. A table that drops them will mislead. Each belongs next to the number it affects, not in a footnote.

1. **Do not sum across segmentations.** Within one segmentation the values sum to `all`. Across two they double-count. The tool should show one segmentation at a time.
2. **Do not add `viewport_type = all` to the devices.**
3. **`buyer` is a description, not a rate.** Sessions in `segment_value = buyer` already bought.
4. **Element revenue is correlational and not additive.** It ranks elements. It does not say the click caused the sale.
5. **Two denominators.** `entry-by-channel` counts entry sessions. Visit tables count human visits after the dead-session rule. They never share a sentence.
6. **`page_period` keeps dead sessions. Visit tables do not.**
7. **`hist30 = bought_before` may label every buyer.** On '47 every buying visit with a device id (54,749) is `bought_before`, and the other history classes have zero buyers, because the visit's own order counts. When that happens, the 30-day flag cannot measure repeat rate, and the returning flag has to stand in.
8. **Returning changed meaning on 7 September 2026.** Comparisons across that date use `returning_era`.
9. **Channel is last touch.** Ad spend is not in the data, so RPV is on-site value only.
10. **Partial weeks.** The first and last bundle weeks can be partial. Trend rows store only whole Monday-to-Sunday weeks.
11. **Chains are only final when `final = 1`.** Open windows understate returns.
12. **The browser is not a person.** Cross-browser and cross-device returns are missed. This hits Meta in-app traffic hardest.
13. **Floors.** About 30 entry sessions for page rates, 10 clicking sessions per element, and the report rule of about 100 visits or 10 orders. Below-floor rows are marked, not hidden.
14. **The analysed page is not always the homepage.** Pipeline tables describe `analysed_page`.

## 7. The information hierarchy, as a dashboard

### 7.1 The order a CRO asks in

```text
Am I OK?  →  What changed?  →  Where?  →  Who?  →  Is it reach or persuasion?  →  What should I do?  →  Did it work?
  site        trend + mix      journey      segment     element / scroll / exposure     verdicts            same tables,
  health      strip            page                                                     + rows under them   later weeks
```

Every step down is a filter on the same shapes. Nothing in it needs a fresh warehouse query, provided the subject is in a stored list.

### 7.2 Navigation

```text
Site (one site, one window or a run of weeks)
├── Health            daily_site · weekly totals · peak days · junk traffic           Shape 2, 1, 8
├── Acquisition       channel · campaign · creative · tag trends · country            Shape 1, 2
├── Journeys          money paths · steps · page-class paths · funnel sequence        Shape 1, 5
│   └── Pages         top pages · entry pages · sister pages · templates              Shape 1, 2, 4
│       └── Elements  selectors · exposure · scroll · rage · taps · product grid      Shape 3, 4
├── Returning         trigger chains · return intent · shopper history · email        Shape 6
├── Orders            ledger · products · order-value distribution                    Shape 7, 4
├── Experiments       arm readouts · descriptors                                      Shape 1, 9
│
├── Verdicts (side panel on every node)   cards · triggers · requirements             Shape 8
└── Definitions (side panel)              segmentations · catalog · glossary          Shape 9
```

The two side panels matter. Verdicts tell the CRO what the platform already concluded about the node they are on. Definitions stop the traps in §6 from becoming wrong decisions.

### 7.3 One view type per shape

| Shape | View | Controls |
|---|---|---|
| 1 Weekly snapshot | Rows are subjects, columns are weeks, with a sparkline and the change on last week | Segmentation switcher, device switcher, measure switcher (sessions, CVR, revenue, RPS, progression), mix strip beneath |
| 2 Crossed cube | Pivot table | Group-by and filter on any dimension, period selector |
| 3 Element rows | Ranked list per page, with a mini time series per element | Device, week, element class, named or unnamed |
| 4 Distribution | Histogram or bar per bin | Device, week |
| 5 Flow | Step funnel or from → to table | Path picker |
| 6 Cohort outcome | Cohort table: chains, returned, bought, revenue, time to purchase | Trigger, device, channel, new or returning, final only |
| 7 Ledger | Paged row table with drill-through | Free filter |
| 8 Verdicts | Board grouped by state (triggered, silent, below floor, blocked) | Catalog, page; each card opens its rule record and rows |
| 9 Reference | Lookup panel | — |

### 7.4 What the current data supports, and where it runs out

- **Supported now, from the warehouse:** Shapes 1, 6, 8 and 9 for 11–14 sites. The trend history is short (4–6 weeks), and subjects are limited to the frozen lists: 3 + 3 paths, 5 pages, 5 selectors per page.
- **Supported now, from bundles:** Shapes 2, 3, 4, 5 and 7, for one window and one analysed page per site.
- **'47 has no trend rows.** Its tool view today would be bundle-only plus chains and cards.
- **Not stored anywhere:** crossed segmentations in Shape 1 (Meta × mobile), daily trend grain, and any page or element outside the frozen lists. These are `--shape` requests (§2.3) or a new frozen-list entry, and the tool should offer them as "build this" rather than show an empty table.
- **Blocked by sources:** ad spend, site speed, stock and pricing history, and every TD/TG/TI tool card. The tool should say so in the cell.

## 8. Decisions for the query-tool plan

1. **Where the tool reads.** Read-only `_current` views live, as the hypothesis builder plans; a local snapshot (bundle files plus each site's `ae_*` rows in a local store); or both. The bundle is only on disk, and the trend rows are only in the warehouse, so a tool that shows both needs either an import of the bundle or a pull of the warehouse rows.
2. **First user.** A coach in a meeting needs Shape 1 and Shape 6 fast. An analyst writing a report needs Shapes 2–5 and the ledger.
3. **First slice.** The smallest useful slice is the weekly snapshot table with the segmentation switcher and mix strip, plus the verdict panel, for one site with trend rows. DVF or Latico are the best candidates.
4. **Annotations.** `PROGRAM-VISION.md` §13.1 puts human timeline markers on every table. They need a store that is not an engine table (D-10).

Decided 15 October 2026: the tool reads a **local snapshot**, and the first slice is the **coach view**.

## 9. First slice: the coach view on a local snapshot

### 9.1 Snapshot

One command per site pulls that site's stored rows from the read-only `_current` views into a local folder. It writes nothing to the warehouse.

| Pulled | From | Size on DVF |
|---|---|---|
| Trend rows | `ae_trend_row_current` | about 8,500 rows |
| Tag-trend rows and the tag selection | `ae_session_tag_trend_current`, `ae_session_tag_selection_current` | about 24,000 rows |
| Chains, aggregated to day × trigger × device × channel × returning × final | `ae_trigger_chain_current` | a few thousand rows from about 61,000 |
| The latest batch's cards, requirement statuses, and page and site rollups | `ae_strategy_card_current`, `ae_requirement_status_current`, `ae_page_analysis_current`, `ae_site_analysis_current` | about 400 rows |
| Segmentation definitions in force | `ae_segmentation_definition_current` | a few rows |

On import, the snapshot checks the partition: every segmentation's values sum to `all` for sessions, orders and revenue in every subject, device and week. A failure stops the import. The snapshot records the batch ids, the weeks and the time it was taken, and the tool shows them.

### 9.2 Screens

1. **Site.** Weekly totals from `all/all`, with the traffic-mix strip for the selected segmentation.
2. **Journeys.** Template paths and URL paths as week columns. Selecting a path opens its steps with progression.
3. **Pages**, then **elements** on a page. The same table shape.
4. **Returning.** The chain table by trigger, filterable by device, channel and new or returning, using closed windows only by default.
5. **Verdicts** panel on every screen: the cards for the page in view, grouped by state, with the rule record.

Every table has the segmentation switcher (one segmentation at a time), the device switcher, and the measure switcher. Rates show their volume, below-floor cells are marked, and each column header links to its definition.

### 9.3 Not in the first slice

Bundle tables (Shapes 2, 3, 4, 7), experiments, annotations, building a missing table from the tool, and any write path.

### 9.4 Candidate sites

DVF (5795, four weeks, the proven trend run) and Latico Leathers (1425, five weeks, six card batches).
