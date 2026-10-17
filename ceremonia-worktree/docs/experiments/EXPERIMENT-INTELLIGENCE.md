# Experiment Intelligence: vision, requirements, and market brief

**Status:** vision and high-level requirements, draft 1
**Date:** 11 October 2026
**Working name:** Experiment Intelligence (not a final product name)
**Companion:** [`experiment-dashboard.html`](./experiment-dashboard.html), a standalone interactive mock of the dashboard and the planning flow. Open it in any browser; it has no dependencies.
**Audience:** the development team (extension, tracker, analysis engine, dashboard), product leadership, and external LLMs used for market and competitive research. Every section is written to be readable without access to the code.

---

## 0. How to use this document

| Reader | Read | Skip |
|---|---|---|
| Development team | Sections 3–13 (solution, requirements, data contract, build plan) | Section 15 is optional |
| Product and leadership | Sections 1–4, 12–15 | Section 9 field lists |
| External LLM doing market research | Sections 1–4, 6, 9.1, 14, 15 (the brief and research prompts are self-contained) | Implementation file names |

Labels used throughout:

- **Built** — running in the analysis engine today and verified on live data.
- **Partial** — the data exists but is not yet split by experiment arm, or the UI path exists without the experiment fields.
- **Proposed** — specified here, not built.

Requirement IDs (`R-PLAN-3`, `R-SEG-5`, …) are stable so tickets and research notes can cite them.

---

## 1. Executive summary

Experiment Intelligence turns the A/B tests a merchant is **already running** in their testing tool (Shoplift, Intelligems, ABConvert and similar) into a revenue-attributed readout at six levels: **site, user journey, funnel, page, section (rollup zone), and element**. Every arm is compared with its control on each level. The readout is also published as **flat, normalized, machine-readable rows**, so an AI analyst can read it as easily as a person can.

Three things make it different from what a testing tool or an analytics tool provides on its own:

1. **The experiment is defined where the user is already looking at it.** In the Heatmap Chrome extension, the user opens the A/B comparison view: control and variant side by side, each rendering its own version of the page. They state the hypothesis, pick the rollup zone (for example the hero section) and the elements under test (the hero image, the CTA), and **declare the segments they want read** before the results arrive. The extension already knows which arm each pane shows, so every element they flag is stamped with its arm automatically.
2. **Revenue is attributed below the page.** Most testing tools stop at "variant B converted 6% better". This product shows *where* in the page and the journey that difference came from. In the hero example it shows that the gain came from home visitors continuing to a collection, driven by the new CTA. Later funnel steps were flat. No guardrail section regressed.
3. **The output is built for machines first.** Identities are normalized: canonical arm ids, theme-independent selectors, stable section names, element roles. Each row carries one segmentation vector, with additive counts and a declared causal status. That lets an LLM, a BI tool, or the site-analysis engine answer "which experiments helped mobile Meta traffic, and where on the page?" without custom joins.

The goal for the merchant and the CRO: **explain every test, not just score it**, and turn each test into the next hypothesis.

---

## 2. The problem

### 2.1 What CROs have today

A CRO running a test on a Shopify store usually has three disconnected views:

- **The testing tool's report.** Arms, visitors, conversion rate, revenue per visitor, a significance number. It is usually only site level, sometimes split by device. It says *whether* the variant won, rarely *why*.
- **Behavior analytics** (heatmaps, recordings, zone analytics). These show *what people did* on the page, but are rarely split by experiment arm with the arm's revenue attached. Even when they can filter by a variant, comparing control and variant region by region is manual.
- **Product or web analytics** (funnels, paths). These can be segmented by an experiment dimension when it is wired up, but the funnel is not tied to the test's page, zone and elements. The comparison and the statistics are left to the analyst.

Joining these takes an analyst hours per test, and the result is a slide, not data. The next test is chosen from intuition rather than from evidence of where the last test moved behavior.

### 2.2 What the data showed when we built the first version

The first engine version ran on a live Shopify store (site 5769, scan window 12 Aug – 10 Oct 2026). Raw partner tags need serious normalization before any comparison is valid:

- 15 partner experiments were detected in 60 days: 1 running and 3 recently ended were analyzed.
- One experiment's variant id appeared in seven raw spellings, with `#slr-…` and `?fbclid=…` suffixes and case drift. Arms from other experiments also leaked into its tags at under 1% of visits.
- The testing tool tags every page *outside* the tested template as control. 44.6% of that experiment's control tags were off the tested surface. Counting them would have inflated control by roughly 2×.
- The theme test's two arms carry different Shopify section ids (`template--20045246103645__…` vs another number), so a naive selector comparison across arms finds no shared elements.
- The section tracker captured 3.74% of control visits but 3.66% of variant visits. The difference is significant (p = 0.0065), so naive "visitors who saw the section" comparisons are biased.

None of this is visible in a testing tool's report, and each issue silently corrupts a manual analysis. Normalization is the product, not plumbing.

### 2.3 Why now

- AI analysts (LLMs connected through MCP and BI connectors) are becoming the primary readers of analytics data. They need flat, self-describing rows, not dashboards.
- Heatmap already captures click, scroll, section and journey data at element granularity, with order revenue joined to the visit. The remaining step is to split it by arm and publish it.
- The Heatmap extension already has an A/B comparison mode and an element-metadata editor (Section 6). The definition flow is an extension of existing UI, not a new product surface.

---

## 3. Goals and non-goals

### 3.1 Goals (the four requirements this document answers)

| # | Goal | Summary |
|---|---|---|
| G1 | **Convenient experiment analysis with revenue attribution at every level** | Site, user journey, funnel, page, section (rollup zone), and element, each comparing every arm to control with revenue per visitor, conversion, and statistical tests. |
| G2 | **Machine-readable outcomes** | Flattened, normalized rows with canonical identities and a fixed metric dictionary. Segmented by enough vectors to meet a CRO's needs: device, traffic source, new vs returning, geography, landing context, customer type, and custom segments. |
| G3 | **Segmentation declared at planning time** | When the user defines the experiment, they declare which segments matter, with an expected direction and a minimum detectable effect. The system estimates the sample and duration needed and reports those segments as *planned*, with the correct multiple-comparison treatment. |
| G4 | **Data in the shape the site-analysis tool needs** | The analysis engine's strategy rules and the LLM site analyst read experiment rows the same way they read every other dataset. They produce actionable insights: where the lift came from, which segment drove it, which guardrail regressed, and what to test next. |

### 3.2 Non-goals

- **Not a testing tool.** It does not split traffic, serve variants, or replace Shoplift, Intelligems or similar tools. It reads their assignment tags. A future option to read assignments from other sources (data layer, cookie, API) is in scope; serving variants is not.
- **Not a statistics-only engine.** Correct statistics are required, but the value is location and explanation of the effect, not a better p-value.
- **Not causal at every level.** Some views are descriptive by nature: visitors *who saw* a section are self-selected. The product labels each metric's causal status rather than pretending everything is causal (Section 8).
- **No personal data.** Outputs are aggregates per arm and segment. No visitor-level export.

---

## 4. Users and jobs to be done

| Persona | Job to be done | What they need from this product |
|---|---|---|
| **CRO lead / optimization manager** (in-house or agency) | Decide whether to ship, iterate or kill a variant, and justify it to stakeholders | A readout that shows the revenue impact and where it came from, with segments they trust because they declared them up front |
| **CRO agency analyst** running tests for many stores | Produce a test report per client quickly; build a library of what works | A consistent, exportable readout across clients and testing tools; machine-readable history for meta-analysis |
| **Merchant / ecommerce manager** | Understand whether the test made money | Headline revenue per visitor, confidence, and a picture of the zones tested |
| **AI analyst** (LLM through MCP, Talk to My Data, a BI agent) | Answer natural-language questions about experiments; generate the next hypothesis | Flat rows with stable keys, explicit units and causal labels, and no hidden joins |
| **Heatmap's site-analysis engine** | Fire strategy rules and produce insights per site | Experiment rows in the same segment/strategy conventions as every other dataset |

