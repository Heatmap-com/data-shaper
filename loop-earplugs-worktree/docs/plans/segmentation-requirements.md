# Declarative segmentation: requirements and strategy

**Written:** 14 October 2026
**Status:** requirements, not implemented
**Reads with:** `docs/VISION.md` (the platform goal), `docs/TREND-ENRICHMENT.md` (the trend grain), `docs/plans/segmentation-implementation.md` (the build plan), `docs/plans/scale-and-profiles-initiative.md` (Part T and Part P)

A segmentation is one way of cutting sessions into a closed list of values: traffic source, new against returning, buyer against not. Every week-over-week table the engine writes stores one segmentation per row, in the `segment` and `segment_value` columns. Today the segmentations are written into the SQL and the rollup code. This document sets out what a declarative replacement has to do, and the strategy for building it.

The aim is the agile half of the vision. A new way of cutting the data should be a declaration an agent can write, the engine can check, and every grain reads the same way. It should not be a code change in four files.

## 1. Terms

| Term | Meaning |
|---|---|
| Segmentation | A named, closed partition of sessions. Its id is what the `segment` column stores, for example `traffic_source` or `channel`. |
| Value | One part of a segmentation, stored in `segment_value`, for example `meta` or `returning`. Every session sits in exactly one value of each segmentation. |
| Declared segmentation | A segmentation defined by a rule table over known fields. Data, not code. |
| Computed segmentation | A segmentation that needs logic a rule table cannot express, such as a lookback over earlier visits. Code, in an adapter. |
| Field | A named per-visit input a rule can test, such as `referer_type` or `utm_medium`. Each field has one SQL expression, one type, and one documented source column. |
| Fact | A field that needs a join beyond the visit row, such as `has_order` or `has_rage_click`. |
| Grain | A table that stores segmented rows: `ae_trend_row`, `ae_session_tag_trend`, `ae_experiment_row`, and later the trigger read path. |
| Override | A site's change to a declared segmentation: rules added before or after the shipped ones, rules removed, or the fallback renamed. |

"Strategy" already means a CRO strategy in `src/catalog/strategies/`. The trend code also calls a segmentation a strategy (`TREND_STRATEGIES`, `TAG_STRATEGIES`). New code says segmentation, so the two meanings stop sharing a word.

## 2. Where it stands today

### 2.1 The hardcoded segmentations

Four segmentations are written into the trend job, and a fifth into the tag trend:

| Segmentation | Where its values come from | Where its values are listed |
|---|---|---|
| `traffic_source` | `TRAFFIC_EXPR` in `src/enrichment/trend-sql.js`: UTM source in a Meta list, else referrer type 1, 2, 3, 6, 7 | `TRAFFIC_VALUES` in `trend-aggregate.js` |
| `returning` | `if(k.returning = 1, 'returning', 'new')`, inline in each aggregate query | `RETURNING_VALUES` |
| `buyer` | `if(ifNull(o.orders, 0) > 0, 'buyer', 'non_buyer')`, inline | `BUYER_VALUES` |
| `rager` | `if(r.idvisit = k.idvisit, 'rager', 'non_rager')`, inline | `RAGER_VALUES` |
| `return_intent` | `RETURN_INTENT_EXPR` and `historyCtes` in `tag-trend-sql.js`: a 30-day lookback over the same `config_id` | `RETURN_INTENT_VALUES` |

Each one appears in five places:

1. The value expression, repeated in `pathAggregateSql`, `pageAggregateSql`, `selectorAggregateSql`, and `tagTrendAggregateSql`.
2. A named output column per segmentation (`traffic_value`, `returning_value`, and so on) in each query's select and group-by.
3. The visit columns in `sessionCtes` that the expressions read. There is no UTM medium or campaign.
4. `cellsOf` and `tagCellsOf`, which copy each named column onto the cell.
5. `TREND_STRATEGIES` and `TAG_STRATEGIES`, which drive the zero grid and the rollup.

`experimentFactSql` in `src/experiments/sql.js` imports `TRAFFIC_EXPR` and repeats the `returning` expression, so experiments carry the same two segmentations.

