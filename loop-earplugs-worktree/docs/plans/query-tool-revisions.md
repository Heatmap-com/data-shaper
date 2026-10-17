# Query tool: a revisions entry page, and revision "Cursor - Opus 5.5 - V1"

**Date:** 15 October 2026
**Status:** plan. Nothing in it is built yet. It is written for a fresh context to carry out from start to finish.
**Reads with:**

- `~/Work/analysis/query-tool/6-ANALYSIS.md`: the analysis this revision implements. Read the executive summary, then §6.1, §6.2, §8.1, §8.2 and §9 (Slice 1).
- `docs/plans/query-tool-information-hierarchy.md`: the hierarchy behind the first revision.
- `prototype/query-tool/`: the prototype as it stands. All of it is untracked.

## 1. What to build

There are two deliverables.

1. **An entry page** at the prototype's root URL that lists every revision of the experience, with a link to open each one. More revisions will follow, so adding one must mean adding a folder and one JSON entry.
2. **Two revisions behind it:**

   | Name shown | Folder id | What it is |
   |---|---|---|
   | Quick Concept | `quick-concept` | The prototype exactly as it is today: 10 question tabs, 48 panels. It is frozen. |
   | Cursor - Opus 5.5 - V1 | `cursor-opus-5-5-v1` | A copy of Quick Concept with Slice 1 of the analysis built in: the brief home tab, the context bar, whole-week coverage, the noise rule and the revenue decomposition. |

Write the display names exactly as above, including the spaces and hyphens in "Cursor - Opus 5.5 - V1".

## 2. Ground rules

- **Do not commit.** The user commits.
- **No warehouse access is needed.** Everything here runs on the snapshot already in `prototype/query-tool/data/`. Do not rerun `snapshot.mjs` or `flows.mjs`. If you think you need to, stop and ask.
- **Quick Concept is frozen.** Once it's moved, change only what the move forces: data paths, the header's revision tag and the "All revisions" link. Any improvement goes into a revision, never into Quick Concept.
- **Revisions are copies, not shared code.** Each revision folder holds its own `app.js`, `views.js`, `flows-views.js`, `query.js`, `styles.css`, `views.json` and `check.mjs`. The duplication is deliberate: a later revision must never change how an earlier one looks.
- **Only data and tooling are shared:** `data/`, `serve.mjs`, `snapshot.mjs`, `flows.mjs` and `capture.mjs` stay at the prototype root.
- **No `*.test.*` or `*.spec.*` file names** inside the prototype, because the repo's `vitest run` would pick them up. Name self-tests `selftest.mjs` and run them with plain `node`.
- **Plain browser JavaScript modules, no build step and no dependencies,** as today.
- **Match the existing code style:** small functions, the `h()` and `s()` DOM helpers from `views.js`, and few comments.

## 3. The prototype today

```text
prototype/query-tool/
  index.html  app.js  views.js  flows-views.js  query.js  styles.css  views.json   ← the app
  check.mjs      validates views.json against every snapshot
  capture.mjs    headless-Chrome screenshots (tabs, panel crops, variants)
  serve.mjs      static server; "/" → index.html; 404s for directories
  snapshot.mjs   writes data/ from the warehouse and the bundle (do not run)
  flows.mjs      adds the journeys and funnel datasets (do not run)
  data/sites.json
  data/sites/<slug>/manifest.json + one JSON file per dataset (mellow, loop-earplugs; 24 MB)
```

- **Run it:** `node prototype/query-tool/serve.mjs --port 8765`, then open `http://127.0.0.1:8765/`.
- **App state** is in the hash: `#site=mellow&tab=funnels&s={"fn-funnel":{"pickers":{...},"week":"...","compare":"..."}}`.
- **The data path is relative to the page.** `app.js` fetches `data/sites.json`, `data/sites/<slug>/manifest.json` and `data/sites/<slug>/<file>`. `check.mjs` reads `join(here, 'data', …)` and `join(here, 'views.json')`.
- **`capture.mjs`** reads `views.json` from its own folder and loads `${base}/?r=…${hash}`. Its variant shots (lines 123–130) are specific to Quick Concept.
- **Reference screenshots** of Quick Concept are in `~/Work/analysis/query-tool/2-screenshots/` (`mellow/` and `loop-earplugs/`). Use them for regression checks.

**Manifest facts this plan relies on** (`data/sites/<slug>/manifest.json`):

