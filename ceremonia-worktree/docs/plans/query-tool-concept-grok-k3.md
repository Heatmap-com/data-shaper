# Query tool: concept "Grok - K3" (answer-first home, context bar, drill everywhere)

**Date:** 15 October 2026
**Status:** plan. Nothing in it is built yet. It's written for a fresh context to carry out.
**Source:** `~/Downloads/GrokIdeas.md`, an external deep-dive of about 12,000 words, written from the handoff zip and its screenshots.
**Depends on:** Phase 1 of `docs/plans/query-tool-revisions.md`. That's already in place: `prototype/query-tool/index.html`, `revisions.json`, `revisions/quick-concept/` and `capture.mjs --revision`.
**Siblings** (independent; don't read their code):

- `revisions/cursor-opus-5-5-v1/`, being built from `query-tool-revisions.md` Phase 2;
- the planned `chatgpt-v1`, from `docs/plans/query-tool-concept-chatgpt-v1.md`.

**Name and folder.** The display name is `Grok - K3`, folder `revisions/grok-k3/`.

---

## Part A. Analysis of the proposal

### A.1 Verdict

**Grok's proposal is the most practical of the three.** It keeps the ten question-named tabs, which it rightly calls the tool's best idea, and improves them in place. On top of that it adds:

- a "This week" home;
- a "What moved?" tab;
- one context bar;
- one drill grammar.

Its standout contributions, which the other two lack:

- **Entity naming as the main blocker.** Campaign and creative IDs, CSS selectors and experiment-arm UUIDs make whole moments unanswerable.
- **Verdicts rebuilt as finding → so what → next move,** with a "what would unblock this" work queue that says who has to do the work.
- **Concrete fixes to existing views:**
  - square-root funnel bars;
  - shared scales on small multiples, capped at the top 3 lines;
  - a scatter chart for "which landing pages bleed";
  - one panel for the two page denominators;
  - "latest full week" as the default everywhere.
- **A plain-language noise rule** (the "wobble band") whose arithmetic is shown in the tooltip.

**Its numbers are wrong where it matters most.** Grok worked from screenshots and trusted the tool's partial-week flag. That flag catches the 3-day 7 Sep week, but not the 6-day 5 Oct week. So:

- **its worked triage example rests on a partial week** (A.2 #1);
- **its home screen would show "the site is OK"** for a week when sessions rose 27.6% and conversion fell;
- **its noise rule, run on whole weeks,** flags 22 of 38 candidates (A.3).

**Build it as its own concept,** with six corrections (A.4) that fix what's factually wrong, and three changes you decided on 15 October (A.6):

- each subject is judged against its own history;
- movers merge the same change seen in different breakdowns;
- the bands keep sale weeks.

Placeholder entity names are made up for the prototype (K9).

### A.2 Claims checked against the code and the Mellow snapshot

| # | Grok claim | Check | Result |
|---|---|---|---|
| 1 | Worked example: site sessions −0.4% is "within wobble"; search −21.5% and Meta +12.3% are "moved, correctly flagged" | Those figures are in `tag_trend` (search 147,837 → 115,989; Meta 584,596 → 656,331), but its 5 Oct week covers 6 days. **Whole weeks (`funnel`): sessions +27.6%, search −3.1%, Meta +47.0%** | **Wrong.** All three examples are artefacts of a partial week. Search didn't fall 21.5%; Meta's surge is four times bigger than shown |
| 2 | "The Sep 7 partial week is correctly flagged" (and, by implication, the rest are whole) | The 70%-of-median heuristic (`views.js` line ~92) catches 7 Sep (3 days), but misses 5 Oct (6 days) | **Half right.** See `6-ANALYSIS.md` §6.1 |
| 3 | `fn-sequence` opens on Sep 7 | Its `dim_week` picker has no default, so `resolvePickers` takes the first option | **Confirmed** |
| 4 | Selectors are almost all "(blank)" | `selector-weekly`: 29 of 1,106 selectors have a `name`, 25 have an `x_am_label` (all "Shop now / cta" style), 4 have a class | **Confirmed.** A label fallback names a few more; naming is still the blocker |
| 5 | Campaigns and creatives are raw IDs | `weekly_source_campaign.camp` and `meta_creative_period.utm_content` are IDs. No name column exists in any dataset | **Confirmed.** Names need a hand map (Grok's `entity_names`) |
| 6 | Experiment arms are UUIDs, and `xp-arms` opens on an A/A test | `experiment_rows.arm` is a UUID, with `is_control` per arm. "JC - Puff Pillow - Control vs Control - MutEx" has 71,325 sessions at 4.83% | **Confirmed.** Arm labels can be derived from `is_control` |
| 7 | Funnel steps are "did at any point", but the drawing implies order | `flows.mjs` counts per-visit flags. 424 of 1,841 `funnel` rows have more add-to-cart sessions than product views | **Confirmed, and understated.** Grok keeps the wells and only rescales them; the step ratios and "abandoned" labels are wrong, not just badly drawn |
| 8 | `pg-entry` and `pg-period` are the same table on two denominators | Entry sessions (`entry-by-channel`) against visits and entries (`page_period`) | **Confirmed** |
| 9 | Element revenue is correlational; the buyer split's order rate is "100% by construction" | Correlational: yes. The buyer split's order rate is orders ÷ sessions = 101.1%; its *buying-session* rate is 100% | **Mostly right.** The chip should say "buying rate is 100% by construction" |
| 10 | 59 requirements say "no dataset provides this requirement yet" | `requirements.json` has 59 missing of 99. The `detail` text varies, and O01 is `unknown_value` with "operator import required" | **Confirmed** (count) |
| 11 | Its home mockup ("Revenue $1.61M ▲0.4%", "volume −$8K · rate +$14K · mix −$6K") | Not in any dataset. The whole-week figure is $2.89M, +12.2% | **Illustrative only.** Don't use it as an answer key |
| 12 | `acq-cube`: meta_paid 57.0% of visits at 1.40% conversion | `weekly_entry_cube`, bundle visits, a different population | **Plausible.** Not checked further |

### A.3 Grok's rules, run on whole weeks (Mellow, `funnel`, 5 Oct against 28 Sep)

**The wobble band** = 2 × median |week-over-week change| over the whole weeks *before* the judged week (7 Sep → 28 Sep, so 3 changes). Percent for counts and money, points for rates.

| Measure | Prior changes | Band | Latest change | Badge |
|---|---|---|---|---|
| Sessions | −23.6%, +2.5%, +0.6% | ±5.0% | +27.6% | moved |
| Orders | −25.6%, +5.0%, −5.4% | ±10.8% | +14.2% | moved |
| **Revenue** | −22.8%, +8.5%, −6.3% | **±17.0%** | +12.2% | **within** |
| Order rate (orders ÷ sessions) | −0.05, +0.05, −0.13 points | ±0.11 points | −0.21 points | moved |

**Three behaviours follow, all faithful to Grok's spec:**

1. **Revenue reads as normal.** The Labor Day week inflates its band, so an answer line led by revenue says "OK". Grok's template picks "moved" over "ok" when any measure moved, so the line still says "Worth a look". But revenue's own clause says "within its usual wobble".
2. **Too much is flagged.** Each segment is judged against the *site's* band (Grok §6.2 rule c). The site's rate band is narrow, so **22 of 38 movers candidates are "moved"**: segments × sessions, order rate and revenue for traffic source, new/returning and device, plus the 5 journeys. Grok's own diagnostic (§10.1) says "everything moved = band too tight".
3. **The top five are one event counted three times.** Movers are ranked by |Δ| ÷ band × session share:

   | Rank | Mover | Change |
   |---|---|---|
   | 1 | Meta sessions | +47.0% |
   | 2 | New-visitor sessions | +32.3% |
   | 3 | Mobile sessions | +30.0% |
   | 4 | Mobile order rate | −0.22 points |
   | 5 | New-visitor order rate | −0.18 points |
   | 6 | Content → product page completion | −3.07 points |

   Content → product page completion lands sixth, just outside the limit of 5 (its journey band, pooled across paths, is ±1.08 points). Meta sessions, new sessions and mobile sessions are the same surge.

**Decomposition** (Grok Model E, per segment; Δrevenue = Σ Δsessions × average revenue per session + Σ average sessions × Δrevenue per session, using two-week averages):

| Traffic source | Volume | Rate | Total |
|---|---|---|---|
| meta | +$283K | −$115K | +$169K |
| campaign | −$34K | +$105K | +$71K |
| social | +$48K | +$11K | +$59K |
| search | −$26K | +$40K | +$15K |
| direct | −$11K | +$19K | +$8K |
| website | −$3K | −$4K | −$8K |
| **Sum** | **+$257,247** | **+$56,677** | **+$313,924** |

**The interaction ("mix") term is exactly $0.** With two-week averages, the volume and rate terms always sum to the whole, so Grok's mix column would always be empty. A meaningful mix needs overall growth separated from share shift (correction 4):

- **traffic growth** = Δsessions × the site's average revenue per session = **+$669,549**;
- **mix** = Σ segment volume − traffic growth = **−$412,302**;
- **rate** = **+$56,677**;
- total **+$313,924**, exact.

### A.4 Corrections built into this concept

| # | Grok's spec | Correction | Why |
|---|---|---|---|
| 1 | "latestFull" and partial weeks found by the current flag | Coverage from the manifest windows. `funnel`, `journeys` and `journey_summary` use `flows.window` (whole weeks). Bundle tables use `bundle.window`. `trend` and `tag_trend` use the bundle window, marked "inferred". `latestFull` = the latest week covered 7/7 | A.2 #1–2 |
| 2 | Home and movers read `ae_trend_row` all/all rows | Read `funnel` and `journey_summary`, which are whole weeks. `trend` holds pages, journeys and elements, not site totals, and its edge weeks are partial | A.2 #1 |
| 3 | The band uses "the full weeks in the window" | The band uses the whole weeks **before** the judged week. The judged week's own change mustn't widen its own band. "≥ 4 full weeks (3 changes)" stays | Grok's text is ambiguous |
| 4 | A "mix" column = the interaction term | Per-segment volume, rate and total (exact). Plus a summary line: traffic growth, mix and rate, defined above | A.3: the interaction is identically $0 |
| 5 | Keep the funnel wells, rescale them | Keep the wells and the square-root scale (Grok), **and** relabel the step ratios: "Completed" becomes "Count ratio", "Abandoned" becomes "Fewer sessions recorded this". Add the note "actions recorded anywhere in the session, not in order" | A.2 #7 |
| 6 | `entity_names` as a reference table | Same idea, as `names/<site>.json`, seeded with **made-up placeholder names** for every campaign, creative, selector and test arm (your decision, A.6). The file is the contract the future naming feature will write to. The tooltip marks each name as a placeholder | A.2 #4–6 |

### A.5 How this concept differs from its siblings

| | Cursor - Opus 5.5 - V1 | ChatGPT - V1 | **Grok - K3** |
|---|---|---|---|
| Existing tabs | Kept | Moved to Reference | **Kept and improved in place,** with cuts and merges |
| Home | Headline, 8 movers, decomposition | At most 3 findings | **One answer line, 5 movers, decomposition, verdict summary** |
| Extra tab | — | Explain | **What moved?** |
| Noise rule | Noise plus largest prior move | Floors plus Bonferroni z | **Wobble band, 2 × median prior change** |
| Funnel | Kept, with badges | Replaced by event reach | **Kept, square-root bars, honest labels** |
| Naming | URL and arm short forms | — | **Placeholder names for every entity, in the naming feature's file format** |
| Verdicts | Unchanged | Out of scope | **Finding / so what / next move, plus an unblock queue** |
| Drill | Links to panels | Evidence drawer | **Every number is a link, with breadcrumbs** |

### A.6 Your decisions (15 October 2026)

| # | Question | Decision | Effect on Mellow |
|---|---|---|---|
| 1 | Band scope | **Each subject against its own history** (`bandScope: "self"`, the default). `"site"` stays as a setting so Grok's original can be compared | Flagged movers fall from 22 of 38 to **15 of 38**. Site-level measures (the answer line) are unchanged: a site's own history *is* the site band |
| 2 | Merge duplicate movers | **Yes.** Rows with the same measure and the same direction, from *different* breakdown families (traffic source, new/returning, device), are one change. Keep the highest-scoring row and list the others under it as "Also seen in". Different segments within one family stay separate. Journeys are never merged | The top five become five distinct changes instead of one surge three times |
| 3 | Leave sale weeks out of bands | **No.** Bands use every prior whole week, including Labor Day | Revenue stays "within" (+12.2% against ±17.0%) |
| 4 | Entity names | **Make them up for the prototype.** They must be readable and logical. A new feature will let the user enter real names later | `names/<site>.json` is seeded in full (K9). No "unnamed" state in this concept |

**Own-history bands that matter on Mellow** (2 × median of the 3 prior whole-week changes):

| Subject | Measure | Band | 5 Oct change | Badge |
|---|---|---|---|---|
| Mobile | sessions | ±3.2% | +30.0% | moved |
| Meta | sessions | ±4.1% | +47.0% | moved |
| New visitors | order rate | ±0.05 points | −0.18 | moved |
| Mobile | revenue | ±13.2% | +13.7% | moved (just) |
| Campaign | order rate | ±0.94 points | +1.54 | moved |
| Search | order rate | ±0.63 points | +0.24 | within |
| Content → product page | completion | ±4.36 points | −3.07 | **within** |

The content → product page journey, sixth under the site band, drops out: its own week-to-week changes (−3.30, −2.18, +0.83) are large.

---

## Part B. Ground rules

These are the same as `query-tool-revisions.md` §2:

- Don't commit.
- No warehouse queries; don't rerun `snapshot.mjs` or `flows.mjs`.
- Don't edit `data/`.
- No `*.test.*` or `*.spec.*` names.
- Plain browser modules, no dependencies.

Also:

- **Fork from Quick Concept:** `cp -R prototype/query-tool/revisions/quick-concept prototype/query-tool/revisions/grok-k3`. Don't copy from the sibling revisions.
- **Other contexts are working in the same folder.** In `revisions.json`, add one entry. Don't rewrite or reorder the others. Don't edit `capture.mjs`, `serve.mjs`, `entry.*` or any other revision. If a shared file needs a change, stop and ask.
- **Every sentence the tool writes comes from a template filled with computed values.** No language model, and no `eval`. Condition names in `views.json` resolve to a fixed table of functions.

## Part C. Build

All expected numbers are Mellow, week of 5 October against 28 September, all visitors and all devices, unless stated. They were checked against `data/sites/mellow/` while writing this plan.

### Files

```text
revisions/grok-k3/
  index.html app.js views.js flows-views.js query.js styles.css views.json check.mjs   (forked)
  coverage.js     week coverage from manifest windows; latestFull (K1)
  context.js      context bar, inheritance, drill grammar, breadcrumbs (K2, K6)
  wobble.js       bands, badges, tooltip arithmetic (K3)
  derive.js       wobble_bands, wobble_check, movers_cache, mix_decomp (K3–K5)
  home-views.js   answerline, movers, decompose, verdictsummary (K4, K5)
  names.js        entity-name resolver (K9)
  names/seed.mjs     one-off generator of placeholder names (K9)
  names/mellow.json  names/loop-earplugs.json   placeholder names; the naming feature's contract (K9)
  verdict-views.js   finding/so-what/next-move cards, unblock queue (K11)
  log.js          local interaction log (K13)
  capture.json  selftest.mjs
```

### K0. Fork and register

1. Fork as above. Set the header tag to `Grok - K3`, and set `views.json` `"revision": "Grok - K3"`.
2. Insert at the top of the `revisions.json` `revisions` array, changing nothing else:

   ```json
   {
     "id": "grok-k3",
     "name": "Grok - K3",
     "date": "<finish date>",
     "status": "current",
     "basis": "GrokIdeas.md: answer-first home, global context bar, drill everywhere",
     "summary": "Keeps the ten question tabs and adds a 'This week' home and a 'What moved?' tab. Every change carries a wobble badge with its arithmetic, every number drills with the context, and campaigns, creatives, selectors and test arms carry readable placeholder names.",
     "changes": [
       "This week home: answer line, five movers, revenue split, verdict summary",
       "What moved? tab: movers by measure and by segmentation, with the split",
       "Context bar (week, compare, split, device) inherited by every panel; drill links with breadcrumbs",
       "Wobble band on every change figure, with the arithmetic in the tooltip",
       "Entity names, square-root funnel bars, comparable small multiples, landing-page scatter",
       "Verdicts as finding, so what, next move, plus a ranked unblock queue"
     ]
   }
   ```

### K1. Coverage and "latestFull" (corrections 1 and 2)

**`coverage.js`:**

- `weekCoverage(manifest, dataset)` returns `Map(week → { days, state })`.
- **Windows:**
  - `funnel`, `journeys`, `journey_summary` → `manifest.flows.window`;
  - other weekly datasets (those with a `week` or `dim_week` column) → `manifest.bundle.window`.
- **Days** = the dates of `[week, week + 6]` that fall inside the window.
- **State:**
  - `full` (7 days), or `partial` (fewer);
  - for `trend`, `tag_trend` and `experiment_rows`, add `inferred: true`, because their window isn't stored.
- `latestFull(manifest, dataset)` = the latest week with 7 days.

| Site | Bundle-window weeks (7 Sep / 14, 21, 28 Sep / 5 Oct) | Flow weeks |
|---|---|---|
| Mellow | 3 / 7 / 6 | all 7 |
| Loop Earplugs | 2 / 7 / 7 | all 7 |

**Use it everywhere:**

- Remove the 70%-of-median heuristic in `views.js` and `flows-views.js`.
- Partial weeks get Grok's existing orange asterisk, now labelled `6/7 days` with a tooltip. When `inferred` is true, the tooltip says so.
- Any change figure whose current or compare week is partial shows `—` for counts and money. Its wobble badge is "can't say: partial week".

**Global week.** The context week defaults to `latestFull('funnel')`, which is 5 Oct on both sites. A panel whose dataset only has that week partially shows it, flagged. **It never moves to another week on its own.** So Mellow's Health table shows 5 Oct as `6/7 days`.

**Fix `fn-sequence`:** it hides (K10), but its week default must also resolve to `latestFull`. Put `"default": "latestFull"` on every week picker, so no picker defaults to its first option.

### K2. Context bar (Grok Model C, §4.2)

**Bar:** `Site · Week · Compare with · Split · Device`, sticky under the header.

- **Week:** the weeks of `funnel`, with days shown; default `latestFull`.
- **Compare with:**
  - `Previous week` (the default);
  - `First full week`, which is `latestFull`'s earliest full week: 7 Sep for `funnel`, 14 Sep for bundle tables;
  - `Pick a week…`;
  - `None`.
- **Split:**
  - Traffic source (the default, per Grok's `contextBar.defaults`), New or returning, Buyer, Rager, None.
  - It's **one** segmentation, never crossed (trap #1).
  - When the split is `buyer`, rate columns that would show the buying rate show the chip "100% by construction". Order-rate cells keep their value, with "describes buyers, not performance" in the tooltip.
- **Device:** `All devices (total)`, Mobile, Desktop, Tablet. It's labelled "Device", never "Split by device".

**Hash:**

- Add `ctx={"week","compare","split","device"}`, compact JSON, alongside the existing `site`, `tab` and `s`.
- A copied URL reproduces the view.

**Inheritance:**

- Every panel inherits by default.
- A panel picker whose field maps to a context key is hidden and driven by context. Use `fieldMap`: device = `viewport_type`/`dim_device`/`dev_s`; split = `segment` (the family); week = `week`/`dim_week`.
- **Override:** the panel shows a small "override" link that reveals its picker. Once changed, it shows a chip: "This panel: split by returning ✕". Clearing the chip restores inheritance.
- **When a dataset can't honour a key,** the panel shows a chip, for example "Split doesn't apply to this table". **Never filter silently.**

**Compare in weekly tables:**

- Add the `compareColumns` from Grok §8.1: `prev` and `firstFull`.
- The context's comparison sets which Change column leads.
- Extend the flow views' existing week and compare controls (`flows-views.js` `weekControls`) to read context instead of local state.

### K3. Wobble band and badges (`wobble.js`, Grok §6.2, correction 3)

**`wobble_bands`** (derived), per measure:

- **Measures:** sessions, orders, revenue, order rate, and journey completion.
- **Source:**
  - the `funnel` site row (`segment = all`, `viewport_type` = context device, summed over entries);
  - for journey completion, the **pooled** prior changes of every general path in `journey_summary`.
- **Changes:** consecutive changes over the `full` weeks before the judged week. Percent for counts and money, points for rates.
- **Band** = `bandMult` (2) × the median of their absolute values.
- **Needs at least 3 changes;** otherwise the band is `null`.

**Badge:**

- `thin`: below the measure floor in either week (Grok's `measureFloors`: order rate 100 sessions, page rates 30 entry sessions, element rates 10 clicking sessions, chain rates 100 chains).
- `cantsay`: the band is null, or a week is partial.
- `moved`: |Δ| > band.
- Otherwise `within`.

`thin` and `moved` can both show (Grok: "a move can be both real and thin").

**Tooltip,** using Grok's wording pattern with real numbers: "Order rate usually moves about ±0.05 points a week on this site (median of 3 full-week changes); the band is twice that, ±0.11 points. This moved −0.21 points: outside the band."

**`bandScope`** in `views.json` `wobble`:

- `"self"` (**the default**, your decision 1): each subject's own prior changes. For a journey, that path's own completion changes.
- `"site"` (Grok's original): every segment is judged against the site band for that measure; journeys against the pooled band. Kept as a setting only.

**Sale weeks stay in the band** (your decision 3). Don't add an exclusion option.

**Where badges show:**

- every Change column on weekly tables;
- funnel step chips and mini-funnel delta chips;
- lane node deltas;
- movers rows;
- the answer line.

**Expected:**

- site bands (used by the answer line under either scope): sessions ±4.99%, orders ±10.76%, revenue ±17.01%, order rate ±0.108 points;
- with `"self"`: 15 of 38 movers candidates are `moved`, and the own-history bands are as in A.6;
- with `"site"`: 22 of 38 are `moved`, and the pooled journey band is ±1.080 points;
- on Mellow `health-weekly` (from `tag_trend`), every 5 Oct badge is `cantsay`, because the week is partial and only 3 full weeks remain (2 changes);
- on Loop Earplugs `health-weekly`, badges appear, because 4 full weeks give 3 changes.

### K4. "This week" home (Grok Model A, §8.1 `home`)

It's the first tab: id `home`, label `This week`, question "Is the site OK, and what moved?".

**`hm-answer`: view `answerline`.**

- **Data:** `wobble_check` (derived), the latest week per measure: value, change, band, badge, and the reason for any "can't say".
- **Templates,** the first whose condition holds:
  - **`moved`** (any measure moved): "Worth a look: {n} of {m} measures moved beyond their usual weekly wobble — {list}." Then the within measures: "{within_list} within its wobble."
  - **`ok`**: "The site is OK. {revenue clause} — inside its normal weekly wobble (±{band}%)."
  - **`cantsay`**: "Can't say yet: {reason}."
- **Footnote** (Grok's "what was checked"): "Checked sessions, orders, revenue and order rate for the week of {week} against {compare}, using whole weeks from the funnel data."
- **Every number** in the sentence links to the panel that shows it.

Expected sentence:

> Worth a look: 3 of 4 measures moved beyond their usual weekly wobble — sessions +27.6% (±5.0%), orders +14.2% (±10.8%), order rate −0.21 points (±0.11). Revenue +12.2% is within its wobble (±17.0%).

**`hm-movers`: view `movers`, limit 5.**

- **Data:** `movers_cache`, built once per snapshot and context:
  - segment values of traffic source and new/returning × sessions, order rate and revenue;
  - devices (mobile, desktop, tablet) × the same three measures;
  - general journeys × completion.
  - The buyer and rager families are excluded from movers.
- **Each row shows:**
  - a name, from valueLabels and K9;
  - the value;
  - the change, with its wobble badge;
  - n, printed inline;
  - a 5-week sparkline.
- **Rank** `moved` rows by |Δ| ÷ own band × current session share (for journeys, starts ÷ site sessions).
- **Merge** (your decision 2), walking the ranked list from the top:
  - a row joins an earlier kept row when it has the same measure and the same direction of change, comes from a different family, and that family isn't already under the kept row;
  - otherwise it's kept as a new row;
  - journeys never merge.

  A kept row shows its merged rows on a second line: "Also seen in: Meta +47.0%, New visitors +32.3%". Each one drills.
- **Clicking a row** drills (K6).
- **"Show all"** lists every candidate with its badge, unmerged.

Expected top five, after merging:

| # | Mover | Change (band) | Also seen in |
|---|---|---|---|
| 1 | Mobile sessions | +30.0% (±3.2%) | Meta +47.0%, New visitors +32.3% |
| 2 | New-visitor order rate | −0.18 points (±0.05) | Mobile −0.22, Meta −0.12 |
| 3 | Mobile revenue | +13.7% (±13.2%) | New visitors +16.8%, Meta +26.0% |
| 4 | Social revenue | +23.1% (±22.1%) | — |
| 5 | Campaign revenue | +21.3% (±12.8%) | — |

Sixth is campaign order rate +1.54 points (±0.94); website (4,433 sessions) fills 7–8. No journey qualifies.

**`hm-decomp`: view `decompose`** (correction 4).

- The split comes from context (default traffic source; device when split = None).
- **Columns:** volume, rate and total per segment, sorted by |total|.
- **Total row** ties to the site change (assert it in code; show "✓ sums to the site change").
- **Summary line above the table:** "Traffic growth +$669,549 · mix −$412,302 · rates +$56,677 = +$313,924."
- **Simpson footnote,** when mix and rate have opposite signs: "Most segments converted better, but traffic shifted toward lower-value segments."
- Expected values are in A.3. Clicking a row opens Health with the split set and the row highlighted.

**`hm-verdicts`: view `verdictsummary`.**

- One sentence from `strategy-triggers`: "On the analysed page ({url}): {n} rules triggered, {b} blocked, {s} silent. [Open Verdicts]". Mellow: 22 triggered, 7 blocked, 11 silent, 1 below floor.
- When nothing fired: "Nothing fired this week — {n} rules watched."

### K5. "What moved?" tab (Grok §4.1)

It's the second tab: id `change`, label `What moved?`, question "Where did the change come from?".

- **`ch-by-measure`:** four short movers lists side by side (sessions, orders, revenue, order rate), each the top 5 for that measure, using the same rows as `movers_cache`, merged as in K4.
- **`ch-by-split`:** one movers list per segmentation (traffic source, new/returning, device, buyer shown with its chip), each ranked within itself. These lists aren't merged, because each holds one family.
- **`ch-split`:** `hm-decomp` again, with its own split picker (an override chip when it differs from context), and a choice of outcome: revenue (default) or orders.
- **Annotations on the timeline:** the panel is present but empty: "No change log yet — add releases to names/<site>.json `changes` to mark them here." It renders marks if the file has entries. Seed it empty.

### K6. Drill everywhere, with breadcrumbs (Grok Model D)

The drill grammar is fixed. Declare it as `drill` per panel (Grok §8.1). It replaces `next`.

| Click on | Goes to | Carries |
|---|---|---|
| A segment value (a movers row, a decomposition row, a weekly-table row label, a mini-funnel card) | Journeys → `jr-flow`, with `segment` = the split and `segment_value` = the value set on that panel | context |
| A journey lane or a journey mover | Funnels → `fn-funnel` and `fn-segments`, with the same segment value | context, plus the segment value |
| A device mover | Funnels, device set | context |
| A "Volume, no orders" badge, or a campaign row | Acquisition → `acq-campaigns`, filtered to that source, sorted by visits | context |
| A selector row (elements), or a fired element rule | Elements → `el-selectors`, filtered to that selector | context |
| A triggered verdict card | the panel whose numbers fired it (mapping table in K11) | context |
| Any number in the answer line | the panel showing it | context |

**Mechanics:**

- Drills use `history.pushState`; control edits use `replaceState`; `popstate` restores the state.
- **A breadcrumb strip** under the context bar shows the last 5 drills ("This week › Meta sessions › Journeys (Meta) › Funnel"). Each crumb is a link.

### K7. Visual fixes to existing views (Grok §5.2)

1. **Funnel wells** (`fn-funnel`):
   - bar length = √(rate), so product views at 51.95% draw at 72% and bought at 1.76% at 13%;
   - keep the dashed ghost for the compare week;
   - a scale note: "bar lengths use a square-root scale so small rates stay visible";
   - relabel per correction 5.
2. **Mini funnels** (`fn-segments`):
   - the same square-root bars;
   - a delta chip with a wobble badge next to the bought rate;
   - a sort picker: Sessions (default) or Biggest move.
3. **Small multiples** (`jr-trend`, `fn-trend`):
   - a shared y-scale for one measure across every chart, plus a toggle "Zoom each chart (shapes only — don't compare heights)";
   - show the top 3 segments by volume plus "Other", with the rest a legend click away;
   - a **movers lead block** above the charts that replaces the footer sentence. It ranks segments by |Δ| × share, and each row drills;
   - an **index toggle**: each line ÷ its own median over full weeks, so 100 = typical.
   - The existing hollow below-floor points stay.
4. **Two new modes on `trendlines`** (`"mode": "lines" | "slope" | "heat"`):
   - **slope:** first full week → selected week, one line per segment;
   - **heat:** segments × weeks; cell = value; background = distance from the row's median; greyed text below the floor.
5. **Landing-page scatter** on `pg-landing` (K10):
   - x = order rate, y = single-pageview share, bubble area = entry sessions;
   - quadrant labels: "Bleeding: high bounce, low conversion" (top left), and so on;
   - the table stays below;
   - hovering a point shows the URL (path only) and its numbers.

Expected: the marshmellow-comforter landing page at about 992,589 entry sessions, 85.6% single-pageview, 1.21% order rate (Grok's figures; recompute and use the snapshot's).

### K8. Trap chips at the point of use (Grok §6.1)

- **Returning era break.** A vertical marker at 7 Sep on any trend or weekly table split by returning: "Returning means something different from 7 Sep — don't compare across this line."
- **Device total.** Column or header text reads `All devices (total)`.
- **Element revenue.** The column header is renamed to "Revenue of clicking sessions (not caused)" in `el-selectors` and `el-rage`.
- **Chains.** `rt-chains` gets a header sentence: "Closed 14-day windows only (final = 1). One browser is not one person." Add the money sentence, computed: "Abandoned-cart chains: {chains} chains, {return}% came back, {buy}% bought, {revenue} revenue." Grok quotes 197K, 47.0%, 10.6% and $2.88M; recompute.
- **Analysed page.** Every verdict sidebar header names the analysed page path (`manifest.bundle.analysedPage.path`).
- **Frozen lists.** `pg-top`, `jr-flow` and `el-trend` say "Top {n} only — chosen once by site-wide revenue; the long tail isn't here."
- **Partial compare week.** This comes from K1.
- **Plumbing.** The "Warehouse · 9,520 rows" source badge moves into an ⓘ hover on the panel title.

### K9. Entity names (`names.js`, correction 6)

**Your decision 4:** names are made up for the prototype. They must read as real names an operator would give, and be logical for what the item is. A later feature will let the user enter real names into the same file, so **`names/<site>.json` is that feature's contract.** Keep its shape simple and stable.

**File shape:**

```json
{
  "_note": "Prototype placeholder names. Real names will come from the naming feature.",
  "campaign": { "<campaign id>": { "name": "…", "placeholder": true } },
  "creative": { "<utm_content id>": { "name": "…", "campaign": "<campaign id or null>", "placeholder": true } },
  "selector": { "<selector_id>": { "name": "…", "placeholder": true } },
  "experiment_arm": { "<experiment_key>|<arm>": { "name": "…", "placeholder": true } },
  "page": {},
  "changes": []
}
```

**Seeding.** `names/seed.mjs` is a one-off Node script: it reads `data/sites/<slug>/` and writes `names/<slug>.json`. It's deterministic, so the same snapshot gives the same names, and it never touches `data/`. Run it for both sites, then hand-edit the top items (below). Commit nothing.

| Type | Count to name (Mellow / Loop) | Key source |
|---|---|---|
| Campaign | 370 / 957 | `weekly_source_campaign.camp` ∪ `campaign-weekly.x_utm_campaign` |
| Creative | 1,181 / 984 | `meta_creative_period.utm_content` ∪ `campaign-weekly.x_utm_content` |
| Selector | 1,106 / 1,106 | `selector-weekly.selector_id` |
| Test arm | 74 / 30 | `experiment_rows` `experiment_key|arm` |

**Naming rules.** Each type has a fixed vocabulary, chosen by rank or by a stable hash of the ID. Names must be unique within a type: on a clash, append ` 02`, ` 03`.

- **Product vocabulary, per site:** title-case the slugs of the site's top 8 product landing paths by entry sessions (`product_entry_period` / `entry-by-channel`), for example `marshmellow-comforter` → "Marshmellow Comforter". Mellow's experiment names also mention CloudAlign Pillow, Cooling Pillowcase and Puff Pillow.
- **Campaigns:** `{Platform} · {Goal} · {Product} · {Audience}`.
  - Platform from the source: facebook/fb/ig → Meta, google → Google, tiktok → TikTok, email sources → Email, SMS sources → SMS, anything else → the source in title case.
  - Rank campaigns by visits. Assign products in the same rank order, so the biggest campaigns sell the biggest products.
  - Goal (Prospecting, Retargeting, Sale, Evergreen) and Audience (Broad, Lookalike 1%, Interest: Sleep, Past purchasers, Site visitors 30d) come from the hash. Retargeting always pairs with Past purchasers or Site visitors 30d.
  - Email/SMS campaigns are `{Platform} · {Theme} · {Mon}`. The theme is one of Welcome series, Back in stock, Abandoned cart, New arrival, Sale, and the month comes from the campaign's first week.
  - Example: "Meta · Prospecting · Marshmellow Comforter · Broad".
- **Creatives:** `{Format} — {Angle}`.
  - Format: UGC video, Studio video, Static, Carousel.
  - Angle: a short product-specific line from a list per product, for example "Like sleeping on a cloud", "Cool all night", "30-night trial", "Side-sleeper approved".
  - The creative keeps its parent campaign id when `campaign-weekly` links them, and shows the campaign name as its sub-label.
- **Selectors:**
  1. If the row has a real `name`, or an `x_am_label` with `x_am_role`, use it and set `placeholder: false`. That covers 29 on Mellow.
  2. Otherwise build `{Region} — {Element}` from the selector text with a token dictionary:

     | Selector tokens | Name |
     |---|---|
     | `header`, `nav` | Region "Header" |
     | `footer` | Region "Footer" |
     | `main-media`, `swiper`, `gallery` | Region "Product gallery" |
     | `cart-drawer` | Region "Cart drawer" |
     | `menu-drawer` | Region "Mobile menu" |
     | `dialog`, `modal` | Region "Popup" |
     | `ocu-` | Region "Upsell popup" |
     | `alia` | Region "Quiz popup" |
     | `swiper-button-next` / `-prev` | Element "next arrow" / "previous arrow" |
     | `add-to-cart`, `AddToCart`, `product-form__submit` | Element "Add to cart button" |
     | `checkout` | Element "Checkout button" |
     | `variant`, `swatch` | Element "Variant picker" |
     | `quantity` | Element "Quantity picker" |
     | `accordion`, `details`, `summary` | Element "Accordion" |
     | `review`, `judgeme`, `yotpo`, `okendo` | Element "Reviews" |
     | `search` | Element "Search" |
     | `logo` | Element "Logo" |
     | `img`, `image` | Element "image" |

     With no match, use `{Region or "Page"} — element {n}`, numbered by clicks.
  3. **Then hand-write the top 60 selectors by clicks on each site.** Read each selector and its median click position (`m_median_x`, `m_median_y`, device) and write the name a person would use, for example "Product gallery — next arrow (mobile)" or "Upsell popup — product image". These are the selectors the Elements tab and the fired element rules show first.
- **Test arms:**
  1. When `is_control` is true: `Control — current`.
  2. Otherwise, by hand from the experiment name; there are only 74 and 30. For example:
     - "SB-061DM - Social Proof vs Value Props Messaging" (4 arms): Control — current, Social proof, Value props, Social proof + value props;
     - price elasticity tests: Control — current price, Price −10%, Price +10%, Price +20%;
     - "Checkout Timer: 10-Min vs Static Text": Control — current, 10-minute timer, Static text.
- **Pages:** no map entries. The URL path is already readable.

**`resolveName(type, key, row)`** returns `{ label, sub, source, placeholder }`.

- Order: the map, then for selectors the row's real name or label, then the type's ID short form as a last resort.
- After seeding, the last resort should never show. The selftest checks this.

**Display:**

- Names replace IDs everywhere: `acq-campaigns`, `acq-creatives`, `el-*`, the `vd-triggers` detail cells, the verdict cards, `xp-arms`, movers and drill crumbs.
- The tooltip shows "Placeholder name (prototype) · ID {id}". There's no on-screen tag, so screens read as they will with real names.
- The full selector stays in the tooltip for selectors.

**`xp-arms` default:** the most recent experiment (by `observed_start`) that has 2 or more arms and at least 1,000 assigned visits, whose name doesn't match `/control vs control|a\/a/i`. Keep the honest caveat.

### K10. Merges, cuts and hides (Grok §4.1)

- **`pg-landing`** replaces `pg-entry` and `pg-period`. Its denominator toggle reads "Entry sessions (visits that started here)" or "Visits that saw this page". Each choice renders the matching source table with one explanatory line, and the scatter (K7) sits above.
- **`fn-weekly`** gains `rows = entry` as an option and absorbs `fn-entry`.
- **Hidden** (`"hidden": true`):
  - `health-peak`, `acq-tags`, `acq-tag-selection`;
  - `el-exposure`, until naming covers it;
  - `fn-sequence`, until an ordered dataset exists;
  - `vd-req`, moved to debug.

  Each tab ends with a muted line, "Hidden in this concept: … [show]", that reveals them in place.
- **Demoted below the fold, in a "More cuts" disclosure:** `acq-country`, `pg-hv`, `pg-sisters`, `jr-cohorts`, `or-daily-mix`, `or-entry`.
- **Retitle `health-periods`** to "The month against the lead-in".

### K11. Verdicts as action (Grok Task 7)

**`vd-actions`** replaces the cards board as the first Verdicts panel. One card per **triggered** rule in `strategy-triggers`:

- **Finding:** the metric label, `m_value` against `m_threshold`, the floor result, and the week. Selectors in `m_detail` go through K9.
- **So what:** only the arithmetic the tool holds. For page rules, use the analysed page's entry sessions and revenue per entry session (from `entry-by-channel` / `page-segment-weekly`). For element rules, use the element's clicking sessions and their revenue (from `selector-weekly`). Every number links to its panel. **Causes are written as open questions,** never as claims.
- **Next move:**
  - the drill (K6) to the panel that holds the numbers, using a mapping table by `m_metric` family: scroll → `el-scroll`, clicks → `el-selectors`, rage → `el-rage`, entry/page → `pg-landing`, journey → `jr-flow`;
  - the list of strategy cards pointing at the same rule, from `cards.triggered_rules`.

**Ordering:**

- Sort triggered cards by attached revenue (the so-what dollar value). When several are equal (one page), sort by strategy id.
- `below_floor` and `blocked` collapse into two queues below.
- Sidebars on the tabs become one sentence ("7 rules watched, 3 triggered — open"). The Returning tab gets one too: "No rules read this tab's numbers yet."

**`vd-unblock`:** one row per requirement key that appears in `cards.missing`, ranked by how many cards list it.

- **Columns:** key and title (shortened), cards unblocked, status (missing or unknown value), and who can supply it, from the requirement's `domain`:

  | `domain` | Who can supply it |
  |---|---|
  | `operator` | You (operator form) |
  | `tracker` | Tracking change |
  | `commerce` | Store connector |
  | `vendor` | App/vendor connector |
  | `ads_external` | Ad platform connector |
  | `heatmap` | Heatmap capture |
  | `render` | Page render capture |

- **A naming row on top:** "Confirm names — {c} campaigns, {k} creatives, {s} selectors and {a} test arms carry placeholder names", counted from `placeholder: true` in K9. It points at where the naming feature will sit; in this prototype it links to the Elements tab.
- Expected top blockers on Mellow (from cards): O01 33, V01 32, O02 28, O04 22, T01 21, T15 21.

`vd-triggers` stays, with names applied. `vd-req-summary` stays as a small footer table.

### K12. Label hygiene

- `returning` and `new` both use valueLabels (`Returning`, `New`).
- The or-hist `null` bucket becomes `(no value)`.
- One measure order in every picker: sessions, orders, revenue, order rate, revenue per session, average order. Then the others.
- **Apply the measure relabels Grok's terms rely on:**
  - `cvr` → "Order rate (orders ÷ sessions)";
  - `session_conversion` → "Sessions that bought";
  - `step_cart`, `step_checkout`, `step_buy` → "… count ratio", with help text saying they're not continuation rates (correction 5).

### K13. Local instrumentation (Grok §10.1)

- `log.js` appends `{ t, type, tab, ctx, detail }` to `localStorage` `qt:grok-k3:log`. Types: `load`, `ctx_change`, `override`, `drill`, `movers_click`, `answer_rendered`, `badge_counts`, `unblock_open`.
- `badge_counts` records the moved, within, thin and can't-say counts per render. That's Grok's band-tightness diagnostic.
- With `?facilitator=1`, a small panel shows Start/Stop task, a task number, and "Download log".
- Never log free text.

### K14. `check.mjs` and `selftest.mjs`

**`check.mjs`:**

- knows the new view types (`answerline`, `movers`, `decompose`, `verdictsummary`) and the derived datasets;
- validates `drill` targets (the tab and panel exist), `hidden` panels, `measureFloors`, `wobble`, `compareColumns`, and every week picker having `default: "latestFull"`;
- checks that `names/<site>.json` parses and has the six keys.

**`selftest.mjs`** (run with `node`; it skips data-backed checks when `data/sites/mellow` is missing):

- **coverage:** the K1 table for both sites; `latestFull('funnel')` = 5 Oct; `latestFull('tag_trend')` = 28 Sep for Mellow and 5 Oct for Loop;
- **bands and badges:** the A.3 site table and the A.6 own-history table. 15 of 38 candidates moved with `bandScope: "self"`, 22 of 38 with `"site"`. Mellow `health-weekly` 5 Oct is `cantsay`;
- **movers merge:** the K4 merged top five in order, with their "Also seen in" lists; no journey in the top eight;
- **answer line:** exactly the expected sentence;
- **movers:** the expected top five in order, and content → product page sixth;
- **decomposition:** the per-segment table within $1K, the sums within $1, interaction = 0, and growth, mix and rate within $1;
- **names:**
  - every campaign, creative, selector and arm key in the data resolves to a name from the map or the data, never the ID fallback;
  - names are unique within a type per site;
  - no name contains a run of 8 or more digits, `nth-child`, `#` or `>`;
  - Mellow's 29 real selector names come through with `placeholder: false`;
  - the 4 arms of "SB-061DM - Social Proof vs Value Props Messaging" have 4 distinct names, one starting "Control";
  - running `seed.mjs` twice gives identical files;
- **unblock:** the top six keys and counts above;
- **funnel:** square-root lengths for 51.95% and 1.76%; the word "Abandoned" doesn't appear in the rendered labels.

### K15. `capture.json`

The variants:

- Home, default;
- Home with split = New or returning;
- What moved?;
- Health on Mellow (showing 6/7 days and can't-say badges);
- Health on Loop (badges);
- Funnels with square-root wells;
- `jr-trend` in heat mode;
- `jr-trend` with the index toggle;
- Pages scatter;
- Verdicts actions plus unblock;
- `xp-arms` (named arms);
- a breadcrumb trail after three drills, using a `before` script that clicks through them.

---

## Part D. Verification

With `node prototype/query-tool/serve.mjs --port 8765` running:

```bash
node prototype/query-tool/revisions/grok-k3/check.mjs
node prototype/query-tool/revisions/grok-k3/selftest.mjs
node prototype/query-tool/capture.mjs --revision grok-k3 --out /tmp/qt-cap/grok-k3 --sites mellow,loop-earplugs --panels mellow
node prototype/query-tool/capture.mjs --revision entry --out /tmp/qt-cap/entry
```

Then read the screenshots and check:

1. **Entry page:** it shows the Grok - K3 card alongside the others, and Open works for both sites.
2. **Home on Mellow:** the answer line, movers and decomposition match K4 exactly.
3. **Home on Loop:** renders with no errors. Its badges reflect its own bands.
4. **Drill:** clicking "Meta +47.0%" (under "Also seen in" on the top mover) opens Journeys for Meta with the context intact. Back returns to Home, and the breadcrumbs show the path.
5. **Health on Mellow:** 5 Oct reads "6/7 days (inferred)", its badges say "can't say", and the tooltip explains why.
6. **Funnels:** square-root wells, no "Abandoned", and the any-point note.
7. **Names:** no raw ID or selector path is visible on any tab. Campaign, creative, selector and arm names read naturally and fit the item (a gallery arrow is called a gallery arrow). `xp-arms` opens on a non-A/A experiment with named arms. Hovering a name shows "Placeholder name (prototype)" and the ID.
8. **Verdicts:** the action cards, the unblock queue with owners, and the "Confirm names" row first.
9. **Console:** no errors on any tab, for either site.

Report to the user:

- what was built;
- the check and selftest results;
- any expected number that didn't match, and why;
- the observed counts behind the A.6 decisions: moved candidates under `"self"` and `"site"`, and how many rows the merge folded;
- ten sample names of each type, so the user can judge whether they read naturally.

**Usability.** Grok's §10.2 script is the test. Replace its task 2 premise ("revenue is basically flat, −0.4% sessions"), because that premise is the partial-week artefact. Use: "Sessions rose 27.6% but revenue only 12.2%. Find out why." Answer key: the shift to Meta (+47% sessions at $0.93 a session). The decomposition shows mix −$412K against rates +$57K.

## Part E. Out of scope, and open questions

**Not in this concept** (Grok's Slice 3 and needs-data items):

- meeting mode;
- the question index;
- the pinned watchlist;
- a real change-log pipeline (the JSON hook exists);
- `weekly_baseline_13w`, `page_weekly_full`, `step_transition_weekly`, `ad_spend_daily` and `landing_page_class`;
- the tap-geometry panel;
- any language-model feature;
- any engine or snapshot change.

**Settled** on 15 October (A.6): bands use each subject's own history; movers merge the same change across breakdowns; sale weeks stay in the bands; names are placeholders for the prototype.

**Still open** (don't block on these):

1. **The naming feature's file.** When it's built, does it write `names/<site>.json` in the K9 shape, or a warehouse table the snapshot exports? This concept assumes the file.
2. **Revenue reads as "within" on a +12.2% week** because the Labor Day week widens its band (your decision 3 keeps it). Watch whether testers trust the answer line's revenue clause.