### 2.2 The declarative pieces that already exist

`src/domain/channel-rules/` (R2.6) is a validated rule language with:

- conditions of `{field, op}` with five operators (`eq`, `ne`, `in`, `like`, `startsWith`), and `any` / `all` groups;
- first-match-wins rule tables with a required fallback;
- site overrides through `resolveChannelRules(kind, {prepend, remove, append, fallback})`;
- a SQL compiler (`channelSql`) and a JS classifier (`createChannelClassifier`) that a `clickhouse local` test proves agree on every combination of a field grid;
- two shipped tables: `VISIT_CHANNEL` (direct, search, email_sms, meta_paid, meta_untagged, affiliate) and `LINK_CHANNEL` (automated_email_flow, affiliate, google_ads, campaign_email_sms, meta, meta_no_link, no_campaign_link).

Only `py/bundle-export.mjs` compiles it. The trend, tag-trend, and experiment grains do not read it.

The session-tag selector role (`src/adapters/session-tag-selectors/`) is the precedent for a computed choice that lives in an adapter. The trigger definitions (`src/triggers/definitions.js`, `ae_trigger_definition`) are the precedent for a versioned declaration with a site override and a stored stamp.

### 2.3 The definitions disagree

The same idea is defined differently in different places:

- **Meta.** The trend job uses UTM sources `facebook, ig, fb, instagram, facebookads`. `LINK_CHANNEL` uses `facebook, facebookads, ig, instagram, igshopping` and also requires a medium or a campaign. `VISIT_CHANNEL` does not read the UTM source at all. It reads the referrer name `facebook` or `instagram`.
- **UTM medium.** `py/bundle-export.mjs` reads it from `custom_var_v1`. The trigger facts read it from the first `udp_session_tags` key matching `/medium/i`. The trend job does not read it.
- **Source.** The trend's UTM source is `custom_var_k5`. The bundle's `src`, which `LINK_CHANNEL` tests, is the UTM source when present and the referrer name otherwise. These are two fields with one name.

A coach who compares "Meta" in a trend row with "Meta" in a bundle chart is comparing two different populations, and nothing tells them so.

## 3. Problem statement

1. **A new segmentation is a code change in at least five places across four queries.** The meeting asks that started this work (email and Google beside Meta, per site) cannot be met without editing `trend-sql.js`.
2. **A definition cannot be shared across grains.** The trend, tag-trend, experiment, bundle, and trigger read paths each define channels on their own.
3. **A changed definition silently mixes a series.** A later write replaces a stored week, so once trends grow week by week (Part T), a changed rule leaves old weeks under the old meaning and new weeks under the new one. No column records which.
4. **The aggregate cost grows as a product.** Each query groups by every segmentation at once and rolls up in JS. Cells per subject, week, and viewport are the product of the value counts: 7 × 2 × 2 × 2 = 56 today. Adding a seven-value channel and the six-value return intent makes 2,352.
5. **An agent cannot add a segmentation safely.** There is nothing to declare, nothing to validate, and no check that proves the new values partition the sessions.

## 4. Goals

- **G1.** A declared segmentation is one JSON document. Adding one changes no code.
- **G2.** One definition per segmentation, read by every grain that stores it.
- **G3.** Sites can override a declared segmentation without forking it.
- **G4.** Every stored row says which version of its segmentation produced it. A changed definition is detected, recorded, and backfilled, never mixed silently.
- **G5.** The cost of a run grows with the sum of the value counts, not their product.
- **G6.** The four shipped trend segmentations produce byte-identical rows after the refactor.
- **G7.** An agent can author, check, and register a segmentation from a question, with the engine rejecting what it cannot validate.

## 5. Non-goals