| Key | Mellow | Loop Earplugs | Meaning |
|---|---|---|---|
| `flows.window` | 2026-09-07 to 2026-10-11 | 2026-09-07 to 2026-10-11 | Whole Monday–Sunday weeks. Covers the `funnel` and `journeys` datasets. |
| `bundle.window` | 2026-09-11 to 2026-10-10 | 2026-09-12 to 2026-10-11 | The 30-day window. Every other weekly dataset was written on it. |
| `flows.segmentations` | traffic_source, returning, buyer, rager | same | Segment families in `funnel` and `journeys` |
| `datasets.<name>.columns` | | | A weekly dataset has a `week` or `dim_week` column |

The stored trend tables (`ae_trend_row`, `ae_session_tag_trend`) have no window column. That `trend` and `tag_trend` follow `bundle.window` is inferred: from the write time, the weekly totals, and the 6-day last week (analysis §6.1). The coverage code makes that assumption explicit and sanity-checks it (W1).

**The `funnel` dataset** (`funnel.json`, 1,841 rows for Mellow):

- **Columns:** `entry, viewport_type, segment, segment_value, week, sessions, product_viewed, added_to_cart, checkout_started, buyers, orders, revenue`.
- **Entry:** one of `home, content, pdp, plp, cart, search, other, (no page view)`. There is no `all` row. Site totals are the sum over entries, and every session has exactly one entry.
- **Viewport:** `all, mobile, desktop, tablet`.
- **Segment:** `all` (value `all`), or one of the four families, each with its values (traffic_source: meta, website, search, direct, campaign, social).

## 4. Target layout

```text
prototype/query-tool/
  index.html            NEW   entry page (revision list)
  entry.js              NEW   renders revisions.json + data/sites.json
  entry.css             NEW
  revisions.json        NEW   the revision registry
  serve.mjs             EDIT  directory index + trailing-slash redirect
  capture.mjs           EDIT  --revision <id>; variants read from the revision's capture.json
  snapshot.mjs  flows.mjs  data/      unchanged
  revisions/
    quick-concept/
      index.html app.js views.js flows-views.js query.js styles.css views.json check.mjs   MOVED (path edits only)
      capture.json      NEW   today's six variant shots, moved out of capture.mjs
    cursor-opus-5-5-v1/
      (a copy of quick-concept, then the V1 work items)
      coverage.js  noise.js  context.js  brief-views.js  selftest.mjs   NEW
```

## 5. Phase 1: the entry page and the Quick Concept move

### 5.1 `revisions.json`

```json
{
  "title": "CRO query tool",
  "intro": "Each revision is a separate take on the same snapshot data. Older revisions are kept unchanged, so they can be compared.",
  "revisions": [
    {
      "id": "cursor-opus-5-5-v1",
      "name": "Cursor - Opus 5.5 - V1",
      "date": "2026-10-16",
      "status": "current",
      "basis": "6-ANALYSIS.md, Slice 1: Brief, Explain, Drill",
      "summary": "Opens on a weekly brief: whole-week headline numbers, ranked movements labelled for noise, and why revenue changed. One context bar sets week, comparison, segment and device for every panel.",
      "changes": [
        "Brief home tab: headline, ranked movers, revenue decomposition",
        "Context bar: week, compare, segment and device, inherited by panels",
        "Whole-week coverage: partial weeks marked 6/7 days and kept out of changes",
        "Noise labels on every change: unusual, sliding or climbing, normal, too thin",
        "Shorter labels for experiment arms and URLs"
      ]
    },
    {
      "id": "quick-concept",
      "name": "Quick Concept",
      "date": "2026-10-15",
      "status": "frozen",
      "basis": "query-tool-information-hierarchy.md",
      "summary": "The first prototype: ten question tabs and 48 panels over nine data shapes, with portal-style journeys and funnels.",
      "changes": []
    }
  ]
}
```

- The order in the file is the display order: newest first.
- `path` is always `revisions/<id>/`. Don't store it.
- Set the V1 `date` to the day it is finished.

### 5.2 Entry page (`index.html`, `entry.js`, `entry.css`)

- **Header:** the title, the intro, and a site picker built from `data/sites.json` (Mellow, Loop Earplugs). The picker sets `#site=<slug>` on every "Open" link, so a reader can compare revisions on the same site.
- **One card per revision:**
  - the name, the date, and a status pill (current or frozen);
  - the summary;
  - the `changes` list, if not empty;
  - "Based on: …";
  - an **Open** button linking to `revisions/<id>/#site=<slug>`.
