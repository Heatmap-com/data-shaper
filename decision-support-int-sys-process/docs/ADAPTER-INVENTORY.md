# Adapter inventory

Fifty-eight adapters are discovered from `src/adapters`. Each one has a sibling descriptor file, `<module>.descriptor.json`, and that file is what startup logs: the purpose, and what the rows mean. This inventory restates those descriptors so the set can be read as a whole. When a sentence here and a descriptor disagree, the descriptor is the one the process uses.

A run is assembled in order. A site source names the sites. A qualifier picks a landing page. A page selector decides which other pages join it. Dataset adapters then collect the rows. Persistence stores them. Telemetry records how long the work took.

## Sites, pages, and storage

| Adapter | Purpose | What the data means |
|---|---|---|
| `static-idsites` | Lists the idsites the run was given (`--sites`). A run without them is an error. | One site per row: idsite and, when the lookup succeeds, the site name. |
| `active-ecommerce-sites` | Lists the sites table rows with the run's platform and status (shopify and active unless `--platform` and `--status` say otherwise). | One site per row: idsite and name. The source fails if the status or platform column is missing. |
| `prefer-non-home` | Chooses the landing page for a site, preferring a non-home page that has orders and enough of the homepage's entry sessions. | A qualification: the chosen page id and URL, why it was chosen or skipped, and bot-filtered sessions, orders, and revenue. |
| `primary-only` | Keeps the qualifier's page as the only page this run will analyze. | One page target: the page id, URL, page type, and the qualifier's sessions, orders, and revenue. |
| `default-six` | Selects the qualifier's page, up to two sister pages in the same channel mix, and one page each of the product, collection, cart, and home kinds that are still missing. | Page targets with a role of primary, sister, or template member, each with its URL and entry sessions. |
| `clickhouse` | Stores landing-page batches, queues, and dataset rows in ClickHouse. | The current row for each batch, queue claim, analysis, and dataset key. A later write replaces the earlier one. |
| `memory` | Stores landing-page batches in process memory so tests can run the same contract as ClickHouse. | The current row for each batch, queue claim, analysis, and dataset key. The latest write wins. |
| `clickhouse-ae` | Stores schema-2 batches, dataset rows, trend rows, descriptors, and the capture queue in ClickHouse. | The current row for each key. A later write replaces the earlier one, and a claim is kept only when its token wins the re-read. |
| `memory-ae` | Stores schema-2 batches in process memory so tests can run the same contract as ClickHouse. | The current row for each schema-2 key. The latest write wins, and claims expire the same way they do in ClickHouse. |
| `localhost` | Records how long each query, stage, site, batch, and write took, on this machine, so we can see what to optimize. | A ring of events with name, duration, and outcome, plus a summary of the slow and failed queries. Served only on 127.0.0.1. |

`static-idsites` is the site list used for a named run. `active-ecommerce-sites` is the fleet list. `primary-only` analyzes the qualifier's page. `default-six` adds sisters and the missing template kinds. `clickhouse` and `memory` are the landing-page store and its test double. `clickhouse-ae` and `memory-ae` are the schema-2 pair. `localhost` is the telemetry adapter.

## The page

These datasets describe the entry sessions of the page this run is analyzing.

| Adapter | Purpose | What the data means |
|---|---|---|
| `page-segment-weekly` | Splits this page's entry sessions by week and by the segments the cards read. | Sessions, orders, and revenue per week, device, referrer, new or returning, browser, viewport, and bot filter. |
| `page-country` | Splits this page's entry sessions by country. | Sessions, orders, and revenue per country that has at least 30 entry sessions. |
| `viewport-weekly` | Counts which viewport class dominated each page session. | Sessions per week, device, viewport class, and bot filter, and that class's share of the week. |
| `scroll-decile` | Builds the scroll-reach curve for this page. | The share of entry sessions that reached each 10-point depth, by week, device, and referrer. |
| `page-speed` | Reads lab page-speed measurements for this page's URL. | Median largest-contentful-paint and first-contentful-paint. Null when no lab row matches the URL. |
| `order-value-hist` | Shows the spread of order values for this page's entry sessions. | Order counts by $10 bucket through $200, plus the 25th, 50th, and 75th percentile. |
| `line-items` | Lists the products inside orders placed by this page's entry sessions. | One row per order line: sku, quantity, and revenue. |
| `forms-weekly` | Measures form start and form submit on the page's entry sessions. | Per week: sessions that filled a form, sessions that submitted it, and the completion share. |
| `recordings-sample` | Samples session recordings of this page. | Up to 50 recording ids, with median time on page, click count, and device. |
| `dwell-model-inputs` | Builds one row per entry session for the dwell-to-revenue model. | Per session: dwell by depth band, engaged time on the page, orders, and revenue. |
| `returning-history` | Holds a place for a visitor's history across sessions. | No rows. The requirement is marked missing because the visitor id on pageviews is a per-session token. |

