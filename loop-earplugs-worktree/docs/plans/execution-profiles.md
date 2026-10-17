# Execution profiles — implementation plan

**Prepared:** 2026-10-13
**Status:** plan, not implemented
**Supersedes nothing.** This plan extends the schema-2 pipeline (`src/runner-ae.js`). The v1 runner stays untouched.

## 0. Success criterion

A single mechanism — an **execution profile** — binds a subject type, a selection criteria schema, an adapter set, and a pipeline step list. When this plan is done, all of the following must work (site `3199` is the standing pilot; any idsite behaves the same):

```text
# Page subjects (today's behavior, expressed as a profile)
node src/cli.js --batch --profile lp --idsites 3199 --window-days 30
node src/cli.js --run --batch <id>

# Page subjects with arbitrary selection criteria
node src/cli.js --batch --profile pdp --idsites 3199 --select '{"minEntrySessions":100,"kinds":["product"]}'
node src/cli.js --batch --profile collection --idsites 3199 --select '{"minEntrySessions":50}'

# Quiz — page-shaped subject selected by URL/descriptor criteria
node src/cli.js --batch --profile quiz --idsites 3199 --select '{"urlContains":"quiz","minEntrySessions":30}'

# Experiment subject — no capture gate, experiment readout pipeline
node src/cli.js --batch --profile experiment --idsites 3199 --select '{"state":"active","minAssignedVisits":500}'
node src/cli.js --batch --profile experiment --idsites 3199 --select '{"experiment":"post-purchase-survey"}'

# Funnel subject — funnel definition from the catalog events registry
node src/cli.js --batch --profile funnel --idsites 3199 --select '{"funnel":"checkout"}'
node src/cli.js --batch --profile funnel --idsites 3199 --select '{"auto":true,"minSessions":200}'

# Journey subject — cross-page path analysis
node src/cli.js --batch --profile journey --idsites 3199 --select '{"path":"home>collection>pdp","minSessions":100}'

# Arbitrary site via the fleet source, arbitrary profile
node src/cli.js --batch --profile pdp --site-source active-ecommerce-sites --select '{"kinds":["product"],"limitPerSite":3}'

# Orchestrated end-to-end (report stages per profile)
bin/orchestrator enqueue --site sayii --run pdp-full
```

**Non-goals**

- v1 pipeline (`src/runner.js`) gains nothing. Profiles are schema-2 only.
- No new findings/prose layer. Cards and stored states remain the output; reports stay orchestrator-side.
- No second claim worker pool, no lease redesign. The site-grain claim protocol is unchanged.
- Trigger *evaluator* extensions (new predicate types) are out of scope except where a subject type requires one; missing trigger support surfaces as `blocked`.

## 1. Concepts

### 1.1 Definitions

| Term | Definition |
| --- | --- |
| **Subject type** | The grain of one analyzed unit: `page`, `experiment`, `journey`, `funnel`, `quiz`. `pdp`, `collection`, `lp` are *profiles over* the `page` subject type, distinguished by selection criteria and catalog, not by engine mechanics. |
| **Subject target** | One unit selected for analysis: `{subjectType, key, idsite, label, dims}`. The generalization of today's `AePageTarget`. |
| **Subject selector** | Adapter role that turns `(site, criteria)` into `SubjectTarget[]`. Generalizes `src/adapters/page-selectors/`. |
| **Execution profile** | Declarative bundle: subject type + selector id + criteria schema/defaults + adapter set + catalog ids + pipeline step list. Data, not code. |
| **Pipeline step** | A named, pure-ish phase of the runner (capture gate, subject datasets, site datasets, requirements, gates, cards, readout). Profiles pick steps; the runner executes the list. |

### 1.2 Design rules (normative)

1. **A profile is data that binds existing ports. No profile registry inside the runner, no `switch` on profile id.** Selection stays by adapter id via `ctx.select` (`src/composition/engine.js:59-62`); profiles only change *which* ids are selected and *which* steps run.
2. **Page-shaped subject types reuse everything.** Quiz/PDP/collection subjects are `page` subjects with different selectors and catalogs. Only genuinely non-page subjects (`experiment`, and `journey`/`funnel` when defined across pages) exercise the new subject machinery.
3. **The subject loop replaces the page loop.** Every per-page loop in `processSite` (`src/runner-ae.js:283-314, 316-339, 385-429, 455-475, 480-524`) iterates subject targets instead. Dataset adapters are untouched: a profile's adapter set guarantees page-only adapters never see a non-page subject.
4. **Blocked is a result.** A subject type without cards/triggers/coverage stores what it can and reports explicit requirement statuses; it never throws or fabricates.
5. **All writes stay idempotent.** Subject identity changes must preserve the `row_key` semantics (`src/adapters/_lib/rows.js:1-20`: `md5` of sorted dims, idsitehsr *not* hashed) and the ReplacingMergeTree + `_current` (FINAL) read pattern.

