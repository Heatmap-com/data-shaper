# Grok - K3: annotate observations, and show what is still open

**Date:** 16 October 2026
**Status:** plan. Nothing in it is built yet. Written for a fresh context to carry out from start to finish.
**Revision:** `prototype/query-tool/revisions/grok-k3/` only. Do not edit other revisions, `capture.mjs`, `serve.mjs`, `entry.*`, or `revisions.json` except the one Grok - K3 summary line if a summary is updated at the end.
**Reads with:** the Grok - K3 code as it stands (`home-views.js`, `derive.js`, `contrast.js`, `changes.js`, `outliers.js`, `verdict-views.js`, `app.js`, `views.json`) and the conversation that set the contract below.

## 1. What this is

The dashboard already reduces weekly series to findings. This work lets an analyst mark each finding, see how many findings on a tab are still untouched, come back to any mark, and change it.

A finding is a signal. A mark is the analyst's disposition on that signal. The prototype stores the mark and shows it. It does not reprioritize, close, or hide a finding because of earlier marks. That inference is a later reader of this ledger.

## 2. Ground rules

- Do not commit.
- No warehouse queries. Do not rerun `snapshot.mjs` or `flows.mjs`. Do not edit `data/`.
- Plain browser modules. No build step, no dependencies.
- No `*.test.*` or `*.spec.*` names. Self-check is `node revisions/grok-k3/selftest.mjs` from `prototype/query-tool`.
- Match the revision: `h()` / `s()` from `views.js`, small functions, few comments.
- Do not write the analyst's words into `log.js`. That log refuses free text on purpose. A save may log `{ id, disposition }` and nothing else.
- Do not put marks in the engine, in `names/*.json`, or in the snapshot. Marks are per browser and per site, in `localStorage`.

## 3. Contract

### 3.1 What counts as an issue

An **issue** is a finding the prototype already flags for the context bar's week, comparison, split, and device. The tab badge counts issues. A row that is inside its wobble, a contrast the rules call "moved with everyone" or "in line," a "can't say," and an unflagged table row are not issues.

The analyst can still open the editor on any issue, including ones below the home tab's top five, once that list is expanded. Unflagged cells do not get a button in this pass.

Each issue has one id. The same id shown on two tabs is one issue. Annotating it clears it on every tab.

The id includes the judged week and the comparison week. A mark on this week's Meta jump does not close next week's. Changing the context bar changes which issues are open. Marks for other weeks stay in the ledger.

### 3.2 Which issues, and which tab owns the badge

Build the list once from the functions that already decide "this is worth a look." Do not invent a second rule.

| Issue | When it exists | Badge tab | Id |
|---|---|---|---|
| A site measure that moved | `wobbleCheck` badge `moved` (sessions, orders, revenue, order rate) | `home` | `measure\|{id}\|{week}\|{compare}` |
| A merged mover that moved | `mergeMovers` of `moverCandidates`, in rank order | `home` for ranks 1–5, `change` for the rest | `mover\|{family}\|{value}\|{measure}\|{week}\|{compare}` |
| A segment that pulled away or changed alone | `headline` findings (`pulled` or `own`, not thin) for the context-bar split | `home` | `contrast\|{group}\|{value}\|{measure}\|{week}\|{compare}` |
| The same, for the other groups, and headline findings past the home strip | `contrasts` over `traffic_source`, `returning`, `device`, kinds `pulled` and `own`, not thin, id not already on `home` | `change` | same contrast id |
| A structural gap | `always` set, not already a pulled/own issue | `change` | same contrast id |
| Mix and rate disagree | `mixDecomp` for the context-bar split, both terms non-zero and opposite sign | `home` | `mix\|{split}\|{week}\|{compare}` |
| A campaign change tile | `findChanges` sections `traffic`, `value`, `started`, `stopped` on panel `acq-changes` | `acquisition` | `change\|acq-changes\|{src}\|{camp}\|{kind}\|{week}\|{compare}` |
| A campaign or creative outlier | `findOutliers` on `acq-campaigns` and `acq-creatives` | `acquisition` | `outlier\|{panel}\|{key}\|{week or period}` |
| A triggered rule | `strategy-triggers` row with `m_state === triggered` | `verdicts` | `trigger\|{x_strategy_id}\|{m_metric}` |