- Crossing two segmentations on one row (Meta and returning together). The trend grain stores one segmentation per row by design. Crossed cuts stay in `queryTriggerTrends` and in the analyst bundles.
- Device as a segmentation. `viewport_type` stays a column with its own rules.
- A free-form expression language. Rules test known fields with known operators. Arbitrary SQL in a declaration is refused.
- Persona. Its defining behaviour is not agreed (`docs/VISION.md`).
- Changing the facet's read contract. `segment` and `segment_value` keep their meaning.
- Rewriting the `traffic-variance` tag selector. Tag keys are subjects of the tag trend, not segmentations.

## 6. Users and use cases

| User | Use case |
|---|---|
| Coach, through the facet | Reads Meta, email, and Google week over week on the money paths, from one definition of each. |
| Analyst | Gets the same channel in the bundle's `ch` column as in the trend rows. |
| Agent (Cursor, Kimi fallback) | Reads a transcript, sees "email against Meta against Google," writes a site override that splits Google paid from organic, checks it, and registers it. |
| Site operator | Adds a site-specific source such as a TikTok shop or an affiliate network, without a deploy. |
| Engine maintainer | Adds a field or a fact once, then every segmentation can use it. |

## 7. Functional requirements

Each requirement has an id, the rule, and how it is accepted.

### Declaring a segmentation

**R1. A declared segmentation is a JSON document** with `id`, `label`, `purpose`, `data`, `rules`, and `fallback`. `rules` is an ordered list of `{value, when}`, where `when` is a condition in the channel rule language. First match wins.
*Accepted when* the five shipped trend and tag segmentations other than `return_intent` are each one document, and the loader rejects a document missing any field, naming the field and the file.

**R2. The value list is closed and derived.** The values are the distinct rule values in first-appearance order, then the fallback. A segmentation has at least two values. `all` is reserved. A value matches `^[a-z0-9_]+$`. A segmentation has at most 16 values.
*Accepted when* a document with a single value, a value named `all`, an uppercase value, or a seventeenth value fails load with the reason.

**R3. A segmentation can extend a shipped rule table.** `"base": "visit"` or `"base": "link"` starts from `VISIT_CHANNEL` or `LINK_CHANNEL`, and `prepend`, `remove`, `append`, and `fallback` adjust it with the existing `resolveChannelRules` semantics.
*Accepted when* a `channel` segmentation declared as `{"base": "visit"}` classifies every combination of the existing channel grid exactly as `VISIT_CHANNEL` does.

**R4. Shared lists.** A condition can name a list instead of repeating it: `{"field": "utm_source", "in": "@meta_utm_sources"}`. Lists live in one file. An unknown list name fails load.
*Accepted when* no source list is spelled out in code. The two Meta UTM lists in use today (the trend's and `LINK_CHANNEL`'s) become two named lists in the one file, `@meta_utm_sources_trend` and `@meta_utm_sources`, until open decision 2 settles them into one. Parity (R12) forbids merging them earlier.

**R5. Fields are a closed, typed registry.** Each field has a name, a type (`string` or `number`), a SQL expression over the visit query's aliases, the source column, and the CTE it needs, if any. A rule can test only a registered field, and only with an operator and value of the field's type.
*Accepted when* a rule on an unregistered field, `eq: 1` on a string field, or `like` on a number field fails load with the field's type in the message.

**R6. Facts are fields that need a join.** `has_order`, `has_checkout`, and `has_rage_click` are number fields (0 or 1) whose entries name the CTE that supplies them. A query includes a fact's CTE only when a selected segmentation reads it.
*Accepted when* the shipped `buyer` and `rager` segmentations are declarations over `has_order` and `has_rage_click`, and a run with neither selected issues no `ragers` CTE.

**R7. Fields never return null.** Every field's SQL is wrapped so a missing value is `''` or `0`, matching the JS classifier's `row[field] ?? ''`.
*Accepted when* the twin test (R10) includes null inputs for every field.

### Computed segmentations

**R8. A computed segmentation is an adapter** in `src/adapters/segmentations/`, discovered like any other role, with a sibling descriptor. It supplies its value list, its SQL value expression, the CTEs and query parameters it needs, its version, and the fields and facts it reads.
*Accepted when* `return_intent` moves into an adapter, and the tag trend's rows are unchanged.

