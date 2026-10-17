# Hypothesis Builder — Architecture

**Status:** proposal (no code exists; the repo does not exist yet)
**Boundary:** governed by `docs/decisions/2026-10-14-d10-hypothesis-builder-boundary.md` (D-10) — sibling repo, read-only seam, engine checks adjudicate every build
**Style contract:** this document proposes an architecture for a *separate repository*, deliberately aligned with the analysis-engine's own rules: hexagonal, declarative, ports-and-adapters, SOLID, short code files, DRY, KISS. Where this repo has a working pattern (discovery, checks-not-claims, prompts-as-data), the builder adopts the pattern rather than the code.

---

## 1. Purpose and position

The analysis-engine is the **data transformation machine**: it measures, stores states, and refuses to write prose. The hypothesis builder is the **question machine**: it turns a client's question into hypotheses, compares hypotheses against what the platform already knows, plans the data shaping, and drives the agentic build — then reads the refreshed cards and composes the answer.

The workflow it implements (the vision's *Agile* mode):

```text
1. Question      "Why is my Google traffic performing worse than direct? It used to outperform."
2. Framing       clarify scope, era, definitions — interactive
3. Hypotheses    a structured, ranked list built with the user and the engine's vocabulary
4. Gap analysis  hypothesis needs vs. requirement registry vs. stored coverage
5. Shaping plan  every gap classified: Read / Declare / Extend / New grain
6. Agentic build proposals cross to the engine; engine checks adjudicate; cards refresh
7. Answer        cited synthesis from stored states — never recomputed numbers
```

Positioning rule (from D-10): **the builder proposes; the engine disposes.** The builder never writes engine tables, never recomputes a number, and never presents an un-cited claim. The engine never knows the builder exists.

---

## 2. System at a glance

```text
┌─────────────────────────── hypothesis-builder (sibling repo) ───────────────────────────┐
│                                                                                          │
│   conversation surface        domain (pure)              application                     │
│  ┌──────────────────┐   ┌───────────────────────┐   ┌───────────────────────────────┐  │
│  │ CLI now          │   │ question, hypothesis, │   │ intake, framing loop, gap     │  │
│  │ Slack later      │──▶│ gap, plan, answer     │──▶│ analysis, planner, synthesizer│  │
│  │ (adapters)       │   │ (pure rule tables)    │   │ context builder, engine proxy │  │
│  └──────────────────┘   └───────────────────────┘   └───────┬───────────────┬───────┘  │
│                                                             │               │          │
│                                       ports (typedefs only) ▼               ▼          │
│   ┌─────────────┐ ┌──────────────┐ ┌──────────────┐ ┌────────────┐ ┌───────────────┐  │
│   │ SessionStore│ │ EngineRead   │ │ Llm          │ │ Proposal   │ │ HierarchyIndex│  │
│   │ (sqlite)    │ │ (CH readonly)│ │ (kimi first) │ │ (PR / job) │ │ (compiled ctx)│  │
│   └─────────────┘ └──────────────┘ └──────────────┘ └────────────┘ └───────────────┘  │
└───────────────────────────────────────────┬──────────────────────────────────────────────┘
                                            │ read-only `_current` views + catalog (pinned)
                                            ▼
                              analysis-engine (ClickHouse, sole writer)
```

Two subsystems inside the builder:

1. **The context builder** — compiles the engine's information hierarchy into a versioned index, and assembles *context packs*: cited, checkable slices of that hierarchy relevant to a question. This is the component that must be "trained" on the transformation machine; §5 is dedicated to it.
2. **The workflow engine** — the question → hypotheses → gaps → plan → build → answer state machine, driven declaratively, with the agent (LLM) behind a port and every agent claim re-verified by a deterministic check.

---

## 3. Architectural rules (normative)

Adopted from the analysis-engine, restated so the sibling repo can enforce them independently:

1. **Hexagonal, strictly.** Domain logic never imports an adapter, a port file, Node built-ins (where avoidable), or the network. Adapters implement ports. The composition root wires everything and is the only place env vars are read — enforced by a `composition-only` architecture test with a pinned allowlist, copied from `test/architecture/composition-only.test.js`.
2. **Ports are JSDoc typedefs.** No port file imports anything. An adapter is selected **by id**; there is no switch. Unknown id fails startup listing the discovered ids (`src/discover.js` pattern: filename-ordered directory scan, duplicate-id rejection).
3. **Declarative over procedural.** Prompts are Mustache templates in files. Question classification, hypothesis templates, and gap taxonomies are **data** (deep-frozen rule tables validated at load). A new hypothesis family is a JSON file, not a code change.
4. **SOLID with short files.** One concept per file; a file that exceeds ~200 lines is a review trigger. Ports segregate; adapters are thin and single-responsibility; domain modules depend on abstractions only.
5. **DRY across the seam, not through it.** The builder and engine share **vocabulary, not code**: requirement keys, strategy ids, effort levels, event names — all read from the engine's published read model at a pinned version. No npm dependency on the engine repo (D-10 rejected it).
6. **KISS in retrieval.** Deterministic, structured retrieval first; embeddings sit behind an optional adapter, never in the domain. If a context pack can't be assembled from the structured index, that is a gap result, not an excuse to guess.
7. **The engine does not trust the builder; the builder does not trust the agent.** Every agent claim is re-verified by a deterministic check before it is shown to a user or emitted as a proposal. "The agent's check is a query, not a claim" — copied verbatim as a rule.
8. **Blocked is a result.** A question the hierarchy cannot support gets an explicit gap list, not a fabricated answer. Every blocker names the requirement key or table that is missing.

---

## 4. Domain model (pure)

All in `src/domain/`, frozen rule tables where possible. The state machine:

```text
Question → Framing → HypothesisSet → GapAnalysis → ShapingPlan → Proposals → EngineBuild(s) → Answer
   intake    loop      ranked set      per need      effort-leveled   artifacts    tracked refs    cited prose
```

Core typedefs (each its own file):

- **`question.js`** — `{id, clientText, idsite?, askedAt, classification}`. Classification assigns the question a *shape* (comparison-over-time, drop-diagnosis, benchmark, feasibility, …) from a declared rule table (`src/domain/question-shapes.json`) keyed on matched terms + optional LLM assist behind a port. The shape selects the hypothesis templates and the context-pack assembly plan.
- **`hypothesis.js`** — `{id, questionId, statement, mechanism, predictedObservation, disconfirmingObservation, evidenceRefs[], requiredFields[], status}`. `evidenceRefs` are typed references into the engine read model (`{kind: 'card'|'requirement'|'dataset'|'trend', id, batchId?}`). A hypothesis is a **structured claim with falsifiers**, not prose.
- **`gap.js`** — `{id, hypothesisId, need, status: 'readable'|'declarable'|'extendable'|'new_grain'|'blocked', requirementKeys[], reason}`. The four non-blocked statuses are the vision's effort levels, verbatim.
- **`plan.js`** — `{id, questionId, items: [{gapId, action, artifact?, effort, risk}], totalEffort}`. Items are ordered: all `readable` first (answers now), then `declarable`, then `extendable`, `new_grain` last with explicit sizing.
- **`answer.js`** — `{id, questionId, synthesis, citations[], unresolvedGaps[]}`. Citations resolve to engine artifacts; the synthesizer may quote stored states, never compute new numbers.
- **`evidence.js`** — pure functions: `supports(hypothesis, evidence)`, `contradicts(...)`, `coverageOf(hierarchy, hypothesis)` — the ranking logic for hypotheses against stored cards.

Domain invariants enforced in pure functions and pinned by tests: every `evidenceRefs` entry must be resolvable at pack-build time (a dangling reference fails the check, not the user); a `GapAnalysis` never contains a need the requirement registry doesn't name in its own vocabulary.

---

## 5. The context builder — training on the information hierarchy

The context builder has two halves: a **build-time indexer** that compiles the engine's hierarchy into a versioned, queryable index, and a **runtime assembler** that turns a question into a cited context pack. "Training" here is deliberately not ML: it is *curriculum compilation* — the builder learns the machine's information hierarchy the way the engine's own tests learn its SQL: by pinning a version and deriving structure from it.

### 5.1 The information hierarchy it must learn

Four layers, from the engine's published read model:

| Layer | Source (engine) | What the builder learns |
| --- | --- | --- |
| **Vocabulary** | `ae_requirement`, `ae_strategy_catalog`, `ae_trigger_definition` (seeded reference tables, `_current` views) + catalog JSON at a pinned ref for trigger specs/event families | Requirement keys (H15/H16/…), strategy ids per catalog family (`LP:…`, `PG:…`), trigger rules, gates G1–G9 semantics, the closed event taxonomy, segmentation ids (once Part SG lands) |
| **Beliefs** | `ae_strategy_card_current`, `ae_requirement_status_current`, `ae_page_analysis_current`, `ae_site_analysis_current` | What the platform currently concludes per site/page: verdicts, trigger states, gate failures, missing requirements — with batch/window provenance |
| **Evidence** | `ae_dataset_row_current`, `ae_trend_row_current`, `ae_trigger_chain_current`, `ae_experiment_row_current` | The raw shaped rows under the cards: dims/metrics grains, coverage, bot-filter variants |
| **Semantics** | `docs/decisions/`, `docs/ARCHITECTURE.md` measurement contract, `IMPLEMENTATION-PLAN.md` §2 — vendored at the pinned ref as *documents*, indexed not trusted | What the numbers mean: RPS is not causal, element revenue is not additive, `bot_filter` variants, window definitions, known boundary caveats (scan vs. window differences) |

Layers 1–3 are read through a **read-only ClickHouse role** (D-10): the builder's credentials cannot write, and its gateway adapter refuses write statements structurally (the `readOnlyClient` pattern from `scripts/scan-acceptance.mjs`). Layer 4 is vendored text, version-pinned.

### 5.2 The hierarchy indexer (build-time)

`src/application/indexer/` (application layer; pure compilers in `src/domain/index/`):

1. **Snapshot** — read the four layers into a normalized **hierarchy pack**: requirements, strategies (+ their requirement keys, triggers, gates), cards (with provenance), coverage summaries, semantics glossary. Pack records carry `catalogVersion`, `taxonomyVersion`, `engineRef`.
2. **Compile** — derive the *relations* the runtime needs: strategy → requirements → datasets that provide them → cards that cite them; question-shape → relevant strategy families; requirement → sites where it is `missing`/`blocked` (the gap shortcut).
3. **Store** — the compiled pack lands in the builder's own store (`hierarchy_pack` table, whole-pack replace on re-index). One row per engine version; runtime always reads the latest *pinned-compatible* pack. Re-indexing on a catalog version bump is a scheduled job, and the builder refuses to mix cards from a different `catalogVersion` into one context pack ("never mixed silently," the segmentation rule, applied here too).
4. **Validate** — pack self-checks: every card's strategy id exists in the pack vocabulary; every requirement key resolves; counts reconcile against the engine tables. A failing pack is quarantined, never served.

### 5.3 The runtime context pack

`src/application/context/` assembles, for a question:

```js
{ question, shape,
  vocabulary:   { requirements, strategies, events },   // defs only
  beliefs:      [cards+statuses relevant to the shape and site],
  evidence:     [dataset/trend summaries the cited cards rest on],
  semantics:    [glossary entries the shape needs],
  gaps:         [requirements missing/blocked for this site],
  citations:    [{ref, packVersion}] }                    // every item cited, none invented
```

Assembly is deterministic-first: the question shape selects strategy families and requirement keys from a declared plan (`src/domain/context-plans.json`); site scoping filters cards; recency ranks them. An LLM may *re-rank or augment* the pack only behind the `LlmPort`, and its additions enter the pack only if the citation check resolves them (§5.4). The pack has a **token budget** declared per question shape — the budget is part of the plan, not an afterthought.

### 5.4 The citation check — "the agent's check is a query"

Every pack item carries a reference. Before a pack is shown to the framing loop or an answer is shown to a user, `CheckPort` re-resolves every citation against the current hierarchy pack: existing id, compatible version, site match. A citation that fails is removed and recorded as a `gap` — the user sees "I can't verify this" instead of an unverifiable claim. This check is pure given the pack, unit-tested with corrupted packs, and is the single most important test in the repo.

### 5.5 Training in the third sense — the feedback loop (deferred, but designed-for)

After real conversations, two artifacts accumulate in the builder's store: which packs led to accepted hypotheses, and which proposals the engine's checks rejected. A feedback adapter may later tune retrieval weights (ranking boosts per question shape). It is an **adapter behind a port** reading only builder-owned data — it never writes the hierarchy pack directly, and it ships in a later phase. The architecture anticipates it; KISS defers it.

---

## 6. Ports and adapters

All ports in `src/ports/`, JSDoc typedefs only. Selection by id; discovery mirrors the engine's `discover.js`.

| Port | Contract (essence) | First adapter | Later adapters |
| --- | --- | --- | --- |
| `session-store.js` | Conversation/hypothesis/plan persistence; append-only events + current state | `sqlite` (`node:sqlite`, leased-free — single writer process) | `postgres` |
| `engine-read.js` | `cards(filter)`, `requirementStatuses(filter)`, `datasetSummary(filter)`, `trendSummary(filter)`, `catalogSnapshot()` — all read-only | `clickhouse` (read-only role; gateway refuses writes; `_current` views only) | fixture adapter (recorded responses for tests) |
| `hierarchy-index.js` | `loadPack(version?)`, `storePack(pack)`, `quarantine(pack, reason)` | `sqlite` | — |
| `llm.js` | `complete(prompt, ctx)` / `rank(candidates, instruction)` — provider-agnostic | `kimi-cli` (non-interactive, prompt-as-file, the engine's agent contract) | remote API providers |
| `prompt-source.js` | Layered Mustache template resolution (general → client → question-shape) | `layered-fs` (copies the orchestrator's prompts layering) | — |
| `proposal.js` | `submit(planItem, artifacts)` → tracked build reference | `pr` (opens a PR against the engine repo: segmentation JSON / profile descriptor / dataset spec + its tests) | `orchestrator-job` (enqueues `bin/orchestrator` work where the engine supports it) |
| `check.js` | `verify(pack)`, `verifyPlan(plan)`, `verifyAnswer(answer)` — deterministic | `local` (pure resolvers over the hierarchy pack) | — |
| `conversation.js` | `ask(question)`, `present(segment)` — the interactive surface | `cli` | `slack` |
| `feedback.js` | (deferred) acceptance/rejection telemetry for retrieval tuning | — | `local-weights` |

**Composition root** (`src/composition/`): reads env (`HB_DATABASE_URL`, `ENGINE_CLICKHOUSE_*` read-only, `ENGINE_REF`, `HB_LLM`), discovers adapters, wires deps. The only files that may touch `process.env` — pinned by an architecture test, exactly as the engine does it.

---

## 7. Declarative artifacts (data, not code)

| Artifact | Location | Loaded/validated by |
| --- | --- | --- |
| Question shapes (`comparison-over-time`, `drop-diagnosis`, `benchmark`, `feasibility`, …) | `declarations/question-shapes.json` | domain loader; unknown shape → intake asks before proceeding |
| Hypothesis templates per shape | `declarations/hypotheses/<shape>.json` | validated against the hierarchy pack vocabulary (requirement keys and strategy ids must exist) |
| Context plans (shape → strategy families, requirement keys, budget) | `declarations/context-plans.json` | same |
| Gap taxonomy (need → effort level mapping rules) | `declarations/gap-rules.json` | same |
| Prompts | `prompts/general/`, `prompts/shapes/<shape>/`, client overrides | layered-fs prompt source; missing template key fails loudly |
| Authoring skill | `skills/hypothesis-authoring/SKILL.md` | for agents extending the declarations |

Adding a new question shape is: one JSON file + one prompt directory + tests. No domain code changes — the same contract the engine gives datasets.

---

## 8. Data stores (builder-owned)

- **`sessions` / `hypotheses` / `gaps` / `plans` / `answers`** — current state, ReplacingMergeTree-analogous semantics are unnecessary; plain upsert tables suffice. Append-only `events` for the conversation log (audit + feedback).
- **`hierarchy_pack`** — one row per engine ref; the compiled context index. Never partially updated.
- **`build_refs`** — engine build tracking: proposal → PR/job → engine check outcome → refreshed card ids.

Nothing here mirrors engine measurement tables; the builder stores *references and interpretation*, the engine stores *measurement*.

---

## 9. Testing strategy (mirrors the engine's)

- **Architecture tests** — `layers.test.js` (domain ← application ← adapters; domain imports no ports/adapters/env), `composition-only.test.js` (env and `clickhouse` client only in composition; allowlist pinned per-line), `no-client-literals.test.js`.
- **Contract tests** — every store and `engine-read` adapter runs the same script against memory/fixture and live read-only fixtures; proposal adapters are contract-tested with a fake forge.
- **Citation checks** — corrupted packs, dangling refs, version mismatches: the check must catch all of them (property-style tests over randomized pack corruption).
- **Golden conversations** — scripted CLI transcripts per question shape (the "Why is Google traffic worse than direct?" case is the first golden file) asserting the exact hypothesis set, gap list, and cited answer. A model or prompt change that alters a golden conversation is a reviewed change.
- **Hierarchy parity** — the indexer reconciles pack counts against engine tables on every build; drift fails the build.

---

## 10. Build phases

1. **H0 — Skeleton.** Repo scaffold, architecture tests, ports as typedefs, sqlite session store, CLI conversation adapter. *Milestone: `hb ask` stores a question.*
2. **H1 — Read seam.** `engine-read` ClickHouse adapter (read-only role + write-refusing gateway), fixture adapter, contract tests. *Milestone: cards and requirement statuses readable from a live engine.*
3. **H2 — Hierarchy indexer.** Snapshot → compile → store → validate; version pinning; quarantine. *Milestone: a validated hierarchy pack from engine ref X.*
4. **H3 — Context builder.** Context plans, deterministic assembly, citation check, token budgets. *Milestone: a context pack for the golden question, fully cited.*
5. **H4 — Hypothesis loop.** Question shapes, templates, framing loop with LLM behind the port, evidence ranking. *Milestone: golden conversation 1 green end-to-end.*
6. **H5 — Gap analysis + planner.** Needs vs. registry vs. coverage; effort-level classification; plan artifact. *Milestone: the Google/direct question yields a plan whose `readable` items answer part of it immediately.*
7. **H6 — Proposal emission.** `pr` adapter (declarations first: segmentation/profile JSON), engine check outcome tracking, answer synthesis with citations. *Milestone: a declarable gap ships as an engine PR, and the accepted result lands in the answer.*
8. **H7 — Feedback adapter** (deferred until real traffic exists).

---

## 11. Risks and open decisions

1. **Hierarchy drift.** The engine's catalog moves (weekly, lately daily). Mitigation: pinned refs + scheduled re-index + version-mixing refusal. Open: who owns the pinning — the builder config or the engine's deployed version probe?
2. **Prompt/LLM nondeterminism vs. golden tests.** Mitigation: LLM only ranks/proposes; checks and structure are deterministic. Golden files assert structure, not wording.
3. **Proposal latency.** A gap answered only after an engine PR + batch can be hours. The plan artifact tells the user exactly which items answer *now* vs. *after build* — latency is surfaced, not hidden.
4. **Scope creep toward the engine.** The strongest pull will be "just let the builder write dataset rows." D-10 is the wall; any such need becomes an engine feature request (a new read view, a new reference table), never a builder write.
5. **Open:** whether hypotheses should eventually get first-class engine visibility (e.g. a `hypothesis_refs` column on cards). Deferred by D-10; revisit after H6.

---

## 12. Relation to this repo's conventions (checklist)

| Engine rule | Builder counterpart |
| --- | --- |
| Ports as typedefs; no imports in ports | §6, rule 2 |
| Adapter discovery; id selection; no switch | §6 |
| Declarative descriptors; new capability = new file | §7 |
| Checks, not exit codes / claims | §5.4, H4 |
| Blocked is a result | rule 8, §11.3 |
| Read-only acceptance harness (`scan-acceptance`) | `engine-read` write-refusing gateway |
| Layered prompts (orchestrator) | `prompt-source.js` |
| Pinned, versioned vocabulary (taxonomy, catalog) | hierarchy packs, §5.2 |
| Terse decision records | D-10; this doc's open decisions to follow the same series |
