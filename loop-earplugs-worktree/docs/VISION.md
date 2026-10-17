# Vision

This is the Enterprise data enrichment program. Heatmap already records the most detailed behavioral data in the category. The raw log is not the shape anyone asks a question in. A coach asks how Meta did on the money paths this week, whether new visitors come back and buy, or which swatch earns the most per session. Each of those needs the raw data transformed into a shape that answers it.

The platform does that transformation in two ways.

1. **Routine.** Every transformation we already know is needed runs on a schedule, for every site that needs it, and is checked before anyone reads it. The stored rows are the reliable answer to the questions people ask of our data.
2. **Agile.** A question nobody has asked before becomes a new dataset with very little effort. An agent builds it, because the engine's extension points are declarations and single files with checks, not rewrites.

The test of the second way: drop a client meeting transcript into Cursor, say "prepare the dataset that will facilitate the next step of analysis based on this conversation," and get back the datasets that can be built, built, plus a list of what is blocked and why.

The raw log stays where it is. The product is the transformed rows.

## The problem

A coach asks a comparative question. Meta against everyone else. New against returning. This journey step against last week. This element on the pages that matter. The warehouse can compute any one of those, and today each one is a new query with its own grain. The Roswell extract proved the cost of that. Path, week, and source never land on the same row, so "how is Meta doing on our top money paths, week over week" cannot be answered. Page type is weekly and has no source. A specific page is one 28-day league. Named elements stored a snapshot of zeros, because the selectors were dated after the window. Referrer channel is weekly for the site and the funnel, and it never meets a page or an element.

That is a measurement problem, and it has two halves. The questions we already know about need a stable grain that is built every week, so nobody rebuilds it by hand. The questions we do not know about yet need a cheap path from question to dataset, so a new comparison is not a project.

## Routine transformation

A routine transformation is one we know is required. It runs without a person starting it, on every site it applies to, and it stays correct as new weeks arrive.

What makes it reliable:

- **The orchestrator runs it.** Stages are declared, idempotent, and leased, and a completion check decides success, not the exit code. A dead worker's stage returns to the queue.
- **It grows by the week.** A run adds the new week and leaves the stored weeks in place. A short overlap recomputes the most recent week for late rows. A new subject backfills its history.
- **A rerun replaces, never stacks.** Every output table is `ReplacingMergeTree(generated_at)` read through a `_current` view, and the batch id is not in the identity.
- **It verifies its own output.** Each transformation has an acceptance check, such as `verifyTrend`, that confirms the partitions add up before the rows are trusted.
- **It stays inside the warehouse budget.** Every fact query is bounded to one site and a date range, and a governor keeps the jobs on idle capacity so they do not crowd out collection.

The routine set today:

| Output | What it answers |
|---|---|
| `ae_trend_row` | Week-over-week journeys, pages, and elements, by traffic source, returning, buyer, rager, and device. |
| `ae_trigger_hit`, `ae_trigger_chain` | Who showed intent, abandoned a cart, or became a super-shopper, and whether the same visitor came back and bought within the chain window. |
| `ae_session_tag_trend` | Week-over-week results by the UTM and campaign tags that actually separate revenue, plus return intent. |
| `ae_dataset_row`, `ae_strategy_card` | The per-page analysis datasets and the strategy states the reports read. |
| `ae_experiment_row` | Partner experiment readouts by arm, section, and element. |

A transformation joins the routine set when a client needs it every week, or when the same custom dataset has been asked for twice. Promoting it means giving it a stage, a schedule, and a check. It does not mean rewriting it.

## Agile transformation

A new question should cost as little as the engine allows. There are four levels of effort, and the agent's job is to choose the lowest one that answers the question.

| Level | What the agent produces | Examples |
|---|---|---|
| Read | Nothing new. The question is a filter on stored rows. | Meta against all on the money paths, from `ae_trend_row`. |
| Declare | A configuration row or file. The engine validates it on load. | A trigger definition of an existing predicate type. A site's channel rules. A selector list for a page. An execution profile with selection criteria. A funnel definition. |
| Extend | One new file and its descriptor, with tests and an acceptance check. | A dataset adapter. A new trigger predicate type. A subject selector. A new chain outcome field. |
| New grain | A new subject type or table. Rare, and reviewed by a person. | A grain the existing tables cannot hold without breaking an invariant. |

