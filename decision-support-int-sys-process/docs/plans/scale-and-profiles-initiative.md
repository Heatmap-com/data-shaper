# Initiative: day-at-a-time analysis, incremental trends, then execution profiles

**Started:** 14 October 2026
**Branch:** `initiative/scale-and-profiles`, off `initiative/orchestrator` at `9d4eb98`
**Source plans:** `docs/plans/day-at-a-time.md` (Part D) and `docs/plans/execution-profiles.md` (Part P)

Part D makes a 30-day analysis of a very large site finish on an 8 GB heap. One shared scan reads a day, folds it into every dataset, and drops it. Part T makes trend series incremental: each run adds the new week and leaves the stored weeks in place. Part P then turns the engine from a landing-page tool into one that runs any declared transformation, with today's landing-page analysis as one profile among several.

## Working rules

- Each phase is a branch `scale/<n>-<name>` off the initiative. It merges back with `--no-ff` when its tests pass. Branches stay local until the user asks for a push.
- Each item is its own commit. A refactor records a characterization test on the old code first, then compares after.
- Live checks read ClickHouse and write only to the in-memory persistence adapter. Nothing in this initiative writes to the production analysis tables, alters a table, or enqueues a job. The schema migration in Part P is written and tested against the memory adapter and a fake client. Running it on ClickHouse waits for the user.
- One heavy query in flight. No `system.*` queries. No passwords or keys in output.
- The two source plans stay the user's files; this document records where the implementation departs from them and why.

## Part D: day-at-a-time

### D1. The day record and the visit close

`src/scan/day-record.js` holds the SQL for one site and one `server_date`. It returns one row per `idvisit` with any fact that day. Every per-visit reduction the datasets and triggers read is a column, so Node never sees pageview, click, tag, or partner-tag rows.

`src/scan/day-scan.js` reads days oldest first and merges rows into an open-visit map. Sums add, maxima take the max, sets union, and orders dedupe by `idorder`. The earliest `started_at` wins the visit fields. A visit closes once a later day is read with no row for it, or at the end. Closed visits go to every folder. Visit ids closed in the last `hold` days are kept to drop late rows, and the drop is counted in the notes.

The day record's columns, one row per `idvisit`, with the spine the union of visit ids across the CTEs below:

| Source (day `d` only) | Columns |
| --- | --- |
| `udp_hsrce_visits` | `started_at` (min `visit_first_action_time`), and by argMin on it: `config_id`, `device_type`, `referer_type`, `visitor_returning`, `location_country`, `entry_hsr`, `utm_source`, `browser`, and `fp_hash` (the existing `fpHashExpr` parts) |
| `udp_hsrce_pageviews` | `pageview_rows` (count), `hsrs` (distinct `idsitehsr` array), `first_pages` (the day's first two `(time, idsitehsr)` pairs, for `site-baselines`' second page), `capped_ms` (sum, capped at `TIME_ON_PAGE_CAP_MS`), `scroll_max` |
| `journey_events_map` | `events`: the distinct event types, filtered to the union of the session-stream names and the trigger predicate names |
| `udp_conversions FINAL` | `orders`: `(idorder, revenue)` pairs, deduped per order |
| `udp_clicksce_clicks` | `clicks` (count) |
| `udp_session_tags` | `tags`: the day's first non-empty tag JSON |

Two decisions follow from the code. The fingerprint hash is computed in SQL per day, and the merge keeps the earliest day's value, so bot tiers come from the unchanged `getBotContext(...).tierOf(week, fp_hash)`. The tag JSON is carried raw on the open visit and dropped at close, which keeps `mediumOf` and the campaign parsers unchanged. That holds one day's blobs at a time, roughly 60 MB for 300,000 visits. Medium extraction moves into SQL only if D6 shows the blobs dominate the heap.

Every fact alias carries `{idsite}` and its own `server_date = {day:Date}`, and a test pins `queryBoundGaps(daySql)` to an empty list. The day query runs under a `scan:` label.

Done when a fixture window with a visit on two dates folds to the same session `fetchSessionRows` builds, and to the same trigger fact `assembleSessions` builds.

### D2. Folders and the runner scan

A dataset that reads sessions gains `open(page, ctx)`, `fold(day, visits)`, and `finish()`. Its `collect` becomes open, fold the window fetch, finish, so the old path and the scan run the same reduction. Discovery is unchanged.