### 1.3 Profile descriptor schema

Profiles live in `profiles/<id>.profile.json` (repo root, new directory — loaded by both the engine CLI and the orchestrator; keeping them out of `orchestration/` avoids making the engine depend on the orchestrator's descriptor root).

```json
{
  "id": "pdp",
  "subject_type": "page",
  "label": "Product detail pages",
  "selector": { "role": "subject-selectors", "use": "page-by-kind", "default_criteria": { "kinds": ["product"], "minEntrySessions": 100 } },
  "qualifier": { "use": "prefer-non-home", "optional": true },
  "datasets": { "include": ["provides", "cards-pi", "cards-pg"], "exclude": [] },
  "catalogs": ["PI", "PG"],
  "steps": ["capture-gate", "subject-datasets", "site-datasets", "requirements", "cards", "analysis"],
  "capture": { "required": true, "devices": ["desktop", "mobile"] },
  "criteria_schema": { "type": "object", "properties": { "kinds": {"type":"array","items":{"type":"string"}}, "minEntrySessions": {"type":"integer"}, "limitPerSite": {"type":"integer"} } }
}
```

Field semantics:

- `id` — kebab-case; unique across `profiles/`. Also usable as `--profile` value and as a run name suffix in the orchestrator.
- `subject_type` — one of the registered subject types (§1.4). Validated against the registry at profile load.
- `selector` — `role` defaults to `subject-selectors`; `use` is an adapter id validated against the discovered role at startup (unknown id → startup error listing discovered ids, same contract as `selectAdapter`, `src/discover.js:223-233`).
- `qualifier` — page-subject profiles keep the qualifier (site must qualify before selection). Non-page profiles set `"optional": true` or name a different qualifier; the runner skips qualification status `skipped_*` handling per profile (`counts.skipped` still applies).
- `datasets.include` — two forms: explicit adapter ids, or `"provides"` meaning "all discovered datasets minus excluded, minus `cards-*` not in `catalogs`". `cards-*` membership is further filtered by `catalogs`. This is the one genuinely new selection rule (today `src/application/commands/batch.js:53` passes **all** discovered adapters); it is profile data evaluated in the composition root, not runner logic.
- `steps` — ordered list from the step registry (§4.2). Unknown step → profile load error naming valid steps.
- `capture.required` — false for `experiment` (no render/naming exists for experiments); the capture-gate step is a no-op when absent from `steps` or when `required` is false.
- `criteria_schema` — JSON Schema (draft 2020-12 subset: `type`, `properties`, `required`, `items`, `enum`, `minimum`, `additionalProperties:false` at the top level). `--select` JSON is merged over `default_criteria` and validated at batch creation; a criteria violation is a usage error before any ClickHouse write.

### 1.4 Subject type registry

`src/domain/subject-types.js` (pure, deep-frozen, architecture-test eligible):

```js
export const SUBJECT_TYPES = deepFreeze({
  page:       { keyKind: 'idsitehsr', capture: true,  pageAnalysis: true },
  quiz:       { keyKind: 'idsitehsr', capture: true,  pageAnalysis: true },   // page-shaped
  experiment: { keyKind: 'experiment_key', capture: false, pageAnalysis: false },
  funnel:     { keyKind: 'funnel_id', capture: false, pageAnalysis: false },
  journey:    { keyKind: 'journey_id', capture: false, pageAnalysis: false },
});
```

`keyKind` names the subject key domain; `capture`/`pageAnalysis` drive step defaults. Adding a subject type is one entry here + a selector + (eventually) a catalog — validated, frozen, testable like the taxonomy.

### 1.5 Subject port — `src/ports/subject.js` (new)

JSDoc-typedef only, no imports (same rule as all ports):

```js
/**
 * @typedef {Object} SubjectRef
 * @property {'page'|'quiz'|'experiment'|'funnel'|'journey'} subjectType
 * @property {string} key            subject key: idsitehsr as string, experiment_key, funnel_id, journey_id
 * @property {number} idsite
 * @property {string} label          human label (url, experiment name, funnel name)
 * @property {Object<string,string|number>} dims  selector-emitted dims (kind, state, path, ...) → dim_extra
 */

/**
 * @typedef {Object} SubjectSelectorPort
 * @property {string} id
 * @property {string} subjectType
 * @property {(site: {idsite:number, siteName:string}, criteria: object, ctx: RunContext)
 *   => Promise<SubjectRef[]>} select
 */

/**
 * @typedef {Object} SubjectContext      // generalizes QualifiedPage inside the runner
 * @property {SubjectRef} subject
 * @property {number} idsite
 * @property {number} [idsitehsr]        // set for page/quiz subjects only
 * @property {string} [url]              // page-shaped subjects
 * @property {string} [pageType]
 * @property {{entrySessions:number, orders:number, revenue:number}} [qualified]
 * @property {Object} [evidence]         // subject-type-specific evidence (arms, steps, path)
 */
```

Compatibility rule: `SubjectContext` carries the fields today's dataset adapters read (`idsite`, `idsitehsr`, `url`, `pageType`, `qualified`). Page-subject profiles therefore run **all existing page datasets unchanged**. Non-page profiles declare adapter sets that only contain adapters written against `subject`/`evidence`.

## 2. Phase 1 — Subject selectors (engine extension point)

**Goal:** `src/adapters/subject-selectors/` mounts and `--select` criteria flow to a selector; page selectors become subject selectors without breaking `ANALYSIS_PAGE_SELECTOR`.

1. **New adapter role directory `src/adapters/subject-selectors/`.** Mounting is automatic — `discoverAdapterRoles` (`src/discover.js:163-181`) reads every non-`_` directory; no edit to `discover.js`. Each module exports `adapter` with `{id, subjectType, select}` plus a sibling `<name>.descriptor.json`:
   ```json
   { "page-by-kind": { "purpose": "...", "data": "...",
       "criteria": { "type": "object", "properties": {...}, "required": [] } } }
   ```
   The loader (`discover.js:95-108`) validates the descriptor has `purpose`/`data`; extend that validation to require `criteria` for this role and to require `adapter.subjectType` to exist in `SUBJECT_TYPES`.

2. **Shipped selectors** (one file each, `+` descriptor):

   | File | id | subjectType | Behavior |
   | --- | --- | --- | --- |
   | `page-by-kind.js` | `page-by-kind` | page | The per-URL aggregation from `default-six` (`src/adapters/page-selectors/default-six.js:57-103`) refactored into `src/adapters/_lib/subject-candidates.js`; filters by `kinds` (page types), `minEntrySessions`, `urlContains`, `limitPerSite`; sorts by entry sessions desc |
   | `page-primary.js` | `page-primary` | page | Wraps the existing qualifier + `primary-only`: criteria `{"maxPages":N}`; preserves today's default profile behavior exactly |
   | `quiz-pages.js` | `quiz-pages` | quiz | `page-by-kind` + quiz detection: URL pattern criteria **or** render/descriptor signal (`ae_render_node`/`ae_page_descriptor` rows marking interactive step containers); emits `dims.kind='quiz'` |
   | `active-experiments.js` | `active-experiments` | experiment | Reads `ae_experiment_descriptor_current` + lifecycle scan over `udp_partner_tags` (reuse `src/experiments/lifecycle.js`, constants `ACTIVE_SHARE=0.1, RECENT_DAYS=14, MIN_VISITS=200`); criteria: `state` (`active`\|`ended`\|`all`), `minAssignedVisits`, `experiment` (exact key or name), `limitPerSite`; emits `dims.state`, `dims.partner` |
   | `catalog-funnels.js` | `catalog-funnels` | funnel | Resolves funnel definitions (§5.4) from `src/catalog/events.json`; criteria: `funnel` (id), `auto` (pick all funnels with ≥ `minSessions` entry sessions in window), `limitPerSite` |
   | `journey-paths.js` | `journey-paths` | journey | Builds path clusters from `journey_events_map` sessions (the clustering logic currently inside `journey-weekly.js` refactored to the shared lib); criteria: `path` (explicit `a>b>c` template sequence), `minClusterShare`, `minSessions`, `limitPerSite` |

3. **Back-compat shim.** `src/adapters/page-selectors/*` stay. `src/application/commands/batch.js:8-14` changes from selecting `page-selectors` to: profile absent → synthesize the implicit `lp` profile (selector `page-primary`, catalogs all, today's step list, `maxPages` from `--max-pages`); profile present → select from `subject-selectors` by profile. `ANALYSIS_PAGE_SELECTOR` keeps working via the implicit profile.

4. **Criteria plumbing.** `--select '<json>'` parses in `batch.js` (JSON.parse with a usage error naming the profile's `criteria_schema` on failure); merged `criteria = {...default_criteria, ...cli}`; validated by a small `src/domain/criteria.js` (pure JSON-schema subset validator — no dependency added; ~120 lines) so validation is unit-testable without ClickHouse.

**Tests:** loader validation (bad subjectType, missing criteria, duplicate id); each selector against fixture gateway responses (the existing `clickhouse-local`/fake-client test harness); criteria validator; back-compat (no `--profile` → identical adapter selection as today, asserted via a characterization snapshot of `batchAdapters` output).

## 3. Phase 2 — Persistence: subject identity

**Goal:** non-page subjects persist with a first-class identity; pages keep working bit-for-bit; writes stay idempotent; the destructive-DDL guard is not weakened.

### 3.1 Schema changes (`src/persistence/schema2.sql`)

Add to `ae_dataset_row`, `ae_analysis_checkpoint`, `ae_requirement_status`, `ae_strategy_card`:

```sql
subject_type LowCardinality(String) DEFAULT 'page',
subject_key  String DEFAULT '',
```

Semantics: for `page`/`quiz` subjects, `subject_key = toString(idsitehsr)` and `idsitehsr` stays the numeric column; for others `idsitehsr = 0` and `subject_key` carries the identity (`experiment:funnel:...` prefixed keys, e.g. `exp:kameleoon:12345`). The prefix prevents cross-type key collisions.

New table (pages migrate lazily; old table left in place, reads switch to the new one):

```sql
CREATE TABLE IF NOT EXISTS ${DATABASE}.ae_subject_target
(
    batch_id         UUID,
    idsite           UInt32,
    subject_type     LowCardinality(String),
    subject_key      String,
    idsitehsr        UInt64,          -- page-shaped subjects only
    label            String,
    role             LowCardinality(String),
    selection_reason String,
    dims             String,          -- JSON selector dims
    status           LowCardinality(String),
    reason           String,
    generated_at     DateTime64(3)
)
ENGINE = ReplacingMergeTree(generated_at)
ORDER BY (batch_id, idsite, subject_type, subject_key);
```

`ae_page_target` is deprecated, not dropped (guard + zero need). `writePageTargets`/`updatePageTarget` gain subject-generalized siblings; the port keeps the old names as page-only conveniences during migration.

### 3.2 Migration mechanics

`ensureAeSchema` is create-only (`src/adapters/persistence/clickhouse/schema-migrator.js:341-381`; guard regex only bans `DROP|TRUNCATE|ALTER TABLE ... DELETE`), so **adding columns needs a new, explicit, non-destructive path**:

1. New `migrateAeSchema(client, database)` in `schema-migrator.js`, called once from the composition root after `ensureAeSchema` (registered alongside the `ae`/`trend` ensure keys in `src/composition/engine.js:17-19`). It runs only:
   ```sql
   ALTER TABLE <db>.ae_dataset_row ADD COLUMN IF NOT EXISTS subject_type LowCardinality(String) DEFAULT 'page';
   ALTER TABLE <db>.ae_dataset_row ADD COLUMN IF NOT EXISTS subject_key String DEFAULT '';
   -- same pair for ae_analysis_checkpoint, ae_requirement_status, ae_strategy_card
   ```
   Statements are whitelisted by an exact-match list (no free-form DDL), each logged, and the function refuses to run any statement not in the list. This is the deliberate, reviewed exception to "no ALTER" — ADD COLUMN IF NOT EXISTS is non-destructive and reversible (columns are additive).
2. ORDER BY stays as-is (ClickHouse cannot alter it in place). Filter cost on `subject_key` is acceptable at current scale; if profiling later says otherwise, the escape hatch is the `ae_trend_row` precedent — a gated empty-table rebuild (`ensureTrendTables`, `schema-migrator.js:390-414`) refusing when rows exist, plus an operator-run rebuild via `scripts/rebuild-schema.mjs`. Documented as deferred.
3. `memory-ae` gains the same columns/keys (`memory/support.js` key shapes: `datasetRows: batchId:idsite:subjectType:subjectKey:datasetId:rowKey`). Memory adapter is a complete mirror today (all 10 role ports, no stubs) so contract tests catch shape drift.

### 3.3 Port changes (`src/ports/persistence.js` typedefs + both adapters)

- `AeDatasetRow`, `AeAnalysisCheckpoint`, `AeRequirementStatusRow`, `AeStrategyCardRow` gain `subjectType`/`subjectKey`; `idsitehsr` stays.
- New `writeSubjectTargets(batchId, idsite, targets)` / `updateSubjectTarget(update)` on BatchStore; `writePageTargets` delegates for page subjects.
- `readDatasetRows({batchId, idsite, idsitehsr, datasetId})` gains an overload `readSubjectDatasetRows({batchId, idsite, subjectType, subjectKey, datasetId})`; checkpoints read stays per-site (already all-subject: `clickhouse/dataset-store.js:103-120`).
- `deleteDatasetRows` accepts `subjectType`/`subjectKey` filters.
- Experiment row keys are unchanged — `ae_experiment*` is already non-page-grain and stays the system of record for experiment facts; subject-typed dataset rows *reference* experiments by `subject_key`.

**Contract tests:** extend `test/ae-persistence-contract.test.js` with: subject target round trip; dataset rows for an experiment subject hydrate back with identical dims/metrics; rerun replaces (not duplicates); page-subject rows byte-identical to today (regression).

## 4. Phase 3 — Runner generalization

**Goal:** `processSite` executes a profile-declared step list over subject targets; page profiles reproduce today's behavior exactly (characterization test).

### 4.1 Refactor `src/runner-ae.js` (mechanical, no behavior change for the default profile)

Extract the existing phases — the code already has clean seams (`processSite` at `runner-ae.js:185-530`) — into `src/pipeline/steps.js`:

```js
export const STEPS = {
  'select-subjects':   runSelectSubjects,     // today: pageSelector.select + writePageTargets (203-216)
  'capture-gate':      runCaptureGate,        // today: captureIsFresh loop (218-252)
  'traffic-exclusion': runTrafficExclusion,   // today: 256-278
  'subject-datasets':  runSubjectDatasets,    // today: per-page loop 283-314
  'descriptors':       runBotDraft,           // today: 316-339 (page subjects only)
  'site-datasets':     runSiteDatasets,       // today: 348-379
  'requirements':      runRequirements,       // today: 385-429
  'cards':             runCards,              // today: 434-475
  'analysis':          runAnalysis,           // today: 477-527 (writes ae_page_analysis per page subject; ae_site_analysis always)
  'experiment-readout': runExperimentReadout, // NEW (§5.5); site-scope
};
```

Each step is `async (siteRun, deps) => void` mutating a per-site `siteRun` object `{batch, site, qualification, subjects, analyzed, siteCollected, counts, checkpoints}`. The profile's `steps` array names the sequence; the runner loops `for (const step of profile.steps) await STEPS[step](siteRun, deps)`. `processSite` becomes ~40 lines of orchestration.

Step guards (fail loud at batch creation, not mid-run): `capture-gate` requires `profile.capture.required` machinery and page-shaped subjects; `descriptors` requires page subjects; `experiment-readout` requires `subject_type === 'experiment'`. A profile declaring an incompatible step is a profile validation error.

### 4.2 The subject loop

`runSubjectDatasets` iterates `siteRun.subjects` (each a `SubjectContext`) instead of page targets:

- Checkpoint key becomes `` `${subjectType}:${key}:${datasetId}` `` (generalizes `checkpointKey(idsitehsr, datasetId)` at `runner-ae.js:543-545`; page subjects produce `page:<idsitehsr>:<datasetId>` — the checkpoint *table* key adds columns, so old and new checkpoint keys coexist; hydration only reads new-format keys, which is safe because a missing checkpoint means "collect", and collection is idempotent).
- `commitCollected` passes `subjectType`/`subjectKey` into `toAeDatasetRows` (generalizes `toAeDatasetRows` at `runner-ae.js:663`; the v1 `row_key` hash inputs are unchanged — dims only).
- `requirement-status` and cards read subject-keyed rows via the new read overloads.

### 4.3 Analysis writes

- `ae_page_analysis` — written only for page-shaped subjects, unchanged shape.
- `ae_site_analysis` — unchanged (site grain); metadata gains `subjects: [{type, key, status}]`.
- Non-page subjects: no per-subject analysis table in this plan. Their rollup is cards + requirement statuses + dataset rows, keyed by subject. (If a per-subject summary table proves necessary, it is additive later — same pattern as `ae_page_analysis`.)

### 4.4 Counts and statuses

- `counts` gains `subjectsSelected`, `subjectsAnalyzed` (page profile maps them to today's `pagesSelected`/`pagesAnalyzed` so batch columns stay meaningful).
- `ae_site_queue` is unchanged (site-grain claims, `clickhouse/batch-store.js:123-169`); statuses stay site-level. `ae_subject_target.status` carries per-subject states (`selected`, `awaiting_capture`, `analyzed`, `failed`, `skipped`).
- `ae_batch` gains `profile LowCardinality(String)` and `subject_type LowCardinality(String)` (both DEFAULT '' via the §3.2 migration path; createBatch fills them).

## 5. Phase 4 — CLI, composition, profiles

1. **`src/profiles/` loader:** `src/domain/profile.js` (pure): `loadProfiles(dir)` reads `profiles/*.profile.json`, validates (§1.3 schema, registry cross-refs, step names, catalog ids against `loadCatalog()` families, selector ids are *not* validated here — that's runtime discovery), deep-freezes, fails startup on duplicate/invalid ids naming the file. `src/catalog/index.js:43-80` is the validation style to copy.
2. **Composition (`src/composition/engine.js` + `src/application/commands/batch.js`):**
   - `parseFlags` needs no change (`--profile pdp`, `--select '{...}'` already parse as string values, `src/application/commands/args.js:4-20`).
   - `batch.js` `batchAdapters` (lines 8-14) becomes profile-aware: resolve profile (flag `--profile` > env `ANALYSIS_PROFILE` > implicit `lp`); select the selector from `subject-selectors`; subset datasets per `datasets.include/exclude` + `catalogs` (cards adapters filtered by `catalogs` membership: `cards-lp` ↔ catalog `LP`, the same mechanical derivation the runner uses at `runner-ae.js:441`).
   - `--batch` persists `profile`, `subject_type`, `criteria` (JSON in `metadata`) on `ae_batch`.
   - `--run` threads the resolved profile into `runAeBatch` deps; runner reads the step list from the batch's profile (re-resolved at run time and checked against the stored id — a changed profile file mid-batch is a startup error, runs are reproducible).
3. **Config (`src/config.js`):** add `profiles: { dir: 'profiles' }` (env `ANALYSIS_PROFILES_DIR`). Nothing else; agent counts and naming config are profile-independent.
4. **Validation errors are usage errors** (exit 2 with the profile's criteria_schema printed), consistent with the CLI's existing `!result.ok → exitCode 1` protocol (`src/cli.js:39-56`).

## 6. Phase 5 — Subject-type implementations

Ordered so each step leaves the system runnable.

### 6.1 Profiles `lp`, `pdp`, `collection` (page subject) — *mechanical, no new engine work after Phases 1–4*

- `profiles/lp.profile.json`: selector `page-primary`, today's full dataset set, catalogs all, today's step list. **Acceptance: a batch run with `--profile lp` produces byte-identical ClickHouse rows to a run without the flag** (characterization test over the memory adapter comparing row maps).
- `profiles/pdp.profile.json`: selector `page-by-kind` (`kinds:["product"]`, `minEntrySessions:100`), catalogs `["PI","PG"]`, datasets `include:["provides"]` minus campaign/ad families that are landing-specific (explicit `exclude` list in the profile), steps: full list.
- `profiles/collection.profile.json`: same with `kinds:["collection"]`.
- Selector work: refactor the per-URL aggregation out of `default-six.js` into `src/adapters/_lib/subject-candidates.js` (both use it; `default-six` behavior pinned by existing tests/snapshots).

### 6.2 Profile `quiz` (page-shaped subject)

- `profiles/quiz.profile.json`: subject_type `quiz`, selector `quiz-pages`, catalogs `["PI"]` + new `QZ` (below), capture required.
- Quiz detection (selector): URL-pattern criteria first; descriptor signal second (`ae_page_descriptor` rows for interactive containers); both pinned by fixtures. A page that matches neither is simply not selected — no guessing.
- Catalog `QZ` (new `src/catalog/strategies/quiz.json` + `requirements.json` entries + `cards-quiz.js` + descriptor): loader validation (`src/catalog/index.js:43-80`) requires unique ids and registered requirement keys. Initial QZ set: step-abandonment, step-time, restart-loop, completion-rate strategies. Trigger definitions: reuse `session_events` predicates over the closed event taxonomy (`src/catalog/events.json`; D-01 — no properties column exists, one event name per state). If quiz events are absent (today: zero rows for pilots), every QZ requirement is `missing` and cards read `conditional` naming the requirement — the honest-empty path the architecture already mandates.
- `ae_capture_queue`/capture gate unchanged (quiz pages render and name like any page).

### 6.3 Profile `experiment` (first non-page subject)

- `profiles/experiment.profile.json`: subject_type `experiment`, selector `active-experiments`, steps `["select-subjects","experiment-readout","site-datasets","requirements","cards","analysis"]` (no capture gate, no subject page-datasets, no descriptors).
- **Experiment readout step** (`runExperimentReadout`): site-scope; for each experiment subject, runs the existing four-phase scan — the body of `src/adapters/datasets/experiment-analysis.js` refactored so its per-experiment readout (`readoutRows`, `sectionReadoutRows`, `elementReadoutRows` from `src/experiments/readout.js`) can run for *selected* experiments rather than the top-25 auto-scan. Honors the documented join fact: in `udp_partner_tags`, `idloghsr` holds the visit id (`src/experiments/sql.js:5-7`). Writes `ae_experiment_row` (identity unchanged — batch_id is stored but not keyed) and emits subject-typed dataset rows (`subject_type='experiment'`, `subject_key='exp:<key>'`) so checkpoints/hydrate/replay work.
- Catalog `XP` (new family + cards): strategy cards for SRM failure, underpowered arms, segment reversal, element-level lift — initial set derived from existing readout outputs (all numbers already computed; cards are interpretation over stored rows).
- Guardrails: sites with no partner tags (site 3207 per D-07) → selector returns zero subjects, site stores `skipped` reason `no_experiments`; never an error.

### 6.4 Profile `funnel`

- Funnel definitions are catalog data: new `src/catalog/funnels.json` — `{id, title, steps:[event names from events.json], entry_page_types?, window_days}`; validated against the closed event taxonomy (unknown event name → catalog load error).
- Selector `catalog-funnels`: explicit `funnel` id, or `auto:true` picks funnels whose first-step sessions ≥ `minSessions` in the window (one grouped query over `journey_events_map`).
- Datasets: generalize `funnel-sequence-weekly` (its hardcoded `STEPS`, `src/adapters/datasets/funnel-sequence-weekly.js:14-21`, become profile-subject `evidence.steps`) — the adapter keeps working for the lp profile via its defaults; funnel subjects pass steps via `SubjectContext.evidence`. New small dataset `funnel-drop` emitting per-step drop rates keyed by subject if `funnel-sequence-weekly`'s grain proves insufficient — decided during implementation; the port cost is identical.
- Catalog `FN` + cards: step-drop cards, bottleneck cards, comparison-to-site cards.

### 6.5 Profile `journey`

- Selector `journey-paths`: explicit `path` criteria (`home>collection>pdp` template sequence, matched against the site path clusters) or auto mode (`minClusterShare`, `minSessions`). Path-cluster building refactored out of `journey-weekly.js` into `subject-candidates.js`.
- Datasets: `journey-weekly` generalized the same way as funnel (cluster selection by subject evidence), plus `trigger-chains` (already site-scope, subject-agnostic) and `nav-next-page` semantics at path scope if the profile's catalog calls for it.
- Catalog `JR` + cards: path-leak cards, step-order friction, loop cards.

## 7. Phase 6 — Orchestrator integration

Profiles become orchestrated end-to-end runs. The orchestrator's existing machinery covers nearly everything; this phase is descriptors, not code, except where noted.

1. **Stage `analysis` lands** (`orchestration/stages/analysis.stage.json` — currently a `pending` placeholder): handler `command`: `node src/cli.js --batch --profile {{stage.params.profile}} --idsites {{site.idsite}} --select '{{stage.params.select}}'` (template values flow through `ctx.render`, `src/orchestrator/domain/template.js:21-28`; `{{site.idsite}}` already resolves from `site.json`); check: new `ae-batch-complete` completion check (adapter in `src/orchestrator/adapters/checks/`) reading `ae_batch_current` for `status='complete'` and `sites_failed=0` for the job's batch — checks, not exit codes, adjudicate (`src/orchestrator/application/execute-stage.js`).
2. **Profile runs** (`orchestration/general/runs/<profile>-full.run.json`): `["naming", "analysis(profile)", "bundle", "bundle-4mb", "chart-render", "site-opportunity-report", "style-pdf"]` using the run layer's existing `patch`/`extends` mechanism (`src/orchestrator/domain/run-descriptor.js:29-56`) over `full`. Chart specs per profile added to the report stages' `charts` blocks (`chartProblems` validation at `src/orchestrator/domain/charts.js:28-48`); new chart types land in `py/lib/chart_types.py` only where a profile needs a figure the library lacks.
3. **Site-level profiles**: `orchestration/sites/<slug>/site.json` gains `"profile": "pdp"`; run resolution prefers the site profile for the `analysis` stage params (site overrides general, matching the prompts/prompts layering).
4. **Governor**: `analysis` stages claim the existing `clickhouse-heavy` capacity slot; per-profile concurrency comes from `ANALYSIS_AGENTS`, unchanged.

## 8. Testing — the definition of done

| Test | Proves |
| --- | --- |
| `profile-loader.test.js` | Valid profile loads; duplicate id, unknown step, unknown subject_type, criteria schema without `additionalProperties:false`, catalog id not in the bundle → named load errors |
| `criteria.test.js` | `--select` merge + validation; CLI override beats `default_criteria`; violation is a usage error before any write |
| `subject-selectors.test.js` | Each selector against fixture gateway data: page-by-kind filters/sorts; quiz-pages URL+descriptor detection; active-experiments lifecycle + criteria (incl. `state:'ended'`, exact key); catalog-funnels resolves only events in `events.json`; journey-paths explicit + auto |
| `runner-profile.test.js` (memory adapter, per existing `runner-ae.test.js` pattern) | Each profile's step list executes in order; page profile reproduces today's row maps **exactly** (characterization); experiment profile skips capture gate and writes subject-typed rows; checkpoint/hydrate round trip for an experiment subject; mid-batch profile change refused |
| `ae-persistence-contract.test.js` (extended) | §3.3 contract additions pass on memory + ClickHouse-over-fake-client |
| `architecture` suites | `layers.test.js`: `src/pipeline/` imports only ports/domain/application; `composition-only.test.js` allowlist gains `src/pipeline/` only if it needs env (it must not); `migrateAeSchema` whitelisted statements pinned by exact-match test; profile dir access only from composition |
| `ddl-lint` | schema2.sql still contains no destructive DDL; new columns carry `DEFAULT` so old writers (v1 replay paths) do not break |
| Catalog validation | `quiz.json`/`FN`/`XP`/`JR` load under the unmodified loader rules (unique ids, registered requirement keys) |
| Live acceptance | The §0 command matrix against idsite 3199 (and one idsite per other pilot): batches complete, `ae_subject_target` counts match selectors, rerun of the same batch is a no-op (idempotent), `--profile lp` parity with a no-flag run |

## 9. Risks and decisions to ratify

Record as `docs/decisions/2026-10-13-d10-execution-profiles.md` (and d11–d13 as needed):

1. **D-10 — Profiles are data, not a registry.** Profile binding happens in the composition root; the runner receives a resolved step list. Rationale: preserves "no switch" and keeps runner/profile evolution independent. Rejected alternative: a `ProfilePort` with per-profile modules — duplicates discovery and invites per-profile forks of the runner.
2. **D-11 — Subject identity is additive.** `subject_type`/`subject_key` columns with a whitelisted ADD COLUMN migration; ORDER BY unchanged, gated rebuild deferred. Rejected: rebuilding `ae_dataset_row` now (downtime + risk for a perf problem not yet measured).
3. **D-12 — Non-page subjects have no per-subject analysis table (initially).** Cards + requirement status + dataset rows are the output. Rejected: a generic `ae_subject_analysis` JSON-blob table (the v1 `metadata` experience showed blobs resist SQL filtering; promote columns when a real consumer needs them).
4. **D-13 — Quiz/funnel/journey semantics use only the closed event taxonomy** (D-01 constraint). No properties column, no invented events; absence reads `missing`/`conditional`.
5. **Risks:** profile creep (every profile ships its own dataset forks — guard with the `subject-candidates.js` shared lib and code review); selector cost on big fleets (auto modes run grouped per-site queries — the gateway's one-idsite-per-query guard keeps this safe by construction); checkpoint format change (old batches resume by re-collecting, which is idempotent — acceptable); memory-adapter drift (contract tests are the guard).

## 10. Build order

1. **P1** Subject port, registry, selectors lib + `page-by-kind`/`page-primary`, criteria validator, loader validation. *(System unchanged behaviorally; page selectors still default.)*
2. **P2** Schema columns + `ae_subject_target` + migration path + memory adapter + contract tests. *(Deployable alone; nothing writes subject rows yet.)*
3. **P3** Step extraction in `runner-ae.js` + subject loop + `--profile`/`--select` CLI + profile loader + implicit `lp` profile. **Milestone: `--profile lp` parity proven; `pdp`/`collection` profiles run end-to-end.**
4. **P4** `quiz` profile + QZ catalog + capture for quiz pages. **Milestone: quiz selection criteria work on a pilot site.**
5. **P5** `experiment` profile + readout refactor + XP catalog. **Milestone: first non-page subject persists and replays.**
6. **P6** `funnel` + `journey` profiles + catalogs + dataset generalizations. **Milestone: §0 command matrix fully green.**
7. **P7** Orchestrator stages/runs + acceptance run on 3199 + decisions D-10–D-13 recorded.

Each phase ships with its tests green and is independently deployable; P3 is the only phase that changes default-path behavior, and only under a flag until parity is proven.