**R9. Declared and computed segmentations share one registry.** A duplicate id across the catalog, the adapters, or a site file fails startup, naming both sources.

### Correctness

**R10. SQL and JS agree.** Every declared segmentation compiles to a ClickHouse expression and to a JS classifier, and a `clickhouse local` test proves they give the same value on a generated grid of every field's edge values, nulls included. Computed segmentations supply a JS twin where one is possible, and say so in the descriptor when it is not.

**R11. Values partition sessions.** For every segmentation written, the values' sessions add up to the `all` row on the same subject, week, and viewport. The run's acceptance check tests every written segmentation, not only `traffic_source`.
*Accepted when* `verifyTrend` fails on a fixture where one segmentation's values do not add up.

**R12. Parity for the shipped segmentations.** With the default selection, the trend, tag-trend, and experiment jobs write exactly the rows they write today. The one deliberate difference is the `metrics.segmentation_version` key (R15), which lands after parity is proven, as its own reviewed change to the characterization.
*Accepted when* a characterization test recorded on the old code matches the new code on the DVF proof fixture and the `clickhouse local` fixtures, row for row, before the version key is added.

### Versioning

**R13. Each segmentation has a version per site.** The version comes from a canonical stamp of the resolved definition (shipped document plus site override plus any list it references), using the trigger definitions' `canonical` and version-bump rules. An unchanged stamp keeps the stored version. A changed stamp increments it.

**R14. Definitions are stored.** `ae_segmentation_definition` holds `(idsite, segmentation, version, stamp, definition, values, generated_at)`, with `idsite = 0` for the shipped default. It is reference data, read through a `_current` view.

**R15. Rows carry their version.** Each segmented row stores `metrics.segmentation_version`. The `all` rows do not, because they are not segmented.

**R16. A version change backfills.** When a site's version of a segmentation changes, the next run rewrites every stored week of that segmentation for that site, for every subject. A value the new definition no longer has is written as a zero row with `metrics.retired = true`, so the partition still holds and no delete is needed. The run's notes name the segmentation, the old and new versions, and the weeks rewritten.

**R17. Renaming is a new segmentation.** A segmentation's id is part of the sort key. Changing what `traffic_source` means in place would break its history, so a different meaning is a new id. The shipped `traffic_source` stays as it is, and the channel rules land as a new `channel` segmentation.

### Selection and overrides

**R18. A run selects segmentations by id.** `--segmentations traffic_source,returning,channel` on `--trend` and `--tag-trend`. Without the flag, the site's list applies, and without a site list, the shipped default: the four trend segmentations, plus `return_intent` on the tag trend.

**R19. Site files.** `orchestration/sites/<slug>/segmentations.json` names the site's `idsite`, its default selection, and its overrides keyed by segmentation id. It loads through `src/composition/registries.js`, the same way `trend-seeds.json` does. A file for an unknown segmentation, or an override that breaks R2 or R5, fails the run before any query.

**R20. A per-run budget.** A run's selected segmentations compile into one query when their value counts sum to at most 48, and into several queries otherwise, each under the budget. The budget is configuration.

### Grains

**R21. The trend grain reads the registry.** `pathAggregateSql`, `pageAggregateSql`, `selectorAggregateSql`, and the rollup take the selected segmentations as input. No segmentation is named in their code.

**R22. The tag-trend grain reads the registry.** The same, for `tagTrendAggregateSql` and `tagTrendRows`.

**R23. The experiment grain reads the registry.** `experimentFactSql` takes its segmentations from the registry, defaulting to `traffic_source` and `returning`.

**R24. The bundle reads the registry.** `py/bundle-export.mjs` takes `ch` from the `channel` segmentation, so the bundle and the trend rows agree.

**R25. The trigger read path can segment by a declared segmentation.** `queryTriggerTrends` accepts `segment_by: ['segmentation:channel']` and classifies each hit's session with the JS twin. It refuses a computed segmentation without a twin.

### Agent authoring