There are two passes. The **site pass** runs once per site, before qualification, and feeds the folders that need no chosen page. The **page pass** runs once per selected page after selection. It re-reads the day record restricted to visits that entered (or, for `journey-weekly`, viewed) that page, together with that page's facts for the day. The runner (`src/site-analysis/handlers.js`) runs the site pass in `qualify` and the page pass in `collectDatasets({scope: 'page'})`, and hands finished folds to the dataset loop in place of `collect`.

**Departure from the source plan.** The source plan folds `journey-weekly`, `funnel-sequence-weekly`, `forms-weekly`, `exposure-weekly`, and `page-segment-weekly` on the site pass. The page is unknown during that pass, so those folders would hold state for every entry page on the site. On the page pass they hold only the chosen page's sessions. That keeps memory proportional to the page's traffic. It also lets the medians, sorts, and top-N cuts in `finish` run on exact per-session values, unchanged, rather than on histograms. Those reductions then match `collect` exactly and the characterization tests compare equal. The cost is one more day loop per selected page, which the source plan already pays for the geometry datasets.

| Pass | Dataset | Reads beyond the session fields |
| --- | --- | --- |
| site | `prefer-non-home`, `default-six` | `site_hsr` pages; the chosen page's hit count (unchanged small queries) |
| site | `entry-by-channel` | site URLs; cells for every entry page, cut in `finish` (top 25, floor 20, chosen page kept) |
| site | `sister-pages` | `ae_page_target_current` (unchanged) |
| site | `site-baselines` | `first_pages` for the second page |
| site | `experiments-weekly` | partner-tag assignments as a day column (D4) |
| site | `trigger-chains` | the trigger folder (D3) |
| page | `page-country`, `campaign-coverage`, `campaign-weekly` | raw tags for `campaign-*` |
| page | `forms-weekly`, `funnel-sequence-weekly` | that page's visits' form and funnel events, with first times |
| page | `journey-weekly` | ordered pageview sequences of visits that viewed the page |
| page | `exposure-weekly`, `dwell-model-inputs` | elements and zones per visit for the page |
| page | `page-segment-weekly`, `scroll-decile`, `viewport-weekly` | per-visit scroll, viewport, and on-page time for the page |
| page | `selector-weekly`, `rage-clicks`, `tap-geometry-weekly`, `nav-next-page`, `product-grid` | the page's clicks, folded to cells per day (D4); geometry and template-start queries unchanged |

`page-country` and `campaign-*` need only the session fields and could fold on the site pass. They go on the page pass to keep one rule: datasets that filter to the page fold there.

`entry-by-channel`, `page-country`, `campaign-coverage`, and the `product-grid` adapter have no gateway-level tests today. Each gets a characterization test on the old `collect` before it moves.

Done when each moved dataset's output on a fixture matches its characterization snapshot, recorded on the old `collect`, and no moved dataset calls `fetchSessionRows` on the production path.

**As built.** Two refinements keep every page dataset's reduction as it is.

- Folders exist where a reduction runs on the site pass: `prefer-non-home`, `default-six`, `entry-by-channel`, and `site-baselines` (`open` returns `{fold(sessions), finish(...)}`; a dataset folded this way declares `pass: 'site'`). Folds count per entry page and resolve URLs in `finish`, so `fold` stays synchronous. `site-baselines` reads `secondHsr` from the row, which the scan takes from `first_pages` and the window path from its second-pageview query.
- Page datasets keep `collect`. The page pass is one scan over every target (fresh or awaiting capture) with the targets' page facts, and it keeps per target the entry sessions as compact rows, plus the viewers when a dataset declares `sessions: 'viewed'` (`journey-weekly`). `fetchSessionRows` returns `ctx.sessionSource.rows(...)` when the page pass set one. `sister-pages` declares `sessions: 'targets'` and reads the targets' entry sessions. `experiments-weekly` reads the window query until D4 (see D4). The cost is one site pass and one page pass per site, two day queries per day for the page pass.

The scan is on when `deps.dayScan` is set. Config `dayScan` is on by default; `ANALYSIS_DAY_SCAN=0` turns it off. A handler started on a fresh state (a separate stage, or a resume) runs the passes its unfinished datasets need.