Representative questions the product must answer:

1. Did the new hero make money, and how sure are we?
2. Where in the journey did the extra buyers come from?
3. Did the CTA get more clicks *because* it is a real button, and did those clicks go somewhere useful?
4. Did anything outside the tested zone get worse (header use, featured collection reach)?
5. Did the effect differ for mobile vs desktop, Meta vs search, new vs returning — the segments I said I cared about?
6. Which of my last 20 tests moved hero-section click rate, and by how much on mobile?
7. What should I test next on this page?

---

## 5. Solution overview

The solution has four parts. Each has an owner and a contract with the next.

```
 ┌──────────────────────────┐     experiment descriptor      ┌───────────────────────────┐
 │ 1. PLAN (Chrome ext.)    │ ─────────────────────────────▶ │ 3. MEASURE (analysis      │
 │ A/B compare mode:        │   hypothesis, page, arms,      │    engine, ClickHouse)    │
 │ define experiment,       │   zones, elements+roles,       │  normalize tags → arms    │
 │ zones, elements,         │   planned segments, MDE        │  per-level fact rows      │
 │ planned segments         │                                │  readouts + statistics    │
 └──────────┬───────────────┘                                │  insights                 │
            │ zone section names + selectors                 └──────────┬────────────────┘
            ▼                                                           │ flat rows (ClickHouse
 ┌──────────────────────────┐   section beacons, clicks,               │ tables, JSONL, MCP,
 │ 2. CAPTURE (tracker)     │ ─ journeys, orders ──────────────────────▶│ facet/API)
 │ section_level config,    │                                           ▼
 │ clicks, journey events   │                                ┌───────────────────────────┐
 └──────────────────────────┘                                │ 4. READ (dashboard, LLMs, │
                                                             │    site-analysis engine)  │
                                                             └───────────────────────────┘
```

1. **Plan.** The user defines the experiment in the Heatmap Chrome extension's A/B comparison mode. Output: an experiment descriptor.
2. **Capture.** The Heatmap tracker already records clicks, journey events and orders. It records section (rollup zone) visibility for the sections it knows about. The plan publishes declared zones to the tracker's section configuration so their visibility is captured too.
3. **Measure.** The analysis engine detects experiments from partner tags, normalizes them, merges the operator's descriptor over what it inferred, and writes daily fact rows and per-arm readouts at every level.
4. **Read.** The dashboard (see the HTML mock), the site-analysis engine, and external AI analysts all read the same flat rows.

---

## 6. Part 1 — Planning in the Chrome extension

### 6.1 What exists today (verified in `Heatmap-extension`)

- **A/B comparison mode.** The user goes to **Filter → A/B → Compare → A/B**. Two windows open side by side.
  - Choosing an arm builds that pane's segment definition: `partnerName==Shoplift;variantId=={variant};experienceId=={experience}`.
  - The arm's preview URL suffix (`variantUrlSuffix`) loads that arm's version of the page in the pane.
- **Peer arm suggestion.** After the first arm is chosen, the second pane is filled with the closest-named arm.
- **Element metadata editor.** Right-click → Edit on any element saves a descriptor row: `elementName`, `classificationGroup`, `rollupZone`, `includeInReport`, `tags`, `notes`, highlight settings. The row is saved per page or scope to the descriptor store. An automatic rule already flags "Section - …" elements and tile grids as rollup zones.
- **Element image capture.** Copy → "Element image" produces an image of any element.

### 6.2 Proposed flow

1. **Enter experiment mode.** When both compare panes are A/B segments with the same `experienceId`, the extension enters *experiment mode*. The experiment key is `{partner}:{experienceId}`, the same key the analysis engine uses.
2. **Label the panes.** The panes are labelled Control and Variant from the engine's observed descriptor (`is_control`). The user can confirm or swap them.
3. **Experiment details panel.**
   - Name and hypothesis.
   - Primary metric (default: revenue per visitor) and guardrail metrics.
   - Page(s) under test.
   - Start and end dates, prefilled from observed traffic.
   - Allocations, prefilled from the partner where known.
   - **Planned segments** (Section 10).
   - Expected direction and minimum detectable effect.
4. **Mark zones and elements.** Right-click → Edit on an element now has an **Experiment** section:
   - **Include in experiment** (toggle).
   - **Arm**, set automatically from the pane the element was clicked in.
   - **Role**: a shared name that pairs elements across arms, e.g. "Hero CTA" for control's image link and the variant's button.
   - **Rollup zone** (the existing checkbox). When on, the element becomes a *zone* in the experiment. When off, it becomes an *experiment element*.
5. **Capture zone images.** For each zone, the extension captures an image in **both** panes, with the capture time and the page URL, and stores the images with the experiment.
6. **Save.** The extension writes an experiment descriptor package (Section 9.4). The engine ingests it on the next site analysis.

### 6.3 Requirements — extension

| ID | Requirement | Status |
|---|---|---|
| R-EXT-1 | Detect experiment mode: two A/B compare slots with the same `experienceId` | Proposed (data present in slot segment definitions) |
| R-EXT-2 | Keep each slot's `variant_id` and `experiment_id`. Today `Dashboard.tsx` keeps only `segment`, `filterName` and `variantUrlSuffix` per slot | Proposed fix |
| R-EXT-3 | In experiment mode, limit the second pane's arm picker to arms of the same experiment. Today the peer is chosen by name overlap and same-experiment only breaks ties | Proposed fix |
| R-EXT-4 | Label panes from the engine's observed descriptor (`is_control`); user can override | Proposed |
| R-EXT-5 | Experiment details form: name, hypothesis, primary metric, guardrails, pages, dates, allocations, planned segments, MDE, direction | Proposed |
| R-EXT-6 | Element panel Experiment section: include toggle, auto arm, role (pick an existing role from the other pane or create one), zone/element by the existing `rollupZone` flag | Proposed |
| R-EXT-7 | Zone images from both panes, stored by reference (not inside the descriptor JSON, which has a 2 MB limit) | Proposed (reuses element image capture) |
| R-EXT-8 | Save an `experiment-v1` descriptor package. Show the save state and validation errors (unknown section name, selector not found in the other arm) | Proposed |
| R-EXT-9 | Show the readout for the open experiment in the extension (headline, zones, elements) once rows exist | Proposed |
| R-EXT-10 | Selectors saved for zones must work in both arms. Prefer a section name or a theme-independent selector such as `[id$="__custom_hero_v1"]` over the raw `#shopify-section-template--{id}__…` | Proposed |

---

## 7. Part 2 — Capture

| Data | Source table | Coverage | Status |
|---|---|---|---|
| Arm assignment | `udp_partner_tags` (partner, experience_id, variant_id, friendly name; visit id in the `idloghsr` column) | Every tagged pageview | Built (read and normalized) |
| Visits, device, source, returning, geography | `udp_hsrce_visits` | Every visit | Built |
| Orders and revenue | `udp_conversions` (deduplicated per visit and order) | Every order | Built |
| Funnel events | `journey_events_map` (`collection_viewed`, `product_viewed`, `add_to_cart`, `cart_viewed`, `checkout_started`, `checkout_completed`) | Every visit | Built for checkout started; other steps Partial (not split by arm) |
| Clicks with selectors | `udp_clicksce_clicks` | Every click | Built |
| Section (zone) visibility and clicks | `section_level_data` (`event_type` click or scroll; scroll means at least 50% visible for 1 s; `section_name`, `section_path`) | A sample: about 4% of assigned visits on the measured store, varying by arm | Built (read); capture rate is a known limitation |

Section definitions reach the tracker from three places:

- The site's batch configuration (`tracking[siteid].section_level`: `{section_name, selector, rules}`).
- Theme attributes (`data-hm-section-name`).
- Automatic detection, which runs alongside configured sections unless it is turned off.