Each level up costs more review. Declarations are cheap because the engine checks them: an unknown id, step, event name, or field fails at load with the valid names listed. Extensions are bounded because the gateway rejects any fact query that is not bounded to one site and a date range, and the characterization tests pin the existing outputs so a new file cannot quietly change an old one.

The engine does not trust the agent. The orchestrator gives the agent the work, then runs the same check it would have run on a deterministic step. The agent's claim that the dataset is right counts for nothing until the check passes.

### From a conversation to a dataset

A conversation holds requests for data mixed with everything else. The agent separates them, maps each request to a level, and reports what it built, what it declared, and what it could not do.

An October 2026 VIP merchant call is the worked example. The merchant's Meta conversion had fallen by about 60% while email held steady. The working hypothesis was that the first visit looks the same for good and bad traffic, and the loss is in how visitors are brought back.

| Request in the call | Level |
|---|---|
| The funnel for all traffic, Meta, email, and Google, week over week | Read for Meta. Declare the shipped `channel` segmentation in the site's trend defaults for email, and Google paid as a site override of `channel`. |
| The money paths by traffic source, week over week, top and dead | Read for the top paths. Declare a dead-journey rank (high sessions, no revenue). |
| Do new visitors from each source come back and buy, and on which visit | Declare a broad trigger, then read the chains by source with `returning = new`. |
| Does the return visit land on what the visitor looked at before | Extend the chain with the return visit's source, landing page, and page overlap. |
| Which colour swatches earn the most per session | Declare the selectors for that page, then wait for trustworthy names. |
| What the merchant has already tested | Ask the merchant. It is not in the warehouse. |

The same call also held a partner introduction, a meeting cadence, and a GA4 attribution gap. The first two are not dataset requests, and the agent leaves them out. The GA4 gap is one once the site has a GA4 connection: sessions by source and medium beside GA4's own, a Declare.

The agent writes the requests it found as one request file, each with the question in the merchant's words, and `node src/cli.js --shape <file> --out <dir>` answers all of them at once. Each request comes back built (a CSV, the same rows as JSON, and a dictionary of what every column means), read (the query on stored rows), blocked (with what is missing), or needing a person (with the level and the file the change goes in). `skills/dataset-requests/SKILL.md` is the procedure.

## What the platform will not do

Agility does not license invented answers. These rules hold at every level.

- **Blocked is a result.** Missing data, an unnamed element, a requirement the warehouse cannot meet, or a volume below the floor is stored and reported as that state. It is never filled with a guess.
- **Identity limits are stated.** `config_id` is a browser id, not a person. A visitor who arrives in Meta's in-app browser and returns in Safari, or on another device, is two visitors, and that undercounts Meta's returns. A cross-visit answer says how much of its traffic that affects.
- **A definition lives in one place.** A segment such as Meta is defined once and every grain reads it. The trend, tag-trend, experiment, bundle, and trigger paths all read one segmentation registry. Declared segmentations live in `src/catalog/segmentations/`, and their source lists are named once in `src/domain/segmentation/lists.js`.
- **Correlation stays correlation.** Revenue on an element row is the revenue of visits that clicked it. It ranks elements. It does not say the click caused the sale.
- **Questions the data cannot answer go back to a person.** A merchant's test history, UTM conventions, or the pages they care about are asked for, not inferred.

## The trend row

`ae_trend_row` is the first routine grain and the one the coaching facet reads first. One table holds a journey, a page, and an element. An experiment uses the same table later. Segmentation is a pair of columns, so a new way of cutting the data does not add a column and does not add a table.

