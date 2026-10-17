# Query tool: concept "ChatGPT - V1" (Weekly Brief → Evidence → Next move)

**Date:** 15 October 2026
**Status:** plan. Nothing in it is built yet. It's written for a fresh context to carry out.
**Depends on:** Phase 1 of `docs/plans/query-tool-revisions.md`: the entry page, `revisions.json`, the `revisions/<id>/` layout and `capture.mjs --revision`. Build that first if it isn't there. Concept "Cursor - Opus 5.5 - V1" (Phase 2 of that plan) is **not** a dependency.

**The source proposal** is an external review of the prototype, pasted into chat on 15 October 2026. It came with two files, kept beside this plan:

- `~/Downloads/views-current-safe.patch.json`: 15 JSON-patch operations against today's `views.json`;
- `~/Downloads/views-v2-proposal.json`: a version-two configuration. It's a specification, not a drop-in config.

The proposal also mentions a zip with reference JavaScript for the revenue bridge and mix/rate split, and 1,000 generated test cases. That zip is **not** in `~/Downloads`. This plan doesn't need it; the formulas are given in full below.

**Name and folder.** The display name is `ChatGPT - V1`, folder `revisions/chatgpt-v1/`. The name follows the existing "tool - version" pattern, and the user can rename it in `revisions.json` without touching code.

---

## Part A. Analysis of the proposal

### A.1 Verdict

**The proposal is sound, and better than our own analysis in three places.** Build it as its own concept, mostly as written, with five corrections.

Its strongest contributions:

- **The funnel is mislabelled.** The funnel counts are actions recorded anywhere in the session, so step-to-step ratios aren't continuation rates (verified below). Our own analysis and the Cursor V1 plan both treat `step_cart`, `step_checkout` and `step_buy` as transitions.
- **Trust as a contract:**
  - per-dataset capabilities;
  - a distinction between filter, breakdown and comparison;
  - "unsupported here" is said out loud, never silently changed;
  - null, zero and unavailable are kept apart.
- **Answer discipline:**
  - three findings at most, and fewer if fewer qualify;
  - templates that list claims they must not make ("recoverable revenue", "wasted spend");
  - an evidence reference on every number.

Its weaknesses:

- **It worked from screenshots,** so it couldn't explain the Health-versus-Funnels gap. We can.
- **Its screening thresholds are miscalibrated for low base rates.** On Mellow they hide Meta's conversion drop and flag Campaign's sale-week bounce.
- **Several specified objects are named but not defined:** `scope_id`, `contract_id`, `priority_tier`, the format of `evidence_refs`, and the third Slice 1 template.

### A.2 Claims checked against the code and the Mellow snapshot

| # | Proposal claim | Check | Result |
|---|---|---|---|
| 1 | The funnel counts actions recorded at any point in the session, so adjacent ratios are not continuation rates | `flows.mjs` lines 53–70 build each flag as `max(event_type = …)` per visit and count `uniqExactIf(idvisit, flag > 0)`. In `funnel.json`, **424 of 1,841 rows have more add-to-cart sessions than product-view sessions** (for example, cart entries on 5 Oct: 1,814 against 779, a "Viewed → added to cart" of 233%), and 136 rows have more checkout starts than add-to-carts | **Confirmed.** `step_cart`, `step_checkout` and `step_buy` are count ratios, and their labels ("Viewed → added to cart") are wrong |
| 2 | Health shows 1,031,732 sessions (−0.4%) for the 5 Oct week, and Funnels shows 1,324,742 (+27.6%) | Same figures in the snapshot | **Confirmed.** The proposal calls the cause unknown; **it is known.** `tag_trend` was written on the 30-day bundle window (11 Sep–10 Oct), so its 5 Oct week has 6 days. In the three whole weeks between, the two datasets agree within 0.2% (`~/Work/analysis/query-tool/6-ANALYSIS.md` §6.1). It's a coverage problem, not two different populations |
| 3 | Capping happens before the browser aggregates | `snapshot.mjs` `cap()` (line 78) slices the rows before writing. `selector-weekly` is 6,000 of 16,577 | **Confirmed** |
| 4 | Missing values turn into zero | `query.js` lines 66 and 88: `Number(r[c]) \|\| 0`. Also `flows-views.js` line 10 | **Confirmed** |
| 5 | The hash uses replace, so Back doesn't step through an investigation | `app.js` `writeHash()` uses `history.replaceState`, and there's no `hashchange` or `popstate` listener | **Confirmed** |
| 6 | The glossary says the buyer segment's order rate is 100% | Glossary entry 6 says exactly that, but orders per buying session is 1.011 on 5 Oct | **Confirmed** |
| 7 | The patch's glossary indexes 6, 11 and 12 are Buyer segment, Floor and Partial weeks | `views.json` glossary order | **Confirmed.** Entry 2 ("Order rate") also needs the new term, and the patch misses it |
| 8 | Hierarchy §7.4 wrongly lists "Meta × mobile" as unavailable | Hierarchy line 316 says crossed segmentations in Shape 1 (Meta × mobile) aren't stored. The funnel and journey rows do carry `viewport_type` beside one segment family | **Confirmed.** Device crosses with one segment family. Two families can't be crossed |
| 9 | Journey ranking is frozen, not top-ranked within a segment | `trend-run.js` `rankMoneyPaths`: one site-wide revenue ranking over the 30 days ending the last week (`DEFAULT_RANK_DAYS = 30`), paths of 2+ steps | **Confirmed.** The panel label should say "the 5 paths with the most revenue site-wide, 12 Sep–11 Oct" |
| 10 | Quoted figures: mobile product-page entries 617,198 sessions with 10.4% add-to-cart and 1.34% bought; Meta content → product page 6.17%, −2.2 points; new 1.52% and returning 3.19%; the experiment arm at 71,325 sessions and 4.83%; 59 missing requirements | Recomputed from the snapshot | **All confirmed.** The 59 comes from `requirements.json` (99 rows). `requirement-status` has 58 of 98, so the two panels differ by one row |
| 11 | A device split needs a reconciled "unknown" residual | `funnel`, `segment = all`: the all-devices row minus the sum of mobile, desktop and tablet = **0 sessions and $0**, in both weeks | **Not needed for `funnel`.** Keep the check, and expect it to pass |
| 12 | Partial-week detection is a volume heuristic | `views.js` line 92 and `flows-views.js` line 29: under 70% of the median week | **Confirmed.** The windows are recorded in the manifest (`flows.window`, `bundle.window`), so coverage can be derived. "Coverage unverified" is only needed for `trend` and `tag_trend`, whose window is inferred |