- **A footer line** with the snapshot time of each site, from `data/sites.json` `generatedAt`.
- **Keep old deep links working.** If the entry page is opened with a hash containing `tab=` (an old prototype link, as in the handoff docs), replace the location with `revisions/quick-concept/` plus the same hash.
- **Style:** reuse the colours and type scale from `styles.css` by copying the few variables needed into `entry.css`. The entry page must not import a revision's stylesheet.

### 5.3 `serve.mjs`

- A request for a directory serves its `index.html`.
- A directory path without a trailing slash (`/revisions/quick-concept`) answers with `301` to the same path plus `/`. Relative fetches such as `../../data/…` depend on the slash.
- Keep the root-escape guard as it is.

### 5.4 Move Quick Concept

1. `mkdir -p prototype/query-tool/revisions/quick-concept`. Move `index.html, app.js, views.js, flows-views.js, query.js, styles.css, views.json, check.mjs` into it. The files are untracked, so use `mv`, not `git mv`.
2. **`app.js`:** add `const DATA = '../../data';` and use it in the three fetches: `sites.json`, `manifest.json` and the dataset file. Also use it in the "No snapshots yet" message, which should name the root-relative path.
3. **`check.mjs`:**
   - `const data = join(here, '..', '..', 'data');` and use it for `sites.json` and each manifest;
   - `views.json` stays `join(here, 'views.json')`.
4. **`index.html` header:**
   - replace `<span class="tag">Prototype</span>` with `<span class="tag">Quick Concept</span>`;
   - add `<a class="revisions-link" href="../../">All revisions</a>`, with one small CSS rule in this revision's `styles.css`.
   - Nothing else changes.