| Column | Role |
|---|---|
| `idsite` | Always set. |
| `idsitehsr` | The page, when the subject is one page. `0` when it is not. |
| `row_type` | `journey`, `page`, `element`, or later `experiment`. |
| `row_key` | The subject family: `step`, `path`, `template`, `page`, `element_class`. |
| `row_key_1` | The subject: a step name, a template path, a template, a page id, or an element class such as `pdp.gallery_main`. |
| `row_key_2` | The rest of the identity. A selector on an element row. A URL on a page row. Empty when there is nothing else. |
| `segment` | The segmentation id from the registry, for example `traffic_source`, `returning`, `buyer`, `rager`, or `channel`. `all` is the unsegmented total. |
| `segment_value` | One value of that segmentation. `meta`, `new`, `buyer`, `rager`, `all`. |
| `week` | The Monday of the week. |
| `sessions`, `buyers`, `orders`, `revenue`, `clicks`, `progressed` | The same measures on every row. A facet compares these without parsing JSON. |
| `metrics` | Extra measures for that row type. They are not the comparison. |

How the keys are filled:

| `row_type` | `row_key` | `row_key_1` | `row_key_2` | `idsitehsr` |
|---|---|---|---|---|
| `journey` | `step` | `checkout_started` | empty | `0` |
| `journey` | `path` | `home > pdp` | empty | `0` |
| `page` | `template` | `pdp` | empty | `0` |
| `page` | `page` | the page id | the URL when it is known | that page id |
| `element` | `element_class` | `pdp.gallery_main` | the selector | the page id, or `0` for the class across a template |

`docs/TREND-ENRICHMENT.md` records the keys the built job writes, including the URL path and step families.

A journey row is either one step or one whole path. Both are `row_type = journey`. The step rows are the breakdown. The path rows are the journey with its metrics, so a coach can see the path and the step without joining two designs.

Within one `segment`, the values partition the sessions. `traffic_source` uses `meta` as its own value, built from the UTM sources `facebook`, `ig`, `fb`, `instagram`, and `facebookads`, and the other values cover the rest of the traffic so that a session sits in one value. `returning` is `new` or `returning`. `buyer` is `buyer` or `non_buyer`. `rager` is `rager` or `non_rager`. The `all` / `all` row is the total, stored on purpose. Summing every `segment_value` across segmentations counts the same session more than once. A facet reads one segmentation.

`buyer` is a partition of sessions, not a conversion opportunity. Sessions in `segment_value = buyer` already bought. Read that cut as how buyers moved through the journey, not as a rate to optimize.

Device, persona, and a page a merchant has flagged as in focus are further strategies. They use the same two columns. Persona, including an instant shopper against a reader, waits until the behavior that defines it is agreed. Flagged pages are a list the aggregation reads: the pages in focus, how many weeks each one is missing, and a backfill of those weeks.

The trend row holds one strategy per row and does not cross them. Cross-visit outcomes cut by device and channel together do not fit it, so they stay in the trigger tables and are read through `queryTriggerTrends`. That is a deliberate second grain, not a gap.

`src/enrichment/trend-row.js` builds a row and rejects a week that is not a Monday. `writeTrendRows` stores it. The latest write of the same identity replaces the week. The Roswell catalog in `src/audit/` stays the evidence and the roadmap for which measures matter. New trend readings go to `ae_trend_row`, not into another `dim_extra` shape on `ae_dataset_row`.

## What a coach can ask once the rows exist

- How did Meta perform on the top money paths, week over week? `row_type = journey`, `row_key = path`, `segment = traffic_source`, `segment_value = meta`, against `segment = all`.
- How did each step of the journey move for new sessions against returning sessions?
- How did the important pages, and the important elements on them, move week over week for one source?
- Of the new visitors from each source this week, how many came back within 14 days, how many bought, and on which visit? From the trigger chains.

The Roswell extract cannot answer these. `data/roswell-audit/DATA.md` is the dictionary of what that extract does contain. `docs/PROJECT-PLAN.md` is the order in which the new rows get built.

## How it gets read

Facet is the integration. Prince can build the facet against a sample of this table while the aggregation is still filling it. The facet returns the stored weeks and the stored segment. It does not recompute them from `log_visit`. Talk to My Data calls the facet. An API in front of the same tables can come after the facet works. The MCP does not learn the tables.

Analysts and agents read the same stored rows, through the analyst bundles and the reports. Nothing downstream rebuilds a number from the raw log.

## How it gets built

The trend readings come first, in this order. The naming work runs beside the first two, not in front of them.