## Elements

| Adapter | Purpose | What the data means |
|---|---|---|
| `selector-weekly` | Counts clicks on each selector for this page's entry sessions. | Clicks, orders, and revenue per week, selector, device, and bot filter. Revenue is the revenue of sessions that clicked, so it is not additive across selectors. |
| `exposure-weekly` | Measures how many entry sessions actually saw an element or a depth band, and what those sessions bought. | Exposed sessions, dwell, orders, and revenue per element and per zone depth band. |
| `rage-clicks` | Counts entry sessions that clicked the same selector in a burst. | Sessions per selector under two separate rules: three clicks within two seconds, and clicks the tracker marked as rage. |
| `nav-next-page` | Finds the next page after a click on this page. | Per selector: sessions that clicked, and where the next pageview went, including exit when the session ended. |
| `tap-geometry-weekly` | Compares click coordinates with the captured box of the element that was clicked. | Per week, device, and selector: taps outside the box, distance from the box center, and rapid correction pairs. |
| `element-binding` | Reads the names already stored for this page's elements. | One row per selector and element class, with the display name and the taxonomy version the name was written under. |
| `kind-fleet-weekly` | Rolls selector clicks up to element kind across the site's pages. | Clicks and revenue per element class and week, using the names stored for those selectors. |
| `saliency` | Reads predicted visual saliency for the page's render nodes. | Per selector or section: the saliency share and quartile, only for nodes a model has scored. |
| `buttons-and-links` | Treats every button and every link on the page as important. | One element per button or link: its selector, whether it is a button or a link, and the visible text. |

`buttons-and-links` is the importance adapter. It decides which elements are worth naming and trending. The other rows in this section measure elements that were already clicked, seen, or named. A batch does not call the importance adapter yet.

## Journey and comparisons

| Adapter | Purpose | What the data means |
|---|---|---|
| `journey-weekly` | Summarizes the paths of sessions that viewed this page. | Per week, device, and bot filter: the share of sessions with each journey flag, and the top path clusters. |
| `trigger-chains` | Classifies sessions and visitors with configurable triggers and follows each hit across later sessions. | One row per chain still open on the window's last day: whether the visitor returned, purchased, and recovered, and the revenue of the later sessions. The same run writes the hits and chains. |
| `funnel-sequence-weekly` | Measures how entry sessions move from one commerce step to the next. | Per week and step pair: sessions that reached the later step after the earlier one. |
| `entry-by-channel` | Compares entry sessions across the site's pages by referrer. | Sessions per entry page and referrer. Small cells are dropped unless they are the chosen page or a top page for that referrer. |
| `sister-pages` | Compares entry sessions across the pages selected for this site. | Sessions, orders, and revenue per selected page and referrer. |
| `template-weekly` | Rolls this batch's page totals up by template family. | Sessions, orders, and revenue per template family and week. |
| `site-baselines` | Computes the site's own entry-session baseline for the batch window. | Per week and referrer group: entry sessions, the share that left from the first page, the share that pogoed, and revenue per session. |
| `coverage` | Counts each source table over the batch window so a missing source keeps its strategies blocked. | One row per source: row count and first and last date. A zero count is a result, not a failed query. |

`trigger-chains` runs once per site, after the page datasets. It resolves the shipped definitions (Abandoned Cart, Showed Interest, and Super-Shopper), writes one hit per qualifying session or visitor, and writes the chain that is still open for each hit. Week-over-week rates by device, channel, and the other stored dimensions are read through `queryTriggerTrends`. The rules, the lookback, and the tables are in [TRIGGER-CHAINS.md](TRIGGER-CHAINS.md).

## Traffic, campaigns, and experiments

| Adapter | Purpose | What the data means |
|---|---|---|
| `campaign-coverage` | Measures how much of a page's entry traffic carries a campaign tag. | Per source, the share of entry sessions that have a utm or session tag. Campaign weekly stays empty when the tagged share is under 5 percent. |
| `campaign-weekly` | Breaks a page's tagged entry sessions down by week and campaign. | Sessions, orders, and revenue per week and utm source, medium, campaign, content, and term. |
| `ad-creative` | Reads the site's stored ad creatives. | One row per ad: platform, source, temperature, and the ad id. An empty table means no creatives have been loaded. |
| `experiments-weekly` | Reads experiment arms and joins them to sitewide orders. | Per week, experience, and variant: sessions assigned to the arm, orders, and revenue. |
| `experiment-analysis` | Detects the site's partner experiments over the last 60 days, normalizes them, and reads out the ones running or ended in the last 14 days. | One `lifecycle` row per experiment (kind, status, active dates, scope, and arms), and one readout row per analyzed arm and basis: sessions, share, SRM p-value, conversion rate, revenue per session, and lift with p-values against control. Section rows (basis `section_captured`, then `section` per rollup section) give each arm's section-capture rate with a balance test, and per section the seen and click rates and the seen visitors' conversion. Element rows (basis `element`) give each selector's click rate, clicks per clicker, and clicker conversion, with the rollup section the selector sits in. The same run writes `ae_experiment_descriptor` and the daily `ae_experiment_row` cells. |
| `custom-event-inventory` | Lists the custom events emitted on the page. | Per event name and week: how many times it fired, when it was first and last seen, and whether the name is in the event registry. |
| `tool-registry` | Reads the tools recorded for the site. | One row per tool: its modules, the surfaces it owns, how it joins to events, and whether its event names are documented. |