A zone flagged in the extension does not reach the tracker today.

| ID | Requirement | Status |
|---|---|---|
| R-CAP-1 | Publish declared zones to the site's `section_level` configuration with a selector that matches in every arm | Proposed |
| R-CAP-2 | Report section visibility for published zones from the moment of publish. The readout states the first day zone data exists | Proposed |
| R-CAP-3 | Investigate and document the section capture rate (about 4%). Raise it, or make the sampling rule explicit and equal across arms | Proposed (open question) |
| R-CAP-4 | Optional sources of assignment beyond partner tags (data layer event, cookie, partner API) | Proposed, later |

---

## 8. Part 3 — Measurement and revenue attribution

### 8.1 Experiment detection and normalization (Built)

The engine scans the last 60 days of partner tags per site.

- **Experiment detection.** It folds raw tags into experiments with canonical arms:
  - Lowercase.
  - `#` and `?` suffixes stripped.
  - Arms under 1% of visits marked as stray.
  - Operator aliases folded in.
- **Scope.** It dates each experiment from its daily traffic and infers its scope (site, template, page) from the templates every arm fires on. For a theme test, the control is the arm shared with the partner's other tests: the live theme.
- **Assignment.** A visit is assigned only from tags on the experiment's surface. This removes the "every other page is control" pattern. A visit tagged in two arms is counted once under `multi_arm` and excluded from comparisons.
- **Bot filtering.** The portal bot predicate is applied before anything is counted.
- **Selector normalization.** Shopify's per-publish ids (`template--{digits}__`, `sections--{digits}__`) are removed, so the same element has one key in both arms and across theme publishes.

### 8.2 Bases and causal status

Every metric has a **base** (who is counted) and a **causal class**. The causal class tells a reader, human or LLM, how to interpret a difference between arms.

| Causal class | Meaning | Examples |
|---|---|---|
| `causal` | The base is fixed before treatment (all assigned visits). A difference between arms is an effect of the variant. | Revenue per visitor, conversion, funnel step reach, element click rate per assigned visit, journey shares of assigned visits |
| `conditionally_causal` | The base is a pre-treatment subset that is the same in both arms. It is causal if that subset is balanced, which the engine tests. | Exposed visits (viewed the tested page), section rates on captured visits when capture is balanced |
| `descriptive` | The base is chosen by behavior after treatment. A difference describes *who* the visitors were, not the effect. | Conversion of visitors who saw a section, conversion of clickers, continuation rate between funnel steps, conversion of a path |

| ID | Requirement | Status |
|---|---|---|
| R-ATT-1 | Every readout metric carries `causal_class` | Proposed (the rules are applied today in docs and in `seen_outcomes_comparable`) |
| R-ATT-2 | Balance checks on every conditional base: sample ratio mismatch (SRM) on assignment, section capture balance, and seen-rate balance. Flag outcomes not comparable when p < 0.05 | Built (SRM, capture, seen); Proposed for exposure balance |
| R-ATT-3 | **Revenue lift decomposition**: split the arm's revenue-per-visitor lift into contributions from each funnel step's continuation, orders per buyer, and average order value, using a log decomposition that sums exactly to the total lift | Proposed |
| R-ATT-4 | Zone and element attribution states both numbers: the *causal* change in the share of assigned visits that clicked or saw, and the *descriptive* revenue of those visitors. It never presents clicker revenue as caused by the click | Built for elements and sections; Proposed for the label |

### 8.3 Levels

Each level has questions, a base, metrics, sources, and a status.

#### Site (Built)

- **Questions:** did the variant make money; is the split healthy?
- **Bases:** `assigned` (every tagged visit in the arm), `exposed` (visited the page or template under test, when declared), `multi_arm` (excluded visits).
- **Metrics:** visits, share, SRM p-value against declared or even allocation, buyers, orders, revenue, CVR, revenue per visitor (RPV), AOV, checkout rate. Lift and p-value against control for CVR (two-proportion z-test) and RPV (Welch difference in means from sums and sums of squares).
- **Daily rows** support cumulative-lift charts and novelty-effect checks (`day_index`).

#### Page (Partial)

- **Questions:** on each tested page, how did visitors who viewed it compare?
- **State:** per-page daily cells are written (`idsitehsr` set), but the readout only sums them into the `exposed` basis.
- **Requirement R-LVL-PAGE-1:** a per-page readout row per arm with lift and p-value.

#### Funnel (Partial → Proposed)

- **Questions:** at which step did the variant gain or lose visitors?
- **Steps:** assigned → viewed tested page → viewed a collection or product → added to cart → viewed cart → started checkout → purchased. The step list is configurable per experiment.
- **Metrics:**
  - Reach: the share of assigned visits that reached the step, in order (causal).
  - Continuation: the share of the previous step's visits that went on (descriptive).
  - Both with lift and p-value.
  - The step with the largest change.
  - The revenue lift decomposition (R-ATT-3).
- **State:** the engine stores checkout started (`progressed`) and purchase per arm. `funnel-sequence-weekly` already orders the steps from `journey_events_map` per site, but not per arm.
- **Requirement R-LVL-FUN-1:** per-arm, per-segment ordered step counts in the experiment fact rows.

#### User journey (Partial → Proposed)

- **Questions:** where did visitors go after the tested page? Did the CTA send them somewhere useful? Did bounce-backs drop?
- **Metrics:**
  - Second page type after the entry page, as a share of the entry page's visitors, with that path's conversion.
  - Next page after clicking a paired element (role).
  - Journey behaviors: going back to the tested page, leaving within 10 seconds, viewing two or more products, reaching cart or checkout.
  - All by arm, with lift and p-value.
  - A flow diagram of entry page → second page → purchase.
- **State:** `journey-weekly` (flags, entry → second-page clusters) and `nav-next-page` (next page after a selector click) exist per page over all traffic.
- **Requirement R-LVL-JRN-1:** the same computations restricted to each arm's assigned visits.
- **Requirement R-LVL-JRN-2:** the next-page lookup on role-paired selectors.

#### Section / rollup zone (Built, with known limits)

- **Questions:** did visitors see the tested zone? Did they interact with it more? Did a guardrail zone regress?
- **Bases:**
  - `section_captured`: an arm's visits with any section event on the experiment's pages. This is the base for every section rate, and it is balance-tested.
  - `section_seen` and `section_clicked` per section.
- **Metrics:** capture rate and capture balance p-value; per section, seen rate and click rate with lift and p-value; the conversion and RPV of visitors who saw it (descriptive); zone role (treated or guardrail); `seen_outcomes_comparable` (0 when capture or seen rate differs by arm at p < 0.05).
- **Keys:** `section_name`, stable across arms; `section_path`, outermost first.
- **Selection:** declared zones are always kept. Otherwise the 40 busiest sections with at least 100 visits.
- **Limits:**
  - About 4% capture.
  - Repeat clicks collapse, so sections count visits, not clicks.
  - A section renamed in the variant appears as two sections.
- **Requirements:**
  - R-LVL-SEC-1: zone click rollup from the full click table by zone selector containment. This covers every visit, works back to the experiment start, and gives clicks only.
  - R-LVL-SEC-2: zone aliases for a section renamed in the variant.

#### Element (Built, pairing Proposed)

- **Questions:** did the tested element get used more? Did its users buy?
- **Base:** every assigned visit; elements read the full click table, not the section sample.
- **Metrics:** click rate per assigned visit with lift and p-value (causal); clicks per clicker; clicker conversion and RPV (descriptive); element class; the rollup section the element sits in (93% of element rows map to a section on the measured store).
- **Selection:** declared elements are always kept and limited to their arm. Otherwise the 40 busiest selectors with at least 100 clicking visits.
- **Gap:** when an element is different in each arm (control's CTA drawn on the hero image, the variant's real button), the engine compares each selector with itself and shows −100% and no lift.
- **Requirement R-LVL-EL-1:** compare by **role** (declared in the extension), falling back to element class within the zone.