"Also seen in" movers are not extra issues. They are lines on the host mover.

Home's verdict summary and the per-tab "What the rules say" aside are not issues. The triggered rules are issues on `verdicts` only.

Tabs with no producer (`health`, `journeys`, `funnels`, `pages`, `elements`, `orders`, `experiments`) show no badge. They have no Heatmap-identified issues in this pass. Do not count every row of their tables.

### 3.3 Addressed

An issue is **addressed** when it has a current mark and, if the disposition is Postpone, the return week is still after the context-bar week.

Postpone whose return week is the context week or earlier is **due**. It counts as unaddressed again. The old words stay visible so the analyst can revise them.

| Disposition | Meaning | Counts as addressed |
|---|---|---|
| `critical` | This needs a decision, and why | Yes. It stays visible on the finding, sorted first on the home list. It does not keep the badge up. |
| `not_important` | Looked; it does not change what we do, and why | Yes |
| `expected` | I know why it moved (a sale, a budget change, a launch), and why | Yes |
| `postpone` | Real, not this sitting. Why, and the Monday to bring it back | Yes, until that Monday is the week on screen |
| `not_accurate` | The number or the comparison is wrong, and why | Yes. It also appears in the Notes filter "Faulty." Nothing in the rank, the band, or the badge reads this disposition. |

The why is required for every disposition: at least one non-space character. Postpone also requires a Monday. The date control lists the context-bar weeks after the judged week, plus a date field if they need a later one. Default the return to the next Monday after the judged week.

Clearing a mark removes the current disposition and makes the issue unaddressed. The previous text stays in history.

### 3.4 What a mark stores

One record per issue id, per site. Saving replaces the current fields and appends the previous current fields to `history` (keep the last 20).

```json
{
  "id": "mover|traffic_source|meta|sessions|2026-10-05|2026-09-28",
  "site": "mellow",
  "disposition": "expected",
  "text": "We raised the Gift Guide budget that Monday.",
  "postponeUntil": null,
  "updatedAt": "2026-10-16T06:00:00.000Z",
  "history": [],
  "snapshot": {
    "week": "2026-10-05",
    "compare": "2026-09-28",
    "label": "Meta sessions",
    "kind": "mover",
    "tab": "home",
    "panel": "hm-movers",
    "delta": "+47.0%",
    "rule": "own-history wobble, 2× median"
  },
  "target": {
    "tab": "home",
    "panel": "hm-movers",
    "ctx": { "week": "2026-10-05", "compare": "prev", "split": "traffic_source", "device": "all" }
  }
}
```

`snapshot` and `target` are written at save from the issue object, so Notes can render and drill after the context bar has moved. Revising updates both.

Storage key: `qt:grok-k3:notes:{slug}`. Value: a JSON array of records. Read and write guard against a broken value by treating it as `[]`. Offer **Download notes** on the Notes tab (a JSON file). There is no server.

## 4. Files

```text
revisions/grok-k3/
  notes.js            NEW   dispositions, load/save, addressed, search. No DOM.
  observations.js     NEW   build the issue list from the existing pure functions. No DOM.
  note-ui.js          NEW   the editor popover, the mark button, the badge text
  notes-views.js      NEW   the Notes tab
  selftest.mjs        NEW   node self-check for notes.js and observations.js
  app.js              EDIT  tab strip, badge refresh, hash `note` and `q`, pass the store into views
  index.html          EDIT  a nav for the question strip
  styles.css          EDIT  strip, badges, editor, notes list
  views.json          EDIT  the Notes tab; register view `notes`
  check.mjs           EDIT  allow view `notes`
  home-views.js       EDIT  mark button on answer measures, mover rows, the mix line
  contrast-views.js   EDIT  mark button on chips and grid cells that are issues
  changes-views.js    EDIT  mark button on change tiles
  views.js            EDIT  mark button on outlier rows
  verdict-views.js    EDIT  mark button on a triggered finding
```