**R26. A read-only check.** `node src/cli.js --segmentation-check --sites <idsite> --segmentation <id or file> --week YYYY-MM-DD` loads and validates the definition, then runs one bounded query for that site and week. It prints each value's sessions, orders, revenue, and share, the partition sum against the week's total, and the version it would get. It writes nothing.
*Accepted when* the check exits non-zero on a validation error, on a partition mismatch, or when one value takes more than 98% of the sessions, which usually means a rule never matched.

**R27. A skill.** `skills/segmentation-authoring/SKILL.md` tells an agent how to go from a question to a declaration. The steps: find the fields, prefer an override of a shipped segmentation to a new one, run the check, read the shares, and register the declaration. The skill also says when to stop and ask a person, for example when a merchant's UTM conventions are unknown.

## 8. Non-functional requirements

| Id | Requirement |
|---|---|
| N1 | **Bounded queries.** Every compiled query passes the gateway's fact-table guard and the query-bounds registry. A test pins `queryBoundGaps` to an empty list for a query compiled from every shipped segmentation at once. |
| N2 | **No injection.** Field names come only from the registry and pass `sqlIdentifier`. Values pass `sqlString`. A declaration cannot carry SQL. |
| N3 | **Determinism.** The same definition, site, and window give the same rows. Value order, list resolution, and stamps are canonical. |
| N4 | **Cost.** On DVF's proof window, the refactored trend run with the default selection takes no more than 1.25 times today's query seconds, and a run with `channel` and `return_intent` added stays under 2 times. |
| N5 | **Layering.** `src/domain/segmentation/` imports only domain code and no Node built-ins, as the architecture tests require. File reads live in the catalog loader and in `src/composition/`. |
| N6 | **No destructive DDL.** `ae_segmentation_definition` is `CREATE TABLE IF NOT EXISTS`. `ae_trend_row` is not altered. The DDL lint stays green. |
| N7 | **No site literals.** No idsite appears in `src/`. Site definitions live under `orchestration/sites/`. |
| N8 | **Observability.** Each run's notes list the segmentations, their versions, the queries they compiled into, and any backfill. |

## 9. Strategy

These are the design decisions and why each one was chosen.

### S1. Declarations first, adapters only where a rule cannot reach

Most segmentations are a rule over visit fields. Making them data gives an agent something it can write and the engine something it can check. Code adapters remain for the cases a rule cannot express (a lookback, a window function, a model), and they use the same port, so a grain does not care which kind it reads.

*Rejected:* one adapter file per segmentation. That is the current problem in a different directory, and the code an agent writes is harder to check than a rule table.

### S2. One condition language, the one already built

The channel rule language already has validation, site overrides, a SQL compiler, a JS twin, and a parity test. Generalizing it (typed fields, list references) is cheaper and safer than designing a second language.

*Rejected:* JSON Logic or a SQL-subset parser. Either adds a dependency or an injection surface, and neither has a proven JS and ClickHouse twin in this repository.

### S3. Closed registries of fields and facts

The registries are the boundary between what an agent may declare and what a maintainer must code. Adding a field is a reviewed one-line entry with a source column and a type. Every segmentation can then use it. The registry is also where the disagreements in §2.3 get settled, because each field names exactly one source.

### S4. Fan out in SQL, do not cross

Each query emits one tuple per selected segmentation per visit, with `arrayJoin`, and groups by `(segment, segment_value)`. `experimentFactSql` already uses this shape. Output cells per subject, week, and viewport become 1 plus the sum of the value counts (14 today, not 56; 27 rather than 2,352 with `channel` and `return_intent` added), and adding a segmentation adds its values instead of multiplying them. The cost moves to intermediate rows, multiplied by the number of segmentations, which the existing external group-by setting handles. The budget (R20) caps it.

*Rejected:* keeping the product and rolling up in JS. It does not scale past five or six segmentations, and it is the reason the tag trend's cells are already large.

### S5. Version like the triggers

The trigger definitions solved the same problem: a site override, a stored stamp, and a version that moves only when the meaning does. Reusing `canonical` and the bump rule keeps one versioning idea in the engine. Storing the version in `metrics` avoids altering `ae_trend_row`, which is protected.