`experiment-analysis` runs once per site. A partner writes its tag on each pageview where it assigned the visit, and `udp_partner_tags` stores the visit id in its `idloghsr` column (its `idvisit` column holds the pageview id). Shoplift tags only the tested template with the visit's arm and tags every other page as control. So the dataset first learns each experiment's surface, meaning the templates every arm fires on, and assigns a visit from its tags on that surface only. Arms are canonicalized: `#`/`?` suffixes and case are dropped, and arms under 1 percent of visits are marked stray. A theme test's control is the arm it shares with the partner's other tests, which is the live theme. When no allocation is declared, the SRM test assumes an even split and says so in `srm_basis`. Operator descriptors from `--governance-import` (`experiment_descriptor`) supply the hypothesis, the pages, rollup zones, and elements under test, the allocations, and the dates.

Section and element rows key on the stable name: `section_name` from `section_level_data`, and the click selector with Shopify's per-publish `template--{id}__` / `sections--{id}__` ids removed, because the two arms of a theme test carry different ids. The section tracker covers only about 4 percent of assigned visits, so section rates use the captured visits as their base, and `section_captured` tests whether capture is balanced across arms. Seeing a section happens after assignment, so the seen visitors' conversion is marked `seen_outcomes_comparable: 0` when capture or seen rate differs by arm at p < 0.05. Each experiment keeps its operator zones and elements plus at most 40 more of each with at least 100 visits.

## What the page is

| Adapter | Purpose | What the data means |
|---|---|---|
| `render-snapshot` | Reads the latest captured render of this page. | One row per device render (viewport, fold, hashes) and one row per section or element node. |
| `descriptor-snapshot` | Reads the page and store descriptors the gate pipeline uses, including which ones have expired. | One row per descriptor field: the stored value, its provenance and confidence, and whether it is current. |
| `bot-draft` | Drafts page-descriptor fields the schema allows a bot to fill, from the captured render and the datasets already collected. | Descriptor rows at low confidence, owned by the bot, expiring in 90 days. A missing source is skipped rather than guessed. |
| `requirement-status` | Marks each data requirement available, partial, or missing from the datasets this run already collected. | One row per requirement code and the status the cards use to decide whether they may speak. |
| `structural-screen` | Evaluates each catalog's screen rules against the descriptor snapshot and requirement status. | One row per rule: present, addable, blocked, unknown, or not evaluable, with the detail the cards read. |

`bot-draft` writes low-confidence descriptor fields. `descriptor-snapshot` reads them back, with the operator-confirmed fields, for the gates.

## Strategy cards

`strategy-triggers` applies the landing-page trigger rules to the datasets already collected. Each row is one strategy and segment: the trigger state and the metric values the rule read. `card-history` reads the cards earlier batches wrote: the latest verdict and trigger state for each catalog, strategy, and segment, and how many batches have seen that cell.

The card adapters run after the gates and requirements pass. Each catalog has its own adapter.

| Adapter | Catalog | What a card means |
|---|---|---|
| `cards-lp` | Landing page | One card per LP strategy: include, conditional, blocked, or silent, with the trigger state that produced it. |
| `cards-pg` | Product-page gallery | One card per PG strategy, including the S12 alias of A4, with its gate result and trigger state. |
| `cards-pi` | Product-page insight | One card per PI strategy with its gate result. The trigger evaluation arrives with the trigger module. |
| `cards-po` | Page optimization | One card per PO strategy with its gate result. The trigger evaluation arrives with the trigger module. |
| `cards-td` | Technical debt | One card per TD strategy. A failed gate is blocked, and a low-confidence descriptor caps the card's confidence. |
| `cards-tg` | Traffic generation | One card per TG strategy. A failed gate is blocked, and an unresolvable descriptor is unknown rather than a silent card. |
| `cards-ti` | Technical implementation | One card per TI strategy. A failed gate is blocked, and a structural contradiction excludes the card. |