Tests: a snapshot of the four reductions recorded on the old code, unchanged after; the same outputs when folded in reversed chunks; a guard that each page dataset reads only `idvisit` and `entryHsr` from sessions off its page; and the handlers on `clickhouse local`, scan against window, storing identical rows in one process and as separate stages with no `sessions:` query.

### D3. The trigger folder

The folder keeps, per `config_id`, the compact sessions of the last `max(window_days, chain_window_days)` days and the purchase sessions within `prior_purchase_lookback_days`. When a day is complete (no open visit is dated on or before it), it evaluates that day's hits with the unchanged `qualifies`. Each hit's chain is evaluated once, with the unchanged `chainOutcome`, on the day its window closes or on the batch's last day. That is the evaluation `collectTriggerWindow` keeps. Hits and final chains are written per day in 50,000-row chunks.

**Departure from the source plan.** The preface is the visitor window (14 days), not visitor plus chain (28). Chains read only sessions after their hit, so the 14 days before `windowStart` that the chain span adds are only ever read for purchases. The prior-purchase lookup covers them instead: same `purchaseStart`, with `purchaseEnd` moved to the day before the scan. A 30-day batch reads 44 days, not 58.

Done when a scripted visitor across 20 days gives the same hits and chains as `collectTriggerWindow`: the 14-day edge, a chain that closes inside the batch, a chain open on the last day, a blank `config_id`, a prior purchase before the first Showed Interest session, and a purchase on the hit day.

**As built.** `src/triggers/fold.js` and `scanWindow` in `src/triggers/load.js`. The lane starts one day before the visitor window, so a visit that crosses into the first needed day is dated before it, as the window query dates it; a visit read both by the prior-purchase query and on the lane merges into one session. Hits come from days `min(windowStart, windowEnd − chain_window_days)` onward, which keeps a short batch's open chains that began before it. `trigger-chains` opens the folder as a lane of the site pass (`lane: {start, events, onClosed, onDay}`), so one day loop serves the window's lane and the trigger lane. Tests: generated visitors over 20-, 7- and 30-day windows give `collectTriggerWindow`'s hits and chains, and on the local warehouse the scan run stores the window run's definitions, hits, and chains.

### D4. Fat pulls and the chosen-page pass

`experiments-weekly` reads partner-tag assignments as a day-record column of `(week, experience_id, variant_id)` per visit, so the 39 million row pull is gone. Each open week cell keeps a visit set, dropped when the week closes. The site-wide memos that hold one row per visit or per fact move onto the page pass: `getPageviewSequences` (`nav-next-page`), the journey pageviews, and the viewport classes. Clicks fold to the cells the geometry datasets store, plus the visit id for the order join, and the click rows are dropped at the end of the day.

**As built.**