### 8.4 Statistics

| ID | Requirement | Status |
|---|---|---|
| R-STAT-1 | Two-proportion z-test for rates; Welch test for revenue per visitor from sums and sums of squares | Built |
| R-STAT-2 | SRM test against declared allocation, or an even split with `srm_basis = assumed_equal` | Built |
| R-STAT-3 | Confidence intervals on every lift (absolute and relative) | Proposed |
| R-STAT-4 | Planned-vs-exploratory treatment: planned segments use Holm correction across the declared family; exploratory cuts use Benjamini–Hochberg false-discovery-rate control and are labelled exploratory | Proposed |
| R-STAT-5 | Heterogeneity test: is the lift in segment A different from segment B (interaction z-test), not just "significant in A and not in B" | Proposed |
| R-STAT-6 | Peeking protection: fixed-horizon readout at the planned end date by default; optional sequential (always-valid) p-values for running tests | Proposed |
| R-STAT-7 | Variance reduction using pre-period behavior (CUPED) when the visitor has history | Proposed, later |
| R-STAT-8 | Minimum cell sizes: rates hidden below a floor (default 100 visits per arm), with the floor stated | Built for selection floors; Proposed for display |

---

## 9. Part 3 — The machine-readable data contract (Goal G2)

### 9.1 Principles

1. **One row, one meaning.** Each row is one experiment, arm, level, entity, basis, segment value, viewport, and day (facts) or window (readouts). There are no nested results to unpack, apart from a `metrics` JSON for row-type extras.
2. **Additive counts, derived rates.** Facts store counts and sums (`sessions`, `buyers`, `orders`, `revenue`, `revenue_sq`, `clicks`, `progressed`). Rates and tests are computed from them, so any consumer can re-aggregate days or arms correctly.
3. **Canonical identities.**
   - Experiment: `{partner}:{partner experiment id}`.
   - Arm: canonical variant id.
   - Page: `idsitehsr`, plus URL and template.
   - Zone: `section_name`.
   - Element: normalized selector, plus element class and role.
   - Segment: strategy and value.
4. **One segmentation vector per row.** `segment` is the strategy (`traffic_source`, `device`, `returning`, …) and `segment_value` is one value of it. The values of one strategy partition the visits. `all`/`all` is the stored total. Summing across strategies double-counts by design; a consumer reads one strategy at a time. This is the same convention as the engine's `ae_trend_row`, so the same facet can read both.
5. **Self-describing readouts.** Each readout row says its base, its causal class, whether the segment was planned, whether it is comparable, and the window it covers.
6. **Provenance on every row.** `batch_id`, `generated_at`, descriptor version, bot filter, analysis window.

### 9.2 Fact table — `ae_experiment_row` (Built)

| Column | Meaning |
|---|---|
| `idsite`, `experiment_key`, `arm`, `is_control`, `scope` | Identity |
| `basis` | `assigned`, `exposed`, `multi_arm`, `section_captured`, `section_seen`, `section_clicked`, `clicked` (element); proposed: `funnel_step`, `journey_next`, `journey_flag` |
| `idsitehsr` | The page, for page rows; 0 otherwise |
| `section` | Rollup section name for section and element rows |
| `selector`, `element_class` | Normalized selector and class for element rows |
| `viewport_type` | `all`, `desktop`, `tablet`, `mobile` |
| `segment`, `segment_value` | Strategy and value (today `all`, `traffic_source`, `returning` on experiment rows) |
| `day`, `day_index` | First assignment day; days since the experiment start |
| `sessions`, `buyers`, `orders`, `revenue`, `clicks`, `progressed` | Additive measures |
| `metrics` | JSON extras: `row_kind`, `revenue_sq`, `section_path` |

Sort key: `(idsite, experiment_key, arm, basis, idsitehsr, section, selector, viewport_type, segment, segment_value, day)`. Replacing merge on `generated_at`, so a rerun replaces a day.

### 9.3 Readout table — `ae_experiment_readout` (Proposed; today readouts are dataset rows)

This is the long, flat format for LLMs and BI tools: one metric per row.

| Column | Example | Meaning |
|---|---|---|
| `idsite` | 5769 | |
| `experiment_key` | `shoplift:01a1b2c3-…` | |
| `experiment_name` | Hero: photo with a real CTA button | |
| `status` | running / ended | |
| `window_start`, `window_end`, `days` | 2026-09-28, 2026-10-11, 14 | Analysis window |
| `level` | site / page / funnel / journey / section / element | |
| `entity_key` | `custom-hero-v1` / `role:hero_cta` / `step:add_to_cart` / `47889565` | Canonical identity at that level |
| `entity_label` | Hero section | Human label |
| `entity_role` | treated / guardrail / '' | From the plan |
| `arm`, `arm_label`, `is_control` | `sl-7c21e9b0`, Photo + button, 0 | |
| `segment`, `segment_value` | `device`, `mobile` | One strategy |
| `segment_planned` | 1 | Declared at planning time |
| `viewport_type` | all | |
| `basis` | assigned / exposed / section_captured / clicked / funnel_step | Who is counted |
| `metric` | `rpv`, `cvr`, `click_rate`, `seen_rate`, `reach`, `continuation`, … | From the metric dictionary |
| `unit` | ratio / currency / count / per_visit | |
| `value`, `control_value` | 0.1370, 0.1010 | |
| `n`, `n_control` | 48020, 48210 | Base sizes |
| `lift_abs`, `lift_rel` | 0.036, 0.356 | |
| `ci_low_rel`, `ci_high_rel` | 0.31, 0.40 | Proposed R-STAT-3 |
| `p_value`, `p_adjusted`, `correction` | 1e-9, 4e-9, holm | |
| `causal_class` | causal / conditionally_causal / descriptive | Section 8.2 |
| `comparable` | 1 | Balance checks passed |
| `quality_flags` | `["capture_imbalance"]` | SRM, capture, low volume, partial window |
| `batch_id`, `generated_at`, `descriptor_version` | | Provenance |

Example rows (JSON Lines):

```json
{"experiment_key":"shoplift:01a1b2c3-hero-photo-cta","level":"site","entity_key":"site","arm":"sl-7c21e9b0","segment":"all","segment_value":"all","basis":"assigned","metric":"rpv","unit":"currency","value":2.470,"control_value":2.309,"n":48020,"n_control":48210,"lift_rel":0.070,"p_value":0.118,"causal_class":"causal","comparable":1}
{"experiment_key":"shoplift:01a1b2c3-hero-photo-cta","level":"element","entity_key":"role:hero_cta","entity_role":"treated","arm":"sl-7c21e9b0","segment":"all","segment_value":"all","basis":"assigned","metric":"click_rate","unit":"ratio","value":0.1370,"control_value":0.1010,"n":48020,"n_control":48210,"lift_rel":0.356,"p_value":1e-9,"causal_class":"causal","comparable":1}
{"experiment_key":"shoplift:01a1b2c3-hero-photo-cta","level":"funnel","entity_key":"step:viewed_collection_or_product","arm":"sl-7c21e9b0","segment":"device","segment_value":"mobile","segment_planned":1,"basis":"funnel_step","metric":"continuation","unit":"ratio","value":0.534,"control_value":0.487,"lift_rel":0.097,"p_value":2e-6,"p_adjusted":6e-6,"correction":"holm","causal_class":"descriptive","comparable":1}
{"experiment_key":"shoplift:01a1b2c3-hero-photo-cta","level":"section","entity_key":"featured-collection","arm":"sl-7c21e9b0","segment":"all","segment_value":"all","basis":"section_captured","metric":"seen_rate","unit":"ratio","value":0.560,"control_value":0.596,"lift_rel":-0.060,"p_value":0.023,"causal_class":"conditionally_causal","comparable":1,"quality_flags":["sample_section_tracker"]}
```