*Rejected:* a `segmentation_version` column. That needs an `ALTER TABLE ADD COLUMN` on a protected table, and the whitelisted migration path in Part P does not exist yet. The column can be promoted later if the facet needs to filter on it.

### S6. Keep `traffic_source`, add `channel`

`traffic_source` is what the facet is being built against for 8 November. Changing its values now would move the target. It becomes a declaration with identical output. `channel` carries the channel rules forward. The facet moves to `channel` when the team decides, and `traffic_source` is then frozen, not deleted.

### S7. Overrides in the orchestration tree

Sites already carry their identity, periods, and trend seeds in `orchestration/sites/<slug>/`. Segmentation overrides go beside them, so a site's whole configuration lives in one place and the orchestrator's site layering applies.

### S8. The agent's check is a query, not a claim

An agent's segmentation is accepted when the engine's check passes on real data, as the orchestrator already does for every agent fallback. The check reads one site and one week, so it is cheap enough to run on every draft.

## 10. How an agent adds a segmentation

From the October merchant call: "the funnel for total, Meta, email, and Google."

1. The agent finds that `channel` (base `visit`) already has `email_sms` and the Meta values. Organic Google lands in `search`, but `VISIT_CHANNEL` has no Google rule, so paid Google arriving as a tagged campaign falls to `other`.
2. It writes a site override that prepends `{"value": "google_paid", "when": {"all": [{"field": "referer_type", "in": [2, 6]}, {"field": "utm_medium", "eq": "cpc"}]}}`, ahead of the `search` rule.
3. It runs `--segmentation-check` for the last complete week and reads each value's share, and that the partition sum equals the week's total.
4. It commits `orchestration/sites/<slug>/segmentations.json` with `channel` in the site's default list.
5. The next trend run stores `channel` at version 2 for that site and writes the stored weeks under it.

If the check shows `google_paid` at 0%, the agent stops and asks how the merchant tags Google. It does not guess another rule.

## 11. Risks

| Risk | Mitigation |
|---|---|
| The fan-out multiplies intermediate rows on the largest sites. | The budget (R20) splits queries. N4 is measured on DVF, then on Mellow before the large-site runs. |
| A wrong override is versioned and backfilled across every stored week. | The check (R26) runs before registration. A bad version is fixed by a later version, which backfills again. Nothing is lost. |
| Retired-value zero rows confuse a reader. | The facet reads the values from `ae_segmentation_definition_current`, and `metrics.retired` marks them. |
| `metrics` JSON is slower to filter than a column. | The version is for audit and backfill, not for the facet's filter. Promote it when a consumer needs it. |
| Field sources disagree (medium in §2.3). | Phase 0 of the plan measures the agreement and records a decision before the field is registered. |
| Agents create many near-duplicate segmentations. | The skill prefers overrides of shipped segmentations. A new id needs a purpose that no shipped one covers, and review. |

## 12. Open decisions

1. **The canonical UTM medium source.** `custom_var_v1` (the bundle) or the session tag (the triggers). Phase 0 measures how often they agree.
2. **The facet's Meta.** Whether the coach's "Meta" is the UTM list, the referrer name, or both. The mechanism supports any of them. The choice is a product decision.
3. **The budget and the value cap.** 48 and 16 are starting values, to be set from the Phase 0 cost measurement.
4. **When the facet moves from `traffic_source` to `channel`.** After 8 November at the earliest.
5. **Whether `rager` stays shipped by default.** It costs a clicks scan on every run.

## 13. Success criteria

- The four shipped trend segmentations and `return_intent` run from the registry with identical rows (G6).
- A `channel` segmentation and one site override exist as data only, pass the check, and are written by the trend, tag-trend, and experiment jobs (G1, G2, G3).
- Changing that override bumps its version, and the next run rewrites the stored weeks under the new version (G4).
- The trend run on DVF with `channel` and `return_intent` added stays within N4 (G5).
- An agent, given the October transcript and the skill, produces a passing site override without code changes (G7).