- `daySql({partnerTags: true})` adds each visit's arms for the day, and the open visit unions them. `experiments-weekly` declares `pass: 'site'`. Its folder takes the arm cells from the window's distinct `(week, experience, variant)` tags, a small aggregated query that keeps arms whose visits have no visit row. Each closed visit counts once toward each of its arms, which is the window path's one-tag-row-per-session rule, so the cells hold counts and no visit sets. The scan reads partner tags only when this folder opens, so sites without the table never touch it.
- The per-page loads read the visits that entered or viewed the page in the window (`PAGE_VISITS` in `_lib/sql.js`): the pageview sequences, the journey's timed sequences, the session tags, and the viewport heights. Each consumer looks up only the page's entry sessions or its viewers, so the restriction is exact. They and the clicks memoize per page in `ctx.pageNotes` (`_lib/page-memo.js`), which the page phase clears after the page's datasets. `page-segment-weekly` reads the shared session stream with the page's scroll facts plus the shared viewport heights, in place of its own whole-site query. `scroll-eff` moves to the same per-page store.
- Clicks stay one page-scoped query (the page's clicks on its entry visits), held only while the page's datasets run. The geometry datasets keep every click's x, y, and time for their exact medians, so folding them per day would keep the same values. D6 reports the largest page's click count; folding follows if clicks drive the peak.
- Tests: `test/characterization/page-memos.test.js` records the memo datasets and `experiments-weekly` on the site-wide loads over `clickhouse local`, and the page-scoped loads and the partner-tag folder on the day scan reproduce it. A mutation of the page restriction or the arm fold fails it. The handler test runs `campaign-coverage`, `campaign-weekly`, `viewport-weekly`, `page-segment-weekly`, and `experiments-weekly` on both paths, with identical stored rows and no raw partner-tag query on the scan.

### D5. The day cursor

After each day the scan writes a `day-scan` checkpoint (`idsitehsr` 0) with the day and the folder snapshots. A resume loads it and starts at the next day.

**As built.** Each pass keeps its own cursor, `day-scan:site` and `day-scan:page`. A saved state holds each lane's open visits (the reporting lane and each folder lane) and each named folder's state (`qualifier`, `page-selector`, and the dataset ids, or the page pass's kept rows). A pass restores a saved state when it holds every lane and folder the pass runs, for the same site, window, pages, and cursor version. It then reads from the next day. A state saved after the last day only closes the visits still open. So a resumed stage continues where the scan stopped, and a later stage on a fresh state reuses the finished pass in place of scanning again. The site phase empties both cursors once the site's datasets are stored. A state over 64 MB is not saved, with a warning, and D6 reports the sizes. `src/scan/snapshot.js` encodes Maps, Sets, and shared references, since the trigger folder holds one session in several maps and merges prior purchases by identity. Tests: the codec, the trigger folder restored on three days, prior-purchase identity after a restore, and on `clickhouse local` a run that fails one site-pass day and one page-pass day, with each stage rerun on a fresh state, storing the window run's rows and reading each of the 37 days once.

### D6. Live acceptance, read-only

`scripts/scan-acceptance.mjs` runs one site through the scan with the live gateway, in-memory persistence, and `--max-old-space-size=8192`. It reports peak RSS, the query count, and the hit, chain, and dataset row counts against the stored batch. First Mellow (idsite 4879, batch `6b5f8c7f-1ff8-46cf-9279-ef04a69a61c4`, 2026-09-11 to 2026-10-10), then Loaded Tea (idsite 5769). Before fixing the hold at one quiet day, the script measures the longest `server_date` span per visit on Mellow.

**As built.** The span measurement found about 2,000 of Mellow's 4.7 million visits with days more than one apart. The scan lists them before the first day and reads their rows over the whole range, so each lane opens them whole and the one-day hold stays exact. The Mellow runs then found seven faults, each fixed with its test:

- The entry-type check failed on the scan's string `entryHsr`; it compares as text.
- The page's clicks (7.4 million on Mellow's chosen page) arrived as one array of row objects. They are read a day at a time into a column table, with the click characterization recorded first over a multi-day read.
- A day cursor over the cap was still encoded in full before the size check. Encoding stops once it passes the cap.
- The prior-purchase load read every visit, event, and order of the year (11 million rows) and filtered in Node. The three queries now carry the purchase predicate in SQL (546,000 visits, 3.07 million events, 1.0 million orders), with the Node filter kept. A characterization test on the local warehouse covers the orders-count and events-only rules.
- The trigger folder stayed live through the page pass (3 GB). Folders gain an optional `settle()`, which the site pass calls after its last day, and `trigger-chains` finishes there and drops the folder. Live heap after qualify fell to 553 MB.
- `rage-clicks` and `tap-geometry-weekly` held an array per click. They keep a group's count, span, and weeks, and candidate clicks by column, with the characterization re-recorded on the old code over a fixture with repeat clicks.
- The harness joined 963,000 chain rows into one string. It appends in `INSERT_CHUNK` lines, and compares chains on their outcome columns with `idvisit` read as text.

Measured on Mellow with the first four fixes: qualify 3,185 s, page datasets 1,214 s, peak RSS 8,293 MB, peak heap 7,497 MB. The 75 day queries took 1,353 s of the run's 2,500 query seconds. Hits match the stored batch for `abandoned_cart` (394,617) and within six for `showed_interest` and `super_shopper`. Of the datasets, 29 match on row count and 4 differ: `campaign-weekly` (+356), `rage-clicks` (+20), `dwell-model-inputs` (+31), `trigger-chains` (+3). `campaign-weekly` differs between runs of the same window (20,826, 20,910, and 21,656 rows), because a visit with several tag rows keeps whichever row ClickHouse returns last. The day cursor never saved: Mellow's state is over the 64 MB cap.

The stored chain table lacked the hit's session dims, so `scale/9-chain-dims` adds the nine (level, device, channel, source, medium, returning, country, landing page, entry template) to `ae_trigger_chain` and its insert.

The Mellow rerun with the harness fixes and the Loaded Tea run wait for the massive-site phase, at the user's direction: the incremental-days work (`docs/plans/incremental-days.md`) comes first and is proven on average sites.

## Part T: incremental trends

A trend series should grow by the new week on each run, with earlier weeks left as stored. The storage already allows it. `ae_trend_row` is keyed by site, row type, subject keys, segment, `week`, and page, with `batch_id` outside the key, and `chooseSubjects` keeps the stored subjects unless `--rerank` is passed. The four items below change how a run picks its window and its subjects. They apply to `runTrend` and `runTagTrend` alike, since both build weeks with `mondayWeeks`. T1 confirms the tag-trend table carries the same week key.

Part T runs after D6 and before Part P, so the profile work (an element trend over PDPs, for example) starts with incremental series.

### T1. Whole weeks only

`mondayWeeks` backs the window start up to its Monday, while the SQL reads from the window start. A window that starts on a Thursday writes a Thursday-to-Sunday row for that week, and that row replaces the complete one stored earlier. A window that ends mid-week writes a partial current week. A run emits only the weeks that lie wholly inside its window, and its notes name any edge days it left out.

Done when a test with a mid-week start and a mid-week end stores only the full weeks, and a second run over an overlapping mid-week window leaves the stored full week unchanged.

### T2. The next window comes from the store

The trend store gains `readTrendWeeks(idsite)`, which returns the latest stored week per subject, on both persistence adapters and in the contract test. The trend commands gain `--next-weeks`. It runs from the Monday after the latest stored week through the last complete Sunday, which fills any missed weeks in the same run. `--overlap-weeks <n>` (default 1) recomputes the most recent stored weeks to take in late-arriving rows. The rewrite is idempotent. The orchestrator's run window gains the matching mode, `{"mode": "next-weeks", "overlapWeeks": 1}`, beside today's `{days, end}`.

Done when, on the memory adapter, a first run over six weeks stores six weeks. A second run with `--next-weeks` a week later writes the overlap week and the new week only. A run after a skipped week writes both missing weeks.

### T3. History for new subjects

A run computes a start week per subject. Subjects already stored start at their next week (less the overlap). A new subject, from a new trend selector or a rerank, backfills `--backfill-weeks <n>` (default 8). The trend SQL already takes the subject list as a parameter, so a run groups subjects by start week and runs one query per group.

Done when a run that adds one selector to a page with stored history writes eight weeks for the new selector and the next week for the others.

### T4. Rank on a lookback, write on the window

Ranking runs only when it can change the subjects: on `--rerank`, or when a subject list is short of its limit. It reads its own lookback (`--rank-days`, default 30), separate from the weeks being written, so a one-week run ranks on a month of data.

Done when a `--next-weeks` run with full subject lists issues no `trend:path-rank` or `trend:page-rank` query, and a rerank on a one-week run passes the 30-day lookback to the rank query.

**As built.**

- T1. `runTrend` and `runTagTrend` read from the first Monday to the last Sunday inside the window, and their notes name the edge days left out. The tag-trend table carries the same `week` key.
- T2. The trend store and the session-tag store each name every subject's latest stored week (`readTrendWeeks`, on both adapters and in the contract test). `--next-weeks` reads from the earliest of those, less `--overlap-weeks` (default 1), to the last Sunday before today, and backfills `--backfill-weeks` (default 8) when nothing is stored. The orchestrator's run window takes `{"mode": "next-weeks", "overlapWeeks": 1}`.
- T3. Each path, URL path, page, and selector starts the week after its own latest stored week, less the overlap, or at the backfill when nothing is stored. Subjects that share a start are read in one query, and rows before a subject's start are left out. The step check reads each path's own first week. The tag trend keeps one window, from the earliest start of its frozen keys, since its keys are read together in one query.
- T4. The rank window is placed apart from the written weeks: `--rank-days` (default 30) ending on the run's last Sunday. The path and page ranks run on `--rerank`, or when a stored list is short of its limit. A short list is filled behind the stored subjects, which keep their rank, so a fill adds subjects and leaves the stored series as they are.

### Live check, read-only

`scripts/trend-acceptance.mjs` runs Mellow's trend twice on the live gateway with in-memory persistence. The first run covers six weeks, and the second uses `--next-weeks` over the first run's store. It reports the weeks and rows each run wrote and confirms that the overlap week's rows match the first run's for complete weeks.

**As run.** The script also runs once over both windows on the same subjects, and compares the stored series (the first run's weeks before the overlap, then the second run's) with that full run on every week. Two fixes came out of the first live runs, each with a test on `clickhouse local`:

- A trend session is a visit's rows in one week. Visits, orders, checkouts, rage clicks, pageviews, and clicks are each keyed by visit and the Monday of their own `server_date`, and every join takes both keys. A week reads only its own seven days, so it reads the same from any window that holds it. A visit's `visit_first_action_time` changes within one `idvisit` (2,541 of 189,085 Latico visits over two weeks), so a visit's start depends on how far back a run reads. A visit that crosses Sunday midnight counts in each week it has rows, about 0.1% of sessions.
- A path orders its pageviews by time, then by `idloghsr`, so two pageviews in the same second give one path on every read.

| Site | First run | Second run | Overlap week equals the first run | Store equals the full run |
|---|---|---|---|---|
| Latico (1425) | 2026-08-24 to 2026-10-04, 10,416 rows | 2026-09-28 and 2026-10-05, 3,472 rows, no rank query | 1,736 of 1,736 | equal on all 7 weeks |
| Seat Cover (2501) | 2026-08-24 to 2026-10-04, 9,744 rows | 2026-09-28 and 2026-10-05, 3,248 rows, no rank query | 1,624 of 1,624 | equal on all 7 weeks |

Rows stored before these fixes keep the earlier session count until a run rewrites their week.

## Part S: declarative segmentation

The trend, tag-trend, and experiment segmentations move from hardcoded SQL to one registry of declared and computed segmentations, with site overrides and versions. Requirements are in `docs/plans/segmentation-requirements.md` and the build plan, phases SG0 to SG12, is in `docs/plans/segmentation-implementation.md`. The backfill on a version change (SG9) uses T2's stored weeks and T3's per-subject starts. Part P's profiles can name segmentations from the registry.

## Part P: execution profiles

The source plan was written against the pre-R2.4 `runner-ae.js`. The steps it extracts already exist as handlers in `src/site-analysis/handlers.js` (`qualify`, `captureGate`, `collectDatasets`, `draftDescriptors`, `writeAnalysis`). A profile's step list names those handlers plus the new ones, so the runner loops over a list rather than gaining a second step registry.

| Phase | Delivers |
| --- | --- |
| P1 | `src/domain/subject-types.js`, `src/ports/subject.js`, `src/domain/criteria.js` (the JSON-schema subset), the `subject-selectors` role with `page-primary` and `page-by-kind` over a shared `_lib/subject-candidates.js`, descriptor validation |
| P2 | `subject_type` and `subject_key` on the four tables, `ae_subject_target`, the whitelisted `migrateAeSchema` (exact-match ADD COLUMN only), memory adapter keys, contract tests |
| P3 | `profiles/*.profile.json`, `src/domain/profile.js` loader, `--profile` and `--select`, the implicit `lp` profile, the step list in the runner, subject checkpoint keys. Milestone: `--profile lp` stores the same rows as no flag; `pdp` and `collection` run |
| P4 | `quiz` profile, `quiz-pages` selector, catalog `QZ` |
| P5 | `experiment` profile, `active-experiments` selector, the `experiment-readout` step, catalog `XP` |
| P6 | `funnel` and `journey` profiles, `catalog-funnels` and `journey-paths` selectors, catalogs `FN` and `JR` |
| P7 | the orchestrator `analysis` stage and profile runs, decisions D-10 to D-13 |

Each phase is tested on the memory adapter and fixture gateways. The live matrix in the source plan's §0 ran on `journey_events` with the user's approval (see Live matrix, as run).

**As built.** Where the build departs from the source plan, and what it fixes that the plan left open:

- Storage (D-11). Every `ORDER BY` is unchanged. Identity within a non-page dataset is carried by `row_key` and `segment_key`, and the checkpoint key format is unchanged. Non-page rows sit at `idsitehsr` 0 with `subject_type` and `subject_key`; their dims are stored as `dim_week`, `bot_filter`, and `dim_extra` (JSON), and each card holds `card_json` = `{dims, metrics}`. `lp` also writes `ae_subject_target` for its pages. The migration is tested on a fake client and the memory adapter; it runs live with the first `ensure` against production.
- Segmentations. A profile descriptor may carry an optional `segmentations` field: a list of ids from the segmentation registry, checked when the profile loads, that the profile's trend and experiment reads use in place of the site's defaults. It is not built yet; see `docs/plans/segmentation-implementation.md`.
- Criteria. Each selector's criteria schema lives in its descriptor, and `--select` is checked against it when the batch is created. The step names follow the handlers (`qualify`, `capture-gate`, `page-datasets`, `descriptors`, `site-datasets`, `analysis`), plus `select-subjects` and `subject-datasets`.
- Experiments. A generic `subject-datasets` step and an `experiment-readout` dataset take the place of the plan's `experiment-readout` step. The reversal rule compares bases, standing in for a segment reversal. The XP strategies are scoped to the site. The subject's requirement status lives on its cards (D-12). The card builder `_lib/subject-cards.js` is shared by the XP, FN, and JR cards.
- Counts and skips. For a non-page profile, `pagesSelected` and `pagesAnalyzed` count subjects. A site with no subject is skipped as `no_experiments`, `no_funnels`, or `no_journeys`.
- Catalogs. `lp` pins its catalogs, so the new catalogs leave its cards unchanged. Q01 to Q03 add the requirement rows they lacked; the Q rows are additive.
- Funnels and journeys (D-13). `funnel-steps` and `journey-path` are new datasets; `funnel-sequence-weekly` and `journey-weekly` stay as they are for `lp`. The funnel event list is `events` in `src/catalog/funnels.json`, the six journey types of H12, and the catalog check refuses a step outside it. A funnel id is checked by the criteria enum when the batch is created; a journey path is checked when the profile runs. The subject datasets read the window's sessions in one pull; moving them onto the day scan is a follow-up.
- Orchestrator (P7, D-10). The `analysis` stage runs `bin/analyze-site.mjs`, which creates the batch for the site with the stage's profile and criteria over the job window's day count, writes `{{run.dir}}/batch.json`, and runs the batch. The engine's batch window ends yesterday, so the job window gives the day count only. The `ae-batch-complete` check reads the stored batch through a reader the container hands to the check registry, and passes on `complete` with no failed site. The stage holds `clickhouse-heavy`. A site picks its profile with `"profile"` or `"stageParams"` in `site.json`, applied after the run's layers and before `--set`; a stage the run lacks takes nothing. The general runs are `pdp-full`, `collection-full`, and `quiz-full` (over `full`, without `today-opportunities` and `user-journey`), and `experiment`, `funnel`, and `journey` (over `analysis-only`). `default` stays `naming-only` while `bundle` and `bundle-4mb` are pending. The report stages read the `lp` bundle; per-profile charts and bundle contents are the next step after the live matrix.

### Live matrix, as run

Each batch ran on idsite 3199 over 30 days (2026-09-14 to 2026-10-13), one agent, `--site-source static-idsites`. Every batch completed with no failed site. The §0 criteria take four corrections: the site flag is `--sites`, `funnel` has no `auto` (omit `funnel` and give `{"minSessions":200}`), journey page types are the H12 types (`home`, `collection`, `product`, …), and quiz `urlContains` is an array.

| Profile | Selection | Subjects | Rows | Cards |
|---|---|---|---|---|
| `experiment` | default (active) | 4 experiments | 422 | 16 |
| `experiment` | `{"key":…}` | 1 | 27 | 4 |
| `experiment` | a named experiment the site lacks | site skipped, `no_experiments` | 0 | 0 |
| `funnel` | `checkout` | 1 | 33 | 3 |
| `funnel` | `{"minSessions":200}` | `fn:purchase` | 51 | |
| `journey` | default | 5 paths | 243 | 15 |
| `journey` | `home>collection>product` | 1 | 51 | |
| `pdp` | default | 5 pages, after capture | 124,925 | 665 |
| `collection` | default | 5 pages, after capture | 76,148 | 205 |
| `quiz` | default | 1 page, after capture | 37,562 | 56 |
| `lp` | default | 1 page (63918696), awaiting capture | 0 | 0 |

- Page profiles. The first run queues each chosen page for capture and leaves the site `awaiting capture`; `--run` on the same batch after capture analyzes the pages. The 11 captures took 35 to 180 s each.
- Two fixes came out of the matrix. `funnel` and `journey` wrote `dim_week` `all` into a date column; the stored row now keeps a non-date week in `dim_extra` and reads it back into `dims.week`, and the memory store refuses a non-date `dim_week` (`e7e6cee`). Two CLI processes on one machine shared the telemetry port; the localhost adapter now takes a free port when 9474 is in use (`193dddb`).
- Idempotency. A rerun of a complete batch analyzes nothing and writes nothing (`experiment`: same rows and cards; `quiz`: 25 s, zero writes). A fresh `quiz` batch over the same window stores the same 37 dataset groups with the same row counts, and `card-history` grows by its 4 new cards (211 to 215 rows).
- `lp` parity (the P3 milestone) ran on Latico (1425), whose landing page has a capture: a batch with no flag and a batch with `--profile lp` store the same target, the same 43 dataset groups (266,973 rows), and the same 8 card groups (311 cards), equal by a content hash over every column except `batch_id` and `generated_at`.
- 3199's `lp` page is a bundle builder whose capture holds the naming bot to its 600 s limit, so its capture failed and the batch waits. A naming fix is outside this initiative.
- The fleet source (`--platform shopify --status active`) resolves 2,817 sites. Its run follows the massive-site phase.

## Known boundary differences

Each scan consumer keeps its own open visits from its own start day. The reporting lanes start at `windowStart`, so a visit that began the day before is seen from its first in-window row, as the window query sees it, and the reporting boundary matches exactly. The trigger lane starts earlier for its preface. When a visit's rows tie on `visit_first_action_time`, `argMin` can pick a different row per day than across the window. Fixtures avoid ties, and D6 reports the dimension mismatches it finds. `dwell-model-inputs` cuts at 200,000 rows in arrival order, which was already the window query's arbitrary order.

## Open items before building

- `viewport-weekly` assigns each visit its dominant viewport over the window. Resolved in D4: it stays one window query over the page's visits, shared with `page-segment-weekly`.
- The visit hold (one quiet day) is confirmed by the Mellow span measurement in D6. That measurement is one read-only query and can run first.

## Status

| Phase | State | Commits |
| --- | --- | --- |
| D1 | done | `0cac2ee` |
| D2 | done | `f946aec`, `bafab19`, `a17dd76` |
| D3 | done | `48efb13`, `c59a1ff` |
| D4 | done | `b22a2f7`, `2895934`, `e94dea3` |
| D5 | done | `c23f8bc` |
| D6 | fixes done; Mellow rerun and Loaded Tea deferred to the massive-site phase | `fc1cfef` to `9c15b4c` |
| T1–T4 | built and merged; the live check passes on Latico and Seat Cover after the week-keyed sessions and the path order fix (see Part T, As run) | `def210b` to `e4b3c64`, `777c177` to `b79d3ca` |
| P1–P7 | built and merged; the schema migration ran on `journey_events` (subject columns on five tables, `ae_subject_target`, the chain dims); the live matrix passes on 3199 and `lp` parity on Latico (see Part P, Live matrix); the fleet run follows the massive-site phase | `5a68804` to `c6edf4f`, `e7e6cee`, `193dddb` |
| Chain dims | built and merged | `a44aaff` |
| I0–I5 | built; incremental runs equal full runs on Latico and Seat Cover on the local store, and on Latico on the ClickHouse store (see `docs/plans/incremental-days.md`); `ae_scan_day` exists on `journey_events`; local stores drop days after 400 | `ff3f040` to `eae0a4b`, `98d092b`, `4df90e1` |
| SG0–SG12 | SG0 to SG11 built on `initiative/segmentation` and merged into `scale/11-completion` through `integration/segmentation-on-scale-11` (suite: 140 files, 1,157 tests); `ae_segmentation_definition` exists on `journey_events`; SG12 passes on DVF (`docs/plans/segmentation-implementation.md`) | `be88f5e` to `421d659`, `b8bea09`, `560bd5f` |