### 9.4 Descriptor — `ae_experiment_descriptor` and the `experiment-v1` package

Operator fields already supported by the import (Built):

- `experiment_key`, `name`, `hypothesis`, `description`, `experiment_kind`, `scope`, `templates`, `pages`.
- `elements: [{selector, idsitehsr?, arm?, element_class?, section?}]`.
- `zones: [{section, role: treated|guardrail}]`.
- `arms: [{arm, label?, is_control?, allocation?, aliases?}]`.
- `device_scope`, `start`, `end`.

Proposed additions for the extension package:

```json
{
  "package": "experiment-v1",
  "idsite": 5769,
  "experiment_key": "shoplift:01a1b2c3-hero-photo-cta",
  "name": "Hero: photo with a real CTA button",
  "hypothesis": "A real, tappable CTA under a clean hero photo gets more visitors into a collection than a CTA drawn on the image.",
  "primary_metric": "rpv",
  "guardrails": [{"metric": "cvr"}, {"level": "section", "entity": "header", "metric": "click_rate"}],
  "pages": [47889565],
  "arms": [
    {"arm": "control", "is_control": true, "allocation": 0.5, "label": "Drawn-on CTA"},
    {"arm": "sl-7c21e9b0", "allocation": 0.5, "label": "Photo + button"}
  ],
  "zones": [
    {"section": "custom-hero-v1", "role": "treated", "selector": "[id$='__custom_hero_v1']",
     "images": {"control": "s3://…/control.png", "sl-7c21e9b0": "s3://…/variant.png", "captured_at": "2026-09-28T15:02:00Z"}},
    {"section": "header", "role": "guardrail"}
  ],
  "elements": [
    {"selector": "#shopify-section-template--20045246103645__custom_hero_v1 a.hero__link > img", "arm": "control", "role": "hero_cta", "element_class": "hero_cta", "section": "custom-hero-v1"},
    {"selector": "#shopify-section-template--20045246103645__custom_hero_v1 a.hero__cta", "arm": "sl-7c21e9b0", "role": "hero_cta", "element_class": "hero_cta", "section": "custom-hero-v1"},
    {"selector": "#shopify-section-template--20045246103645__custom_hero_v1 div.hero__media > img", "arm": "sl-7c21e9b0", "role": "hero_image", "element_class": "content_section", "section": "custom-hero-v1"}
  ],
  "funnel": ["viewed_page", "viewed_collection_or_product", "add_to_cart", "checkout_started", "purchased"],
  "segments": {
    "planned": [
      {"strategy": "device", "values": ["mobile", "desktop"], "expected": "larger_on_mobile", "mde_rel": 0.10},
      {"strategy": "traffic_source", "values": ["meta", "search"], "mde_rel": 0.15},
      {"strategy": "returning", "values": ["new", "returning"]}
    ],
    "custom": [
      {"key": "landing_home", "label": "Landed on home", "rule": {"field": "entry_template", "op": "eq", "value": "home"}}
    ]
  },
  "start": "2026-09-28",
  "planned_end": "2026-10-19",
  "created_by": "extension", "created_at": "2026-09-28T15:04:00Z", "version": 3
}
```

| ID | Requirement | Status |
|---|---|---|
| R-DATA-1 | Fact rows at every level with additive counts and canonical identities | Built for site, page, section, element; Proposed for funnel and journey |
| R-DATA-2 | Flat readout table, one metric per row, with the columns in 9.3 | Proposed |
| R-DATA-3 | JSONL export per experiment, and an MCP tool returning readout rows filtered by experiment, level, segment and metric | Proposed (the Heatmap MCP already exposes `get_ab_test_experiments` and `get_ab_test`) |
| R-DATA-4 | Metric dictionary published with the data: name, unit, base, causal class, formula | Proposed (Appendix B is the draft) |
| R-DATA-5 | Descriptor versioning: each readout cites the descriptor version it used | Proposed |
| R-DATA-6 | Cross-experiment history: rows stay queryable after an experiment ends, for meta-analysis ("what worked on hero sections") | Built (rows are kept); Proposed for the cross-experiment view |

---

## 10. Segmentation — vectors and planning (Goals G2 and G3)

### 10.1 The rule: segment only on what was true before assignment

A segment must be decided by information available **before** the visitor saw the variant:

- Device and viewport.
- Traffic source, campaign, landing page.
- Geography.
- New or returning, and prior customer status.
- Time of first visit.

Anything that happens after assignment (added to cart, saw the section, clicked the CTA) is an **outcome**, reported in the funnel, journey, section and element levels. It is never a segment. The engine enforces this. It is the most common analysis error in CRO reporting, and it makes segment results unreliable.

### 10.2 Segment catalog

| Strategy | Values | Status |
|---|---|---|
| `all` | `all` | Built |
| `viewport_type` (device) | desktop, tablet, mobile | Built (as a column on every row) |
| `traffic_source` | meta, search, direct, website (referral), campaign, social, other | Built |
| `returning` | new, returning | Built |
| `channel_detail` | google_ads, google_organic, meta_paid, tiktok, email, sms, affiliate, … from UTM and referrer | Proposed (UTM fields exist on the visit) |
| `campaign` | top N UTM campaigns, the rest as `other` | Proposed |
| `country` / `region` | top N countries, the rest as `other` | Proposed (geography is on the visit) |
| `entry_template` | home, pdp, plp, cart, search, content, other | Proposed (entry page is known) |
| `customer_type` | first-time visitor, prior non-buyer, prior buyer, repeat buyer | Proposed (orders history per visitor) |
| `weekday` / `daypart` | weekday or weekend; morning, afternoon, evening, night | Proposed |
| `browser` / `os` | top N | Proposed |
| `trigger` | `abandoned_cart` previously, `super_shopper` previously (from the trigger-chain engine, pre-assignment only) | Proposed |
| `custom:{key}` | user-defined rule on pre-assignment fields | Proposed |

Each strategy keeps a partition: every visit is in exactly one value. Values below the volume floor fold into `other`, and the fold is recorded.

### 10.3 Planning segments with the experiment (Goal G3)

**Why it matters:** if a CRO looks at 30 segments after the test, about 1 or 2 will look significant by chance. Declaring the important segments up front, with an expected direction, separates confirmatory findings from exploration. It also lets the system tell the user, *before* launch, whether the test can detect the effect in those segments at all.

**Flow in the extension's Experiment details panel:**

1. **Primary metric and minimum detectable effect.** The defaults come from the site's baselines over the last 28 days (CVR, RPV and their variance per segment).
2. **Planned segments.** The user picks strategies from the catalog, the values that matter, an optional expected direction ("larger on mobile"), and an optional per-segment MDE.
3. **Custom segments.** The user builds a rule on pre-assignment fields, for example `utm_campaign contains "fall"`, `entry_template = pdp`, or `country in (US, CA)`.
4. **Feasibility.** For each planned segment the panel shows its expected daily visits per arm and the required visits per arm:

   \[ n = \frac{(z_{1-\alpha/2} + z_{1-\beta})^2 \cdot 2\,p(1-p)}{(p \cdot \text{MDE})^2} \]

   for conversion, or the Welch equivalent for RPV using the baseline variance. It also shows the days needed and a status: feasible, needs N more days, or not detectable at this traffic.
5. **Correction family.** The planned segments form a family for Holm correction. Everything else is exploratory, reported with false-discovery-rate correction and labelled as exploratory.
6. **Lock.** The plan is versioned. Edits after launch are allowed but recorded. The readout shows which segments were planned at launch.