5. **Move the variants:** take the six variant shots from `capture.mjs` (journeys page-specific, Meta segment, trend by revenue per session, mobile product-page funnel, split by returning, definitions drawer) into `revisions/quick-concept/capture.json`:

   ```json
   { "lead": "mellow", "variants": [ { "name": "variant-journeys-page-specific", "tab": "journeys", "state": { "jr-flow": { "pickers": { "kind": "page" } } }, "what": "Top journeys, page-specific (URL) journeys" } ] }
   ```

   This is one example entry. A variant may also have `before` (JavaScript run before the shot), `viewportOnly`, and `params` (extra hash parameters, used by V1's context).

### 5.5 `capture.mjs`

- New required flag `--revision <id>`. It reads `revisions/<id>/views.json` and the optional `revisions/<id>/capture.json`. Shot URLs become `${base}/revisions/<id>/?r=…${hash}`.
- `--revision entry` shoots just the entry page, full height, as `entry.png`.
- Output goes to `<out>/<site>/…`, as today. The caller picks `--out` per revision.
- `hashFor(site, tab, state, params)` adds `params`, such as V1's context keys, to the hash.

### 5.6 Phase 1 done when

- `http://127.0.0.1:8765/` shows the entry page with two cards, and the site picker changes the Open links.
- Both Open links load, and `http://127.0.0.1:8765/revisions/quick-concept` (no slash) redirects and loads.
- An old link, `http://127.0.0.1:8765/#site=mellow&tab=funnels`, lands on Quick Concept's Funnels tab.
- `node prototype/query-tool/revisions/quick-concept/check.mjs` prints `views.json matches every snapshot`.
- **Capture matches the reference.** Run `node prototype/query-tool/capture.mjs --revision quick-concept --out /tmp/qt-cap/quick-concept --sites mellow`. Its tab screenshots match `~/Work/analysis/query-tool/2-screenshots/mellow/` apart from the header tag and link. Check a few side by side, by viewing them.

## 6. Phase 2: revision "Cursor - Opus 5.5 - V1"

Start with `cp -R revisions/quick-concept revisions/cursor-opus-5-5-v1`. Then:

- set the header tag to `Cursor - Opus 5.5 - V1`;
- add `"revision": "Cursor - Opus 5.5 - V1"` to `views.json`, and use it for `document.title` (`<title> · <revision>`);
- add the card in `revisions.json` (the text in §5.1).

Then do the work items in order. Each ends in a state you can check in the browser.

All expected numbers below are Mellow, week of 5 October against 28 September, all visitors and all devices, unless stated. They come from `funnel.json` and `journeys.json`, and were checked while writing this plan.

### W1. Week coverage (`coverage.js`)

**Why:** the Health, Acquisition, Pages and Elements tabs read weekly rows written on the 30-day window, 11 Sep–10 Oct for Mellow. Their 7 Sep week has 3 days and their 5 Oct week has 6. Quick Concept's "under 70% of the median week" check catches the first and misses the second. So Health shows sessions −0.4% for a week that was +27.6% (analysis §6.1).

**Build:**

- **`weekCoverage(manifest, dataset)`** returns a `Map(week → days)`, or `null` for a dataset with no `week` or `dim_week` column.
  - **Window:** `funnel`, `journeys` and the derived `journey_summary` use `manifest.flows.window`. Every other weekly dataset uses `manifest.bundle.window` (fields `start` and `end`, both inclusive).
  - **Days** = the number of dates in `[week, week + 6]` that fall inside the window.
  - Keep the rule in one table at the top of the file:

    ```js
    const WHOLE_WEEK = new Set(['funnel', 'journeys', 'journey_summary']);
    ```

- **`coverageCheck(manifest, rowsOf)`** tests the assumption. For each week, it compares the `tag_trend` sessions (filter `tag_key = utm_source`, `segment = all`, `viewport_type = all`; if the `all` segment isn't there, sum the `traffic_source` values) with the `funnel` site total for the same week.
  - **Expect a ratio of 0.97–1.03 for weeks covered 7/7.** Mellow: 14 Sep 0.999, 21 Sep 0.999, 28 Sep 0.998.
  - **Expect below 0.95 for partial weeks.** Mellow: 7 Sep 0.326, 5 Oct 0.779. The ratio isn't days/7, because traffic isn't spread evenly; Labor Day front-loaded the 7 Sep week.
  - It returns `{ ok, weeks: [{ week, days, ratio }] }`. The data health line (W4) shows a warning if `ok` is false.
- **Expose it on `ctx`** (built in `renderPanel`) as `ctx.coverage` (the map for the panel's dataset) and `ctx.isWhole(week)`.

**Use it in every weekly view.** Replace the median heuristic in:

- `views.js` `weekly()` (lines ~91–96 and the note at ~127);
- `flows-views.js` `partialWeeks()` (line ~29) and its callers.

**The rules:**

- A week header for a partial week reads `5 Oct · 6/7 days`, with class `partial` and a tooltip: "This table's data covers 6 of the 7 days of this week. Compare its rates, not its totals."
- In the **Change** column and in any delta badge, a **sum measure** (sessions, revenue, orders, clicks…) shows `–` when either week is partial, with the same tooltip. A **ratio measure** still shows its change, with the partial marker.
- The panel note becomes "Weeks marked n/7 days are partial: …". The 70% note goes away.

**Expected after W1:**

| Site | Dataset | 7 Sep | 14, 21, 28 Sep | 5 Oct |
|---|---|---|---|---|
| Mellow | `tag_trend`, `trend`, `selector-weekly` … | 3/7 | 7/7 | 6/7 |
| Mellow | `funnel`, `journeys` | 7/7 | 7/7 | 7/7 |
| Loop Earplugs | bundle-window datasets | 2/7 | 7/7 | 7/7 |

On Health, Weekly snapshot, the 5 Oct sessions change shows `–`, not `−0.4%`.

### W2. Context bar (`context.js`)

**Why:** each of the 48 panels has its own pickers (77 in all), and device is spelt three ways (`viewport_type`, `dim_device`, `dev_s`). Context should be set once (analysis §4 and §8.1, model C).

**Markup:** a second row in the header, under the Site and Question pickers.

- **Week:**
  - options are the weeks of `funnel`;
  - default is the latest week that is 7/7 in `funnel` (Mellow: 5 Oct);
  - the label shows the days, for example `5 Oct (7/7 days)`.
- **Compare with:** `Previous week` (default), `4-week average`, `First week`, `No comparison`.
  - "4-week average" is the up to 4 weeks before the selected week. Use the mean for sum measures, and the ratio of the sums for ratio measures.
- **Segment:** first a family picker (`All visitors`, `Traffic source`, `New or returning`, `Buyer`, `Rager`, built from `manifest.flows.segmentations`).
  - When a family is picked, a value picker appears. Its first option is "Every value (split)", followed by the values.
- **Device:** `All devices`, `Mobile`, `Desktop`, `Tablet`.

**State:**

- Flat hash keys: `wk`, `cmp` (`prev|avg4|first|none`), `seg`, `segv`, `dev`.
- Panel state stays in `s`.
- Changing context re-renders every panel on the tab and keeps the tab.
- Changing site keeps the context, apart from the week, which resets to that site's default.

**`views.json`:** add the top-level `context` block from analysis §8.1. `fieldMap` maps each context field to the column names panels use:

```json
"fieldMap": {
  "segment": ["segment"], "segment_value": ["segment_value"],
  "device": ["viewport_type", "dim_device", "dev_s"], "week": ["week", "dim_week"]
}
```

**Panel `inherit`.** A panel without `inherit` behaves exactly as in Quick Concept. With it:

| Key | Values | Behaviour |
|---|---|---|
| `device` | `true` | The panel's picker whose field is in `fieldMap.device` is hidden, and its value comes from context. |
| `segment` | `"filter"` | The `segment` and `segment_value` pickers are hidden and set from context. `All visitors` means `segment=all, segment_value=all`. A family with "Every value (split)" means the family's rows are all kept. |
| `segment` | `"series"` or `"rows"` | Context sets the family that the panel splits by. `All visitors` falls back to the panel's own default family. A chosen value is highlighted (class `ctx-highlight`) rather than filtered. |
| `week` | `true` | The panel's `state.week` and `state.compare` come from context (the funnel and journey views already read these). Weekly tables highlight the selected week's column, and their Change column compares against the context comparison. |

- When a panel can't honour a context field, because its dataset lacks the column or the value, it shows a chip under its header: "This table can't split by rager; showing all visitors." Never ignore context silently.
- **Apply `inherit` to:**
  - every Brief panel (W4);
  - Journeys: `jr-flow`, `jr-trend`, `jr-weekly` (not `jr-cohorts`);
  - Funnels: `fn-funnel`, `fn-segments`, `fn-trend`, `fn-weekly`, `fn-entry` (not `fn-sequence`, a bundle table);
  - Health: `health-weekly` (`segment: "rows"`, `device: true`, `week: true`).
- Leave the other panels on their own pickers for V1.

**Expected after W2:** the context set to Traffic source → Meta, Mobile carries over when you switch between Brief, Journeys and Funnels. `fn-funnel` then shows the Meta mobile funnel, and `fn-segments` highlights the Meta card. Reloading the URL restores the same state.

### W3. Noise rule (`noise.js`) and badges

**Why:** at Mellow's scale almost every change passes a sampling test. The rule from analysis §6.2 adds "bigger than anything in recent weeks", and that is what separates news from noise.

**API:**

```js
// points: [{ week, num, den, days }] for a rate, or [{ week, value, days }] for a count or money value.
// i: index of the week being judged. kind: 'rate' | 'count' | 'money'.
classify(points, i, { kind, floor = { den: 100, num: 10 }, sigma = 2 })
// → { label, delta, noise, maxPriorMove, reason }
```

**Labels**, in order of precedence:

1. **`partial`:** week `i` or `i − 1` is not 7/7. There's no judgement.
2. **`thin`:**
   - for a rate: `den < floor.den` in either week, or `num < floor.num` in both weeks (orders or buyers);
   - for a count: the value is below 100 in either week.
3. **`unusual`:** the change is bigger than history and, for rates, bigger than noise.
   - **(a) noise**, rates only: `|Δ| > sigma × √(se₁² + se₀²)`, where `se = √(p(1 − p) / den)`. Money values skip (a) and are marked "directional" in the reason.
   - **(b) history:** `|Δ|` is greater than the largest absolute week-to-week move between whole weeks before `i`. It needs at least 2 prior moves. Otherwise the rule can't call it unusual.
4. **`slide` / `climb`:** the value at `i` is the lowest (or highest) of all whole weeks up to `i`, and at least 3 of the last 4 moves went the same way. That needs at least 4 moves.
5. **`normal`:** anything else.

**Details:**

- **Labels are always judged against the previous week,** whatever the context comparison. When the comparison isn't "Previous week", the badge's tooltip says "Label is against the previous week."
- **The `reason` is a full sentence with numbers.** Example: "Down 0.12 points. Noise is about ±0.03 points, and the largest move in the 3 weeks before was 0.06 points."
- **Badge component** `noiseBadge(result)`, a small pill with a tooltip:
  - Unusual: filled red-orange;
  - Sliding or Climbing: amber;
  - Normal: hollow grey;
  - Too thin: a grey dash;
  - Partial: striped.

**Where badges go in V1:**

- `fn-funnel`: each step's change;
- `fn-segments`: each card's end-to-end conversion change;
- weekly tables: each ratio measure's Change cell. Sum measures get test (b) only;
- `jr-flow`: each lane's completion change;
- the Brief's headline and movers.

**Expected labels** (the selftest asserts these from `data/sites/mellow/funnel.json` and `journeys.json`; the series run 7 Sep → 5 Oct):

| Series | Weekly values | Label |
|---|---|---|
| Meta conversion (`traffic_source = meta`, all devices, entries summed) | 0.931, 0.988, 0.967, 0.915, 0.795% | `unusual` |
| Meta sessions | 862,187; 614,222; 611,131; 598,718; 880,079 | `unusual` (+281,361 > 247,965) |
| Campaign conversion | 5.827, 3.739, 3.776, 4.242, 5.759% | `normal` (+1.52 points < the 2.09-point prior move) |
| Returning conversion | 3.302, 2.988, 3.207, 3.243, 3.191% | `normal` (fails noise) |
| Journey `content > pdp` completion (general, all, all; end ÷ start sessions) | 16.96, 13.66, 11.48, 12.31, 9.24% | `slide` |
| Journey `home > content > pdp` completion | 31.18, 32.93, 32.94, 30.61, 29.66% | `normal` (lowest, but only 2 of the last 4 moves down) |

Synthetic cases: a 90-session series is `thin`, and a series whose week `i` has `days: 6` is `partial`.

### W4. The Brief tab (`brief-views.js`)

Make it the first tab: id `brief`, label `This week: "Am I OK, and what moved?"`. Its intro: "Whole weeks only. Read top to bottom: the headline, what moved, and why revenue changed."

It has four panels.

**`br-headline`: view `headline`.**

- **Data:** the derived dataset `site_week`, built from `funnel` by summing over `entry` for each `segment, segment_value, viewport_type, week`.
- **Context:** honours `inherit: { segment: "filter", device: true, week: true }`. When a segment value is set, the panel title says whose numbers they are, for example "Meta visitors".
- **Measures:** revenue, sessions, `session_conversion`, `rps`, `aov`.
- **Each measure shows:** a big number, a change against the comparison, a noise badge and a 5-week sparkline (inline SVG, about 80×24, with the selected week's dot filled).
- **Below the numbers:** a link, "Why did it change? ↓", that scrolls to `br-decompose`.

Expected:

| Measure | 28 Sep | 5 Oct | Change |
|---|---|---|---|
| Revenue | $2,579,051 | $2,892,975 | +12.2% |
| Sessions | 1,037,914 | 1,324,742 | +27.6% |
| Sessions that bought | 1.96% | 1.76% | −0.21 points |
| Revenue per session | $2.48 | $2.18 | −12% |
| Average order | $125.09 | $122.92 | −1.7% |

**`br-movers`: view `movers`.** It builds every candidate change and labels it with W3. It scores the stake, ranks, and writes one sentence for each.

**Candidates.** All use context device and week, and `funnel` with entries summed unless stated:

| Source | Subject | Measures | Stake (dollars, at this week's volume) |
|---|---|---|---|
| Segment values, families `traffic_source`, `returning` and `rager` (not `buyer`, whose rates are 0% and 100% by definition) | the value | sessions (count) | Δsessions × the subject's previous revenue per session |
| | | `session_conversion` (rate) | Δconversion × sessions₁ × revenue per buyer₁ |
| Entry pages (`segment = all`) | the entry | sessions, `session_conversion` | as above |
| Funnel steps (`segment = all`) | product view, add to cart, checkout, purchase | `step_pv`, `step_cart`, `step_checkout`, `step_buy` | Δstep rate × sessions entering the step₁ × revenue₁ ÷ sessions passing the step₁ |
| Journeys, `journey_summary` with `kind = general`, segment from context (default `all`) | the path | completion = end ÷ start sessions (rate, den = start) | Δcompletion × start₁ × end revenue₁ ÷ end sessions₁ |

**Ranking:**

- **Tiers:** `unusual`, then `slide`/`climb`, then `normal`. Within a tier, sort by |stake|.
- **Show the top 8.** `thin` and `partial` never enter the top list.
- **"Show all N movements"** opens a table of every candidate: subject, measure, before, after, change, label, stake.

**Sentences.** These are deterministic templates, with no language model:

- **Volume:** `{Subject} traffic {+47%} ({+281K} sessions) at {$0.93} a session`
- **Rate:** `{Subject} {measure label} {0.91%} → {0.79%}`
- **Step:** `{Step} {59.3%} → {51.9%} of sessions`
- **Journey:** `{Path, using valueLabels} journey completion {12.3%} → {9.2%}`

Each sentence carries its badge, its stake (`−$123K`) and a drill link (below).

**Drill links** set the context and the tab, then focus a panel. Hash `…&tab=funnels&focus=fn-segments`. The focused panel scrolls into view and gets a 2-second outline.

| Mover source | Opens | With context |
|---|---|---|
| Segment value | Funnels → `fn-segments` | family, value |
| Entry page | Funnels → `fn-entry` | — |
| Funnel step | Funnels → `fn-funnel` | — |
| Journey | Journeys → `jr-flow` | segment, if set |

**Expected:**

- The top 8 include Meta sessions (`unusual`, stake about +$305K), Meta conversion (`unusual`, stake about −$123K) and `content > pdp` completion (`slide`, stake about −$164K).
- Campaign conversion is not labelled `unusual`.
- The product-view step is 59.31% → 51.95%, stake about −$410K. Whatever its label, it is listed among the movements.

**`br-decompose`: view `decompose`.** "Why did revenue change?"

- **The model:** revenue = sessions × revenue per session, split across one dimension's values.
- **The method is sequential shift-share,** with totals S, shares sᵢ and rates rᵢ. Index 0 is the comparison week and 1 is this week:
  - volume = ΔS × Σ s₀ᵢ r₀ᵢ
  - mix = S₁ × Σ Δsᵢ r₀ᵢ
  - rate = S₁ × Σ s₁ᵢ Δrᵢ
- The three sum exactly to the change. Show the order in the tooltip: "Split in this order: traffic, then mix, then rates."
- **Dimension picker** (a panel picker, not context): Traffic source (default), Device, Entry page, New or returning.
  - **Traffic source** and **New or returning** use `segment = <family>` and `viewport_type` = context device.
  - **Device** uses `segment = all`, `viewport_type ≠ all`.
  - **Entry page** uses `segment = all`, `viewport_type` = context device.
- **Comparison:**
  - "4-week average" uses the mean of those weeks as period 0;
  - "No comparison" hides the panel body, with a note.
- **Layout:**
  - a total line: `$2,579,051 → $2,892,975, +$313,924`;
  - a three-bar horizontal waterfall (volume, mix, rate), coloured by sign;
  - a table per value: sessions change %, revenue per session before → after, then volume, mix and rate. Sort by |mix + rate|.

Expected, all devices:

| Dimension | Volume | Mix | Rate |
|---|---|---|---|
| Traffic source | +$712,722 | −$429,239 | +$30,441 |
| Device | +$712,722 | −$14,484 | −$384,313 |
| Entry page | +$712,722 | −$176,536 | −$222,262 |
| New or returning | +$712,722 | −$80,488 | −$318,310 |

Traffic-source rows, to the nearest $0.1K:

| Value | Volume | Mix | Rate |
|---|---|---|---|
| meta | +179.5K | +125.8K | −136.7K |
| search | +226.0K | −251.0K | +39.5K |
| campaign | +92.2K | −121.2K | +100.2K |
| direct | +136.2K | −146.8K | +19.0K |
| social | +70.4K | −23.8K | +12.3K |
| website | +8.4K | −12.2K | −3.9K |

**`br-health`: view `health`.** One line about the data, with details on hover:

- **Weeks:** "Journeys and Funnels cover whole weeks (7 Sep–11 Oct). Other tables cover 11 Sep–10 Oct, so their 7 Sep week is 3/7 days and their 5 Oct week is 6/7 days." Build it from W1. Add a warning if `coverageCheck` isn't ok.
- **Element names:** "29 of 1,106 clicked elements are named." Count distinct `selector` values in `selector-weekly` with a non-blank `name`.
- **Partition check:** passed, or failed, from `manifest.checks`, as the header shows today.

### W5. Short labels

- **URLs:** in `fieldLabel`, a value matching `^https?://` shows as its path plus query, with the host dropped. The full URL goes in the `title`.
- **Experiment arms** (`xp-arms`, `xp-weekly`): show `Control` for the row with `is_control` true, and `Variant 1`, `Variant 2`… for the rest, in `arm` order. Keep the raw arm key in the tooltip.

### W6. `check.mjs` and `selftest.mjs`

**`check.mjs`:**

- knows the new view types (`headline`, `movers`, `decompose`, `health`) and the derived `site_week`;
- validates the `context` block;
- for a panel with `inherit`, checks that its dataset has at least one mapped column for each inherited field;
- checks that every `movers` source names a dataset that exists, or is derived.

**`selftest.mjs`** (run with `node`), using `node:assert`:

- `weekCoverage` gives the expected table in W1 for both sites;
- `coverageCheck` is ok for Mellow;
- `classify` gives the labels in W3;
- the decomposition gives the four totals in W4, and the three effects sum to the change within $1;
- the headline numbers match the W4 table.

When `data/sites/mellow` is missing, it skips the data-backed assertions with a message.

### W7. `capture.json` for V1

The variants:

- Brief, default;
- Brief with context Traffic source → Meta;
- Brief, decomposition by Entry page;
- Funnels with context Mobile;
- Health, showing the 6/7-day week;
- Journeys with "4-week average".

Use `params` for the context keys, for example `{ "seg": "traffic_source", "segv": "meta" }`.

## 7. Verification

Run from the repo root, with `node prototype/query-tool/serve.mjs --port 8765` running in the background:

```bash
node prototype/query-tool/revisions/quick-concept/check.mjs
node prototype/query-tool/revisions/cursor-opus-5-5-v1/check.mjs
node prototype/query-tool/revisions/cursor-opus-5-5-v1/selftest.mjs
node prototype/query-tool/capture.mjs --revision entry --out /tmp/qt-cap/entry
node prototype/query-tool/capture.mjs --revision quick-concept --out /tmp/qt-cap/quick-concept --sites mellow
node prototype/query-tool/capture.mjs --revision cursor-opus-5-5-v1 --out /tmp/qt-cap/v1 --sites mellow,loop-earplugs --panels mellow
```

Then look at the screenshots: read the PNGs. Check, at least:

1. **The entry page:** two cards, newest first, and working Open links for both sites.
2. **Quick Concept:** looks like the reference screenshots, apart from the header.
3. **V1 Brief on Mellow:** the headline, movers and decomposition numbers in W4.
4. **V1 Brief on Loop Earplugs:** renders with no error panels, and has movers listed.
5. **V1 Health:** the 5 Oct column reads "6/7 days" for Mellow, and the sessions change is `–`. For Loop, 7 Sep reads "2/7 days" and 5 Oct is whole.
6. **V1 context:** Meta + Mobile set on Brief carries over to Funnels and Journeys, and survives a reload.
7. **The browser console** has no errors on any V1 tab, for either site. Use the `cursor-ide-browser` tools, or `capture.mjs` with a console listener.

Finish with a short report to the user: what was built, the verification results, any expected number that didn't match and why, and anything deferred.

## 8. Not in V1 (for later revisions)

These are in the analysis, but deliberately left out of this revision:

- **Slice 2:**
  - the full Explain tab, with heat tables;
  - the drill drawer on every number;
  - cross-links (`links`) on every panel;
  - the unblock list replacing the cards board;
  - pins, local annotations and meeting mode;
  - element-jump detection;
  - the small-multiples fixes;
  - pulling whole weeks in the snapshot.
- **Slice 3:**
  - the question box;
  - verdicts linked to findings;
  - experiment interval and sample-ratio checks;
  - watchlists.
- **Trigger chains as a movers source.** `trigger-chains` is daily on the bundle window, so its edge weeks are partial. Add it after the whole-week pull.
- **Any change to the engine** or to the snapshot scripts.

## 9. Adding a later revision

1. `cp -R revisions/<latest> revisions/<new-id>`. The id is the display name in lowercase, with every run of non-alphanumeric characters turned into `-` (so "Cursor - Opus 5.5 - V2" becomes `cursor-opus-5-5-v2`).
2. Set the header tag and `views.json` `revision` to the display name.
3. Add the entry at the top of `revisions.json`. Mark the previous revision `"status": "frozen"`.
4. Make the changes in the new folder only. Run its `check.mjs` and `selftest.mjs`, and capture it.

## 10. Decisions taken in this plan, and open questions

**Decided:**

- **Coverage is computed in the browser** from the manifest windows, not written into the snapshot. That keeps `data/` shared and unchanged, and Quick Concept untouched.
- **Noise labels always use the previous week.** Other comparisons change the displayed delta only.
- **Stakes follow analysis §8.2,** with revenue per buyer for conversion changes. So Meta's conversion stake is about −$123K, not the −$137K rate effect in analysis Model D (which uses revenue per session). Both are honest. The decomposition panel shows the −$137K.

**Open, for the user** (don't block on these):

- Should V1 screenshots also go into the handoff folder, as `~/Work/analysis/query-tool/7-…`?
- Should the entry page show a thumbnail per revision (from `capture.mjs --revision <id>`), or text only? The plan assumes text only.