### A.3 The proposal's arithmetic, run on Mellow (5 Oct against 28 Sep, all visitors, all devices)

**Four-factor revenue bridge.** This is a Shapley split of sessions × buying-session rate × orders per buying session × average order, averaged over all 24 orders of substitution:

| Factor | 28 Sep | 5 Oct | Contribution |
|---|---|---|---|
| Sessions | 1,037,914 | 1,324,742 | **+$669,334** |
| Buying-session rate | 1.965% | 1.757% | **−$307,903** |
| Orders per buying session | 1.0110 | 1.0112 | **+$626** |
| Average order | $125.09 | $122.92 | **−$48,132** |
| Total | $2,579,051 | $2,892,975 | **+$313,924** (exact) |

**Mix/rate split of the buying-session rate change** (−0.208 points), symmetric form:

| Partition | Mix | Within-segment rate |
|---|---|---|
| Traffic source | **−0.268 points** | **+0.060 points** |
| Device | −0.009 | −0.199 |
| Entry type | −0.110 | −0.098 |
| New or returning | −0.049 | −0.159 |

By traffic source, Meta contributes +0.075 points of mix and −0.074 of rate. Search contributes −0.150 of mix and +0.030 of rate. This agrees with the Cursor analysis: the conversion drop is a traffic-mix effect.

**Screening rule as configured** (`views-v2-proposal.json` `screening`). The candidate family is the 6 traffic-source conversion rates, 4 event-reach rates and 5 general journeys, so M = 15 and z* = 2.94:

| Candidate | 28 Sep → 5 Oct | Result | Fails on |
|---|---|---|---|
| Content → product page completion | 12.31% → 9.24% | **Review** | — |
| Product-view reach | 59.31% → 51.95% | **Review** | — |
| Buying-session rate (site) | 1.96% → 1.76% | **Review** | — |
| Product page → content → product page | 3.11% → 2.51% | **Review** | — |
| Campaign conversion | 4.24% → 5.76% | **Review** | — |
| **Meta conversion** | 0.91% → 0.79% | **Not flagged** | the 0.2-point absolute floor |
| Search conversion | 4.24% → 4.48% | Not flagged | absolute floor |
| Others | — | Not flagged | absolute floor and/or z |

**Two calibration problems follow.**

1. **The fixed 0.2-point absolute floor can't fire for low-rate segments.** Meta's −0.12 points is 13% of its rate, on 880,079 sessions (z ≈ 8). Still, Meta stays visible through the channel template, which is a level finding, not a change.
2. **There's no history test.** Campaign's +1.5 points passes, but Campaign swings every sale week (5.83, 3.74, 3.78, 4.24, 5.76% over five weeks).

The concept implements the rule as configured, so it's a fair test of the proposal. It also exposes the thresholds as configuration and records this outcome as an expected result (§C10). Whether to change them is an open question for the user (Part E).

### A.4 Gaps the build has to fill