`observations.js` imports `derive.js`, `contrast.js`, `changes.js`, `outliers.js`, and `wobble.js`. Views import `note-ui.js`. `note-ui.js` imports `notes.js`. Views do not import `observations.js`; `app.js` does, and it passes `issueById` and `onNote` down on the view context so a row can render its mark without recomputing the catalog.

## 5. Behaviour

### 5.1 Tab indicators

The question `<select>` stays. Above the tab title, add a strip of short labels, one button per tab including Notes:

| id | Short label |
|---|---|
| home | This week |
| change | What moved |
| health | Health |
| acquisition | Acquisition |
| journeys | Journeys |
| funnels | Funnels |
| pages | Pages |
| elements | Elements |
| orders | Orders |
| experiments | Experiments |
| verdicts | Verdicts |
| notes | Notes |

On every button except Notes:

- A count, as an `aria-label` and a numeric badge, when that tab has one or more unaddressed issues. Example: `This week` with `4`.
- A check, label "All marked," when the tab has issues this week and every one is addressed.
- Nothing beside the label when the tab has no issues this week.

The `<option>` text gets the same suffix (` · 4`, ` · all marked`) so the closed select still shows it. Notes has no issue badge. The strip and the select both call `selectTab`.

Recompute the catalog, then the badges, whenever the site or the context bar changes, and after every save or clear. Cache the catalog on the context key `(site, week, compare, split, device)` so rendering a panel does not rebuild it.

Building the catalog loads `funnel`, `journey_summary`, `strategy-triggers`, `weekly_source_campaign`, and the two acquisition datasets the outlier panels read. Use the existing `loadDataset` cache. Acquisition panels follow their own week picker; for the badge, use the same default those panels use (`latestFull` of that dataset), not a second definition.

### 5.2 Annotate

Every issue row, chip, tile, answer-line measure, mix summary, and triggered-rule card gets a button:

- No mark: `Mark`.
- A mark: the disposition's short word (`Critical`, `Not important`, `Expected`, `Postpone`, `Not accurate`). A due postpone reads `Due`.

The button opens one editor, anchored to the button, closed by Escape, by a click outside, and by Save. It does not use the hover card or the pin tray.

The editor shows the issue label, five dispositions as radio buttons, a textarea labelled "Why," and for Postpone the return week. Save is disabled until the why is non-empty and, for Postpone, a week is chosen. Save writes the record, closes the editor, and re-renders the open tab and the badges.

Under the button, if a mark exists, one line shows the why, truncated, with the full text in the `title`.

### 5.3 Revise

Opening the editor on a marked issue fills the disposition, the why, and the return week. The footer shows "Edited {date}" and, when `history` is non-empty, "Previously: {disposition}, {date}." Save stores the new current values and pushes the old ones onto `history`.

A Clear control asks nothing further. It removes the current disposition (`disposition: null`, `text` kept on the history entry) and the issue counts as unaddressed again.

### 5.4 Notes tab

New tab `notes`, last in `views.json`. No dataset. Intro: "Marks you have put on findings. A finding stays in its own tab; this list is the ledger."

The panel is one view, `notes`:

- A search box, focused when the tab opens. Filtering happens on each keystroke. There is no submit button. The placeholder is "Search marks."
- The query is whitespace-separated words. Every word must match, case-insensitive, somewhere in the label, the why, the disposition's short word, the tab's short label, the kind, or the week. The list shows `4 of 27` as it narrows. An empty query shows every mark for this site, newest update first.
- Chips to narrow before the text match: All, Unaddressed due, Critical, Not important, Expected, Postpone, Not accurate. One chip at a time. "Not accurate" is the faulty queue. The chip and the text both apply.
- Each row: disposition word, label, why (two lines, then ellipsis), week against comparison week, tab short label, edited date.
- Clicking the row, or pressing Enter on the first row while the box is focused, drills to `target`: set the context bar from `target.ctx`, open `target.tab` and `target.panel`, scroll the panel into view, flash the element that carries `data-obs="{id}"`, and open the editor on it.
- The row also has Revise, which opens the editor in place without leaving Notes. Save from there refreshes the list.
- Download notes, and a line `Stored in this browser for {site name}.`
- Empty: "No marks yet. Mark a finding on This week, What moved, Acquisition, or Verdicts."

The hash carries the search: `q` is the text, `nf` is the chip id. `note` is the issue id to open after render. `readHash` / `hashString` gain these three keys. A drill from Notes pushes a crumb, as other drills do.

### 5.5 Sorting on the home list

Where a panel lists issues (movers, contrast chips), marked `critical` rows go first, then unmarked, then the other dispositions. Do not drop addressed rows off the panel. The badge is the only "how many are left" signal. The full mover list and the contrast grid keep their current order, with the disposition word on the row.

## 6. Self-check

`selftest.mjs` imports `notes.js` and `observations.js` and asserts, with no DOM and no `localStorage` (pass an in-memory store into the notes functions; do not touch `window`):

1. A new id is unaddressed. Each of the five dispositions makes it addressed. Postpone with `postponeUntil` equal to the context week is unaddressed. Postpone with a later week is addressed.
2. Save then save again leaves one record, and `history` has the first text and disposition.
3. Clear makes it unaddressed and keeps the cleared text in `history`.
4. Search: `"meta budget"` matches a why containing those words and does not match a why that has only one of them. A disposition word matches. Ranking is unchanged from input order except that non-matches are removed.
5. Two issues with the same contrast id and different tabs produce one badge count on each owning tab from a fixture list, and one record addresses both lookups.
6. `buildIssues` on a tiny hand-built funnel: one segment's sessions jump far past a flat history, so exactly one mover issue exists; a flat site measure is not an issue; opposite mix and rate produce one mix issue. Use weeks `2026-09-07`, `09-14`, `09-21`, `09-28`, `10-05`, all marked full, so the band has three prior changes. State the expected ids in the file.

`check.mjs` still exits 0 after the Notes tab is added. Run it.

## 7. Done when

On Mellow, week of 5 Oct against 28 Sep, all devices, split by traffic source:

- This week shows a badge equal to the moved site measures, plus the merged movers in the top five, plus the home contrast findings, plus one if mix and rate oppose.
- Marking one mover as Not important, with a why, drops that badge by one, shows the why on the row, and shows the row on Notes.
- Changing the why and saving leaves the new why on the row and the old why in the editor's "Previously" line.
- Clear puts the badge back up.
- Notes search narrows as you type. Clicking the row opens This week, scrolls to that mover, and opens the editor with the saved why.
- Postpone to the following Monday drops the badge. Moving the context bar to that Monday brings the badge back and the button reads Due.
- A Not accurate mark drops the badge and appears under the Faulty chip. No wobble band, rank, or other badge changes because of it.
- Acquisition's badge is the change tiles plus the outlier rows for the panels' default week. Verdicts' badge is the triggered rules. Health, Journeys, Funnels, Pages, Elements, Orders, and Experiments show no badge.
- `node prototype/query-tool/revisions/grok-k3/selftest.mjs` and `node prototype/query-tool/revisions/grok-k3/check.mjs` both exit 0.

Verify in the browser at the running query-tool server: save, revise, search, drill, postpone-due, and the faulty chip. A reload keeps the marks. Switching to Loop Earplugs shows that site's own empty ledger.