1. **Journey.** Week-over-week steps and whole paths, with the first strategies: traffic source, new versus returning, buyer versus not, rager versus not. This does not need element names. It is the first value, and it is the dataset the facet can start on.
2. **Page.** The same strategies on page type, then on the pages that matter. A page matters because it earns revenue or because someone flagged it. The URL is stored on the row so the coach sees a page, not only an id.
3. **Element.** The same strategies on the important element classes. This reading stays empty until names are trustworthy. Important classes come from a descriptor, plus site-specific regular expressions in config, plus the classes the aggregation itself reports as carrying data. The naming system names what it already considers important and what this API asks it to name. Heuristics alone are not the whole rule. Agentic naming is part of the naming track, owned with Joseph Barnes.

Experiment is the fourth reading, in the same table, after these three. That is the point at which the set is something another company cannot assemble, because the element classification does not exist anywhere else.

The platform work runs alongside, in this order:

1. **Incremental weeks.** Trend runs take their window from the store, add the new week, and backfill new subjects (`docs/plans/scale-and-profiles-initiative.md`, Part T).
2. **Segments as data.** Trend strategies read the channel rule tables, so a new channel split is a declaration and Meta has one definition.
3. **Execution profiles.** A profile binds a subject type, selection criteria, a dataset set, and a step list, so landing pages become one subject among pages, funnels, journeys, quizzes, and experiments (`docs/plans/execution-profiles.md`, Part P).
4. **Chain return attributes.** The chain records the return visit's source, landing page, and overlap with the pages the visitor saw before, so retargeting can be judged.
5. **Dataset requests.** A schema an agent fills from a question or a transcript: subject, strategies, measures, window, and rank. The engine answers with what it can build, what is blocked, and what needs a person.

ClickHouse capacity is the constraint on how many of these jobs run at once. A governor belongs on the runner so the fleet of jobs uses idle CPU and does not crowd out collection. An admin panel that accepts a packaged adapter, checks it, and registers it is a later way to add a strategy. It is not the way the first three readings ship. Shopify theme scope, so that a name can be judged stale from the theme's update time, is the same: wanted, not in front of the first reading.

The coaching conversation on 15 November 2026 needs a subset of this, not the full strategy catalog. The facet bar is earlier: by 8 November 2026 the facet in production should answer week-over-week journey by traffic source, and week-over-week elements on the key pages, from this table. A Wednesday strategy review, 14 October 2026, is where the team says what in this repository is the starting point and what gets rewritten. The grain above is the part that stays either way.

## Where it stands

| Piece | State |
|---|---|
| Single-file dataset adapters, discovered on start | Built. 48 adapters. |
| Orchestrator with declared stages, checks, and agent fallback | Built. |
| Day-at-a-time scan for very large sites | Built. The largest-site runs are deferred. |
| `ae_trend_row` journey, page, and selector rows | Built and proven on DVF. |
| Trigger hits and chains, with config-only triggers | Built. |
| Session-tag trends with return intent | Built. |
| Incremental weeks | Planned. |
| Declarative segmentations read by every grain | Built. Versioned, with backfill on a change. The live acceptance run waits for the user. |
| Execution profiles and subject types | Planned. |
| Chain return attributes | Not started. |
| Dataset requests from a question or a transcript | Built for sessions: `--shape` answers a request file with built datasets, stored-row reads, blocked reasons, and what needs a person. Day, week, month, quarter, and window periods, rolling sums, previous-period comparison, an attribute catalog, and source kinds for Meta Ads, GA4, and a site catalog. Sources are read through a simulated file adapter; no real connector yet. |
| External sources (GA4, Meta Ads, Shopify) | Port, kinds, and a synthetic-file adapter built. Real connectors, stored source tables, and ingest runs not started. |

## What this repository already is

The schema-2 engine, the audit catalog, and the five-brand extract are the starting point for the measures and the proof of which grains fail. They are not the trend product. A checkout contains the extract in `data/roswell-audit/` and the traps in `DATA.md`: the ordered funnel is not a landing page, element clicks in that extract are zero because of selector dates, and Peter Thomas Roth has no orders. Those traps still apply to anyone reading that extract. They are not the shape of `ae_trend_row`.