| ID | Requirement | Status |
|---|---|---|
| R-SEG-1 | Segments only from pre-assignment attributes; outcomes never become segments | Proposed as an explicit rule (true of today's segments) |
| R-SEG-2 | Catalog of strategies in 10.2, each a partition with a volume floor and an `other` fold | Partial (4 built) |
| R-SEG-3 | Planned segments declared in the descriptor; the engine computes planned segments at every level, not only site | Proposed |
| R-SEG-4 | Custom segment rules on pre-assignment fields, stored with the plan, computed as `custom:{key}` | Proposed |
| R-SEG-5 | Feasibility estimate per planned segment before launch, from site baselines | Proposed (`site-baselines` provides entry baselines; extend to CVR/RPV variance by segment) |
| R-SEG-6 | Planned vs exploratory labels and corrections in every readout (R-STAT-4) | Proposed |
| R-SEG-7 | Heterogeneity readout: which planned segment's lift differs from the rest (R-STAT-5) | Proposed |
| R-SEG-8 | Segment cost control: default strategies at all levels; extra strategies at site, funnel and zone levels only unless planned | Proposed |

---

## 11. Part 4 — Reading: the dashboard (Goal G1)

The companion HTML mock (`experiment-dashboard.html`) shows every screen with illustrative numbers. Its tables and charts are shaped like the rows in Section 9.

### 11.1 Screens

1. **Experiment list.** Name, status, scope, start, assigned visits, headline lift, descriptor state (operator or observed only), and plan completeness.
2. **Experiment header.** Hypothesis, arms with allocation, zone images for control and variant, planned end date and feasibility.
3. **Site.**
   - Headline lift on RPV and CVR with p-values.
   - SRM.
   - Arms by basis (assigned, exposed).
   - Cumulative lift and daily CVR by arm.
4. **Segments.**
   - Planned segments first, with corrected p-values and the heterogeneity flag.
   - Exploratory segments behind a toggle.
   - A lift-by-segment chart.
5. **Page.** Per tested page, by arm.
6. **Funnel.**
   - Continuation rate per step.
   - Visits remaining per 1,000 assigned.
   - A step table with reach and continuation lifts.
   - The largest step change.
   - The revenue lift decomposition.
7. **Journeys.**
   - Entry page → second page → purchase flow per arm.
   - Where CTA clickers went next.
   - Second-page table.
   - Journey behaviors.
8. **Sections (zones).**
   - Capture balance.
   - Seen and click rates by section.
   - Section table with roles and comparability.
9. **Elements.**
   - The role-paired comparison: the hero CTA across both arms.
   - Click rate by element.
   - Element table.
10. **Insights.** Generated findings with evidence and the next test to run (Section 12).
11. **Plan / Definition.** The four conditions and what each adds; planned segments with feasibility; the descriptor JSON.
12. **Data.** The readout rows behind the screen, as a table and as JSONL, to show the machine-readable contract.

### 11.2 Requirements — dashboard

| ID | Requirement |
|---|---|
| R-UI-1 | Every number shows its base and, on hover, its causal class |
| R-UI-2 | Significant lifts are colored (green for better, red for worse) only when p (or adjusted p) < 0.05; otherwise neutral |
| R-UI-3 | Descriptive metrics are visually secondary; non-comparable metrics are greyed out with the reason |
| R-UI-4 | Elements that exist in one arm only are marked, and their selector-level lift is suppressed in favour of the role pair |
| R-UI-5 | Each screen states which plan fields it depends on; a missing field shows what it would add, not an empty panel |
| R-UI-6 | Export: CSV and JSONL of the readout for the current screen; image export of zone pairs |
| R-UI-7 | The same screens are reachable from the Chrome extension (R-EXT-9) and from the web app |

---

## 12. Site-analysis integration and insights (Goal G4)

The Heatmap analysis engine runs per site. Datasets write rows. Strategy rules read them and fire when a condition holds. An LLM site analyst reads the current rows and writes the report. Experiments join this flow as one more dataset family, with rules that understand experiments.

### 12.1 What the site-analysis tool needs

- **Readouts in the flat format** (9.3), filtered by `status` running or recently ended.
- **Daily facts** for trend and novelty checks.
- **Plan context:** hypothesis, roles, planned segments, guardrails.
- **Cross-experiment history** per zone class and element class, for priors ("hero CTA tests on this store have moved click rate +20–40%").
- **Links to page context:** element names and classes from the naming system, page templates, zone images.

### 12.2 Insight rules (proposed)

Each rule produces an `ae_experiment_insight` row. The row holds `rule_id`, `severity`, `experiment_key`, `level`, `entity_key`, `segment`, `evidence` (the readout row keys and values it read), a plain-language `finding`, a `recommendation`, and an ICE score (impact, confidence, ease).

| Rule | Fires when | Example finding |
|---|---|---|
| `health.srm` | SRM p < 0.01 | "Assignment is off the declared 50/50 split; results are unreliable until the cause is found." |
| `health.capture_imbalance` | Section capture balance p < 0.05 | "Section data sampled the arms unequally; seen-visitor outcomes are not comparable." |
| `health.underpowered` | Planned segment below required visits at the planned end | "Device = mobile needs 10 more days to detect a 10% lift." |
| `effect.headline` | Primary metric lift with adjusted p < 0.05, or not | "Photo + button lifts RPV +7.0% (p 0.12, not yet significant)." |
| `locate.funnel_step` | One step carries most of the decomposed lift | "The gain is home → collection/product continuation (+8.4%); later steps are flat." |
| `locate.zone` | Treated zone click or seen rate moves significantly | "Hero section click rate +38% among captured visits." |
| `locate.element_role` | A role pair's click rate moves significantly | "Hero CTA clicks +36%: 10.1% → 13.7% of visits." |
| `guardrail.regression` | A guardrail zone or metric worsens significantly | "Featured collection seen rate −6% (p 0.02): the taller hero may push it below the fold." |
| `segment.heterogeneity` | Interaction test significant on a planned segment, or a large gap that is not significant | "Lift is concentrated on mobile (+19% vs +2%, interaction p 0.01)." Or: "Mobile looks stronger, but the difference from desktop is not significant (p 0.47); treat it as a hypothesis." |
| `journey.redirect` | Next-page mix after the paired element shifts significantly | "CTA clickers now land on collections 70% vs 62%; exits fell." |
| `element.dead_click` | An element that is no longer a link keeps clicks, with high clicks per clicker | "The new hero image draws 2.1% of visits in clicks with 1.47 clicks per clicker: it looks clickable." |
| `novelty.decay` | Lift trends down over `day_index` | "Lift fell from +12% in week 1 to +4% in week 2." |
| `next_test` | Combines the above | "Next: make the hero image link to the same collection, or remove its affordance; test a shorter hero to recover featured-collection reach." |

### 12.3 Requirements — integration

| ID | Requirement | Status |
|---|---|---|
| R-INS-1 | Experiment readouts available to the site-analysis run as a dataset family (`experiment-analysis` today) | Built (dataset rows) |
| R-INS-2 | Insight rules above as configurable rules (thresholds in config, like trigger definitions) | Proposed |
| R-INS-3 | Insights cite evidence row keys so an LLM or human can verify every claim | Proposed |
| R-INS-4 | The LLM site analyst receives readouts, insights and plan context in one bundle per experiment | Proposed |
| R-INS-5 | Experiment rows follow the `ae_trend_row` segment conventions so Facet and Talk to My Data read them without new structure | Partial (conventions match; facet not wired) |

---

## 13. Current state and build plan

### 13.1 What is built (verified on live data, 11 October 2026)

- **Experiment detection and normalization** from partner tags: canonical arms, stray arms, aliases, surface-restricted assignment, multi-arm exclusion, bot filter, inferred scope and dates.
- **Daily fact rows** at experiment, page, section and element level in `ae_experiment_row`.
- **Readouts:**
  - Assigned and exposed bases.
  - SRM.
  - CVR and RPV lifts with p-values.
  - Section capture balance.
  - Per-section seen and click rates with comparability.
  - Per-element click rates and clicker outcomes.
- **Selector normalization** across theme arms and publishes; element-to-section mapping.
- **Operator descriptor import** with pages, zones (treated or guardrail), elements (arm, class, section), arms, dates.
- **Live run** on one store:
  - 6,013 daily fact rows (2,707 section, 2,649 element) and 489 readout rows for 4 analyzed experiments.
  - The section query takes about 7 s and the element query about 38 s, against a 300 s limit.

### 13.2 Gaps by owner

| Owner | Work | Requirements |
|---|---|---|
| Extension | Experiment mode, slot ids, same-experiment peer, pane labels, experiment details, element Experiment section with role, zone images, `experiment-v1` save | R-EXT-1…10 |
| Tracker config | Publish declared zones to `section_level`; capture-rate investigation | R-CAP-1…3 |
| Engine — ingest | Load `experiment-v1` packages into `ae_experiment_descriptor`; descriptor versioning | R-DATA-5 |
| Engine — levels | Per-page readout; funnel steps per arm; journey per arm; zone click rollup; zone aliases; role pairing | R-LVL-* |
| Engine — statistics | CIs, corrections, heterogeneity, sequential option, revenue lift decomposition | R-STAT-*, R-ATT-3 |
| Engine — segments | Catalog expansion; planned and custom segments at all levels; feasibility | R-SEG-* |
| Engine — data contract | Flat readout table, metric dictionary, JSONL, MCP tool | R-DATA-2…4 |
| Engine — insights | Insight rules, evidence, LLM bundle | R-INS-* |
| Dashboard | Screens in 11.1 | R-UI-* |

### 13.3 Phases and acceptance

| Phase | Scope | Accepted when |
|---|---|---|
| 1. Contract | Flat readout table, metric dictionary, causal classes, CIs, per-page readout | An LLM given only the readout rows answers the seven questions in Section 4 for one live experiment, with correct causal language |
| 2. Plan | Extension experiment mode and `experiment-v1`; engine ingest; role pairing | A user defines the hero test in the extension in under five minutes; the next run reports the role-paired CTA |
| 3. Depth | Funnel and journey per arm; revenue lift decomposition; zone click rollup; zone publish to tracker | Funnel and Journeys screens populate from real rows for a live experiment |
| 4. Segments | Catalog, planned and custom segments, feasibility, corrections, heterogeneity | Planned segments appear first with Holm-adjusted p-values; feasibility matches realized sample within 15% |
| 5. Insights | Insight rules, evidence, LLM bundle, dashboard Insights screen | Every generated insight cites rows that reproduce its numbers |

### 13.4 Non-functional requirements

| ID | Requirement |
|---|---|
| R-NFR-1 | One site's experiment analysis completes within the batch's query limits (300 s per query today); segment expansion must not exceed 2× today's runtime without a governor |
| R-NFR-2 | Rows are idempotent per (identity, day): a rerun replaces, never duplicates |
| R-NFR-3 | No visitor-level output; minimum cell sizes for display |
| R-NFR-4 | Works on Shopify themes where section ids change per publish; does not depend on the testing tool's API |
| R-NFR-5 | Every readout is reproducible from fact rows plus the descriptor version |

---

## 14. Market positioning brief (for external research)

This section is written for an external LLM doing deep research. Claims about competitors are **hypotheses to verify**, not established facts.

### 14.1 Category framing

Experiment Intelligence sits between four categories:

1. **A/B testing and experimentation platforms.**
   - Shopify-native examples: Shoplift, Intelligems, ABConvert.
   - General examples: Optimizely, VWO, AB Tasty, Convert, Kameleoon.
   - Warehouse-native experimentation and analysis tools (for example Eppo, Statsig, GrowthBook).
2. **Behavior analytics / digital experience analytics:** Contentsquare (including Hotjar), FullStory, Microsoft Clarity, Mouseflow, Lucky Orange, Quantum Metric, and Heatmap itself.
3. **Product and web analytics:** GA4, Amplitude, Mixpanel, Heap.
4. **AI analytics and CRO agents:** LLM assistants over analytics data, and agency tooling.

### 14.2 Value proposition

> *Know where your test made money.* Experiment Intelligence reads the tests you already run in your testing tool and shows the revenue impact at every level of the page and the journey: site, funnel, journey, page, section and element. Segments are declared before launch, and every number is labelled causal or descriptive. Your AI analyst can read every result.

### 14.3 Differentiators (claimed, to validate)

1. **Testing-tool agnostic.** It reads assignment from existing partner tags. There is no migration and no second snippet.
2. **Revenue attribution below the page**, at zone and element level. It uses Heatmap's revenue-joined click, scroll and section data and its element naming and classification system.
3. **Definition in context.** The experiment is defined in the side-by-side visual comparison of the live arms, so the zones and elements are the real DOM of each arm, with images.
4. **Normalization as a product.** It handles canonical arms, theme-independent selectors, off-surface tag removal, multi-arm exclusion, and balance checks on sampled data.
5. **Planned segmentation** with a feasibility check and multiple-comparison control, inside a visual tool rather than a statistics notebook.
6. **Machine-readable by design.** Flat, self-describing readouts with causal labels, exposed through MCP and a facet, built for LLM analysts.
7. **Cross-experiment learning.** Element classes and zone roles are comparable across tests and stores, which enables "what works on hero sections" priors.

### 14.4 Hypotheses for competitive research

| # | Hypothesis | What would falsify it |
|---|---|---|
| H1 | Shopify-native testing tools report site-level (and sometimes device or source) results but not zone- or element-level behavior by arm with revenue | A Shopify testing tool showing per-section or per-element interaction lift by arm |
| H2 | Behavior analytics vendors can filter heatmaps or zones by a variant, but do not compute arm-vs-control lift with significance and revenue at zone level | A vendor offering zone-level lift with p-values per arm |
| H3 | Enterprise experimentation platforms offer strong statistics (sequential, CUPED) but not visual zone and element attribution | A platform offering visual element-level attribution |
| H4 | No product lets the user declare segments with feasibility at planning time inside a visual heatmap tool | A testing or analytics tool with planned-segment power estimates and correction |
| H5 | Agencies spend hours per test assembling a "why" report from several tools | Agency time studies showing under 30 minutes per report |
| H6 | LLM analysts struggle with experiment data because exports are nested or tool-specific | Vendors offering flat, documented, LLM-ready experiment exports |
| H7 | Shopify merchants running continuous tests number in the thousands, concentrated in the $1M–$50M GMV band | Partner install counts and public case studies |

### 14.5 Research prompts for external LLMs

Use these prompts with this document attached.

1. "Using the attached document, map each competitor named in Section 14.1 against the seven differentiators in Section 14.3. For each cell, say yes / partial / no with a source URL and the date checked."
2. "Which Shopify A/B testing apps expose segment-level results, element-level click data, or exports by API? List features, pricing tiers and integration points with behavior analytics tools."
3. "How do Contentsquare, FullStory, Microsoft Clarity and Hotjar integrate with A/B testing tools today? Can they compute lift between variants at zone level, with statistics?"
4. "Estimate the number of Shopify stores running A/B tests continuously, and the number of CRO agencies serving them. Use app store review counts, partner directories and public statements. Show the method."
5. "What do CRO practitioners say are the most time-consuming parts of reporting a test? Summarize from practitioner blogs, communities and surveys from 2024 onward."
6. "Propose three packaging options for Experiment Intelligence: an add-on to a heatmap plan, an agency tier, or usage-based per experiment. For each, give comparable price points from adjacent products."
7. "What are the risks that testing-tool vendors build this themselves? Which would they be least likely to build (cross-tool normalization, zone attribution, LLM-ready exports) and why?"
8. "List the statistical practices CRO buyers now expect (sequential testing, CUPED, multiple-comparison correction, SRM checks), and which Shopify-native tools offer them."

### 14.6 Packaging hypotheses (to test)

- **Included** in Heatmap paid plans for site-level and segment readouts. **Advanced tier** for zone, element, funnel and journey attribution, and the insights.
- **Agency tier:** multi-store, cross-experiment library, white-label exports.
- **Data tier:** MCP and API access to readout rows for AI analysts and BI.

### 14.7 Risks

- **Data coverage:** the section tracker sample (about 4%) limits zone "seen" metrics until capture is raised or zones are published to the tracker.
- **Assignment source:** dependence on partner tags; a partner can change its tag format. Mitigation: normalization tests per partner, and alternative assignment sources (R-CAP-4).
- **Statistical trust:** a wrong causal claim damages credibility. Mitigation: causal classes, balance checks and corrections are not optional.
- **Complexity:** six levels can overwhelm. Mitigation: the Insights screen leads, and levels are drill-downs.

---

## 15. Glossary

| Term | Meaning |
|---|---|
| Arm | One variant of an experiment, including the control |
| Assigned visit | A visit the testing tool tagged into an arm on the experiment's surface |
| Exposed visit | An assigned visit that viewed the page or template under test |
| SRM | Sample ratio mismatch: observed split differs from the planned split |
| Rollup zone / section | A region of the page (for example the hero section) whose interactions are grouped; identified by the section tracker's `section_name` |
| Element | A clickable or viewable element, identified by a normalized selector, with a name, a class and an experiment role |
| Role | A name that pairs different elements across arms that play the same part ("Hero CTA") |
| Captured visit | A visit for which the section tracker sent section events; the base for section rates |
| Seen | A section at least 50% visible for 1 second |
| Reach | Share of assigned visits that reached a funnel step |
| Continuation | Share of the previous step's visits that reached the next step |
| RPV | Revenue per visit (revenue per session) |
| CVR | Conversion rate: buyers ÷ visits |
| AOV | Average order value |
| MDE | Minimum detectable effect, the smallest lift the test is planned to detect |
| Planned segment | A segment declared before launch, corrected as a family |
| Exploratory segment | A segment examined after the fact, with false-discovery control |
| Causal class | Whether an arm difference in a metric is an effect, conditionally an effect, or a description |

---

## Appendix A — Worked example: the hero CTA test

**Setup.** On a Shopify coffee store's home page:

- **Control:** a hero image with the CTA drawn onto the image. The whole image is a link (`a.hero__link > img`).
- **Variant:** a clean photo with a separate real button (`a.hero__cta`).
- **Allocation:** 50/50.
- **Zones:** `custom-hero-v1` (treated) and `header` (guardrail).
- **Elements:** control's image link and the variant's button, both role `hero_cta`, plus the variant's image (role `hero_image`).
- **Planned segments:** device, traffic source, new vs returning.

**Illustrative readout over 14 days.**

| Level | Finding | Causal class |
|---|---|---|
| Site | RPV $2.31 → $2.47 (+7.0%, p 0.12); CVR 2.61% → 2.79% (+6.9%, p 0.08); SRM p 0.54 | causal |
| Funnel | Home → collection/product continuation 48.0% → 52.0% (+8.4%, p < 0.001); add to cart, checkout and purchase continuation flat | descriptive (continuation); causal (reach) |
| Journey | Bounce after home 33.7% → 30.7%; CTA clickers to a collection 62.0% → 70.1% | causal (shares of assigned/exposed); descriptive (path CVR) |
| Section | Capture balanced (p 0.65). Hero click rate 10.8% → 14.9% (+38%). Featured collection seen rate 59.6% → 56.0% (−6%, p 0.02): a possible fold push | conditionally causal |
| Element | Hero CTA (role pair) clicked by 10.1% → 13.7% of visits (+36%, p < 0.001). The new hero image still draws 2.1% of visits in clicks at 1.47 per clicker (dead clicks) | causal (rates); descriptive (clicker CVR) |
| Segment | CVR lift looks larger on mobile (+10.9%, nominal p 0.046) than desktop (+2.1%). But the heterogeneity test is not significant (p 0.47), and the mobile result does not survive Holm correction across the six planned segment values (adjusted p 0.24). Reading: a hypothesis for the next test, not a finding. Meta traffic shows the largest relative lift (+18%). The feasibility check had warned at planning time that no planned segment could reach its MDE by the planned end: the site-level test is powered, the segment cuts are not | causal |

**Generated next test.** Keep the button. Make the hero image link to the same collection to recover the dead clicks. Test a shorter hero to restore featured-collection reach on mobile.

## Appendix B — Metric dictionary (draft)

| Metric | Unit | Base | Formula | Causal class |
|---|---|---|---|---|
| `visits` | count | basis | count of visits | — |
| `share` | ratio | assigned | arm visits ÷ all arms' visits | — |
| `srm_p` | p-value | assigned | test of observed vs planned split | — |
| `cvr` | ratio | basis | buyers ÷ visits | causal on assigned |
| `rpv` | currency | basis | revenue ÷ visits | causal on assigned |
| `aov` | currency | buyers | revenue ÷ orders | descriptive |
| `checkout_rate` | ratio | basis | visits that started checkout ÷ visits | causal on assigned |
| `reach` | ratio | assigned | visits reaching step k in order ÷ assigned visits | causal |
| `continuation` | ratio | step k−1 | visits reaching step k ÷ visits at step k−1 | descriptive |
| `next_page_share` | ratio | entry or clicker visits | visits whose next page is type T ÷ base | causal on exposed; descriptive on clickers |
| `journey_flag_rate` | ratio | exposed | visits with flag F ÷ exposed visits | conditionally causal |
| `capture_rate` | ratio | assigned | captured visits ÷ assigned visits | balance check |
| `seen_rate` | ratio | captured | visits that saw section S ÷ captured visits | conditionally causal |
| `section_click_rate` | ratio | captured | visits that clicked in S ÷ captured visits | conditionally causal |
| `seen_cvr`, `seen_rpv` | ratio, currency | seen visits | buyers or revenue ÷ seen visits | descriptive |
| `click_rate` | ratio | assigned | visits that clicked element or role E ÷ assigned visits | causal |
| `clicks_per_clicker` | per visit | clickers | clicks ÷ clicking visits | descriptive |
| `clicked_cvr`, `clicked_rpv` | ratio, currency | clickers | buyers or revenue ÷ clicking visits | descriptive |
| `lift_rel` | ratio | — | arm ÷ control − 1 | inherits |
| `rpv_lift_contribution_{step}` | ratio | assigned | log-decomposition share of RPV lift (R-ATT-3) | descriptive decomposition of a causal total |

## Appendix C — Source references in the codebase

| Area | Location |
|---|---|
| Experiment dataset | `analysis-engine/src/adapters/datasets/experiment-analysis.js` |
| Normalization | `analysis-engine/src/experiments/normalize.js` |
| SQL (facts, sections, elements) | `analysis-engine/src/experiments/sql.js` |
| Readouts and statistics | `analysis-engine/src/experiments/readout.js`, `stats.js` |
| Tables | `analysis-engine/src/persistence/schema2.sql` (`ae_experiment_descriptor`, `ae_experiment_row`) |
| Descriptor import | `analysis-engine/src/governance-import.js`; runbook `docs/RUNBOOK.md` |
| Trend-row conventions | `analysis-engine/docs/VISION.md` |
| Extension A/B filter | `Heatmap-extension/heatmap-extension-preact/src/components/filter/ABTestingDetails.tsx`, `abVariantOverlap.ts` |
| Extension compare slots | `Heatmap-extension/heatmap-extension-preact/src/layout/Dashboard.tsx` |
| Extension element metadata | `Heatmap-extension/onsite-heatmap/src/naming/descriptorPersist/descriptorTypes.ts`, `events/elementContextMenu.ts` |
| Tracker sections | `core-javascript-refactor-analysis/src/preprocessor/src/section-tracking.ts`, `section-auto-detect.ts` |