| Gap | Decision in this plan |
|---|---|
| `scope_id`, `contract_id` undefined | `scope_id` = a canonical string such as `funnel|seg=traffic_source:meta|dev=all`. `contract_id` = the dataset name |
| `evidence_refs` format undefined | Defined in C6 (`evidenceRef`) |
| `priority_tier` and "materiality ordering" undefined | Defined in C10 |
| The third Slice 1 template ("event-reach movement") isn't specified | Specified in C10 |
| "Coverage unverified" everywhere | Coverage is derived from the manifest windows (C2). "Unverified" is only for inferred windows |
| The proposal covers 7 panels; the prototype has 48 | The new tabs inherit context. The 44 other panels move, unchanged, into a labelled **Reference** group that keeps its own pickers (as the proposal's Slice 1 says) |
| The proposal puts the bridge and mix/rate in Slice 2 | **Included**, because usability task 2 needs them and they're pure arithmetic (C11) |
| `snapshot` context and pinned versions | There's one snapshot per site. Pin it with `manifest.generatedAt` in the link, and warn on mismatch (C3) |

### A.5 How this concept differs from "Cursor - Opus 5.5 - V1"

Both open on a brief and share a context bar, so the comparison will be about judgement and presentation, not features.

| | Cursor - Opus 5.5 - V1 | ChatGPT - V1 |
|---|---|---|
| Home | Headline, 8 ranked movers, revenue decomposition | Outcome strip, at most 3 findings, improvements, limits |
| Change rule | Noise plus "bigger than any prior weekly move", with labels such as "sliding" | Eligibility, absolute and relative floors, and Bonferroni z. Badge: "Large enough to review" |
| Funnel | Keeps the portal funnel, adds badges | **Replaced by event reach.** No narrowing shape, no "abandoned" |
| Revenue split | Sequential traffic/mix/rate on revenue per session | Shapley four-factor bridge, plus symmetric mix/rate on the buying-session rate |
| Journeys | Five lanes | A path table, one expanded |
| Drill | Links to existing panels | An evidence drawer with provenance |
| Other panels | Kept in their tabs | Moved to a Reference group |
| Extra | — | Pins, a client-brief export, a local task log, real Back/Forward history |

---

## Part B. Ground rules

These are the same as `query-tool-revisions.md` §2:

- Don't commit.
- No warehouse access; don't rerun `snapshot.mjs` or `flows.mjs`.
- Revisions are copies, and Quick Concept is frozen.
- No `*.test.*` or `*.spec.*` names.
- Plain browser modules, no dependencies.

Also:

- **Fork from Quick Concept,** not from Cursor V1: `cp -R revisions/quick-concept revisions/chatgpt-v1`. The two concepts must stay independent.
- **No `eval`,** and no functions read from configuration. Condition and template names in `views.json` resolve to a fixed table of JavaScript functions.
- **Never show a missing value as 0.** Use `—` with a tooltip saying why: "not in this snapshot", "no comparison week" or "below the floor".

## Part C. Build

All expected numbers are Mellow, week of 5 October against 28 September, all visitors and all devices, unless stated. They were checked against `data/sites/mellow/` while writing this plan.

### Files

```text
revisions/chatgpt-v1/
  index.html app.js views.js flows-views.js query.js styles.css views.json check.mjs   (forked)
  contracts.js     dataset contracts, capabilities, coverage, compatibility (C2)
  context.js       context bar, inheritance, history (C3)
  screening.js     eligibility and the screening rule (C5)
  evidence.js      evidenceRef, the evidence drawer (C6)
  answer-views.js  comparison, eventReach, journeyFocus, answers, outcomes, changeBridge, mixRate, brief (C7–C12)
  derive.js        scope_weekly, metric_comparisons, journey_comparisons, revenue_bridge, mix_rate_effects, partition_contributions
  pins.js          pins, client-brief export, task log (C12)
  capture.json     screenshot variants (C14)
  selftest.mjs     (C13)
```

### C0. Fork and register

1. Fork as above. Set the header tag to `ChatGPT - V1`, and set `views.json` `"revision": "ChatGPT - V1"`.
2. Add a card to `revisions.json`, after the newest entry:

   ```json
   {
     "id": "chatgpt-v1",
     "name": "ChatGPT - V1",
     "date": "<finish date>",
     "status": "current",
     "basis": "External review (15 Oct 2026): Weekly Brief → Evidence → Next move; views-v2-proposal.json",
     "summary": "Opens on at most three findings worth reviewing, each with its comparison, volume, limits and next step. Every number opens its evidence. The funnel is shown as event reach, because the data records actions, not their order.",
     "changes": [
       "Weekly Brief: outcome strip, up to three findings, improvements and limits",
       "Event reach replaces the funnel; journeys open one path at a time",
       "Explain: exact four-factor revenue bridge and mix-versus-rate split",
       "Evidence drawer with breakdowns, definitions and provenance",
       "Context bar with real Back/Forward history; pins and a client-brief export",
       "Earlier panels kept, unchanged, under Reference"
     ]
   }
   ```

### C1. Measurement-contract fixes (proposal R01)

1. **Apply all 15 operations** in `views-current-safe.patch.json` to `views.json`, by hand or with a ten-line JSON-patch applier in a scratch script (don't keep the script). Also:
   - rename glossary entry 2's term from "Order rate" to **"Orders per session"**, and rewrite its text to match;
   - set `measures.step_pv.label` to **"Sessions with a product view"** (it is `product_viewed ÷ sessions`, a true reach rate).
2. **Nulls in `query.js`:**
   - `aggregate` and `totals` keep `null` when every input in a group is null or missing. When some inputs are present, they sum the present values and record `partial: true` on the group;
   - `measureValue` returns `null` when the denominator is 0 or null;
   - `format(null)` returns `—`. Do the same in `flows-views.js` `sum`.
3. **Remove the 70%-of-median partial-week heuristic** from `views.js` and `flows-views.js`. Coverage now comes from C2.
4. **Capped datasets:**
   - when `manifest.datasets[name].capped` is true, a panel shows a chip: "Incomplete source: 6,000 of 16,577 rows exported. Totals and week-to-week rankings are not shown";
   - the panel suppresses its totals row and any change-based sort;
   - row values stay visible.

**Done when:**

- the Definitions drawer shows the new labels;
- Reference → Elements → `el-selectors` shows the incomplete-source chip and no totals;
- no number anywhere renders as `0` where the source cell is null. Spot-check `pg-sisters` and `xp-arms`.

### C2. Dataset contracts, coverage and compatibility (`contracts.js`)

**Contracts.** Copy `schemaExtension.datasetContracts` from the proposal into `views.json` as `datasetContracts`. Add entries for `trend` (keys like `tag_trend`; `nonAdditiveAcross: ["row_key"]`) and `journey_summary` (as `journeys`).

**API:**

```js
contractOf(name)                         // the views.json entry, or a default "unknown contract" record
supports(name, field, columns)           // true if the dataset has the column (via fieldMap) and the contract doesn't forbid it
crossable(name, fieldA, fieldB)          // device × one segment family: true for funnel/journeys; two families: false
coverage(manifest, name) → Map(week → { days, state })
compatibility(manifest, rowsOf, a, b) → [{ week, ratio, state }]
```

**Coverage states:**

| Dataset | Window | Days | State |
|---|---|---|---|
| `funnel`, `journeys`, `journey_summary` | `manifest.flows.window` (whole weeks by construction in `flows.mjs`) | 7 | `verified` |
| Bundle tables (any other dataset with `week` or `dim_week` and `source: bundle`) | `manifest.bundle.window` | n | `verified` when 7, otherwise `partial` (n/7) |
| `trend`, `tag_trend`, `experiment_rows` (warehouse, window not stored) | inferred from `manifest.bundle.window` | n | 7 → `unverified-complete`; fewer → `partial-inferred` |

**Compatibility.** `compatibility(manifest, rowsOf, 'tag_trend', 'funnel')` compares weekly site sessions. For `tag_trend`, use `tag_key = utm_source`, `segment = all`, `viewport_type = all`, or the sum of `traffic_source` values if there's no `all` row. For `funnel`, use `segment = all`, `viewport_type = all`, summed over entries.

- A ratio of 0.97–1.03 → `compatible`.
- Anything else → `incompatible`.

| Mellow week | Ratio | State |
|---|---|---|
| 7 Sep | 0.326 | incompatible (partial) |
| 14, 21, 28 Sep | 0.999, 0.999, 0.998 | compatible |
| 5 Oct | 0.779 | incompatible (partial) |

**Where it shows:**

- Any panel reading a non-`verified` week shows the state on that week's header (`5 Oct · 6/7 days, inferred`).
- Its changes for that week follow the trust rules in C5.
- The Brief's limits section (C10) says, in one sentence: "Health and Acquisition tables cover 11 Sep–10 Oct, so their 5 Oct week has 6 of 7 days and can't be compared with Funnels or Journeys. In whole weeks they agree within 0.2%."

### C3. Context bar and history (`context.js`, proposal R03)

**Bar**, left to right: **Site** · **Snapshot** · **Week** · **Compare with** · **Segment** · **Device**.

- **Snapshot:** read-only text, `Snapshot 16 Oct 02:53`, from `manifest.generatedAt`. Links carry it as `snap=<generatedAt>`. When a link's `snap` differs from the loaded manifest, show a banner: "This link was made on snapshot X. You're seeing snapshot Y; numbers may differ."
- **Week:**
  - the weeks of `funnel`;
  - default is the latest `verified` week (Mellow: 5 Oct);
  - an unverified week is labelled "Coverage unverified".
- **Compare with:** only `Previous week` (the default) and `No comparison`. The proposal doesn't include averages.
  - When the previous week is missing, show "comparison unavailable". Never substitute another week.
- **Segment:** one family, then one value ("All visitors" by default; `maxFamilies: 1`).
- **Device:** All devices, Mobile, Desktop, Tablet.

**Hash keys:** `wk`, `cmp` (`prev|none`), `seg`, `segv`, `dev`, `snap`. `tab` and `focus` stay as they are, plus `s` for panel state and `ev` for an open evidence drawer.

**History:**

- **`pushState`** for navigation: a tab change, opening an evidence drawer, drilling from a finding, focusing a path.
- **`replaceState`** for control edits: context pickers, sort, panel pickers.
- **On `popstate` and `hashchange`:** re-read the hash and re-render without pushing.
- Back from an open drawer closes it. Back again returns to the previous tab with its context.

**Inheritance.** New-concept panels inherit by default (`inheritByDefault: true`). For each context field, through `fieldMap`:

- **Supported:** apply it as a filter, with no picker.
- **Unsupported:** don't render the panel body. Show: "This view can't be filtered by {field} ({reason from contracts}). [Show it for all visitors] [Keep my filter and go to {alternative}]". The first button sets a **visible override chip** on that panel ("Showing all visitors — remove ✕"). The alternative comes from the contract. For example, for returning × traffic source the alternative is `weekly_entry_cube` (Reference → Acquisition → `acq-cube`), with a "different population" note.

**Filter, breakdown, comparison.** A panel declares which it does with a segment. The channel comparison breaks down by traffic source, so a context value of `meta` **highlights** the Meta row rather than filtering the table to one row. Write this distinction into `views.json` as `"segmentRole": "filter" | "breakdown"`.

**Reference panels** (C4) ignore context. Each Reference tab shows one banner: "Reference views keep their own filters and don't follow the context bar."

**Done when:**

- Context Traffic source → Meta, Mobile carries across Brief, Channels, Paths and Explain, and survives a reload.
- Back and Forward walk through tab changes and drawers.
- On Paths, setting New or returning → Returning while the channel comparison expects traffic source shows the explicit choice, not a silent change.

### C4. Navigation (proposal §1.4 and §4.1, Slice 1 cut)

The question dropdown becomes a grouped select (`<optgroup>`) with short labels. Question text moves into each tab's heading.

```text
Brief                       (new, C10)
Explore
  Channels                  (new, C7)
  Paths and actions         (new, C8: event reach + journey focus)
  Explain revenue change    (new, C11)
Saved
  Client brief              (new, C12)
Reference
  Health · Acquisition · Journeys (lanes) · Funnels (legacy) · Pages · Elements · Returning · Orders · Experiments · Verdicts
```

- The Reference tabs are Quick Concept's ten tabs, with their panels unchanged apart from C1. Prefix their ids with `ref-` so hashes don't collide.
- In Reference → Funnels, `fn-funnel` keeps its drawing, but with a red-outlined note at the top: "This drawing shows counts of sessions that recorded each action anywhere in the visit. The narrowing shape and 'abandoned' labels don't mean visitors left between steps. Use Paths and actions → Event reach." Change the "Abandoned" text in `flows-views.js` `funnel` to **"Fewer sessions recorded this"** and "Completed" to **"Count ratio"**.
- The Verdicts sidebar stays on Reference tabs only.

### C5. Comparisons, trust states and screening (`derive.js`, `screening.js`, proposal R04/R05)

**`scope_weekly`** (derived from `funnel`):

- Filter `segment` and `segment_value` (from context, or all/all) and `viewport_type`. Sum over `entry`; entry is the partition leaf, with no `all` row.
- Columns: `scope_id, week, sessions, product_viewed, added_to_cart, checkout_started, buyers, orders, revenue`.
- **Guard:** throw if asked to mix `segment = all` rows with member rows, or `viewport_type = all` with device rows.

**`metric_comparisons`.** One record per subject × metric × week pair:

```js
{ scope_id, subject, metric, kind: 'rate' | 'money' | 'count',
  x1, n1, x0, n0,                  // numerator and denominator, this week and the comparison week (null when missing)
  current, prior, delta, delta_pp, relative,
  coverage: 'verified' | 'partial' | 'partial-inferred' | 'unverified-complete',
  sample: 'ok' | 'small' | 'missing-baseline',
  screen: { eligible, review, fails: [...] },
  evidence: evidenceRef }
```

**Trust states** come from proposal §6.1 Layer 2. Each record gets exactly one primary state, in this order:

1. **`missing-baseline`:** "comparison unavailable". Show the value; the delta is `—`.
2. **`incompatible`:** the two weeks have different coverage, or the datasets differ. Show both values; no delta, no sentence.
3. **`partial`:** "Partial week (n/7)". Show the value; for counts and money, the delta is `—`.
4. **`capped`:** "Incomplete source". No totals and no ranking.
5. **`outcome-defined`:** the buyer family. "Buyer-defined segment; buying rate isn't a performance comparison." Never screened.
6. **`small`:** below 200 sessions, or 20 successes or 20 failures, in either week. Show exact x/n for both weeks, plus "Small cohort — inspect before acting". It isn't promoted.
7. **`ok`**.

**Screening** (`screening.js`). Read `views.json` `screening`, copied unchanged from the proposal. A rate candidate is **reviewable** when it's eligible (trust state `ok`) and passes all of these:

- n ≥ 200 in both weeks;
- x ≥ 20 and n − x ≥ 20 in both weeks;
- |Δp| ≥ max(0.002, 0.10 × p₀);
- n₁ × |Δp| ≥ 20;
- |Δp| > z* × √(p₀(1 − p₀)/n₀ + p₁(1 − p₁)/n₁), with z* = Φ⁻¹(1 − 0.05/(2M)).

Details:

- M is the size of the candidate family, **fixed before ranking**. Use the Acklam rational approximation for Φ⁻¹; about 15 lines, with no dependency.
- **Money metrics** (revenue, revenue per session, average order) are never screened. Show their observed changes with "uncertainty not estimated".
- **Badge text:** `Large enough to review` (filled), or nothing. Never use "significant", "real" or "proven". The tooltip lists each check with its numbers.
- **Individual rate intervals,** shown in the evidence drawer, use the Wilson 95% interval.

### C6. Evidence references and the evidence drawer (`evidence.js`, proposal R04)

```js
evidenceRef = {
  snap: manifest.generatedAt, site, dataset, file: manifest.datasets[dataset].file,
  filter: { segment, segment_value, viewport_type, ...subjectKeys },   // exact row filter
  weeks: [week, compareWeek], measure, calc: 'ratio-of-sums' | 'shapley-4' | 'mix-rate-symmetric' | 'screen-v1',
  coverage, capped
}
```

The drawer is a right-hand panel opened by clicking any value in the new views. The hash `ev=` holds a compact JSON of the ref. It has five fixed sections:

1. **Comparison:** current x/n = value, prior x/n = value, delta, the Wilson interval for each rate, and the screening result with each check.
2. **History:** the five weeks as a small inline chart. Gaps are drawn as gaps; non-verified weeks are hollow.
3. **Breakdown:** the cuts the contract allows for this subject. For `funnel`, that's device (when not already filtered), entry type, and the other members of the current family. Each cut is a short sorted table.
   - Unsupported cuts are listed with their reason and alternative, for example: "New or returning × Meta: not in this dataset. Crossed in `weekly_entry_cube` (bundle visits, different population) → open".
4. **Definition:** the measure's `help`, plus the caveat for this subject type (proposal §6.2 table).
5. **Provenance:** dataset, source (warehouse or bundle), file, rows, capped or not, window and coverage, snapshot time, batch ids from `manifest.warehouse`, the calculation id, and "Copy link" (the full URL including `ev=`).

### C7. Channels: the `comparison` view (proposal panel `channel-comparison`)

- **Rows:** traffic-source members of `funnel`, using context device.
- **Measures:** session share, sessions that bought, revenue per session, revenue.
- **Columns per measure:** current, prior, delta, and n. The trust badge sits on the measure picked in "Sort by".
- **Sort:** "Sort by: change in {measure}" (the default is change in sessions that bought), or by volume.
- **Highlight:** the context value's row is highlighted.
- **Clicks:** any value opens the drawer. A row's "Inspect journeys →" goes to Paths with `seg=traffic_source&segv=<value>`, using pushState.

**Required point-of-use caveat** in the header: "Last touch. On-site value only: no spend, so nothing here says a channel is or isn't profitable."

**Expected values:**

| Value | Session share | Sessions that bought | Revenue per session | Revenue |
|---|---|---|---|---|
| Meta | 57.7% → **66.4%** | 0.915% → **0.795%** | $1.09 → **$0.93** | $649,700 → **$818,319** |
| Search | — | 4.24% → 4.48% | — | — |
| Campaign | — | 4.24% → 5.76% (Review) | — | — |
| All other sources combined (for templates) | — | 3.40% → 3.66% | — | — |

### C8. Paths and actions (proposal panels `fn-event-reach` and `jr-focus`)

**`eventReach`** replaces the funnel.

- **Data:** `scope_weekly` with context applied, plus an **Entry type** panel picker (default: all entries).
- **Layout:** four rows, one per action: product viewed, added to cart, checkout started, bought.
  - Each row shows sessions, the share of all sessions as a horizontal bar on a **shared 0–100% scale**, and the change in points.
  - Each share opens the evidence drawer.
- **No connectors, no narrowing shape,** and none of the words "abandon", "drop-off" or "continued".
- **Fixed footnote:** "Actions recorded anywhere in the session, out of the same sessions. Not an ordered sequence, and not step-to-step rates."

| Action | 28 Sep | 5 Oct | Sessions on 5 Oct | Screen |
|---|---|---|---|---|
| Product viewed | 59.31% | **51.95%** | 688,156 | Review |
| Added to cart | 9.85% | **10.27%** | 136,083 | — |
| Checkout started | 4.76% | **4.77%** | 63,254 | — |
| Bought | 1.96% | **1.76%** | 23,275 | Review |

Mobile + product-page entry: 617,198 sessions, 10.41% added to cart, 1.34% bought.

**`journeyFocus`** replaces the lanes as the default.

- **Data:** `journey_comparisons`, derived from `journey_summary` with `kind` = general (a "Page-specific" toggle switches to `kind = page`). Uses context segment and device.
- **Table columns:** path (from valueLabels), starts, completion this week, completion prior, Δ points, end-session buying rate, trust and screen.
- **Selection basis** goes above the table: "The 5 paths with the most revenue site-wide over 12 Sep–11 Oct, ranked once for all segments. Not the top paths for the selected segment."
- **One path expands** under its row: the first row by default, or `focus=<path>`. It reuses the existing lane renderer from `flows-views.js` for that single path, with each transition's own denominator shown.
- **Fixed-volume scenario line,** under the expanded path when Δ < 0: "At this week's 482,800 starts, the prior completion rate would mean about 14,800 more completions. This is a comparison at fixed volume, not lost or recoverable shoppers."
- **Never** sum starts or revenue across paths.

Expected, general paths:

| Path | Completion | Starts |
|---|---|---|
| Content → product page | 12.31% → **9.24%** (−3.07 points, Review) | 482,800 |
| Same path with context Meta | 8.33% → **6.17%** | 391,730 |

### C9. Outcome strip (Q02)

It sits at the top of the Brief, from `scope_weekly`:

- sessions;
- sessions that bought;
- orders per buying session;
- average order;
- revenue.

Each shows its value, delta and trust. Money values say "uncertainty not estimated" in the tooltip.

Expected: sessions 1,037,914 → 1,324,742 (+27.6%); sessions that bought 1.965% → 1.757% (−0.21 points, Review); orders per buying session 1.011 → 1.011; average order $125.09 → $122.92; revenue $2,579,051 → $2,892,975 (+12.2%).

Under the strip are two links: "Explain revenue change →" (C11) and "Prepare client brief →" (C12).

### C10. The Brief: the `answers` view (proposal panel `home-movements`)

**Candidates** (`answer_candidates`): run every answer rule over the current scope.

| Rule id | Dataset | Fires when | Claim template |
|---|---|---|---|
| `journey_completion_decline` | `journey_comparisons` (general) | Δ < 0 and screen = review | `{path}: {completion} completed, {delta_pp} points versus the week of {compare_week}, across {starts} starts.` |
| `channel_on_site_value` | `metric_comparisons` (traffic source, sessions that bought) | the source has the largest session share **and** its rate is below the rate of all other sources combined. It's a level finding; no screen is needed | `{source}: {share} of sessions, {rate} of them bought, versus {others_rate} for all other sources ({top2_label} {top2_rate}).` |
| `event_reach_movement` | `metric_comparisons` (event reach) | screen = review, excluding "Bought" when it duplicates the site buying-session rate in the outcome strip | `{action}: {current} of sessions, {delta_pp} points versus the week of {compare_week}.` |
| `channel_rate_change` | `metric_comparisons` (traffic source) | screen = review | `{source} sessions that bought: {prior} → {current}.` |

Each rule carries `prohibitedClaims` and `requiredCaveats` from the proposal. **`requiredCaveats` render under the claim.** `prohibitedClaims` is a selftest check: no rendered text may contain those phrases.

**Ranking:**

- **Tier 1:** reviewable declines.
- **Tier 2:** level findings (`channel_on_site_value`).
- **Tier 3:** reviewable improvements. These go to **"Improvements worth preserving"**, never the top three.
- Within a tier, sort by `observed_exposure`, the current-week denominator.
- **De-duplicate by theme:** journey, channel, event reach. Keep the highest-ranked candidate per theme.
- **Show at most 3.** If fewer qualify, show fewer, plus the proposal's `emptyState` sentence for the empty slots.

**Each finding shows:**

- the claim;
- one line of concentration: the biggest breakdown cell, from the drawer's breakdown logic, only when the cut is supported;
- the caveats;
- three buttons: `See evidence` (the drawer), `Go to view` (pushState to Channels or Paths with focus) and `Pin` (C12).

**"What this can't assess"** sits below. It's a short list from the trust layer for the current scope:

- the coverage sentence from C2;
- "No ad spend: channel profitability can't be judged";
- "Funnel actions are not ordered: no step-to-step rates";
- any capped dataset that the Reference tabs use.

**Expected Mellow Brief** (all visitors, all devices):

1. Product viewed: 51.95% of sessions, −7.36 points versus the week of 28 Sep. (Event reach; tier 1, exposure 1,324,742 sessions)
2. Content → product page: 9.24% completed, −3.07 points versus the week of 28 Sep, across 482,800 starts. (Journey; tier 1, exposure 482,800)
3. Meta: 66.4% of sessions, 0.79% of them bought, versus 3.66% for all other sources (Search 4.48%). (Channel; tier 2)

**Improvements worth preserving:** Campaign sessions that bought, 4.24% → 5.76%.

The 3.11% → 2.51% decline on product page → content → product page loses the journey-theme slot to content → product page, because it has more starts. **Meta's conversion change is not a finding** under the configured screen (Part A.3).

### C11. Explain revenue change (proposal panel `why-revenue`, plus `mix_rate_effects`)

**`changeBridge`** is the four-factor Shapley split from A.3, shown as a horizontal waterfall with a reconciliation line ("Contributions sum to the observed change: +$313,924. Residual $0").

- Average over all 24 orders.
- When a ratio is undefined (no buyers or no orders in a week), fall back to the two-factor split, sessions × revenue per session, with a note.
- **Footnote:** "An accounting split of the observed change, not its causes."

**`mixRate`** is the symmetric split of the buying-session rate change, over one partition picked in the panel: Traffic source (default), Device, Entry type, or New or returning.

- mix = Σ (w₁ − w₀)(p₀ + p₁)/2
- rate = Σ (p₁ − p₀)(w₀ + w₁)/2
- A member present in only one week gets its own "entered/exited" term, and isn't given an imagined prior rate.
- Show the total line, the two bars, and a member table (weights, rates, mix, rate).

**`partitionContributions`:** revenue this week minus the comparison week, per member of the same partition, with a check that it sums to the total change.

Expected values are in A.3 (bridge and mix/rate). Per-channel revenue change: Meta +$168,619. The rest the implementer computes, and the selftest asserts the sum.

### C12. Pins, client brief, task log (`pins.js`, proposal R10/R12, local only)

**Pins:**

- `Pin` on a finding or drawer stores `{ id, claim, caveats, evidenceRef, pinnedAt }` in `localStorage` under `qt:chatgpt-v1:<site>:<snap>`.
- At most 3 findings plus 1 action. The action is free text typed by the user, labelled **"Your recommendation"**, and kept visibly separate from tool statements.

**Saved → Client brief** lists the pins and offers:

- **Copy as Markdown:** each finding with its numbers, scope (site, week, comparison, segment, device), caveats and a link that reproduces it;
- **Download JSON:** the same, with the full `evidenceRef`s.

It warns when a pin's `snap` differs from the loaded snapshot.

**Task log:**

- Append `{ t, event, tab, context, ev }` to `localStorage` `qt:chatgpt-v1:log` for the events in proposal §10.3: `context_changed`, `answer_rendered`, `evidence_opened`, `unsupported_cut_requested`, `scope_change_accepted`, `answer_pinned`, `brief_exported`.
- `task_started` and `task_completed` come from a small hidden facilitator control, opened with `?facilitator=1`, which has Start, Stop and a task number.
- A "Download log" button sits in the facilitator control.
- Never log free text.

### C13. `check.mjs` and `selftest.mjs`

**`check.mjs`:**

- knows the new views (`comparison`, `eventReach`, `journeyFocus`, `answers`, `outcomes`, `changeBridge`, `mixRate`, `brief`) and the derived datasets;
- validates `datasetContracts` against the manifests: every listed key exists as a column;
- every answer rule's `dataset`, condition name and template fields resolve;
- a Reference panel id never collides with a new one.

**`selftest.mjs`** (run with `node`; it skips data-backed checks when `data/sites/mellow` is missing):

- **Shapley:** synthetic cases, including one undefined ratio. On Mellow, the four contributions in A.3 within $1, and their sum equals the observed change within $0.01.
- **Mix/rate:** the four partitions in A.3 within 0.001 points, and mix + rate (+ entered/exited) = the observed change.
- **Screening:** the A.3 table. Exactly these five are reviewable at M = 15: content → product page, product-view reach, buying-session rate, product page → content → product page, Campaign. Meta conversion fails only on the absolute floor.
- **Event reach** and **Meta values:** the C7 and C8 tables.
- **Coverage and compatibility:** the C2 tables. Loop Earplugs: bundle-window weeks 7 Sep = 2/7, 5 Oct = 7/7.
- **Nulls:** an aggregate of all-null inputs is `null`, and `format(null)` is `—`.
- **The Brief:** the three expected findings in order, and the improvement.
- **Prohibited phrases:** no rendered template contains a rule's `prohibitedClaims`, or "abandon" in the new views.

### C14. `capture.json`

The variants:

- Brief, default;
- Brief with Traffic source → Meta;
- Channels;
- Paths with Mobile and a product-page entry;
- Paths with Meta, content → product page expanded;
- Explain, mix/rate by device;
- the evidence drawer open on Meta's sessions that bought;
- the unsupported-cut message (Paths with New or returning, opening a cut that needs traffic source);
- Client brief with two pins. Use a `before` script that writes the pins to `localStorage`.

---

## Part D. Verification

With `node prototype/query-tool/serve.mjs --port 8765` running:

```bash
node prototype/query-tool/revisions/chatgpt-v1/check.mjs
node prototype/query-tool/revisions/chatgpt-v1/selftest.mjs
node prototype/query-tool/revisions/quick-concept/check.mjs
node prototype/query-tool/capture.mjs --revision chatgpt-v1 --out /tmp/qt-cap/chatgpt-v1 --sites mellow,loop-earplugs --panels mellow
node prototype/query-tool/capture.mjs --revision entry --out /tmp/qt-cap/entry
```

Then read the screenshots and check:

1. **Entry page:** it lists ChatGPT - V1 with its summary and changes, and Open works for both sites.
2. **Brief on Mellow:** the outcome strip, the three findings and the improvement match C9 and C10. "What this can't assess" names the 6/7-day coverage.
3. **Brief on Loop Earplugs:** renders. It may show fewer than three findings, with the empty-state sentence. No errors.
4. **Paths:** event reach has no narrowing shape and no "abandon". The journey table shows the selection-basis sentence, with one expanded path.
5. **Explain:** the bridge reconciles with a $0 residual, and the mix/rate numbers match A.3.
6. **Drawer:** all five sections, an unsupported cut with its alternative, and a copied link that reopens the same drawer.
7. **History:** Brief → finding → drawer → Back closes the drawer → Back returns to the Brief with the same context.
8. **Reference tabs:** they look like Quick Concept, with the new labels, the funnel warning, the capped chip on `el-selectors` and no 70% note.
9. **Console:** no errors on any tab, for either site.

**Usability acceptance** (the proposal's first test, for the user to run later): a CRO finds and correctly explains Meta's traffic concentration and the content → product page decline in under a minute, without arithmetic and without changing populations by accident. Use the proposal's §10.4 script. Its task 2 answer key is now A.3.

Report to the user:

- what was built;
- the selftest and check results;
- any expected number that didn't match, and why;
- the screening outcome (Meta conversion not flagged, Campaign flagged), restated as an open question.

## Part E. Out of scope, and open questions

**Not in this concept:**

- strategy matching and the unblock queue (`related-actions`; proposal R09 needs N10);
- the question palette (R11);
- watchlists;
- the language-model parser;
- every `needsData` contract (N01–N13);
- any engine or snapshot change;
- trigger-chain recovery cohorts;
- slope charts and heat tables.

The Reference tabs keep the older views for everything else.

**Open, for the user** (don't block on these):

1. **Screening thresholds.** As configured, the 0.2-point absolute floor hides Meta's 13% conversion drop on 880K sessions, while Campaign's sale-week bounce passes. Options:
   - keep it as written, to test the proposal faithfully (the plan's default);
   - make the absolute floor relative to the base rate;
   - add a history test like Cursor V1's.
2. **Name.** Is "ChatGPT - V1" right, or should it name the model, like "Cursor - Opus 5.5 - V1"?
3. **Reference code.** Can you get the proposal's zip (`cro-query-next-iteration.zip`)? Its 1,000 bridge fixtures could be added to the selftest.
4. **Cursor V1 plan.** The finding in A.2 #1 also affects `query-tool-revisions.md`. Its movers list uses `step_cart`, `step_checkout` and `step_buy` as transition rates. Replace those with event-reach rates?
