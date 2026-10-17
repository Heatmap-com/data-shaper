# Orchestrator implementation plan

**Prepared:** 13 October 2026
**Package:** `analysis-engine` (Node, ESM)
**Replaces, at the end:** `scripts/queue.mjs`, `scripts/queue-lib.mjs`, and the agent-driven queue skills in `skills/analysis-queue-*`
**Status:** plan. Phase 1 is specified to the code level. Later phases are specified to the module and contract level. Section 4A refactors the existing code so the result is SOLID end to end, not only in the new orchestrator.

## 0. What this builds

A Node orchestrator that takes one site from domain to styled reports without a person or a chat agent holding the loop. It does five things:

1. **Reads the process from descriptors.** A run descriptor declares which ETL stages run, in what order, with what parameters. A general descriptor is the default. A site can override it. The person enqueuing can name a run, or the system picks one: the site's own, if it exists, then the general one.
2. **Gives each stage its own queue.** A site that finishes a stage is forwarded to the next stage's queue. Each stage has its own concurrency limit, so one site holds naming while another holds analysis.
3. **Runs a deterministic handler first.** For example, `bin/seed-named-page.sh` for naming. The stage's completion check decides whether the stage is done. The handler's exit code does not.
4. **Traps failure and hands it to a coding agent.** Each stage descriptor names its fallback agent and its prompt file. Kimi CLI is the first adapter. The agent's claim is not trusted. The orchestrator runs the same completion check after the agent finishes.
5. **Survives crashes and holds no state in memory.** Messages are leased. A worker that dies loses its lease, and the message comes back. Every stage is idempotent: it checks whether the work is already done before it does it.

The local queue is SQLite, through Node's built-in `node:sqlite`. There is no daemon and nothing to install. On the server the same ports take a Postgres adapter (`FOR UPDATE SKIP LOCKED`). ClickHouse is not a queue. `IMPLEMENTATION-PLAN.md` already says it is not a lock manager.

### Why this replaces the current queue

On 13 October, the JSON queue showed Jormands and Sayii as `running` for over an hour while no process was working on them. The only thing alive was a 5-minute monitor that was not allowed to change anything. A status field is not a worker. In this design, `running` means a worker holds a lease and renews it. `status` reports a stage as **stalled** when a lease exists and no live worker owns it.

## 1. Architecture

```text
                    ┌─────────────────────── declarative ───────────────────────┐
                    │ orchestration/general/runs/*.run.json   (default ETL)     │
                    │ orchestration/sites/<slug>/runs/*.run.json (overrides)    │
                    │ orchestration/stages/*.stage.json  (stage library)        │
                    │ orchestration/agents/*.agent.json  (coding agents)        │
                    │ orchestration/{general,sites/<slug>}/prompts/<class>/*.md │
                    │ orchestration/sites/<slug>/site.json (domain, pages)      │
                    └───────────────────────────┬───────────────────────────────┘
                                                │ resolve + snapshot at enqueue
  cli enqueue ──► RunResolver ──► Job (JobStore) ──► queue "stage:<first>"
                                                         │
     ┌───────────────────────── StageWorker (one per stage, N slots) ─────────────┐
     │ reserve(lease) → StageExecutor                                             │
     │   for each unit (page):                                                    │
     │     check already satisfied? → skip                                        │
     │     Governor.acquire(resources) → StageHandler.run → CompletionCheck       │
     │     failure → classify: transient → retry w/ backoff                       │
     │                         blocked   → stop, record blocker                   │
     │                         defect    → AgenticFallback                        │
     │                                       prompt = PromptSource(site ▸ general)│
     │                                       CodingAgent.run (Kimi CLI adapter)   │
     │                                       CompletionCheck again (never trust)  │
     │ Settler: advance → forward(lease, "stage:<next>") | retry → release(delay) │
     │          blocked/failed → deadLetter                                       │
     └────────────────────────────────────────────────────────────────────────────┘
        Journal (markdown + events)      Workers heartbeat      ResourceGovernor
```

### Layers

```text
src/orchestrator/
  domain/        pure functions and value types. No I/O.
  ports/         JSDoc contracts. One file per port.
  application/   use cases. Depend on ports only.
  adapters/      one folder per port kind. One file per adapter id.
  composition/   the only place that maps config ids onto adapter modules.
  cli.js         thin: parse arguments, call a use case, print JSON.
orchestration/   data, not code: descriptors, prompts, site specs.
```

This mirrors two patterns the repository already uses:

- `src/discover.js`: an adapter module with a sibling descriptor.
- `scripts/remote-llm-projects/load-port.mjs`: one loader maps an id onto an adapter and knows nothing about what the adapter does.

### SOLID, concretely

| Principle | Where it shows |
|---|---|
| Single responsibility | `StageWorker` leases and heartbeats. `StageExecutor` decides one delivery. `AgenticFallback` recovers. `Settler` moves the message. `RunResolver` merges descriptors. `PromptSource` finds and renders prompts. Each one can be tested with fakes for the rest. |
| Open/closed | A new stage is a `*.stage.json`, plus a handler or check only when the existing ones do not cover it. A new coding agent is a `*.agent.json` plus `adapters/agents/<id>.js`. A new queue is `adapters/queue/<id>.js`. The core does not change. |
| Liskov | Every queue adapter passes one shared contract suite (`test/orchestrator/queue-contract.js`), the same way `test/persistence-contract.test.js` holds persistence adapters to one contract. Every agent adapter passes the agent contract with a scripted fake CLI. |
| Interface segregation | The executor sees `JobReader`, `StageHandler`, `CompletionCheck`, and `Fallback`. It never sees the queue. The worker sees the queue and never sees prompts. The SQLite module exposes five small ports (`queue`, `jobs`, `events`, `workers`, `resources`) and not one store object. |
| Dependency inversion | Application modules take ports as constructor arguments. `composition/container.js` reads `orchestrator.config.json` and wires adapters by id. Swapping SQLite for Postgres is a config line. |

The table above covers the new code. The existing code that the stages call does not meet it today. Section 4A lists each violation with its file and lines, and the phase that fixes it. The end state is a new site that needs only a `site.json` and, if wanted, override descriptors and prompts, with no code edit anywhere in the pipeline.

## 2. The declarative model

### 2.1 Files

```text
orchestrator.config.example.json               adapters, paths, capacities (not secret); copy to the gitignored orchestrator.config.json
orchestration/
  schemas/                                     JSON Schemas for editor help
  stages/<id>.stage.json                       the stage library
  agents/<id>.agent.json                       coding-agent descriptors
  general/
    resilience.json                            what "standard" and "top" allow
    runs/default.run.json                      the default run when none is named
    runs/full.run.json, naming-only.run.json, data-only.run.json, reports-only.run.json
    prompts/system/agent-rules.md              shared preamble, included as a partial
    prompts/fallback/<stage>.md                agentic recovery, one per stage
    prompts/fallback/stage.md                  generic recovery when a stage has none
    prompts/primary/<stage>.md                 stages whose primary handler is an agent
    prompts/report/<report>.md                 report authoring
  sites/<slug>/
    site.json                                  domain, idsite, page collection, context
    runs/<name>.run.json                       optional overrides
    prompts/<class>/<name>.md                  optional overrides (replace | append | prepend)
```

### 2.2 Run descriptor: which ETL runs

A run is an ordered list of stage entries. Each entry names a stage from the library (`use`), and it can override that stage's parameters, retry policy, check, fallback agent, or prompt. Site runs `extends` a general run and edit it by stage id.

```json
{
  "id": "full",
  "description": "Name, analyze, export, report, style.",
  "defaults": { "window": { "days": 30, "end": "yesterday" }, "priority": "normal", "resilience": "standard" },
  "pages": { "source": "site", "fallback": "home" },
  "stages": [
    "naming",
    "analysis",
    "bundle",
    "bundle-4mb",
    "site-opportunity-report",
    "today-opportunities",
    "user-journey",
    { "use": "style-pdf", "params": { "reports": ["site-opportunity-report", "today-opportunities", "user-journey"] } }
  ]
}
```

A site override:

```json
{
  "id": "full",
  "extends": "general:full",
  "pages": { "source": "site" },
  "patch": {
    "naming": { "params": { "seedTimeoutMs": 1200000 } },
    "user-journey": { "fallback": { "agent": "kimi-cli-k3", "prompt": "fallback/report.md" } }
  },
  "remove": ["bundle-4mb"],
  "insert": [{ "after": "bundle", "stage": { "use": "remote-enhance", "params": { "provider": "kimi" } } }]
}
```

Merge rules (in `domain/run-descriptor.js`):

- `extends` is resolved first, root first. The chain is at most 8 deep, and a cycle is an error.
- Top-level keys deep-merge. Objects merge by key. Arrays and scalars replace. `null` deletes a key.
- `stages` in a layer replaces the whole list. `remove`, `patch`, and `insert` edit the list by stage id, in that order. A patch, removal, or insert that names a missing stage is an error. It is never ignored.
- `enabled: false` keeps an entry in place so a later layer can turn it back on. Disabled entries are dropped after the last layer.
- Each surviving entry is deep-merged over its library descriptor. That gives the resolved stage.
- `--set path=value` on the command line is the last layer. Example: `--set stages.analysis.params.windowDays=14`.

### 2.3 Run selection

| Invocation | Run used |
|---|---|
| `enqueue sayii --run general:full` | the general `full`, even if Sayii has its own |
| `enqueue sayii --run site:full` | Sayii's `full`. Error if it does not exist |
| `enqueue sayii --run full` | Sayii's `full` if it exists, else general `full` |
| `enqueue sayii --run ./my.run.json` | that file, with its `extends` chain |
| `enqueue sayii` | the name in `site.json` `run`, else `default`, using the same site-then-general rule |

The resolved run is **snapshotted into the job** with its provenance (the files used, root first) and a SHA-256 hash. Editing a descriptor does not change a job already in flight. `requeue --refresh` re-resolves it. `explain <site> [--run ref]` prints the resolved run, which layer set each stage, and the prompt files each stage will read. Run it before enqueuing anything unusual.

### 2.4 Stage descriptor

```json
{
  "id": "naming",
  "label": "Name the site",
  "phase": "analyze",
  "skill": "skills/resilient-naming/SKILL.md",
  "concurrency": 1,
  "resources": ["chromium"],
  "forEach": "pages",
  "leaseMs": 120000,
  "timeoutMs": 1800000,
  "handler": { "use": "command", "command": "bin/seed-named-page.sh", "args": ["{{unit.page.url}}", "{{site.idsite}}"] },
  "check": { "use": "naming-complete", "datasetRoot": "{{config.naming.datasetRoot}}" },
  "retry": { "maxAttempts": 2, "backoffMs": 60000, "factor": 2, "maxBackoffMs": 900000 },
  "errors": [
    { "match": "ERR_NAME_NOT_RESOLVED|ENOTFOUND|net::ERR_CONNECTION_REFUSED", "class": "transient", "reason": "merchant site not reachable" },
    { "match": "login required|password protected|/account/login", "class": "blocked", "reason": "login wall" },
    { "match": "unknown idsite|idsite .* not found", "class": "blocked", "reason": "unknown idsite" }
  ],
  "fallback": {
    "agent": "kimi-cli",
    "prompt": "fallback/naming.md",
    "maxAttempts": { "standard": 1, "top": 3 },
    "timeoutMs": 2700000,
    "rerunPrimary": true,
    "addDirs": ["{{config.naming.botDir}}", "{{config.naming.engineDir}}"]
  }
}
```

- `handler.use` is a handler adapter id: `command`, `agent`, or `node` (an in-process function, phase 2).
- `check.use` is a completion-check adapter id. The check runs before the handler, so finished work is skipped. It runs after the handler, so success means the artifact exists. It runs after the fallback, so an agent's claim is verified.
- `errors` classifies a failure as `transient` (retry with backoff), `blocked` (stop and record the blocker, which needs a person), or `defect`. Anything unmatched is a `defect`, and a defect goes to the fallback. A transient failure that has used up its retries also goes to the fallback.
- `fallback.maxAttempts` can be keyed by resilience. `orchestration/general/resilience.json` supplies the repair scope that the prompt shows for that resilience: what the agent may edit.
- `fallback.rerunPrimary`: the agent may fix the tool and not rerun it. If the check still fails after the agent, the handler runs once more before the attempt is judged.

### 2.5 Agent descriptor

```json
{
  "id": "kimi-cli",
  "adapter": "kimi-cli",
  "description": "Kimi Code CLI in non-interactive prompt mode.",
  "command": "kimi",
  "model": null,
  "mode": "auto",
  "outputFormat": "stream-json",
  "promptDelivery": "file",
  "skillsDirs": ["skills"],
  "env": {
    "pass": ["PATH", "HOME", "CLICKHOUSE_HOST", "CLICKHOUSE_PORT", "CLICKHOUSE_USER", "CLICKHOUSE_PASSWORD", "CLICKHOUSE_DATABASE", "CNN_AI_BOT_DIR", "NAMING_ENGINE_ASSETS", "NAMING_DOCKER_CONTAINER"],
    "set": { "NO_COLOR": "1" }
  },
  "timeoutMs": 2700000,
  "killGraceMs": 10000
}
```

Several descriptors can share an adapter. For example, `kimi-cli-k3.agent.json` can set a different `model`. A stage picks a descriptor id. It never picks an adapter. A Claude Code, Codex, or Cursor agent later is a new descriptor plus `adapters/agents/<id>.js`.

### 2.6 Site spec and the page collection

```json
{
  "slug": "sayii",
  "name": "Sayii",
  "domain": "sayiioficial.com",
  "origin": "https://www.sayiioficial.com/",
  "idsite": 5680,
  "platform": "shopify",
  "currency": "USD",
  "run": "full",
  "pages": {
    "include": [
      { "url": "https://www.sayiioficial.com/", "role": "home" },
      { "url": "https://sayiioficial.com/products/coctel-capilar-complex-hyaluron-en-frio", "role": "focus" },
      { "url": "https://sayiioficial.com/collections/kits", "role": "compare" }
    ]
  },
  "context": { "country": "CO", "language": "es", "cartNoun": "carrito", "notes": "Hair care. Domain has two i's." }
}
```

Page selection, in precedence order: `enqueue --pages url,url`, then the run's `pages.source` (`site` reads `site.json` `pages.include`, `qualifier` lets the analysis stage choose, `home` is the origin only), then `pages.fallback`. The resolved list is stored on the job (`job.pages`), and stages with `forEach: "pages"` run once per page. `site.json` is optional. `enqueue <domain>` with no site file builds a minimal spec, and phase 2's `resolve-site` stage looks up the idsite. It never invents one.

### 2.7 Prompts: general per class, site-specific override

A prompt name is `<class>/<name>.md`. Classes are `system`, `fallback`, `primary`, and `report`. Lookup is `sites/<slug>/prompts/<name>` and then `general/prompts/<name>`. A site file's front matter chooses how it combines with the general one:

```md
---
mode: append      # replace (default) | append | prepend
---
Sayii's add button reads "Añadir Al Carrito". The English regex in bot-draft misses it.
```

Templates use `{{path.to.value}}` and `{{> class/name}}` partials. The partials follow the same site-then-general lookup. A missing value is an error that names the key and the file. It never renders as an empty string. The values available to a prompt are `site`, `job`, `stage`, `unit`, `params`, `window`, `config`, `paths`, `resilience`, `failure`, `check`, and `run`.

## 3. Resilience and fault tolerance

| Failure | Mechanism |
|---|---|
| Worker crashes or the machine reboots | The lease expires. The next `reserve` reclaims it with `deliveries + 1`. The stage's pre-check skips units that already finished. |
| A step hangs | The handler `timeoutMs` kills the whole process group (`detached` spawn, `kill(-pid)`). A timeout is a `defect` by default, so it goes to the agent. Naming hangs were a renderer stuck inside the injected engine. The agent prompt carries that diagnosis. |
| Stage succeeds and the process dies before forwarding | The job is written first, then `forward`. On redelivery, the executor sees the stage is `done` in the job and forwards immediately. `dedupeKey = jobId:stage` makes the second enqueue a no-op. |
| Duplicate delivery | Every unit has a pre-check. Enqueue is idempotent by dedupe key. |
| Poison message | `maxDeliveries` (default 5) sends the message to the stage's dead letters. `dlq requeue <id>` brings it back. |
| Contention (two Chromium seeds, a ClickHouse OOM at 28.51 GiB during parallel product-grid) | `ResourceGovernor` with capacities in config: `chromium: 1`, `clickhouse-heavy: 1`. Leases on resources expire too, so a dead holder frees its slot. |
| The agent says it fixed the stage and it did not | The completion check runs again. A `fixed` status with a failing check counts as not fixed. |
| The agent edits something it should not | The working directory and `--add-dir` are limited to what the stage declares. The prompt states the repair scope for the job's resilience. A git status snapshot before and after each agent run is saved in the run directory (phase 2). |
| A stage is marked running and nothing is working on it | Workers heartbeat into the `workers` table. `status` prints `STALLED` for a stage whose lease is held by an owner whose heartbeat is older than 3 × the heartbeat interval. |
| A person is needed | `blocked` with a reason, as the current skills define it: merchant wall after retries, login, unknown idsite, missing credentials, or a decision only the user can make. Other jobs continue. |
| Graceful stop | On `SIGINT`/`SIGTERM`, workers stop reserving, abort running handlers, and release their leases with no delay, so the message goes back to the front of its queue. |

## 4. Phases

| Phase | Delivers | Done when |
|---|---|---|
| **1. Core** | Descriptors, resolution, ports, the SQLite queue/jobs/events/workers/governor, the worker and executor, retry, classification, the agentic fallback, the Kimi CLI adapter, the command handler, two checks, the layered prompts, and the CLI (`validate`, `explain`, `enqueue`, `run`, `status`, `retry`, `dlq`, `cancel`). The naming stage works end to end. | A site named in `site.json` with three pages is named by `run --until-idle`. A broken bot path is recovered by Kimi and verified by the check. `kill -9` mid-seed resumes after restart. `status` shows `STALLED` when no worker is alive. |
| **2. Data stages** | `resolve-site` (idsite lookup, which blocks rather than inventing one). Analysis split into `analysis-qualify`, `analysis-capture`, `analysis-run`, `descriptors` (agent-primary, because the operator corrections are judgment), and `analysis-enrich` (replay, trend, tag-trend). The refactors in 4A (R2.1–R2.9) land here: one ClickHouse composition, site lists as input, role persistence ports, `runner-ae` split into the five handlers these stages call, one page-class and channel rule table, and the bundle stages driven by `site.json`, which retires the DVF one-off scripts. Then `bundle` and `bundle-4mb` with the anchor check. The engine gets an `explicit` page-selector adapter so the analysis honours `job.pages`. Deterministic `repairs` run before the agent (for example, requeue a `failed` AE site with `updateSite` and rerun). Facts that stages write back to the job (`site.idsite`, the focus page) are merged into the job. | `data-only` produces `~/work/analysis/<slug>/` and `-4mb/` with matching anchors for a new site, with no chat agent involved. |
| **3. Report stages** | The `agent` handler as primary. `primary`/`report` prompts for the three documents, built from the skills, standards, and style guide. A `markdown-report` check: required sections, figures exist, no placeholder text, numbers present in the bundle where a check can verify them. `style-pdf` (command). `remote-enhance` (wraps `scripts/remote-llm-projects`). Site-specific report prompts. A `chart-render` stage with declared chart specs (R3.1), and the Chrome path injected (R3.2). | `full` runs one site from domain to six files (three markdown, three PDF) unattended. Sayii's report prompt override is applied. |
| **4. Skills and migration** | `import-legacy` reads `process/queue/queue.json`. The `analysis-queue-*` skills call the orchestrator CLI. The monitor reads `status`, including stalled detection. `scripts/queue.mjs` is retired. The engine CLI is split into commands (R4.1), and the hardening items in R4.4 are closed. | The user's sentence "Add X to the queue for full process, high priority, top resilience" maps to one `enqueue` command, and work starts with no agent in the loop. The refactor track's done-when (4A.4) holds. |
| **5. Server** | A Postgres adapter set (queue `SKIP LOCKED`, jobs, events, workers, governor) passing the same contract suites. A systemd unit or container for the EC2 box, replacing the three units in `deploy/` (`analysis-naming`, `analysis-capture`, `analysis-saliency`). Several worker processes. DLQ alerting. Structured logs (pino, already a dependency). The server cron runs the orchestrator, and the v1 path is retired (R4.3). | Two worker processes on the server share stages without a double lease, under the contract tests and a soak run. |
| **6. More agents** | `claude-code`, `codex`, and `cursor-agent` adapters and descriptors. Per-stage agent choice. Agent duration and outcome in the events table, so stages can be compared by agent. | One run uses Kimi for naming and another agent for a report fallback, set only in descriptors. |

The success criteria in the request are met at the end of phase 3: one site, end to end, a declared page collection, and site-specific prompts for every prompt class. Phases 4–6 are adoption and scale.

Each phase also closes the refactor items in section 4A for the code it touches. A phase is not done while it has an open high- or medium-severity item.

## 4A. Refactor track: SOLID end to end

The orchestrator calls the existing code as stage handlers. A SOLID orchestrator over handlers that hard-code sites, read the environment deep inside logic, and share one 50-method port is not SOLID end to end. This track refactors the existing code alongside the phases.

The register comes from an audit of `src/`, `bin/`, `py/`, and `scripts/` (about 41,000 lines) on 13 October 2026. Every high-severity line reference below was checked against the code.

### 4A.1 Rules

1. **Pin before you move.** Every refactor starts with a characterization test that records today's output: generated SQL, classifier output, bundle files, and the figure list. The refactor keeps that output identical. Any intended change is a reviewed fixture update in its own commit.
2. **Refactor when a phase first touches the code.** A stage handler is not done until its register items are closed. Code no stage calls is in R4.4 and is done last.
3. **Strangle, do not rewrite.** The fat persistence port stays as a facade composed from the new role ports until its last caller moves. Old CLI flags keep working until phase 4.
4. **Site data lives in descriptors.** No site name, idsite, domain, date window, or absolute path stays in `src/`, `py/`, `bin/`, or `scripts/`. Test R0.2 enforces this.
5. **One composition root.** Only `src/composition/` and `src/orchestrator/composition/` read `process.env` or import a concrete adapter. Test R0.2 enforces this too.

### 4A.2 Register

Severity: **H** blocks the orchestrator or forces a code edit per site. **M** is a real violation off the critical path. **L** is minor.

**Phase 1**

| ID | Where | Principle | Problem | Refactor | Guard |
|---|---|---|---|---|---|
| R0.1 | `py/bundle-export.mjs:613-624`, `src/page-type.js`, `py/bundle-build.py` | — | Nothing pins today's output. `bundle-export.mjs` runs the export at import time, so its SQL builders cannot be tested. | Move the top-level run behind an `import.meta.url` main check and export the `*Sql` builders. Snapshot the SQL for every site in the table. Run one URL fixture (about 40 URLs, including cart/checkout/search edge cases) through `pageType`. Record one raw export (Sayii) and hash the `bundle-build.py` and `bundle-trim.py` outputs. | `test/characterization/{bundle-sql,page-class,bundle-build}.test.js` |
| R0.2 | whole repo | DIP, OCP | No test stops new hard-codes. | `test/architecture/no-site-literals.test.js` scans for `/Users/`, `/tmp/`, known client domains, and `idsite: <number>` literals. `test/architecture/composition-only.test.js` has three rules:
- `process.env` may be read only in `composition/` (adapters are not exempt).
- `adapters/persistence/*` may be imported only from `adapters/` and `composition/`.
- `@clickhouse/client` may be imported only from `adapters/persistence/` and `composition/`, across `src/`, `py/`, and `scripts/`.

Both tests start with an allowlist of today's hits. An allowlist counts its entries: two identical lines in one file need two entries, so a copied violation still fails. Each R item deletes its lines from the allowlist. | The allowlists are empty at the end of phase 4. |
| R1.1 | `bin/seed-named-page.sh:18-19`, `bin/name-page.sh:15-17` | DIP | The defaults point at `/Users/kennpalm/source/heatmap/cnn-ai-bot` and `/Users/kennpalm/work/landing-page-analysis/...`. The container name `naming-bot` is fixed. | Make `CNN_AI_BOT_DIR`, `NAMING_ENGINE_ASSETS`, and `NAMING_CONTAINER` required. The naming stage sets them from `orchestrator.config.json` (`naming.botDir`, `naming.assetsDir`, `naming.container`). Exit contract, stated in each script header and mapped in the stage's `errors`: `0` named, `2` usage, `3` missing config (blocked), any other code passes the child's status through (defect). | A shell test: missing env exits 3. |

**Phase 2: the data stages call this code**

| ID | Where | Principle | Problem | Refactor | Guard |
|---|---|---|---|---|---|
| R2.1 | `src/adapters/persistence/clickhouse.js:27,421-439`; `src/saliency-worker.js:3`; `src/enrichment/trend-schema.js:1`; `py/bundle-export.mjs:123-141`; `src/index.js:10`; `src/cli.js:136-141` | DIP | `DATABASE` is read from `process.env` when the module loads. Two non-adapter modules import it. `bundle-export.mjs` builds its own ClickHouse client. | `src/composition/clickhouse.js` exports `createClickHouse(config)`, which returns `{ client, database, gateway }`. Adapters take `{ client, database }`. The saliency worker and trend schema receive `database` through deps. The exporter uses the same factory. | R0.2 allowlist entries removed. The existing persistence tests pass. |
| R2.1 landed | `src/composition/clickhouse.js`, `src/adapters/persistence/`, `src/adapters/query-gateway/`, the schema migrator | | | `clickHouseConfig(env)` is the one place `CLICKHOUSE_*` is read, and composition builds the client and gateway from it. Adapters take `{ client, database }`; the query gateway and the schema migrator are their own modules, and the trend schema runs through the migrator. The saliency worker, the scripts, and the exporters take the database as an argument. | The schema characterization snapshot is byte-identical to the old code. |
| R2.2 | `src/index.js:53`, `src/cli.js:190`, `src/adapters/site-sources/static-idsites.js:9-12`, `src/adapters/site-sources/active-ecommerce-sites.js:25-31`, `src/adapters/_lib/element-names.js:20` | DIP, OCP | The CLIs write `process.env.ANALYSIS_IDSITES` for an adapter to read back. The adapter defaults to `3199,3207,3228`. `shopify` and `active` are hard-coded. The names path comes from the environment. | Site sources take `{ idsites }`, `{ platform, status }`, and `elementNamesPath` from their context. There is no default list. The orchestrator passes `job.site.idsite`. | Site-source unit tests. A missing idsite list is an error, not a default. |
| R2.2 landed | `src/adapters/site-sources/`, `src/adapters/_lib/element-names.js`, `src/application/commands/args.js` | | | `static-idsites` lists `ctx.sites.idsites`, and a run without them is an error. `active-ecommerce-sites` takes `ctx.sites.platform` and `status`, which the CLI defaults to `shopify` and `active`. Element names come from `ctx.elementNamesPath`, loaded from config. The `ANALYSIS_IDSITES` round trip and the default list are gone. | Site-source unit tests for both sources, `runSites`, and element names. |
| R2.3 | `src/ports/persistence.js:68-78,671-721`; `clickhouse.js:54-3077`; `memory.js:296-1407`; `src/index.js:72-78`; `src/naming-consumer.js:29,50` | SRP, ISP, LSP | One 3,088-line adapter holds the DDL, the client, the gateway, the mappers, and about 60 store methods. The AE port has about 50 operations, and the capture consumer uses 3 of them. `memory-ae` lacks seven trend and tag methods (`writeTrendRows`, `writeTrendSelectors`, `readTrendSelectors`, `readTrendSubjects`, `writeTagTrendRows`, `writeTagSelection`, `readTagSelection`). The v1 port omits `claimNaming`, `failNaming`, `readBatch`, and `deleteDatasetRows`, which callers use. `index.js` patches `readBatch` onto the adapter after checking `id === 'clickhouse'`. | Role ports in `src/ports/persistence/`: `BatchStore`, `NamingQueue`, `CaptureStore`, `DatasetStore`, `TrendStore`, `SessionTagStore`, `DescriptorStore`, `GovernanceStore`, `TriggerStore`, `CardAnalysisStore`, and `CatalogSeedStore`. Adapters move to `adapters/persistence/{clickhouse,memory}/<role>.js`, alongside `schema-migrator.js` (from `54-416`) and the gateway, which moves to `adapters/query-gateway/clickhouse.js` (from `450-530`; the port `src/ports/query-gateway.js` already exists). `AePersistencePort` becomes a facade composed of roles, so callers move one at a time. `memory-ae` implements the seven methods. Each consumer takes only the roles it uses. | Both contract suites are extended to cover trend, tag, naming claim/fail, `readBatch`, and `deleteDatasetRows`, and run against both adapters. |
| R2.3 landed | `src/ports/persistence/`, `src/adapters/persistence/{clickhouse,memory}/<role>.js` | | | One port per role (`BatchStore`, `CaptureStore`, `DatasetStore`, `TrendStore`, `SessionTagStore`, `DescriptorStore`, `GovernanceStore`, `TriggerStore`, `CardAnalysisStore`, `CatalogSeedStore`, and the v1 `LandingPageStore` and `NamingQueue`). `AePersistencePort` and `PersistencePort` are their intersections, and the adapter facades compose the role modules. `memory-ae` gains the trend and session-tag methods, and the v1 adapters carry `readBatch`. Consumers name the roles they use. | Both contract suites check every role method on both adapters. |
| R2.4 | `src/runner-ae.js:3-5,104-106,185-527,441` | SRP, OCP, DIP | `processSite` runs qualify, page selection, the capture gate, traffic exclusion, page and site datasets, the bot draft, cards, and the analysis writes. Card datasets are found with `id.startsWith('cards-')`. `botDraft` and `requirementStatus` are imported concretely. | Five exported handlers with explicit inputs (`{ site, window, pages, deps }`) and a `HandlerResult`. They match the phase 2 stages: `qualify` (with the page selector), `captureGate`, `collectDatasets`, `draftDescriptors`, and `writeAnalysis`. `runAeBatch` becomes their composition, so the old CLI keeps working. Dataset descriptors gain `"role": "card"` and `"catalogId"`, which replace the prefix test. The descriptor source is discovered by role. | A scenario test: on the memory store, running the five handlers in sequence gives the same rows as `runAeBatch`. The existing runner tests pass. |
| R2.4 landed | `src/site-analysis/{handlers,rows,roles,checkpoints,context}.js`, `src/runner-ae.js`, dataset descriptors | | | `qualify`, `captureGate`, `collectDatasets`, `draftDescriptors`, and `writeAnalysis` each take `{ site, window, pages, deps }` and return a `HandlerResult` whose facts the next one reads. `collectDatasets` takes a `scope` of `page` or `site`, and the descriptor draft runs between the two, because `descriptor-snapshot` (a site dataset) reads the descriptors it writes. A handler started on its own reloads earlier work from the checkpoints. Descriptors declare `"role": "card"` with a `catalogId`, and `"role": "requirements"`; the runner and replay read the roles in place of the `cards-` prefix and the concrete imports. | `test/site-analysis-scenario.test.js`, recorded on the old runner. `runAeBatch`, the handlers on one state, and the handlers as separate stages store identical rows. |
| R2.5 | `src/replay.js:14-76,175-249,388` | OCP, LSP | The keep, restamp, and recollect lists are hard-coded. Optional persistence methods are duck-typed. | Each dataset descriptor declares `"replay": "keep" \| "restamp" \| "recollect"`, and the replay plan is derived from those descriptors. Replay depends on a narrow `ReplayStore` made from role ports. | A characterization test of the replay plan. |
| R2.5 landed | `src/replay.js`, `src/ports/persistence/replay-store.js`, dataset descriptors | | | Each descriptor declares `"replay"` (`keep`, `restamp`, or `recollect`), and discovery requires it. `resolveReplayPlan` derives the plan from the descriptors. Replay writes through `ReplayStore`, a narrow port picked from three roles, and checks the adapter once. `runReplay` reads from the run's database. | `test/replay-plan.test.js`, recorded on the old code. Two reviewed differences: `kind-fleet-weekly` runs before `structural-screen` (discovery order), and the kept list names `card-history` and `experiment-analysis`, which replay already left as stored. |
| R2.6 | `src/page-type.js:20-34`, `src/audit/sql.js:77-99`, `src/enrichment/trend-sql.js:15-26`, `py/bundle-export.mjs:143-165`, `py/build.py` (`link_channel`) | OCP, DRY | The Shopify page-class rules are copied four times and have drifted (`cart` against `cart_page`). The channel rules (`CH`, `LINK`) exist only in the exporter, with an older copy in `build.py`. A site with different URLs needs code edits. | `src/domain/page-class/` holds one rule table with platform presets (`shopify` first). It generates both a JS classifier and a ClickHouse `multiIf` fragment, so they cannot drift. `src/domain/channel-rules/` does the same for channels. A site overrides or extends them in `site.json` (`pageClasses`, `channelRules`). The DVF classes `private_sale` and `size_guide` become a site override. URLs are normalized before any rule runs. Some sites store JSON-escaped URLs (`https:\/\/host\/products\/...`), and the October batch exports put every page of Jormands, Sayii, Tennis Premium, and Vitasei in `other` because of it. | The R0.1 fixture. Equivalence tests in `test/domain/` run the generated SQL in `clickhouse local` and assert it equals the JS classifier for every label set, the audit brand rules, and every channel field combination. They skip when the binary is missing. |
| R2.6 landed | `src/domain/page-class/`, `src/domain/channel-rules/`, `src/domain/text-repair.js` | | | `pageType`, `classifyTemplate`, `templateMultiIf`, `templateSql`, and the exporter read the one preset through label maps (`page`, `template`, `trend`, `bundle`). The exporter decodes match-rule URLs in SQL and restores titles like `Cu00f3ctel` after the orders query. Channel SQL is generated from the visit and link tables and gives the old answers on all 10,296 tested inputs. Each condition kind (`PATH_CONDITIONS`) and channel operator (`OPERATORS`) is one entry holding its value check, its JS test, and its SQL, so a new kind is added in one place. The tables are deep-frozen, and every classifier and SQL builder checks its rules when built. The site-level `pageClasses` and `channelRules` overrides arrive with `site.json` under R2.7, and `build.py`'s `link_channel` is retired there with the DVF scripts. | The reviewed R0.1 bundle-SQL update changes `visitSql`, `pagePeriodSql`, and `hvSql`. In the bundle, query-string homes become `home`; uppercase and bare `/products` and `/collections` paths are classified; blogs are `content`; search is a path prefix; `/cart/<id>` permalinks are `other`. Audit and trend SQL now match their JS twins on fragments, empty URLs, and escaped URLs, and the audit checks search before checkout. |
| R2.7 | `py/bundle-export.mjs:10-115,555`; `py/bundle-build.py:463,526-527`; `py/build.py`, `py/split.py`, `py/export.mjs`; `py/hypothesis-{export.mjs,build.py,scrape.py}` | OCP, SRP, DIP | Every site is a row in `SITES` (slug, name, domain, idsite, idsitehsr, currency, platform, window, focus path and label), and output goes to `/tmp/bundle/<slug>`. Kurk's reading notes are in the builder. The DVF scripts hard-code idsite 5795, `dvf.com`, fixed dates, `/tmp/dvf.pkl`, and `/Users/kennpalm/...` imports. | **Generalize the DVF scripts (decided 13 October).** `bundle-extract` (the exporter) reads the job's site spec. `site.json` gains `idsitehsr`, `currency`, `platform`, `focus`, `periods` (the general default is pre/first/second; DVF overrides it with full/promo), `pageClasses`, `channelRules`, and `readingNotes`. `SITES` is deleted, and output goes to the stage workspace. `bundle-build` reads periods and notes from `meta.json`. `bundle-trim` stays as it is. `py/lib/bundle_io.py` holds the TABLE/CSV parsing that `bundle-trim.py` and the chart stage share. `build.py`, `split.py`, and `export.mjs` are deleted once `orchestration/sites/dvf/site.json` reproduces the DVF bundle through the generic stages. The hypothesis scripts become optional stages, `hypothesis-extract` and `hypothesis-build`. They are driven by `site.json` `hypotheses[]`: query presets, click-class CSS, help paths, and the window from the job. The scrape host comes from `site.domain`. The DVF P0 queries move to `orchestration/sites/dvf/hypotheses/`. | The R0.1 SQL snapshots are unchanged for the existing sites. The regenerated DVF tables match today's on row counts. The DVF hypothesis CSVs and `key_numbers.json` in `docs/analysis/dvf/hypotheses/data/` regenerate within rounding. |
| R2.7 site spec landed | `orchestration/sites/<slug>/site.json`, `py/bundle-export.mjs`, `py/bundle-build.py`, `py/bundle-trim.py`, `py/lib/bundle_io.py` | | | `SITES` is deleted. Each of the eight bundle sites has a `site.json` with `focus` (`path`, `label`, `idsitehsr`), and optionally `periods` and `readingNotes`; Kurk's notes moved there. The exporter takes `--site`, `--window-start`, `--window-end`, and `--out`. `periodSql` labels visits from the period list and emits the old `multiIf` for the default `pre`/`first`/`second`. The builder takes `<extract-dir> <outdir>` and reads periods and notes from `meta.json`. `bundle-trim.py` imports the table parsing from `bundle_io.py`. **Still open, deferred by decision on 14 October:** the exporter does not yet read `site.json` `pageClasses` and `channelRules`; the DVF generalization (`orchestration/sites/dvf/site.json`, the DVF bot rule, page classes, `saw_*` flags, and high-value line, then deleting `build.py`, `split.py`, and `export.mjs`); and the `hypothesis-extract` and `hypothesis-build` stages. Today's DVF tables came from `/tmp/dvf.pkl` and `/tmp/dvf_ck.pkl`, which no recorded query produces, so the row-count guard needs a decision on its baseline first. | The R0.1 SQL snapshot and build hashes are unchanged. `test/bundle-export.test.js` and `test/bundle-build-calendar.test.js` cover the spec, the calendar, and a build on a site calendar. |
| R2.8 | `src/audit/brands.js:6-27`, `src/enrichment/trend-seed.js:1-18`, `src/enrichment/trend-run.js:221-233`, `src/enrichment/trend-schema.js:1` | OCP, DIP | Five brands are hard-coded, and an unknown key throws. DVF homepage selectors and idsite 5795 are in production code, and `checkTrend` contains a DVF proof check. | The audit takes a brand list as input from `orchestration/registries/brands.json`. The trend seeds move to `orchestration/sites/dvf/trend-seeds.json`. The DVF proof becomes a test fixture. The trend schema goes through the schema migrator from R2.3. | Audit and trend tests run with injected lists. |
| R2.8 landed | `orchestration/registries/brands.json`, `orchestration/sites/dvf/trend-seeds.json`, `test/fixtures/dvf-trend-proof.js` | | | `selectBrands` takes the brand registry, and `runAudit` needs a list. Composition collects every site's trend seeds, and `runTrend` takes them as input. The DVF device-shape proof is a test fixture. The trend schema goes through the migrator (R2.1). | The audit and trend tests, reading the registries. |
| R2.9 | `bin/name-click-selectors.mjs:17-29,132` | OCP, DIP | Its batch and site list are hard-coded. It loads Playwright through an absolute `createRequire` path. | Sites come from arguments (the orchestrator passes the job's pages). Playwright is resolved from `naming.botDir`. | R0.2 allowlist entries removed. |
| R2.9 landed | `bin/name-click-selectors.mjs` | | | `--batch` and `--sites`, with `--url` for one site whose analysis row has no URL. Playwright loads from `naming.botDir`, and the tables come from the configured database. `main` runs only when the file is executed. | `test/name-click-selectors.test.js`. Its eleven allowlist entries are removed. |

**Phase 3: the report stages**

| ID | Where | Principle | Problem | Refactor | Guard |
|---|---|---|---|---|---|
| R3.1 | `py/charts.py`; the `media/*.png` files in `docs/analysis/*` | SRP, OCP | No stage makes the report charts. This batch's charts were inline Python written per site. `charts.py` is DVF-only, uses absolute paths, and has channel rows typed in by hand. | A `chart-render` stage, a Python command handler. Chart specs (type, bundle table, filters, title, filename) are declared per report in general report descriptors, from the figure lists in the report skills. A site can add, drop, or change figures. The stage reads the full bundle through `bundle_io` and writes `docs/analysis/<slug>/media/<prefix>-fig<N>-<name>.png`. Colours come from `scripts/report-style/tokens.json`, a single source that `tokens.mjs` also reads. `charts.py` is deleted. The report check fails if a referenced figure is missing. | From the Sayii bundle, it renders the same file list that is in `docs/analysis/sayii/media/` today. |
| R3.2 | `scripts/report-style/style-reports.mjs:9` | DIP | The Chrome path is fixed to `/Applications/Google Chrome.app/...`. | It is injected from `orchestrator.config.json` (`report.chromePath`), with `CHROME_PATH` read only in composition. | The existing `style-reports.test.mjs` passes. |
| R3.3 | `scripts/remote-llm-projects/application/site-bundle.mjs:4-20` | OCP (L) | The three report filename patterns are hard-coded. | Read them from the report stage descriptors. | Its existing tests pass. |
| R3.1 landed | `py/chart-render.py`, `py/lib/{bundle_io,chart_style,chart_types}.py`, `adapters/handlers/chart-render.js`, `adapters/checks/charts-rendered.js`, `domain/charts.js` | | | Each report stage declares `charts` (file stem to `{type, ...params}`); a site run adds one with a new key or drops one with `null`. The `chart-render` handler writes the run's declared charts to `<run dir>/charts.json` and runs the descriptor's command with `--specs` appended. Nine chart types live in one registry (`CHART_TYPES`); each reads its own bundle table and raises `Skip` with a reason when the table is empty. The renderer writes `media/charts.json` (file, title, drawn or skipped), which the report prompts cite. `charts-rendered` passes when every declared chart is drawn or skipped with a reason, newer than the bundle profile. The validator rejects a bad stem, a missing type, and a chart two stages declare. Page and chart tokens are in `scripts/report-style/tokens.json`. `py/charts.py` is deleted. | From the Sayii bundle the stage renders the eight files in `docs/analysis/sayii/media/`, with the same numbers (4.3% of 831 mobile cart chains, $1.02 per visit on 1,354 untagged Meta visits). |
| R3.2 landed | `scripts/report-style/style-reports.mjs`, `orchestration/stages/style-pdf.stage.json` | | | `--chrome <path>` overrides the macOS default; the `style-pdf` stage passes `{{config.report.chromePath}}` and holds the `chromium` resource. Its check is `files-exist` on the three PDFs with `newerThan` the markdown, so a PDF older than its report counts as missing. | `style-reports.test.mjs` passes, with an arguments test. |
| R3.3 landed | `scripts/remote-llm-projects/application/report-specs.mjs` | | | `loadReportSpecs(stagesDir)` reads each stage's `report` block (`title`, `order`, `job`); `collectSite` takes the list and refuses to run without one. `analyze-site.mjs` gains `--stages`. The `remote-enhance` stage wraps it in the separate `enhance` run. | The remote-project tests pass, reading the real descriptors. |
| Phase 3 landed | `adapters/handlers/agent.js`, `adapters/checks/markdown-report.js`, `src/domain/report-check/`, `orchestration/general/prompts/report/`, `orchestration/sites/sayii/prompts/report/site-notes.md` | | | The `agent` handler renders the stage prompt with `check.description` and `run.resultFile`, runs the agent in the repo with the bundle and reports directories added, and reads `result.json`. A `blocked` report or a usage limit becomes the failure's `hint`, which `classifyFailure` applies after the stage's own rules. Handler modules may export `createAdapter(deps)`; the registry passes `{agents, prompts, checks, workspace}`. The `markdown-report` rules (`minWords`, `sections`, `headingCount`, `placeholders`, `figures`, `anchors`, `windowEnd`, `fresh`) are calibrated on all fifteen existing reports. A check may export `validate(spec)`, which `orchestrator validate` reports. The validator flags any `{{site.*}}` or `{{config.*}}` reference with no value. Prompt sources include partials and their site layers, so `explain` shows Sayii's site notes. Bare commands such as `node` and `python3` resolve on `PATH`. New runs: `reports-only` and `enhance`; `full` gains `chart-render` before the reports. | A live `reports-only` job on a scratch copy of the Sayii reports drew the charts, found the three reports complete, and wrote three PDFs through the injected Chrome path. `full` end to end waits on the Phase 2 data stages. |

**Phase 4: migration and hardening**

| ID | Where | Principle | Problem | Refactor | Guard |
|---|---|---|---|---|---|
| R4.1 | `src/cli.js:85-278,428,458` | SRP | One `main` holds argument parsing, discovery, the client and schema setup, and eleven commands. Import helpers set `process.exitCode`. | `src/application/commands/<command>.js`. The CLI parses, calls a command, and prints. Helpers return `{ ok, errors }`. | The CLI smoke tests pass. |
| R4.2 | `scripts/queue-lib.mjs:12-39,52-62` | — | The file is being retired. | Move the `PROCESSES` stage graph into the general run descriptors and `normalizeDomain` into `src/orchestrator/domain/site.js`, then delete the file. | `test/queue.test.js` cases that still apply move to the orchestrator suite. |
| R4.3 | `src/index.js`, `src/runner.js`, `src/naming-consumer.js` (the v1 path) | — | `docs/RUNBOOK.md` still runs v1 from two server cron lines, and `deploy/analysis-naming.service` runs `src/index.js --naming-agents 1`. | Mark them deprecated in phase 4, and retire them in phase 5 when the orchestrator's units replace `deploy/analysis-{naming,capture,saliency}.service` and the cron lines. Until then, only the R2.3 port fixes apply. | The server cron runs the orchestrator. |
| R4.4 | Off the critical path (M) | SRP, OCP, DRY | See the list below. | One commit per item, each with its own characterization test. | The register has no open M items. |
| Phase 4 queue landed | `src/orchestrator/application/{job-admin,import-legacy,resolve-site,start-workers}.js`, `domain/{site,legacy-queue}.js`, `adapters/{site-directory,launcher,legacy}/`, `skills/analysis-queue-*`, `skills/analysis-queue/CONTRACT.md` | | | `priority`, `note`, `cancel`, `clear`, `show`, and `retry` select a job by id, domain, or slug and journal each change; `priority` reorders the queued messages. `enqueue` looks up a domain with no `site.json` in `default.sites`, takes only a single active row, and writes the `site.json`. `import-legacy` brings `queue.json` items in under their legacy ids, keeps finished steps, and skips on a second run. `enqueue --start` and `start` launch a detached worker when no live worker serves the queued stages. `complete` records a person's done note on a stage whose check is still pending and queues the next stage. A cancelled job stays cancelled when its in-flight stage settles. The markdown journal writes its header on a new file. The store contract covers every port method on both adapters. The queue skills, the contract, and `.cursorrules` call `bin/orchestrator`; the monitor leads with `STALLED`. | The four legacy items live in `process/orchestrator.db`, and a dry-run `import-legacy` skips all four as already imported. `validate` passes. |
| R4.1 landed | `src/application/commands/{args,imports,enrichment,batch,audit,index}.js` | | | Each command takes the engine context and its flags and returns `{ ok, output }` or `{ ok: false, errors }`. `src/cli.js` parses, finds the command, runs it, and prints. The tool-registry import's missing `parseToolRegistryImport` import is fixed. | `test/engine-commands.test.js`. The 19 `src/cli.js` allowlist entries are removed. |
| R4.2 landed | `src/orchestrator/domain/site.js` | | | `normalizeDomain` lives in the site domain. `scripts/queue.mjs`, `scripts/queue-lib.mjs`, and `test/queue.test.js` are deleted; the cases that still apply run in the orchestrator suite. The stage graph is the general run descriptors. | The orchestrator suite. |
| R4.3 landed | `src/index.js`, `src/runner.js`, `src/naming-consumer.js`, `docs/RUNBOOK.md`, `deploy/analysis-naming.service` | | | Each carries a `@deprecated` note, `src/index.js` logs a warning at start, and the runbook and unit point at the orchestrator. Phase 5 retires them. | |
| R4.4 landed | See the list below. | | | Every item has its own commit and a characterization test recorded on the old code. | The full suite passes (93 files, 823 tests). |

R4.4 items (all landed in phase 4, one commit each):

- Audit acquisition: `audit/queries/{funnel,template,context,_lib}.js` and `audit/shape.js`. The query-plan snapshot pins every spec (id, label, params, chunk days, and a SQL digest).
- Audit runner: `audit/stages/{readiness,site-kpis,funnel,template,context,run-query,page-scope}.js`. Each stage takes the gateway and the inputs it reads. A runner snapshot pins every phase's summary, query order, and stored rows.
- Audit readiness, funnel, and template: the R queries move to `queries/readiness.js`, F1–F4 to `queries/funnel.js`, and H1 with the scorecards to `queries/template.js`. The interpretation modules import `FRESHNESS`, `EVENT_STEPS`, and `SCORECARD_QUERY` from them.
- Product grid: `product-grid/{stats,narrative}.js` and a `RULES` registry in `flags.js` where each rule names its layouts. The click classifiers read `product-grid/click-parts.json`.
- Experiments: `INTERNAL_PARTNERS`, `KIND_RULES`, and `NAME_DEVICES` tables in `normalize.js`.
- Triggers: a `PREDICATES` registry in `evaluate.js`.
- Query bounds: `src/governance/fact-tables.json` holds the shared bounds, and each dataset descriptor declares its own `factTables`.
- Proportions: `src/lib/stats/proportions.js` (`pooledProportionZ`, `wilsonInterval`). A missing or NaN n now gives a null lift in place of NaN.
- Capture consumer: `capture/{bot-runner,artifacts,harvester}.js` and `src/ports/harvest.js`.
- Saliency: `runSaliencyWorker` takes a `SaliencyConfig` built by `saliencyConfig(env)` in composition.
- Catalog: `directoryCatalogSource(dir)` and `buildCatalog(source)`.
- Rebuild schema: `scripts/rebuild-schema/{plan,execute}.mjs` and the CLI.
- Dataset SQL: `ENTRY_VISITS_CTE` in `adapters/_lib/sql.js`; `viewport-weekly` imports the `_lib/viewport.js` CTEs. `order-value-hist` keeps its own entry CTE, because it joins on the raw `idvisit` type.
- Page selector: `src/ports/page-selector.js` and `adapters/_lib/page-targets.js`.

Still open, listed: `test/query-constraints.test.js` keeps its own `TABLE_RULES` map beside `FACT_BOUNDS`, so a new fact table is declared in two places.

The original R4.4 list:

- `src/audit/acquire.js:65-1631` (about 50 query builders plus shaping): split into `audit/queries/{funnel,template,context}.js` and `audit/shape.js`.
- `src/audit/runner.js:53-303`: split into `audit/stages/{readiness,funnel,template,context}.js`, called with explicit inputs.
- `src/audit/{readiness,funnel,template}.js`: split each into queries and interpretation.
- `src/product-grid/flags.js` (1,027 lines): split into `stats.js`, a rules registry keyed by layout (replacing the layout `if`s at `88-89`), and `narrative.js`. The `quick-add` and `rs-qv-panel` click classifiers in `rollup.js:10-15` move to theme-family config.
- `src/experiments/normalize.js:24-43,450-475`: the scope, name, and partner regex chains become data tables.
- `src/triggers/evaluate.js:124-137`: the predicate `if` chain becomes a type-to-function registry.
- `src/governance/query-bounds.js:24-48`: fact-table bounds are registered with dataset descriptors, not a closed map.
- The proportion statistics in `audit/stats.js:69`, `experiments/stats.js:43`, and `product-grid/flags.js:20-54` share one `src/lib/stats/proportions.js`.
- `src/capture-consumer.js`: extract `BotRunner` and `ArtifactLoader`. The harvest re-export in `naming-consumer.js:14` becomes a `HarvestPort`.
- `src/saliency-worker.js:184-215`: its environment reads become a `SaliencyConfig` built in composition.
- `src/catalog/index.js:12-16,68-76`: a `CatalogSource` is injected.
- `scripts/rebuild-schema.mjs`: split into plan, execute, and CLI.
- Dataset SQL: CTEs that repeat the same spine move into `adapters/_lib/sql.js`. `ORDERS_CTE` and `conversionCte` read different sources on purpose; a comment in `_lib/sql.js` records that.
- Add `src/ports/page-selector.js` for the informal `select(...)` contract.

### 4A.3 Audited and kept

`src/discover.js`; `src/domain/*`; the typedef-only ports (`dataset`, `query-gateway`, `telemetry`, `qualifier`, `site-source`); `capture-artifact.js`; `descriptor-import.js`; `governance-import.js`; `bot-flag.js`; `naming-mapper.js`; the dataset adapter-plus-descriptor pattern and the `cards-*` wrappers over `_cards.js`; `adapters/_lib/{session-stream,dims,clicks,viewport,bot-context,rows,urls,checks}`; the importance strategies; `traffic-exclusion/*`; `scripts/remote-llm-projects/**`, apart from R3.3; `scripts/report-style/{html,tokens}.mjs`; `py/bundle-trim.py`.

### 4A.4 Done when

- Both R0.2 allowlists are empty.
- Both persistence contract suites cover every port method, on both adapters.
- The register has no open H or M item. L items may stay open if they are listed.

This is checked at the end of phase 4. Phase 5 retires the v1 path (R4.3).

Status at the end of phase 4: the R4 items are closed, and both persistence contract suites cover every port method. The allowlists still hold 123 entries (104 site literals, 19 composition-only), which belong to the open Phase 2 items R2.1–R2.5 and R2.7–R2.9. The first two conditions are met when those land.

Status on 14 October: R2.1–R2.5, R2.8, and R2.9 have landed, and R2.7 has landed its site spec. The allowlists hold 70 entries (60 site literals, 10 composition-only). None belongs to a landed item. 42 of the site literals are the DVF and hypothesis scripts (`py/export.mjs`, `py/build.py`, `py/split.py`, `py/hypothesis-*`), which go with the rest of R2.7. The others are the probes (`scripts/probe-clickhouse.mjs`, `scripts/probes/run-probes.mjs`), the remote-project and report-style tests and tokens, the idsite-0 trigger entries, `src/audit/queries/template.js`, the environment reads in `src/config.js` and `src/adapters/telemetry/localhost.js`, and the v1 path (`src/index.js`, `bin/seed-named-page.sh`) that phase 5 retires.

---

## 5. Phase 1 in detail

### 5.1 Tasks, in order

| # | Task | Output | Test |
|---|---|---|---|
| 1.0 | Spike Kimi CLI. Run `kimi -p "Write ok to ./out.txt" --auto --output-format stream-json` in a temp directory. Save stdout as a fixture. Confirm that `--skills-dir skills` loads `SKILL.md` folders, and that `--add-dir` grants write access. Check `node -v` on the EC2 box: `node:sqlite` is unflagged from Node 22.13. | `test/fixtures/orchestrator/kimi-stream.jsonl`, notes in this file | — |
| 1.1 | Domain: `errors`, `deep-merge`, `run-descriptor`, `template`, `retry`, `failure`, `job`, `pages`, `validate` | pure modules | `test/orchestrator/domain/*.test.js` |
| 1.2 | Ports: JSDoc contracts | `src/orchestrator/ports/*.js` | type-checked by use |
| 1.3 | Memory store (queue, jobs, events, workers, resources) and the queue contract suite | `adapters/queue/memory.js`, `test/orchestrator/queue-contract.js` | contract on memory |
| 1.4 | SQLite store | `adapters/queue/sqlite.js` | contract on SQLite, plus a two-process lease test |
| 1.5 | Descriptor source (fs) and the run resolver | `adapters/descriptors/fs.js`, `application/resolve-run.js` | selection table in 2.3, merge rules in 2.2 |
| 1.6 | Prompt source (layered fs) | `adapters/prompts/layered-fs.js` | replace, append, partials, missing key |
| 1.7 | Process runner, command handler, checks | `adapters/_lib/process.js`, `adapters/handlers/command.js`, `adapters/checks/{files-exist,naming-complete}.js` | timeout kills the group, abort, log tail |
| 1.8 | Agent port: Kimi CLI and fake adapters | `adapters/agents/{kimi-cli,fake}.js` | argument building, stream parsing from the fixture, timeout |
| 1.9 | Executor, fallback, settler, worker | `application/*` | scenario tests with the memory store and fake agent |
| 1.10 | Journal (markdown, events), workspace, governor | `adapters/journal/*`, `adapters/workspace/fs.js` (port `ports/workspace.js`), `application/governor.js` (capacity rules in `domain/capacity.js`) | |
| 1.11 | Container, plugin loader, CLI, `bin/orchestrator` | `composition/*`, `cli.js` | CLI smoke tests via `execFile`, like `test/queue.test.js` |
| 1.12 | Descriptors and prompts for naming. The other stages are declared with `"handler": { "use": "pending" }` so runs validate. | `orchestration/**` | `validate` passes. Sayii naming runs end to end on the workstation. |
| 1.13 | Housekeeping: set `engines.node` to `>=22.13`, gitignore `process/orchestrator.db*` and `process/runs/`, add an npm script `orchestrator` | | `npm test` |
| 1.14 | Refactor R0.1: the characterization baseline. Make `py/bundle-export.mjs` importable and export its SQL builders. Snapshot them, the page-class fixture, and one recorded bundle build. | `test/characterization/*`, `test/fixtures/bundle/sayii-raw/` | The snapshots pass on today's code. |
| 1.15 | Refactor R0.2: the architecture tests, with today's allowlists | `test/architecture/*` | They pass, and they fail on a new hard-coded path. |
| 1.16 | Refactor R1.1: required naming config and an exit contract for the seed scripts. The naming stage descriptor maps exit 3 to `blocked`. | `bin/seed-named-page.sh`, `bin/name-page.sh`, `orchestration/stages/naming.stage.json` | Missing env exits 3. The R0.2 allowlist shrinks. |

### 5.2 File tree after phase 1

```text
bin/orchestrator
orchestrator.config.example.json
orchestration/
  agents/kimi-cli.agent.json
  agents/fake.agent.json
  stages/naming.stage.json
  stages/{analysis,bundle,bundle-4mb,site-opportunity-report,today-opportunities,user-journey,style-pdf}.stage.json
  general/resilience.json
  general/runs/{default,full,naming-only}.run.json
  general/prompts/system/agent-rules.md
  general/prompts/system/result-contract.md
  general/prompts/fallback/{stage,naming}.md
  sites/sayii/site.json
  sites/sayii/runs/full.run.json
  sites/sayii/prompts/fallback/naming.md
  sites/jormands/site.json
src/orchestrator/
  domain/{errors,deep-merge,run-descriptor,template,retry,failure,job,pages,validate}.js
  ports/{queue,job-store,event-log,worker-registry,resource-lease,stage-handler,completion-check,coding-agent,prompt-source,descriptor-source,journal}.js
  application/{resolve-run,enqueue-job,execute-stage,agentic-fallback,settle,stage-worker,status,governor,workspace,context}.js
  adapters/_lib/{process,tail}.js
  adapters/queue/{memory,sqlite}.js
  adapters/agents/{kimi-cli,fake}.js
  adapters/handlers/{command,pending}.js
  adapters/checks/{files-exist,naming-complete,pending}.js
  adapters/prompts/layered-fs.js
  adapters/descriptors/fs.js
  adapters/journal/{markdown,events,composite}.js
  composition/{plugins,container,config}.js
  cli.js
test/orchestrator/
  queue-contract.js
  queue-memory.test.js
  queue-sqlite.test.js
  run-descriptor.test.js
  resolve-run.test.js
  template.test.js
  prompts.test.js
  process.test.js
  kimi-cli.test.js
  execute-stage.test.js
  stage-worker.test.js
  cli.test.js
  fixtures/...
```

Phase 3 adds `stages/{chart-render,remote-enhance}.stage.json`, `general/runs/{reports-only,enhance}.run.json`, `general/prompts/report/{site-opportunity-report,today-opportunities,user-journey,inputs,site-notes}.md`, `sites/sayii/prompts/report/site-notes.md`, `domain/{charts,agent-report}.js`, `adapters/handlers/{agent,chart-render}.js`, `adapters/checks/{markdown-report,charts-rendered}.js`, `src/domain/report-check/`, `py/chart-render.py`, and `py/lib/`.

### 5.3 Configuration

`orchestrator.config.example.json` is committed. Each machine copies it to `orchestrator.config.json`, which is gitignored like `analysis.config.json`, and sets its own paths. A leading `~` in `values` expands to the home directory.

```json
{
  "root": "orchestration",
  "workspace": "process/runs",
  "journalDir": "process/journal",
  "store": { "adapter": "sqlite", "path": "process/orchestrator.db" },
  "governor": { "capacity": { "chromium": { "limit": 1, "scope": "machine" }, "clickhouse-heavy": 1 }, "leaseMs": 120000 },
  "worker": { "pollMs": 2000, "maxPollMs": 15000, "heartbeatMs": 15000, "maxDeliveries": 5 },
  "values": {
    "analysisRoot": "~/work/analysis",
    "naming": {
      "botDir": "~/source/heatmap/cnn-ai-bot",
      "engineDir": "~/source/heatmap/Heatmap-extension/onsite-heatmap",
      "assetsDir": "~/work/landing-page-analysis/deploy/context/naming-assets",
      "datasetRoot": "~/source/heatmap/cnn-ai-bot/dataset",
      "container": "naming-bot"
    }
  }
}
```

On the server, `store.adapter` becomes `postgres` with `"urlEnv": "ORCH_DATABASE_URL"`, and `values.naming` points at `/home/ec2-user/naming-bot`. Nothing else changes.

`orchestration/general/resilience.json`:

```json
{
  "standard": {
    "fallbackAttempts": 1,
    "repairScope": "Rerun the step, fix inputs and configuration in this repository, and stop stuck processes. Do not edit the naming bot or the Chrome extension unless the stage skill tells you to."
  },
  "top": {
    "fallbackAttempts": 3,
    "repairScope": "Use whatever repair the stage needs, including patches to the naming bot and the Chrome extension engine. Fail only when blocked. List every file you change."
  }
}
```

### 5.4 Ports

`src/orchestrator/ports/queue.js`

```js
/**
 * One queue per stage, named `stage:<stageId>`. Delivery is at least once.
 * A reserved message is invisible to other consumers until its lease expires
 * or the holder settles it. Settling with a stale token throws LeaseLostError.
 *
 * @typedef {Object} EnqueueRequest
 * @property {string} jobId
 * @property {number} priority 0 critical, 1 high, 2 normal, 3 low
 * @property {number} rankAt epoch ms; earlier runs first within a priority (the job's created time)
 * @property {object} payload
 * @property {string} [dedupeKey] a second open message with the same key in the same queue is dropped
 * @property {number} [delayMs]
 *
 * @typedef {Object} QueueMessage
 * @property {string} id
 * @property {string} queue
 * @property {string} jobId
 * @property {number} priority
 * @property {number} rankAt
 * @property {object} payload
 * @property {number} deliveries count of reservations, including this one
 * @property {string|null} lastError
 *
 * @typedef {Object} Lease
 * @property {string} token
 * @property {string} owner
 * @property {number} expiresAt epoch ms
 * @property {QueueMessage} message
 *
 * @typedef {Object} ReserveOptions
 * @property {number} leaseMs
 * @property {string} owner worker id
 * @property {number} [maxInFlight] reserve nothing when this many leases are already held on the queue
 * @property {number} [maxDeliveries] a reclaimed message past this count is dead-lettered
 *
 * @typedef {Object} QueueStats
 * @property {string} queue
 * @property {number} ready
 * @property {number} delayed
 * @property {number} leased
 * @property {number} dead
 * @property {Array<{jobId: string, owner: string, expiresAt: number, deliveries: number}>} leases
 *
 * @typedef {Object} StageQueuePort
 * @property {(queue: string, request: EnqueueRequest) => Promise<{id: string, deduped: boolean}>} enqueue
 * @property {(queue: string, options: ReserveOptions) => Promise<Lease|null>} reserve
 * @property {(lease: Lease, leaseMs: number) => Promise<Lease>} extend
 * @property {(lease: Lease) => Promise<void>} ack
 * @property {(lease: Lease, options: {delayMs: number, reason: string}) => Promise<void>} release
 * @property {(lease: Lease, queue: string, request: EnqueueRequest) => Promise<{id: string, deduped: boolean}>} forward ack and enqueue, atomically
 * @property {(lease: Lease, reason: string) => Promise<void>} deadLetter
 * @property {(messageId: string) => Promise<void>} revive move a dead message back to ready
 * @property {(queue?: string) => Promise<QueueStats[]>} stats
 * @property {(queue: string, limit: number) => Promise<QueueMessage[]>} peekReady
 * @property {(queue?: string) => Promise<QueueMessage[]>} listDead
 */

export class LeaseLostError extends Error {
  constructor(messageId) {
    super(`lease on ${messageId} is no longer held`);
    this.name = 'LeaseLostError';
  }
}
```

`ports/job-store.js`

```js
/**
 * The job is the record of one site going through one resolved run. Queue
 * messages carry only the job id and the stage; everything else is here.
 *
 * @typedef {'pending'|'queued'|'running'|'done'|'blocked'|'failed'|'skipped'} StageStatus
 * @typedef {'queued'|'running'|'done'|'blocked'|'failed'|'cancelled'} JobStatus
 *
 * @typedef {Object} StageState
 * @property {StageStatus} status
 * @property {number} attempts deliveries that ran the primary handler
 * @property {number} fallbackAttempts
 * @property {string|null} startedAt
 * @property {string|null} finishedAt
 * @property {string|null} recoveredBy agent descriptor id when the fallback completed the stage
 * @property {string|null} note
 * @property {string|null} lastError
 *
 * @typedef {Object} Job
 * @property {string} id
 * @property {number} version
 * @property {JobStatus} status
 * @property {'critical'|'high'|'normal'|'low'} priority
 * @property {'standard'|'top'} resilience
 * @property {import('./descriptor-source.js').SiteSpec} site
 * @property {Array<{url: string, role?: string}>} pages
 * @property {{start: string, end: string}} window
 * @property {import('../domain/run-descriptor.js').ResolvedRun} run
 * @property {{refs: Array<{ref: string, file: string}>, hash: string}} provenance
 * @property {Object<string, StageState>} stages keyed by stage id
 * @property {string|null} blocker
 * @property {string} createdAt
 * @property {string} updatedAt
 *
 * @typedef {Object} JobStorePort
 * @property {(job: Job) => Promise<Job>} create
 * @property {(id: string) => Promise<Job|null>} get
 * @property {(id: string, mutate: (job: Job) => Job|void) => Promise<Job>} update serialized per job
 * @property {(filter?: {status?: JobStatus[]}) => Promise<Job[]>} list
 * @property {(domain: string) => Promise<Job[]>} findOpenByDomain
 */
export {};
```

`ports/coding-agent.js`

```js
/**
 * A coding agent runs one prompt to completion in a working directory and
 * returns. It does not decide whether the stage is done; the orchestrator's
 * completion check does.
 *
 * @typedef {Object} AgentRunRequest
 * @property {string} prompt full rendered prompt
 * @property {string} runDir directory for prompt.md, transcript.jsonl, result.json
 * @property {string} workdir
 * @property {string[]} [addDirs] extra directories the agent may read and write
 * @property {string[]} [skillsDirs]
 * @property {string|null} [model]
 * @property {number} [timeoutMs]
 * @property {AbortSignal} [signal]
 *
 * @typedef {Object} AgentRunResult
 * @property {number|null} exitCode
 * @property {boolean} timedOut
 * @property {boolean} aborted
 * @property {string} finalText the agent's closing message
 * @property {string} transcriptFile
 * @property {number} durationMs
 *
 * @typedef {Object} CodingAgentPort
 * @property {string} id descriptor id
 * @property {(request: AgentRunRequest) => Promise<AgentRunResult>} run
 */
export {};
```

`ports/stage-handler.js` and `ports/completion-check.js`

```js
/**
 * @typedef {Object} StageContext
 * @property {import('./job-store.js').Job} job
 * @property {object} stage resolved stage descriptor
 * @property {{key: string, page?: {url: string, role?: string}}} unit
 * @property {number} attempt
 * @property {string} runDir
 * @property {string} owner worker id
 * @property {AbortSignal} signal
 * @property {object} values template values: site, job, stage, unit, params, window, config, paths, resilience
 * @property {(template: string) => string} render strict {{path}} substitution over values
 * @property {(extra?: object) => NodeJS.ProcessEnv} env
 * @property {{repo: string, analysis: string}} paths
 *
 * @typedef {Object} HandlerResult
 * @property {'ok'|'error'} status
 * @property {number|null} [exitCode]
 * @property {boolean} [timedOut]
 * @property {string} [message]
 * @property {string} [command]
 * @property {string} [logFile]
 * @property {string} [logTail]
 * @property {object} [facts] values the job keeps for later stages (phase 2)
 *
 * @typedef {Object} StageHandler
 * @property {string} id
 * @property {(ctx: StageContext, spec: object) => Promise<HandlerResult>} run
 */
export {};
```

```js
/**
 * A check answers one question: is this unit of this stage complete. It is
 * read-only and cheap enough to run before and after every attempt.
 *
 * @typedef {Object} CheckDetail
 * @property {string} name
 * @property {boolean} ok
 * @property {string} [message]
 *
 * @typedef {Object} CheckResult
 * @property {boolean} ok
 * @property {string} summary one line for the journal and the agent prompt
 * @property {CheckDetail[]} details
 *
 * @typedef {Object} CompletionCheck
 * @property {string} id
 * @property {(ctx: import('./stage-handler.js').StageContext, spec: object) => Promise<CheckResult>} evaluate
 * @property {(ctx: import('./stage-handler.js').StageContext, spec: object) => string} describe what "done" means, for the prompt
 */
export {};
```

`ports/prompt-source.js`, `ports/descriptor-source.js`, `ports/journal.js`, `ports/resource-lease.js`, `ports/worker-registry.js`, `ports/event-log.js`

```js
/**
 * @typedef {Object} RenderedPrompt
 * @property {string} text
 * @property {string[]} sources files used, general first
 *
 * @typedef {Object} PromptSourcePort
 * @property {(name: string, values: object, scope: {site?: string}) => Promise<RenderedPrompt>} render
 * @property {(name: string, scope: {site?: string}) => Promise<string[]>} sources
 */

/**
 * @typedef {Object} SiteSpec
 * @property {string} slug
 * @property {string} domain
 * @property {string} origin
 * @property {string} [name]
 * @property {number} [idsite]
 * @property {string} [run]
 * @property {{include?: Array<{url: string, role?: string}>}} [pages]
 * @property {object} [context]
 *
 * @typedef {Object} DescriptorSourcePort
 * @property {(id: string) => Promise<object>} stage
 * @property {() => Promise<string[]>} stageIds
 * @property {(id: string) => Promise<object>} agent
 * @property {() => Promise<object>} resilience
 * @property {(scope: 'general'|'site', name: string, slug?: string) => Promise<{body: object, file: string}|null>} run
 * @property {(file: string) => Promise<{body: object, file: string}>} runFile
 * @property {(slugOrDomain: string) => Promise<SiteSpec|null>} site
 * @property {() => Promise<SiteSpec[]>} sites
 */

/**
 * @typedef {Object} JournalEvent
 * @property {string} type e.g. job.queued, stage.started, unit.satisfied, handler.failed, fallback.started, stage.done
 * @property {string} [stage]
 * @property {string} [message] one readable sentence
 * @property {object} [data]
 *
 * @typedef {Object} JournalPort
 * @property {(job: import('./job-store.js').Job, event: JournalEvent) => Promise<void>} record
 */

/**
 * @typedef {Object} ResourceLeasePort
 * @property {(resource: string, capacity: number, owner: string, leaseMs: number) => Promise<{slot: number, token: string}|null>} tryAcquire
 * @property {(resource: string, token: string, leaseMs: number) => Promise<boolean>} renew
 * @property {(resource: string, token: string) => Promise<void>} release
 *
 * @typedef {Object} WorkerRegistryPort
 * @property {(worker: {owner: string, pid: number, host: string, stages: string[]}) => Promise<void>} heartbeat
 * @property {(owner: string) => Promise<void>} remove
 * @property {() => Promise<Array<{owner: string, pid: number, host: string, stages: string[], lastSeen: number}>>} list
 *
 * @typedef {Object} EventLogPort
 * @property {(jobId: string, event: object) => Promise<void>} append
 * @property {(jobId: string, limit?: number) => Promise<object[]>} tail
 */
export {};
```

### 5.5 Domain

`domain/errors.js`

```js
export class OrchestratorError extends Error {
  constructor(message, { exitCode = 1, cause } = {}) {
    super(message, { cause });
    this.name = this.constructor.name;
    this.exitCode = exitCode;
  }
}
export class DescriptorError extends OrchestratorError {}
export class TemplateError extends OrchestratorError {}
export class NotFoundError extends OrchestratorError {}
```

`domain/deep-merge.js`

```js
const isPlain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Objects merge by key. Arrays and scalars replace. `null` in the patch removes the key. */
export function deepMerge(base, patch) {
  if (patch === undefined) return structuredClone(base);
  if (!isPlain(base) || !isPlain(patch)) return structuredClone(patch);
  const out = structuredClone(base);
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete out[key];
    else out[key] = deepMerge(base[key], value);
  }
  return out;
}

export function setPath(target, dotted, value) {
  const out = structuredClone(target);
  const keys = dotted.split('.');
  let node = out;
  for (const key of keys.slice(0, -1)) {
    if (Array.isArray(node) && !/^\d+$/.test(key)) {
      node = node.find((entry) => entry?.id === key) ?? (() => { throw new Error(`--set: no stage ${key}`); })();
      continue;
    }
    node[key] = isPlain(node[key]) || Array.isArray(node[key]) ? node[key] : {};
    node = node[key];
  }
  node[keys.at(-1)] = value;
  return out;
}
```

`domain/run-descriptor.js`

```js
import { deepMerge } from './deep-merge.js';
import { DescriptorError } from './errors.js';

/**
 * @typedef {Object} RunEntry
 * @property {string} id
 * @property {string} use stage library id
 * @property {boolean} enabled
 *
 * @typedef {Object} ResolvedRun
 * @property {string} id
 * @property {string} [description]
 * @property {object} defaults
 * @property {object|null} pages
 * @property {object[]} stages resolved stage descriptors, in order, each with `id` and `use`
 */

const LIST_KEYS = new Set(['extends', 'stages', 'patch', 'remove', 'insert']);

export function normalizeEntry(entry) {
  const value = typeof entry === 'string' ? { use: entry } : { ...entry };
  if (typeof value.use !== 'string' || !value.use) throw new DescriptorError(`run stage entry needs "use": ${JSON.stringify(entry)}`);
  value.id ??= value.use;
  value.enabled ??= true;
  return value;
}

/** One override layer over the run built so far. Layers apply root first. */
export function applyRunLayer(base, layer, source) {
  const rest = Object.fromEntries(Object.entries(layer).filter(([key]) => !LIST_KEYS.has(key)));
  const run = deepMerge(base, rest);
  let list = layer.stages ? layer.stages.map(normalizeEntry) : (base.stages ?? []).map((entry) => ({ ...entry }));

  for (const id of layer.remove ?? []) {
    if (!list.some((entry) => entry.id === id)) throw new DescriptorError(`${source}: remove names no stage "${id}"`);
    list = list.filter((entry) => entry.id !== id);
  }
  for (const [id, change] of Object.entries(layer.patch ?? {})) {
    const index = list.findIndex((entry) => entry.id === id);
    if (index === -1) throw new DescriptorError(`${source}: patch names no stage "${id}"`);
    list[index] = { ...deepMerge(list[index], change), id: list[index].id, use: list[index].use };
  }
  for (const insertion of layer.insert ?? []) {
    const anchor = insertion.after ?? insertion.before;
    const index = list.findIndex((entry) => entry.id === anchor);
    if (index === -1) throw new DescriptorError(`${source}: insert anchor "${anchor}" is not in the run`);
    list.splice(insertion.after ? index + 1 : index, 0, normalizeEntry(insertion.stage));
  }
  const seen = new Set();
  for (const entry of list) {
    if (seen.has(entry.id)) throw new DescriptorError(`${source}: stage id "${entry.id}" appears twice`);
    seen.add(entry.id);
  }
  run.stages = list;
  return run;
}

/** Library descriptor under the run entry's overrides. */
export function resolveStage(library, entry) {
  const { id, use, enabled, ...override } = entry;
  return { ...deepMerge(library, override), id, use };
}

export function parseRunRef(ref) {
  const match = /^(?:(general|site):)?([a-z0-9][a-z0-9-]*)$/.exec(ref ?? '');
  if (!match) throw new DescriptorError(`run reference "${ref}" must be name, general:name, site:name, or a .json path`);
  return { scope: match[1] ?? 'auto', name: match[2] };
}
```

`domain/template.js`

```js
import { TemplateError } from './errors.js';

const VALUE = /\{\{\s*([a-zA-Z_][\w.-]*)\s*\}\}/g;
const PARTIAL = /\{\{>\s*([a-z0-9][\w./-]*)\s*\}\}/g;

export function lookup(values, dotted) {
  let node = values;
  for (const key of dotted.split('.')) {
    if (node === null || node === undefined || !Object.hasOwn(Object(node), key)) return undefined;
    node = node[key];
  }
  return node;
}

/** Strict substitution. A missing key is an error that names the key and the source. */
export function renderValues(text, values, source = 'template') {
  return text.replace(VALUE, (_, key) => {
    const value = lookup(values, key);
    if (value === undefined) throw new TemplateError(`${source}: no value for {{${key}}}`);
    if (value === null) return '';
    return typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);
  });
}

/** Partials first (async, through the caller's lookup), then values. */
export async function renderTemplate(text, values, { source = 'template', loadPartial, depth = 0 } = {}) {
  if (depth > 5) throw new TemplateError(`${source}: partials nest more than 5 deep`);
  let expanded = text;
  for (const [token, name] of [...text.matchAll(PARTIAL)]) {
    if (!loadPartial) throw new TemplateError(`${source}: partial {{> ${name}}} with no loader`);
    const partial = await loadPartial(`${name}.md`);
    const body = await renderTemplate(partial.body, values, { source: partial.file, loadPartial, depth: depth + 1 });
    expanded = expanded.replace(token, body);
  }
  return renderValues(expanded, values, source);
}

export function parseFrontMatter(raw) {
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(raw);
  if (!match) return { meta: {}, body: raw };
  const meta = {};
  for (const line of match[1].split('\n')) {
    const pair = /^([a-zA-Z_][\w-]*):\s*(.*?)\s*(?:#.*)?$/.exec(line);
    if (pair) meta[pair[1]] = pair[2];
  }
  return { meta, body: raw.slice(match[0].length) };
}
```

`domain/retry.js`

```js
/** Exponential backoff with jitter. `attempt` is 1 for the first retry. */
export function backoffMs(policy = {}, attempt, random = Math.random) {
  const base = policy.backoffMs ?? 30_000;
  const factor = policy.factor ?? 2;
  const max = policy.maxBackoffMs ?? 600_000;
  const jitter = policy.jitter ?? 0.2;
  const raw = Math.min(max, base * factor ** Math.max(0, attempt - 1));
  return Math.round(raw * (1 - jitter + random() * 2 * jitter));
}
```

`domain/failure.js`

```js
/**
 * @typedef {Object} Failure
 * @property {'handler'|'check'|'agent'} kind
 * @property {string} message
 * @property {string} [command]
 * @property {number|null} [exitCode]
 * @property {boolean} [timedOut]
 * @property {string} [logTail]
 * @property {import('../ports/completion-check.js').CheckDetail[]} [details]
 *
 * @typedef {{class: 'transient'|'blocked'|'defect', reason: string}} Verdict
 */

/** First matching rule wins. Unmatched failures are defects, which go to the fallback. */
export function classifyFailure(rules, failure) {
  const haystack = [failure.message, failure.logTail].filter(Boolean).join('\n');
  for (const rule of rules ?? []) {
    if (new RegExp(rule.match, 'i').test(haystack)) return { class: rule.class, reason: rule.reason ?? rule.match };
  }
  if (failure.timedOut) return { class: 'defect', reason: 'timed out' };
  return { class: 'defect', reason: failure.message || 'stage failed' };
}

export function describeFailure(failure, verdict) {
  return {
    kind: failure.kind,
    message: failure.message,
    command: failure.command ?? '(none)',
    exit: failure.exitCode ?? '(none)',
    timedOut: Boolean(failure.timedOut),
    logTail: failure.logTail || '(no output)',
    check: (failure.details ?? []).map((row) => `${row.ok ? 'ok' : 'FAIL'} ${row.name}${row.message ? ` — ${row.message}` : ''}`).join('\n') || '(not run)',
    class: verdict.class,
    reason: verdict.reason,
  };
}
```

`domain/job.js`

```js
export const PRIORITY_RANK = { critical: 0, high: 1, normal: 2, low: 3 };
export const queueName = (stageId) => `stage:${stageId}`;

const blankStage = () => ({ status: 'pending', attempts: 0, fallbackAttempts: 0, startedAt: null, finishedAt: null, recoveredBy: null, note: null, lastError: null });

export function createJob({ id, site, pages, window, priority, resilience, resolved, now }) {
  const at = now.toISOString();
  return {
    id,
    version: 0,
    status: 'queued',
    priority,
    resilience,
    site,
    pages,
    window,
    run: resolved.run,
    provenance: { refs: resolved.refs, hash: resolved.hash },
    stages: Object.fromEntries(resolved.run.stages.map((stage) => [stage.id, blankStage()])),
    blocker: null,
    createdAt: at,
    updatedAt: at,
  };
}

export function nextStage(job, stageId) {
  const index = job.run.stages.findIndex((stage) => stage.id === stageId);
  return job.run.stages[index + 1] ?? null;
}

export function messageFor(job, stage) {
  return {
    jobId: job.id,
    priority: PRIORITY_RANK[job.priority],
    rankAt: Date.parse(job.createdAt),
    dedupeKey: `${job.id}:${stage.id}`,
    payload: { stage: stage.id },
  };
}

export function windowFor(defaults = {}, now) {
  const days = defaults.days ?? 30;
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if ((defaults.end ?? 'yesterday') === 'yesterday') end.setUTCDate(end.getUTCDate() - 1);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (days - 1));
  const iso = (date) => date.toISOString().slice(0, 10);
  return { start: iso(start), end: iso(end) };
}
```

`windowFor({days: 30}, 13 Oct 2026)` gives 13 September – 12 October, the window this batch used. The window is fixed at enqueue, so a run that crosses midnight keeps one window.

`domain/pages.js`

```js
/** The page list a job carries. CLI pages win, then the run's source, then its fallback. */
export function resolvePages({ cliPages, runPages, site }) {
  if (cliPages?.length) return cliPages.map((url) => ({ url }));
  const source = runPages?.source ?? 'site';
  if (source === 'site' && site.pages?.include?.length) return site.pages.include.map((page) => ({ ...page }));
  if (source === 'qualifier') return [{ url: site.origin, role: 'home' }];
  if ((runPages?.fallback ?? 'home') === 'home') return [{ url: site.origin, role: 'home' }];
  return [];
}

/** The units one stage runs. `forEach: pages` is one unit per page. */
export function unitsFor(stage, job) {
  if (stage.forEach === 'pages') return job.pages.map((page) => ({ key: page.url, page }));
  return [{ key: 'site' }];
}
```

`domain/validate.js` checks the resolved run against the library. Every `use` must exist. Every `handler.use` and `check.use` must be a known adapter id. Every `fallback.agent` must have a descriptor. Every prompt name must resolve for this site. `forEach: pages` needs at least one page, and `site.idsite` is required when a template references it. It returns a list of problems, and `validate`/`enqueue` print all of them at once.

### 5.6 Application

`application/resolve-run.js`

```js
import { applyRunLayer, parseRunRef, resolveStage } from '../domain/run-descriptor.js';
import { setPath } from '../domain/deep-merge.js';
import { DescriptorError } from '../domain/errors.js';
import { createHash } from 'node:crypto';

const MAX_CHAIN = 8;

/** @param {{descriptors: import('../ports/descriptor-source.js').DescriptorSourcePort}} deps */
export function createRunResolver({ descriptors }) {
  return { resolve, choose };

  async function choose(site, ref) {
    if (ref?.endsWith('.json')) return descriptors.runFile(ref);
    const { scope, name } = parseRunRef(ref ?? site.run ?? 'default');
    if (scope === 'general') return required(await descriptors.run('general', name), `general:${name}`);
    if (scope === 'site') return required(await descriptors.run('site', name, site.slug), `site:${name} for ${site.slug}`);
    return (await descriptors.run('site', name, site.slug)) ?? required(await descriptors.run('general', name), `general:${name}`);
  }

  async function resolve({ site, ref, sets = [] }) {
    const chain = [];
    let current = await choose(site, ref);
    while (current) {
      if (chain.some((layer) => layer.file === current.file)) throw new DescriptorError(`run extends cycle at ${current.file}`);
      if (chain.length === MAX_CHAIN) throw new DescriptorError(`run extends more than ${MAX_CHAIN} deep`);
      chain.unshift(current);
      current = current.body.extends ? await choose(site, current.body.extends) : null;
    }
    let run = { stages: [] };
    for (const layer of chain) run = applyRunLayer(run, layer.body, layer.file);
    for (const [dotted, value] of sets) run = setPath(run, dotted, value);

    const stages = [];
    for (const entry of run.stages.filter((stage) => stage.enabled)) {
      stages.push(resolveStage(await descriptors.stage(entry.use), entry));
    }
    const resolved = { id: run.id, description: run.description, defaults: run.defaults ?? {}, pages: run.pages ?? null, stages };
    const refs = chain.map((layer) => ({ ref: layer.body.id, file: layer.file }));
    return { run: resolved, refs, hash: createHash('sha256').update(JSON.stringify(resolved)).digest('hex') };
  }
}

function required(found, label) {
  if (!found) throw new DescriptorError(`no run descriptor ${label}`);
  return found;
}
```

`application/enqueue-job.js`

```js
import { createJob, messageFor, queueName, windowFor } from '../domain/job.js';
import { resolvePages } from '../domain/pages.js';
import { OrchestratorError } from '../domain/errors.js';

export function createEnqueue({ descriptors, resolver, validator, jobs, queue, journal, clock, newId }) {
  return async function enqueue({ site: selector, run: ref, priority, resilience, pages: cliPages, sets, note }) {
    const site = (await descriptors.site(selector)) ?? minimalSite(selector);
    const open = await jobs.findOpenByDomain(site.domain);
    if (open.length) throw new OrchestratorError(`${site.domain} already has open job ${open[0].id}`, { exitCode: 2 });

    const resolved = await resolver.resolve({ site, ref, sets });
    const now = clock.now();
    const job = createJob({
      id: newId(now, site.slug),
      site,
      pages: resolvePages({ cliPages, runPages: resolved.run.pages, site }),
      window: windowFor(resolved.run.defaults.window, now),
      priority: priority ?? resolved.run.defaults.priority ?? 'normal',
      resilience: resilience ?? resolved.run.defaults.resilience ?? 'standard',
      resolved,
      now,
    });
    const problems = await validator.validateJob(job);
    if (problems.length) throw new OrchestratorError(`run ${resolved.run.id} is not valid for ${site.slug}:\n- ${problems.join('\n- ')}`);

    const first = job.run.stages[0];
    job.stages[first.id].status = 'queued';
    await jobs.create(job);
    await queue.enqueue(queueName(first.id), messageFor(job, first));
    await journal.record(job, {
      type: 'job.queued',
      message: `queued. Run ${resolved.run.id} (${resolved.refs.map((ref) => ref.file).join(' → ')}), ${job.priority} priority, ${job.resilience} resilience, ${job.pages.length} page(s), window ${job.window.start} to ${job.window.end}.${note ? ` ${note}` : ''}`,
    });
    return job;
  };
}

function minimalSite(selector) {
  const domain = String(selector).toLowerCase().replace(/^https?:\/\//, '').split('/')[0];
  return { slug: domain.replace(/^www\./, '').split('.')[0], domain, origin: `https://${domain}/` };
}
```

`application/execute-stage.js`

```js
import { classifyFailure } from '../domain/failure.js';
import { backoffMs } from '../domain/retry.js';
import { unitsFor } from '../domain/pages.js';

/**
 * One delivery of one stage for one job. It returns how to settle the message
 * and never touches the queue.
 *
 * @typedef {{type: 'advance', note: string, recoveredBy?: string}
 *   | {type: 'retry', delayMs: number, reason: string}
 *   | {type: 'blocked', reason: string}
 *   | {type: 'failed', reason: string}} Settlement
 */
export function createStageExecutor({ jobs, handlers, checks, fallback, governor, journal, contexts, random = Math.random }) {
  return { execute };

  /** @returns {Promise<Settlement>} */
  async function execute({ jobId, stageId, owner, signal }) {
    let job = await jobs.get(jobId);
    if (!job) return { type: 'failed', reason: `no job ${jobId}` };
    if (job.status === 'cancelled') return { type: 'failed', reason: 'job was cancelled' };
    if (job.stages[stageId]?.status === 'done') return { type: 'advance', note: 'already done (redelivery)' };
    const stage = job.run.stages.find((row) => row.id === stageId);
    if (!stage) return { type: 'failed', reason: `job has no stage ${stageId}` };

    job = await jobs.update(jobId, (draft) => {
      const state = draft.stages[stageId];
      state.status = 'running';
      state.attempts += 1;
      state.startedAt ??= new Date().toISOString();
      draft.status = 'running';
    });
    const attempt = job.stages[stageId].attempts;
    await journal.record(job, { type: 'stage.started', stage: stageId, message: `stage ${stageId} started, attempt ${attempt}.` });

    let recoveredBy = null;
    const units = unitsFor(stage, job);
    for (const unit of units) {
      const ctx = await contexts.create({ job, stage, unit, attempt, owner, signal });
      const before = await verify(stage, ctx);
      if (before.ok) {
        await journal.record(job, { type: 'unit.satisfied', stage: stageId, message: `${unit.key} already complete: ${before.summary}` });
        continue;
      }
      const failure = await runPrimary(stage, ctx);
      if (!failure) {
        await journal.record(job, { type: 'unit.done', stage: stageId, message: `${unit.key} complete.` });
        continue;
      }
      const verdict = classifyFailure(stage.errors, failure);
      await journal.record(job, { type: 'unit.failed', stage: stageId, message: `${unit.key}: ${verdict.class}, ${verdict.reason}.`, data: { failure } });
      await jobs.update(jobId, (draft) => { draft.stages[stageId].lastError = `${verdict.class}: ${verdict.reason}`; });

      if (verdict.class === 'blocked') return { type: 'blocked', reason: `${stageId} on ${unit.key}: ${verdict.reason}` };
      if (verdict.class === 'transient' && attempt < (stage.retry?.maxAttempts ?? 1)) {
        return { type: 'retry', delayMs: backoffMs(stage.retry, attempt, random), reason: verdict.reason };
      }
      const outcome = await fallback.recover({ job, stage, unit, ctx, failure, verdict, rerun: () => runPrimary(stage, ctx), verify: () => verify(stage, ctx) });
      if (outcome.type !== 'recovered') return outcome;
      recoveredBy = outcome.agent;
    }
    return { type: 'advance', note: `${units.length} unit(s) complete.`, recoveredBy };
  }

  async function runPrimary(stage, ctx) {
    const handler = await handlers.get(stage.handler.use);
    const result = await governor.withResources(stage.resources ?? [], ctx.owner, ctx.signal, () => handler.run(ctx, stage.handler));
    if (result.status !== 'ok') {
      return { kind: 'handler', message: result.message ?? `exit ${result.exitCode}`, command: result.command, exitCode: result.exitCode, timedOut: result.timedOut, logTail: result.logTail };
    }
    const after = await verify(stage, ctx);
    return after.ok ? null : { kind: 'check', message: `handler exited cleanly but the check failed: ${after.summary}`, command: result.command, exitCode: result.exitCode, details: after.details, logTail: result.logTail };
  }

  async function verify(stage, ctx) {
    const check = await checks.get(stage.check.use);
    return check.evaluate(ctx, stage.check);
  }
}
```

`application/agentic-fallback.js`

```js
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { describeFailure } from '../domain/failure.js';

export function createAgenticFallback({ agents, prompts, checks, jobs, journal, governor, workspace, descriptors }) {
  return { recover };

  async function recover({ job, stage, unit, ctx, failure, verdict, rerun, verify }) {
    const spec = stage.fallback;
    if (!spec?.agent) return { type: 'failed', reason: `${stage.id}: ${verdict.reason}. No fallback is declared.` };
    const profiles = await descriptors.resilience();
    const profile = profiles[job.resilience];
    const limit = typeof spec.maxAttempts === 'object' ? (spec.maxAttempts[job.resilience] ?? profile.fallbackAttempts) : (spec.maxAttempts ?? profile.fallbackAttempts);
    const check = await checks.get(stage.check.use);
    let last = failure;
    let lastVerdict = verdict;

    for (;;) {
      const updated = await jobs.update(job.id, (draft) => { draft.stages[stage.id].fallbackAttempts += 1; });
      const n = updated.stages[stage.id].fallbackAttempts;
      if (n > limit) return { type: 'failed', reason: `${stage.id} on ${unit.key}: fallback used ${limit} attempt(s). Last: ${last.message}` };

      const runDir = await workspace.runDir(job.id, stage.id, `fallback-${n}`);
      const resultFile = path.join(runDir, 'result.json');
      const values = {
        ...ctx.values,
        failure: describeFailure(last, lastVerdict),
        check: { description: check.describe(ctx, stage.check) },
        resilience: { level: job.resilience, repairScope: profile.repairScope },
        run: { dir: runDir, resultFile, attempt: n, limit },
      };
      const prompt = await prompts.render(spec.prompt, values, { site: job.site.slug });
      const agent = await agents.get(spec.agent);
      await journal.record(job, { type: 'fallback.started', stage: stage.id, message: `${unit.key}: ${agent.id} fallback ${n}/${limit} (${prompt.sources.join(' + ')}).` });

      const result = await governor.withResources(spec.resources ?? stage.resources ?? [], ctx.owner, ctx.signal, () => agent.run({
        prompt: prompt.text,
        runDir,
        workdir: ctx.paths.repo,
        addDirs: [runDir, ...(spec.addDirs ?? []).map(ctx.render)],
        skillsDirs: spec.skillsDirs?.map(ctx.render),
        model: spec.model ?? null,
        timeoutMs: spec.timeoutMs,
        signal: ctx.signal,
      }));
      const report = await readReport(resultFile);
      await journal.record(job, { type: 'fallback.finished', stage: stage.id, message: `${agent.id} exited ${result.exitCode}${result.timedOut ? ' (timed out)' : ''}, reported ${report.status}: ${report.summary}`, data: { transcript: result.transcriptFile, changes: report.changes } });

      if (report.status === 'blocked') return { type: 'blocked', reason: `${stage.id} on ${unit.key}: ${report.blocker || report.summary}` };

      let after = await verify();
      if (!after.ok && spec.rerunPrimary) {
        const again = await rerun();
        after = again ? { ok: false, summary: again.message, details: again.details ?? [] } : { ok: true, summary: 'complete after rerun', details: [] };
      }
      if (after.ok) {
        await jobs.update(job.id, (draft) => { draft.stages[stage.id].recoveredBy = agent.id; });
        return { type: 'recovered', agent: agent.id, summary: report.summary };
      }
      last = { kind: 'agent', message: `after fallback ${n}, the check still fails: ${after.summary}`, details: after.details, logTail: result.finalText.slice(-4000) };
      lastVerdict = { class: 'defect', reason: 'fallback did not complete the stage' };
    }
  }
}

async function readReport(file) {
  try {
    const body = JSON.parse(await readFile(file, 'utf8'));
    const status = ['fixed', 'blocked', 'gave_up'].includes(body.status) ? body.status : 'gave_up';
    return { status, summary: String(body.summary ?? ''), blocker: String(body.blocker ?? ''), changes: Array.isArray(body.changes) ? body.changes : [] };
  } catch {
    return { status: 'gave_up', summary: 'no result.json was written', blocker: '', changes: [] };
  }
}
```

`application/settle.js`

```js
import { messageFor, nextStage, queueName } from '../domain/job.js';

/** The job is written before the queue moves. A crash in between is a redelivery that the executor short-circuits. */
export function createSettler({ queue, jobs, journal, clock }) {
  return async function settle(lease, outcome) {
    const { jobId } = lease.message;
    const stageId = lease.message.payload.stage;
    const at = clock.now().toISOString();

    if (outcome.type === 'advance') {
      let job = await jobs.update(jobId, (draft) => {
        Object.assign(draft.stages[stageId], { status: 'done', finishedAt: at, note: outcome.note });
        if (outcome.recoveredBy) draft.stages[stageId].recoveredBy = outcome.recoveredBy;
      });
      const next = nextStage(job, stageId);
      if (!next) {
        job = await jobs.update(jobId, (draft) => { draft.status = 'done'; });
        await queue.ack(lease);
        await journal.record(job, { type: 'job.done', stage: stageId, message: `step ${stageId} done. The job is done.` });
        return;
      }
      job = await jobs.update(jobId, (draft) => { draft.stages[next.id].status = 'queued'; });
      await queue.forward(lease, queueName(next.id), messageFor(job, next));
      await journal.record(job, { type: 'stage.done', stage: stageId, message: `step ${stageId} done${outcome.recoveredBy ? ` (recovered by ${outcome.recoveredBy})` : ''}. Queued for ${next.id}.` });
      return;
    }
    if (outcome.type === 'retry') {
      const job = await jobs.update(jobId, (draft) => { draft.stages[stageId].status = 'queued'; });
      await queue.release(lease, { delayMs: outcome.delayMs, reason: outcome.reason });
      await journal.record(job, { type: 'stage.retry', stage: stageId, message: `${stageId} retries in ${Math.round(outcome.delayMs / 1000)}s: ${outcome.reason}.` });
      return;
    }
    const status = outcome.type === 'blocked' ? 'blocked' : 'failed';
    const job = await jobs.update(jobId, (draft) => {
      draft.stages[stageId].status = status;
      draft.status = status;
      draft.blocker = outcome.reason;
    });
    await queue.deadLetter(lease, outcome.reason);
    await journal.record(job, { type: `job.${status}`, stage: stageId, message: `${status}. ${outcome.reason}` });
  };
}
```

`application/stage-worker.js`

```js
import { LeaseLostError } from '../ports/queue.js';
import { queueName } from '../domain/job.js';

export function createStageWorker({ stage, queue, executor, settle, logger, options, sleep }) {
  const controller = new AbortController();
  let running = null;
  return { start, stop };

  async function start() {
    let wait = options.pollMs;
    while (!controller.signal.aborted) {
      let lease;
      try {
        lease = await queue.reserve(queueName(stage.id), {
          leaseMs: stage.leaseMs ?? options.leaseMs,
          owner: options.owner,
          maxInFlight: stage.concurrency ?? 1,
          maxDeliveries: options.maxDeliveries,
        });
      } catch (err) {
        logger.warn({ err, stage: stage.id }, 'reserve failed; backing off');
        await sleep(wait, controller.signal);
        wait = Math.min(wait * 2, options.maxPollMs);
        continue;
      }
      if (!lease) {
        await sleep(wait, controller.signal);
        wait = Math.min(wait * 2, options.maxPollMs);
        continue;
      }
      wait = options.pollMs;
      running = handle(lease);
      await running;
      running = null;
    }
  }

  async function handle(lease) {
    const local = new AbortController();
    const onStop = () => local.abort(new Error('worker stopping'));
    controller.signal.addEventListener('abort', onStop, { once: true });
    let current = lease;
    const leaseMs = stage.leaseMs ?? options.leaseMs;
    const beat = setInterval(async () => {
      try {
        current = await queue.extend(current, leaseMs);
      } catch (err) {
        if (err instanceof LeaseLostError || (options.now ?? Date.now)() >= current.expiresAt - 1000) {
          logger.warn({ err, stage: stage.id }, 'lease lost; aborting this delivery');
          local.abort(err instanceof LeaseLostError ? err : new LeaseLostError(current.message.id));
          return;
        }
        logger.warn({ err, stage: stage.id }, 'heartbeat failed; retrying before the lease expires');
      }
    }, Math.max(1000, Math.floor(leaseMs / 3)));
    try {
      const outcome = await executor.execute({ jobId: lease.message.jobId, stageId: stage.id, owner: options.owner, signal: local.signal });
      if (controller.signal.aborted) {
        await queue.release(current, { delayMs: 0, reason: 'worker stopped' });
        return;
      }
      await settle(current, outcome);
    } catch (err) {
      if (err instanceof LeaseLostError || local.signal.reason instanceof LeaseLostError) return;
      logger.error({ err, stage: stage.id, job: lease.message.jobId }, 'stage delivery threw');
      await queue.release(current, { delayMs: 60_000, reason: `worker error: ${err.message}` }).catch(() => {});
    } finally {
      clearInterval(beat);
      controller.signal.removeEventListener('abort', onStop);
    }
  }

  async function stop() {
    controller.abort();
    await running;
  }
}
```

`application/governor.js`

```js
/** Holds every named resource for the length of `fn`, in sorted order so two holders cannot deadlock. */
export function createGovernor({ resources, capacity, leaseMs, sleep, pollMs = 2000 }) {
  return {
    async withResources(names, owner, signal, fn) {
      const held = [];
      try {
        for (const name of [...new Set(names)].sort()) {
          const limit = capacity[name];
          if (!limit) throw new Error(`resource "${name}" has no capacity in orchestrator.config.json`);
          let slot = null;
          while (!(slot = await resources.tryAcquire(name, limit, owner, leaseMs))) {
            if (signal?.aborted) throw signal.reason ?? new Error('aborted');
            await sleep(pollMs, signal);
          }
          const renew = setInterval(() => resources.renew(name, slot.token, leaseMs).catch(() => {}), Math.floor(leaseMs / 3));
          held.push({ name, slot, renew });
        }
        return await fn();
      } finally {
        for (const { name, slot, renew } of held.reverse()) {
          clearInterval(renew);
          await resources.release(name, slot.token).catch(() => {});
        }
      }
    },
  };
}
```

`application/context.js` builds `StageContext`. The values are `site`, `job` (`id`, `priority`, `resilience`), `stage` (`id`, `label`, `skill`, `also`), `unit`, `params` (the stage's `params`), `window`, `config` (`values` from the config file, with `~` expanded), and `paths` (`repo`, `analysis`). `render` is `renderValues` over those values. `env(extra)` copies `process.env` and merges `stage.env` and `extra`. `runDir` comes from `workspace.runDir(job.id, stage.id, 'attempt-<n>')`.

`adapters/workspace/fs.js` implements the workspace port: it creates `process/runs/<jobId>/<stage>/<label>/` and returns the path, and reads back the JSON an agent wrote there. `application/status.js` is in 5.10.

### 5.7 Adapters

#### SQLite store: `adapters/queue/sqlite.js`

```js
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { LeaseLostError } from '../../ports/queue.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  queue TEXT NOT NULL,
  job_id TEXT NOT NULL,
  dedupe_key TEXT,
  priority INTEGER NOT NULL,
  rank_at INTEGER NOT NULL,
  payload TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('ready', 'leased', 'done', 'dead')),
  deliveries INTEGER NOT NULL DEFAULT 0,
  available_at INTEGER NOT NULL,
  lease_token TEXT,
  lease_owner TEXT,
  lease_expires_at INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS messages_open_dedupe ON messages(queue, dedupe_key)
  WHERE dedupe_key IS NOT NULL AND state IN ('ready', 'leased');
CREATE INDEX IF NOT EXISTS messages_next ON messages(queue, state, priority, rank_at, available_at);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  domain TEXT NOT NULL,
  status TEXT NOT NULL,
  version INTEGER NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_domain ON jobs(domain, status);
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  type TEXT NOT NULL,
  stage TEXT,
  body TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_job ON events(job_id, seq);
CREATE TABLE IF NOT EXISTS workers (
  owner TEXT PRIMARY KEY,
  pid INTEGER NOT NULL,
  host TEXT NOT NULL,
  stages TEXT NOT NULL,
  last_seen INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS resource_slots (
  resource TEXT NOT NULL,
  slot INTEGER NOT NULL,
  token TEXT NOT NULL,
  owner TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (resource, slot)
);
`;

const OPEN = new Set(['queued', 'running']);

export function createStore({ path: file, root, clock = { now: () => new Date() } }) {
  const full = path.resolve(root ?? process.cwd(), file);
  mkdirSync(path.dirname(full), { recursive: true });
  const db = new DatabaseSync(full);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;');
  db.exec(SCHEMA);
  const now = () => clock.now().getTime();

  const tx = (fn) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const value = fn();
      db.exec('COMMIT');
      return value;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  };

  const sql = {
    insert: db.prepare(`INSERT OR IGNORE INTO messages
      (id, queue, job_id, dedupe_key, priority, rank_at, payload, state, deliveries, available_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'ready', 0, ?, ?, ?)`),
    deadOverdue: db.prepare(`UPDATE messages SET state = 'dead', last_error = 'lease expired ' || deliveries || ' times', lease_token = NULL, updated_at = ?
      WHERE queue = ? AND state = 'leased' AND lease_expires_at < ? AND deliveries >= ?`),
    reclaim: db.prepare(`UPDATE messages SET state = 'ready', lease_token = NULL, lease_owner = NULL, lease_expires_at = NULL,
      last_error = 'lease expired', updated_at = ? WHERE queue = ? AND state = 'leased' AND lease_expires_at < ?`),
    inFlight: db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE queue = ? AND state = 'leased'`),
    next: db.prepare(`SELECT * FROM messages WHERE queue = ? AND state = 'ready' AND available_at <= ?
      ORDER BY priority, rank_at, created_at LIMIT 1`),
    lease: db.prepare(`UPDATE messages SET state = 'leased', deliveries = deliveries + 1, lease_token = ?, lease_owner = ?,
      lease_expires_at = ?, updated_at = ? WHERE id = ? AND state = 'ready'`),
    extend: db.prepare(`UPDATE messages SET lease_expires_at = ?, updated_at = ? WHERE id = ? AND lease_token = ? AND state = 'leased'`),
    settle: db.prepare(`UPDATE messages SET state = ?, available_at = ?, last_error = COALESCE(?, last_error),
      lease_token = NULL, lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ? AND lease_token = ? AND state = 'leased'`),
    revive: db.prepare(`UPDATE messages SET state = 'ready', deliveries = 0, available_at = ?, updated_at = ? WHERE id = ? AND state = 'dead'`),
    stats: db.prepare(`SELECT queue,
        SUM(state = 'ready' AND available_at <= ?) AS ready,
        SUM(state = 'ready' AND available_at > ?) AS delayed,
        SUM(state = 'leased') AS leased,
        SUM(state = 'dead') AS dead
      FROM messages GROUP BY queue ORDER BY queue`),
    leases: db.prepare(`SELECT queue, job_id, lease_owner, lease_expires_at, deliveries FROM messages WHERE state = 'leased'`),
    peek: db.prepare(`SELECT * FROM messages WHERE queue = ? AND state = 'ready' ORDER BY priority, rank_at, created_at LIMIT ?`),
    dead: db.prepare(`SELECT * FROM messages WHERE state = 'dead' AND (? IS NULL OR queue = ?) ORDER BY updated_at DESC`),
    jobGet: db.prepare(`SELECT body, version FROM jobs WHERE id = ?`),
    jobInsert: db.prepare(`INSERT INTO jobs (id, domain, status, version, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`),
    jobPut: db.prepare(`UPDATE jobs SET status = ?, version = ?, body = ?, updated_at = ? WHERE id = ? AND version = ?`),
    jobList: db.prepare(`SELECT body FROM jobs ORDER BY created_at`),
    jobOpen: db.prepare(`SELECT body FROM jobs WHERE domain = ? AND status IN ('queued', 'running')`),
    eventAdd: db.prepare(`INSERT INTO events (job_id, at, type, stage, body) VALUES (?, ?, ?, ?, ?)`),
    eventTail: db.prepare(`SELECT body FROM events WHERE job_id = ? ORDER BY seq DESC LIMIT ?`),
    workerBeat: db.prepare(`INSERT INTO workers (owner, pid, host, stages, last_seen) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(owner) DO UPDATE SET last_seen = excluded.last_seen, stages = excluded.stages`),
    workerRemove: db.prepare(`DELETE FROM workers WHERE owner = ?`),
    workerList: db.prepare(`SELECT * FROM workers`),
    slotClear: db.prepare(`DELETE FROM resource_slots WHERE resource = ? AND expires_at < ?`),
    slotUsed: db.prepare(`SELECT slot FROM resource_slots WHERE resource = ?`),
    slotTake: db.prepare(`INSERT INTO resource_slots (resource, slot, token, owner, expires_at) VALUES (?, ?, ?, ?, ?)`),
    slotRenew: db.prepare(`UPDATE resource_slots SET expires_at = ? WHERE resource = ? AND token = ?`),
    slotFree: db.prepare(`DELETE FROM resource_slots WHERE resource = ? AND token = ?`),
  };

  function enqueueSync(queue, request, at) {
    const id = randomUUID();
    const { changes } = sql.insert.run(
      id, queue, request.jobId, request.dedupeKey ?? null, request.priority, request.rankAt,
      JSON.stringify(request.payload ?? {}), at + (request.delayMs ?? 0), at, at,
    );
    return { id, deduped: changes === 0 };
  }

  function settleSync(lease, state, delayMs, error) {
    const at = now();
    const { changes } = sql.settle.run(state, at + delayMs, error ?? null, at, lease.message.id, lease.token);
    if (changes === 0) throw new LeaseLostError(lease.message.id);
  }

  const toMessage = (row) => ({
    id: row.id, queue: row.queue, jobId: row.job_id, priority: row.priority, rankAt: row.rank_at,
    payload: JSON.parse(row.payload), deliveries: row.deliveries, lastError: row.last_error,
  });

  /** @type {import('../../ports/queue.js').StageQueuePort} */
  const queue = {
    async enqueue(name, request) {
      return tx(() => enqueueSync(name, request, now()));
    },
    async reserve(name, { leaseMs, owner, maxInFlight = Infinity, maxDeliveries = 5 }) {
      return tx(() => {
        const at = now();
        sql.deadOverdue.run(at, name, at, maxDeliveries);
        sql.reclaim.run(at, name, at);
        if (sql.inFlight.get(name).n >= maxInFlight) return null;
        const row = sql.next.get(name, at);
        if (!row) return null;
        const token = randomUUID();
        const expiresAt = at + leaseMs;
        sql.lease.run(token, owner, expiresAt, at, row.id);
        return { token, owner, expiresAt, message: toMessage({ ...row, deliveries: row.deliveries + 1 }) };
      });
    },
    async extend(lease, leaseMs) {
      const at = now();
      const { changes } = sql.extend.run(at + leaseMs, at, lease.message.id, lease.token);
      if (changes === 0) throw new LeaseLostError(lease.message.id);
      return { ...lease, expiresAt: at + leaseMs };
    },
    async ack(lease) {
      tx(() => settleSync(lease, 'done', 0, null));
    },
    async release(lease, { delayMs, reason }) {
      tx(() => settleSync(lease, 'ready', delayMs, reason));
    },
    async forward(lease, next, request) {
      return tx(() => {
        settleSync(lease, 'done', 0, null);
        return enqueueSync(next, request, now());
      });
    },
    async deadLetter(lease, reason) {
      tx(() => settleSync(lease, 'dead', 0, reason));
    },
    async revive(id) {
      const at = now();
      if (sql.revive.run(at, at, id).changes === 0) throw new Error(`no dead message ${id}`);
    },
    async stats() {
      const at = now();
      const leases = sql.leases.all();
      return sql.stats.all(at, at).map((row) => ({
        queue: row.queue, ready: row.ready, delayed: row.delayed, leased: row.leased, dead: row.dead,
        leases: leases.filter((lease) => lease.queue === row.queue).map((lease) => ({
          jobId: lease.job_id, owner: lease.lease_owner, expiresAt: lease.lease_expires_at, deliveries: lease.deliveries,
        })),
      }));
    },
    async peekReady(name, limit) {
      return sql.peek.all(name, limit).map(toMessage);
    },
    async listDead(name = null) {
      return sql.dead.all(name, name).map(toMessage);
    },
  };

  /** @type {import('../../ports/job-store.js').JobStorePort} */
  const jobs = {
    async create(job) {
      const at = now();
      sql.jobInsert.run(job.id, job.site.domain, job.status, 0, JSON.stringify(job), at, at);
      return job;
    },
    async get(id) {
      const row = sql.jobGet.get(id);
      return row ? JSON.parse(row.body) : null;
    },
    async update(id, mutate) {
      return tx(() => {
        const row = sql.jobGet.get(id);
        if (!row) throw new Error(`no job ${id}`);
        const draft = JSON.parse(row.body);
        const next = mutate(draft) ?? draft;
        next.version = row.version + 1;
        next.updatedAt = clock.now().toISOString();
        const { changes } = sql.jobPut.run(next.status, next.version, JSON.stringify(next), now(), id, row.version);
        if (changes === 0) throw new Error(`job ${id} changed underneath this update`);
        return next;
      });
    },
    async list({ status } = {}) {
      const all = sql.jobList.all().map((row) => JSON.parse(row.body));
      return status ? all.filter((job) => status.includes(job.status)) : all;
    },
    async findOpenByDomain(domain) {
      return sql.jobOpen.all(domain).map((row) => JSON.parse(row.body)).filter((job) => OPEN.has(job.status));
    },
  };

  const events = {
    async append(jobId, event) {
      sql.eventAdd.run(jobId, now(), event.type, event.stage ?? null, JSON.stringify(event));
    },
    async tail(jobId, limit = 20) {
      return sql.eventTail.all(jobId, limit).map((row) => JSON.parse(row.body)).reverse();
    },
  };

  const workers = {
    async heartbeat({ owner, pid, host, stages }) {
      sql.workerBeat.run(owner, pid, host, JSON.stringify(stages), now());
    },
    async remove(owner) {
      sql.workerRemove.run(owner);
    },
    async list() {
      return sql.workerList.all().map((row) => ({ owner: row.owner, pid: row.pid, host: row.host, stages: JSON.parse(row.stages), lastSeen: row.last_seen }));
    },
  };

  const resources = {
    async tryAcquire(resource, capacity, owner, leaseMs) {
      return tx(() => {
        const at = now();
        sql.slotClear.run(resource, at);
        const used = new Set(sql.slotUsed.all(resource).map((row) => row.slot));
        for (let slot = 0; slot < capacity; slot += 1) {
          if (used.has(slot)) continue;
          const token = randomUUID();
          sql.slotTake.run(resource, slot, token, owner, at + leaseMs);
          return { slot, token };
        }
        return null;
      });
    },
    async renew(resource, token, leaseMs) {
      return sql.slotRenew.run(now() + leaseMs, resource, token).changes > 0;
    },
    async release(resource, token) {
      sql.slotFree.run(resource, token);
    },
  };

  return { queue, jobs, events, workers, resources, close: () => db.close() };
}
```

`node:sqlite` prints an `ExperimentalWarning`. `bin/orchestrator` runs Node with `--disable-warning=ExperimentalWarning`. The adapter keeps every statement synchronous inside `BEGIN IMMEDIATE`, so two worker processes on one database file cannot double-lease. The two-process test in 1.4 proves that.

#### Memory store: `adapters/queue/memory.js`

It has the same five ports, held in `Map`s, with the same lease, dedupe, delay, dead-letter, and in-flight rules. The contract suite runs against it first, and the scenario tests use it. It is about 150 lines and has no I/O.

#### Queue contract: `test/orchestrator/queue-contract.js`

```js
import { describe, expect, it } from 'vitest';
import { LeaseLostError } from '../../src/orchestrator/ports/queue.js';

/** @param {string} name @param {(clock) => Promise<{queue: import('../../src/orchestrator/ports/queue.js').StageQueuePort, close?: () => void}>} open */
export function describeQueueContract(name, open) {
  describe(`${name} queue contract`, () => {
    const msg = (jobId, extra = {}) => ({ jobId, priority: 2, rankAt: 1, payload: { stage: 'naming' }, ...extra });
    const clockAt = (ms) => { const clock = { t: ms, now: () => new Date(clock.t) }; return clock; };

    it('reserves by priority, then rank, and hides a leased message', async () => {
      const clock = clockAt(1000);
      const { queue } = await open(clock);
      await queue.enqueue('stage:naming', msg('a', { priority: 2, rankAt: 1 }));
      await queue.enqueue('stage:naming', msg('b', { priority: 1, rankAt: 5 }));
      const first = await queue.reserve('stage:naming', { leaseMs: 1000, owner: 'w1' });
      expect(first.message.jobId).toBe('b');
      const second = await queue.reserve('stage:naming', { leaseMs: 1000, owner: 'w2' });
      expect(second.message.jobId).toBe('a');
      expect(await queue.reserve('stage:naming', { leaseMs: 1000, owner: 'w3' })).toBeNull();
    });

    it('redelivers after the lease expires and counts the delivery', async () => {
      const clock = clockAt(1000);
      const { queue } = await open(clock);
      await queue.enqueue('stage:naming', msg('a'));
      const lease = await queue.reserve('stage:naming', { leaseMs: 1000, owner: 'w1' });
      clock.t += 1001;
      const again = await queue.reserve('stage:naming', { leaseMs: 1000, owner: 'w2' });
      expect(again.message.deliveries).toBe(2);
      await expect(queue.ack(lease)).rejects.toBeInstanceOf(LeaseLostError);
    });

    it('respects maxInFlight across owners', async () => {
      const { queue } = await open(clockAt(1000));
      await queue.enqueue('stage:naming', msg('a'));
      await queue.enqueue('stage:naming', msg('b'));
      await queue.reserve('stage:naming', { leaseMs: 1000, owner: 'w1', maxInFlight: 1 });
      expect(await queue.reserve('stage:naming', { leaseMs: 1000, owner: 'w2', maxInFlight: 1 })).toBeNull();
    });

    it('forwards atomically and drops a duplicate open message', async () => {
      const { queue } = await open(clockAt(1000));
      await queue.enqueue('stage:naming', msg('a', { dedupeKey: 'a:naming' }));
      expect((await queue.enqueue('stage:naming', msg('a', { dedupeKey: 'a:naming' }))).deduped).toBe(true);
      const lease = await queue.reserve('stage:naming', { leaseMs: 1000, owner: 'w1' });
      await queue.forward(lease, 'stage:analysis', msg('a', { dedupeKey: 'a:analysis', payload: { stage: 'analysis' } }));
      const [stats] = (await queue.stats()).filter((row) => row.queue === 'stage:analysis');
      expect(stats.ready).toBe(1);
    });

    it('delays a released message and dead-letters a poison one', async () => {
      const clock = clockAt(1000);
      const { queue } = await open(clock);
      await queue.enqueue('stage:naming', msg('a'));
      const lease = await queue.reserve('stage:naming', { leaseMs: 1000, owner: 'w1' });
      await queue.release(lease, { delayMs: 5000, reason: 'transient' });
      expect(await queue.reserve('stage:naming', { leaseMs: 1000, owner: 'w1' })).toBeNull();
      clock.t += 5000;
      for (let i = 0; i < 3; i += 1) {
        await queue.reserve('stage:naming', { leaseMs: 10, owner: 'w1', maxDeliveries: 3 });
        clock.t += 11;
      }
      expect(await queue.reserve('stage:naming', { leaseMs: 10, owner: 'w1', maxDeliveries: 3 })).toBeNull();
      expect((await queue.listDead()).map((row) => row.jobId)).toEqual(['a']);
    });
  });
}
```

`queue-memory.test.js` and `queue-sqlite.test.js` each call `describeQueueContract`. The SQLite one uses a temporary database file. The Postgres adapter in phase 5 adds a third file and must pass the same suite.

#### Process runner: `adapters/_lib/process.js`

```js
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { createTail } from './tail.js';

/** Runs a command in its own process group so a timeout or abort kills every child. */
export function runProcess({ command, args = [], cwd, env, logFile, timeoutMs, killGraceMs = 10_000, signal, onLine, spawnFn = spawn }) {
  return new Promise((resolve, reject) => {
    const log = createWriteStream(logFile, { flags: 'a' });
    const tail = createTail(200);
    const started = Date.now();
    let timedOut = false;
    let aborted = false;
    let done = false;

    const child = spawnFn(command, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const kill = (sig) => { try { process.kill(-child.pid, sig); } catch { /* already gone */ } };
    const stop = () => { kill('SIGTERM'); setTimeout(() => kill('SIGKILL'), killGraceMs).unref(); };
    const timer = timeoutMs ? setTimeout(() => { timedOut = true; stop(); }, timeoutMs) : null;
    const onAbort = () => { aborted = true; stop(); };
    if (signal?.aborted) onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });

    const pump = (stream) => {
      let carry = '';
      stream.on('data', (chunk) => {
        log.write(chunk);
        const lines = (carry + chunk.toString('utf8')).split('\n');
        carry = lines.pop();
        for (const line of lines) { tail.push(line); onLine?.(line); }
      });
      stream.on('end', () => { if (carry) { tail.push(carry); onLine?.(carry); } });
    };
    pump(child.stdout);
    pump(child.stderr);

    const finish = (fn) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      log.end(fn);
    };
    child.on('error', (err) => finish(() => reject(err)));
    child.on('close', (exitCode, exitSignal) => finish(() => resolve({
      exitCode, exitSignal, timedOut, aborted, tail: tail.text(), durationMs: Date.now() - started,
    })));
  });
}
```

`adapters/_lib/tail.js` is a ring buffer of the last N lines, with `push(line)` and `text()`.

#### Command handler: `adapters/handlers/command.js`

```js
import path from 'node:path';
import { runProcess } from '../_lib/process.js';

/** @type {import('../../ports/stage-handler.js').StageHandler} */
export const adapter = {
  id: 'command',
  async run(ctx, spec) {
    const command = path.isAbsolute(ctx.render(spec.command)) ? ctx.render(spec.command) : path.join(ctx.paths.repo, ctx.render(spec.command));
    const args = (spec.args ?? []).map((arg) => ctx.render(arg));
    const cwd = spec.cwd ? ctx.render(spec.cwd) : ctx.paths.repo;
    const logFile = path.join(ctx.runDir, 'primary.log');
    const shown = [command, ...args].join(' ');
    const result = await runProcess({
      command, args, cwd, logFile,
      env: ctx.env(spec.env),
      timeoutMs: spec.timeoutMs ?? ctx.stage.timeoutMs,
      signal: ctx.signal,
    });
    const ok = result.exitCode === 0 && !result.timedOut && !result.aborted;
    return {
      status: ok ? 'ok' : 'error',
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      command: shown,
      logFile,
      logTail: result.tail,
      message: ok ? 'exit 0' : result.timedOut ? `timed out after ${spec.timeoutMs ?? ctx.stage.timeoutMs}ms` : `exit ${result.exitCode ?? result.exitSignal}`,
    };
  },
};
```

`adapters/handlers/pending.js` returns `{ status: 'error', message: 'this stage has no handler yet' }` and classifies as `blocked` through the stage's `errors` (`"no handler yet"` → `blocked`). `adapters/checks/pending.js` never reports complete. Every stage declares a handler and a check, and the validator rejects a run whose stage lacks either. Runs that include phase 2 and 3 stages then validate and enqueue, and they stop at a clear blocker that `retry` resumes once the real handler lands.

#### Naming check: `adapters/checks/naming-complete.js`

```js
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

/** dataset/<idsite>/<kind>/<slug>/ must hold names.json with rows, both renders, and console.json with naming.complete. */
export const adapter = {
  id: 'naming-complete',
  describe(ctx, spec) {
    return `${ctx.render(spec.datasetRoot)}/${ctx.values.site.idsite}/<kind>/${pageSlug(ctx.unit.page.url)}/ has names.json with at least one row, render.desktop.json, render.mobile.json, and console.json containing "naming.complete".`;
  },
  async evaluate(ctx, spec) {
    const root = path.join(ctx.render(spec.datasetRoot), String(ctx.values.site.idsite));
    const slug = pageSlug(ctx.unit.page.url);
    const dir = await findPageDir(root, slug, preferredKind(ctx.unit.page.url));
    if (!dir) return { ok: false, summary: `no dataset folder for ${slug} under ${root}`, details: [{ name: 'folder', ok: false, message: root }] };
    const details = [
      await namesHaveRows(path.join(dir, 'names.json')),
      await exists(path.join(dir, 'render.desktop.json'), 'render.desktop.json'),
      await exists(path.join(dir, 'render.mobile.json'), 'render.mobile.json'),
      await contains(path.join(dir, 'console.json'), 'naming.complete'),
    ];
    const ok = details.every((row) => row.ok);
    return { ok, summary: ok ? `${dir} complete` : `${dir}: ${details.filter((row) => !row.ok).map((row) => row.name).join(', ')} missing`, details };
  },
};

export function pageSlug(url) {
  const segments = new URL(url).pathname.split('/').filter(Boolean);
  return segments.at(-1) ?? 'index';
}

function preferredKind(url) {
  const { pathname } = new URL(url);
  if (pathname === '/' || pathname === '') return 'landing';
  if (pathname.includes('/products/')) return 'pdp';
  if (pathname.includes('/collections/')) return 'collection';
  return null;
}

async function findPageDir(root, slug, kind) {
  if (kind && (await isDir(path.join(root, kind, slug)))) return path.join(root, kind, slug);
  let kinds = [];
  try { kinds = await readdir(root); } catch { return null; }
  for (const candidate of kinds.sort()) {
    if (await isDir(path.join(root, candidate, slug))) return path.join(root, candidate, slug);
  }
  return null;
}

async function namesHaveRows(file) {
  try {
    const body = JSON.parse(await readFile(file, 'utf8'));
    const rows = Array.isArray(body) ? body : (body.names ?? body.rows ?? []);
    return { name: 'names.json', ok: rows.length > 0, message: `${rows.length} row(s)` };
  } catch (err) {
    return { name: 'names.json', ok: false, message: err.code ?? err.message };
  }
}

async function exists(file, name) {
  try { return { name, ok: (await stat(file)).size > 0 }; } catch { return { name, ok: false, message: 'missing' }; }
}

async function contains(file, text) {
  try { return { name: 'console.json naming.complete', ok: (await readFile(file, 'utf8')).includes(text) }; } catch { return { name: 'console.json naming.complete', ok: false, message: 'missing' }; }
}

async function isDir(dir) {
  try { return (await stat(dir)).isDirectory(); } catch { return false; }
}
```

`adapters/checks/files-exist.js` takes `paths` (templated) and an optional `minBytes`, and returns one detail per path. Phase 2 adds `anchors-match`, `command-exit`, and `clickhouse-count`. Phase 3 adds `markdown-report`.

#### Kimi CLI adapter: `adapters/agents/kimi-cli.js`

```js
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runProcess } from '../_lib/process.js';

/**
 * Kimi Code CLI, one prompt per process: `kimi -p ... --auto --output-format stream-json`.
 * The full prompt is written to prompt.md and the CLI is told to read it, so a
 * long failure log never hits the argv limit.
 *
 * @param {object} descriptor contents of orchestration/agents/<id>.agent.json
 * @param {{ env?: NodeJS.ProcessEnv, run?: typeof runProcess }} [deps]
 * @returns {import('../../ports/coding-agent.js').CodingAgentPort}
 */
export function createAgent(descriptor, deps = {}) {
  const env = deps.env ?? process.env;
  const run = deps.run ?? runProcess;

  return {
    id: descriptor.id,
    async run(request) {
      const promptFile = path.join(request.runDir, 'prompt.md');
      const transcriptFile = path.join(request.runDir, 'transcript.jsonl');
      await writeFile(promptFile, request.prompt);
      const parser = createStreamParser();
      const result = await run({
        command: descriptor.command,
        args: buildArgs(descriptor, request, promptFile),
        cwd: request.workdir,
        env: agentEnv(descriptor, env),
        logFile: transcriptFile,
        timeoutMs: request.timeoutMs ?? descriptor.timeoutMs,
        killGraceMs: descriptor.killGraceMs,
        signal: request.signal,
        onLine: parser.push,
      });
      return {
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        aborted: result.aborted,
        finalText: parser.finalText() || result.tail,
        transcriptFile,
        durationMs: result.durationMs,
      };
    },
  };
}

export function buildArgs(descriptor, request, promptFile) {
  const prompt = descriptor.promptDelivery === 'inline'
    ? request.prompt
    : `Read ${promptFile} and do exactly what it says. That file is your whole task. Write the result file it names before you stop.`;
  const args = ['-p', prompt];
  if (descriptor.mode === 'auto') args.push('--auto');
  else if (descriptor.mode === 'yolo') args.push('--yolo');
  args.push('--output-format', descriptor.outputFormat ?? 'text');
  const model = request.model ?? descriptor.model;
  if (model) args.push('-m', model);
  for (const dir of request.skillsDirs ?? descriptor.skillsDirs ?? []) args.push('--skills-dir', path.resolve(request.workdir, dir));
  for (const dir of request.addDirs ?? []) args.push('--add-dir', dir);
  return args;
}

function agentEnv(descriptor, env) {
  const out = {};
  for (const key of descriptor.env?.pass ?? []) if (env[key] !== undefined) out[key] = env[key];
  return { ...out, ...(descriptor.env?.set ?? {}) };
}

/** Tolerant: each stdout line may be JSON; the last assistant text wins. Non-JSON lines are ignored. */
export function createStreamParser() {
  let last = '';
  return {
    push(line) {
      let event;
      try { event = JSON.parse(line); } catch { return; }
      const text = textOf(event);
      if (text && isAssistant(event)) last = text;
    },
    finalText: () => last.trim(),
  };
}

function isAssistant(event) {
  const role = event?.role ?? event?.message?.role ?? event?.data?.role;
  const type = String(event?.type ?? '');
  return role === 'assistant' || /assistant|agent\.message|result/.test(type);
}

function textOf(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (typeof value.text === 'string') return value.text;
  if (typeof value.result === 'string') return value.result;
  if (typeof value.content === 'string') return value.content;
  if (Array.isArray(value.content)) return value.content.map((part) => (typeof part === 'string' ? part : part?.text ?? '')).join('');
  return textOf(value.message ?? value.data);
}
```

Spike 1.0 decides the stream-json shape. The parser is tolerant on purpose, and `kimi-cli.test.js` pins it to the recorded fixture. `textOf` mirrors the one in `scripts/remote-llm-projects/adapters/kimi.mjs`, and phase 2 moves both into one shared `_lib/text-of.js`.

`adapters/agents/fake.js` is the test double. `createAgent(descriptor, { behave })` calls `behave(request)`, a test function that writes `result.json` and may "fix" a fixture directory. It returns a canned result. Scenario tests use it.

#### Prompts: `adapters/prompts/layered-fs.js`

```js
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseFrontMatter, renderTemplate } from '../../domain/template.js';
import { NotFoundError } from '../../domain/errors.js';

const NAME = /^(system|fallback|primary|report)\/[a-z0-9][a-z0-9-]*\.md$/;

/** sites/<slug>/prompts/<name> over general/prompts/<name>. Front matter `mode` chooses replace, append, or prepend. */
export function createLayeredPromptSource({ root }) {
  return { render, sources };

  async function load(name, site) {
    if (!NAME.test(name)) throw new NotFoundError(`prompt name "${name}" must be <class>/<name>.md`);
    const general = await read(path.join(root, 'general', 'prompts', name));
    const specific = site ? await read(path.join(root, 'sites', site, 'prompts', name)) : null;
    if (!general && !specific) throw new NotFoundError(`no prompt ${name} for ${site ?? 'general'}`);
    if (!specific) return { body: general.body, file: general.file, sources: [general.file] };
    const mode = specific.meta.mode ?? 'replace';
    if (mode === 'replace' || !general) return { body: specific.body, file: specific.file, sources: [specific.file] };
    const body = mode === 'prepend' ? `${specific.body}\n\n${general.body}` : `${general.body}\n\n${specific.body}`;
    return { body, file: `${general.file} + ${specific.file}`, sources: [general.file, specific.file] };
  }

  async function render(name, values, { site } = {}) {
    const top = await load(name, site);
    const used = [...top.sources];
    const text = await renderTemplate(top.body, values, {
      source: top.file,
      loadPartial: async (partial) => {
        const found = await load(partial, site);
        used.push(...found.sources);
        return found;
      },
    });
    return { text, sources: [...new Set(used)] };
  }

  async function sources(name, { site } = {}) {
    return (await load(name, site)).sources;
  }
}

async function read(file) {
  try {
    const { meta, body } = parseFrontMatter(await readFile(file, 'utf8'));
    return { meta, body, file };
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}
```

#### Descriptor source: `adapters/descriptors/fs.js`

It reads `stages/<id>.stage.json`, `agents/<id>.agent.json`, `general/resilience.json`, `general/runs/<name>.run.json`, `sites/<slug>/runs/<name>.run.json`, and `sites/*/site.json`. `site(selector)` matches a slug, a domain, or a `www.` variant of the domain. Every id is checked against `/^[a-z][a-z0-9-]{0,47}$/` before it becomes a path. A parse error names the file.

#### Journal: `adapters/journal/{markdown,events,composite}.js`

`markdown` appends `- <iso> — <message>` to `process/journal/<jobId>.md` and writes the journal header table the first time it creates the file, so imported legacy journals and new ones read the same. `events` writes the whole event to the store's `events` table. `composite` fans one `record` out to both and logs (rather than throws) a journal write that fails, so a journal problem never fails a stage.

### 5.8 Composition

`composition/plugins.js`

```js
const ID = /^[a-z][a-z0-9-]{0,47}$/;
const KINDS = new Set(['queue', 'agents', 'handlers', 'checks', 'journal']);

/** The only place an id becomes a module. It knows nothing about what the module does. */
export async function loadPlugin(kind, id) {
  if (!KINDS.has(kind)) throw new Error(`unknown adapter kind ${kind}`);
  if (!ID.test(id ?? '')) throw new Error(`bad ${kind} adapter id ${JSON.stringify(id)}`);
  const url = new URL(`../adapters/${kind}/${id}.js`, import.meta.url);
  try {
    return await import(url.href);
  } catch (err) {
    if (err?.code === 'ERR_MODULE_NOT_FOUND' && String(err.message).includes(url.pathname)) throw new Error(`no ${kind} adapter "${id}"`);
    throw err;
  }
}

/** Lazy registry of `export const adapter` modules (handlers, checks). */
export function createRegistry(kind) {
  const cache = new Map();
  return {
    async get(id) {
      if (!cache.has(id)) {
        const mod = await loadPlugin(kind, id);
        if (!mod.adapter || mod.adapter.id !== id) throw new Error(`${kind}/${id}.js must export adapter with id "${id}"`);
        cache.set(id, mod.adapter);
      }
      return cache.get(id);
    },
  };
}

/** Agents are descriptor first: the descriptor names its adapter. */
export function createAgentRegistry({ descriptors, deps }) {
  const cache = new Map();
  return {
    async get(id) {
      if (!cache.has(id)) {
        const descriptor = await descriptors.agent(id);
        const mod = await loadPlugin('agents', descriptor.adapter);
        if (typeof mod.createAgent !== 'function') throw new Error(`agents/${descriptor.adapter}.js has no createAgent`);
        cache.set(id, mod.createAgent(descriptor, deps));
      }
      return cache.get(id);
    },
  };
}
```

`composition/container.js`

```js
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from './config.js';
import { loadPlugin, createRegistry, createAgentRegistry } from './plugins.js';
import { createFsDescriptorSource } from '../adapters/descriptors/fs.js';
import { createLayeredPromptSource } from '../adapters/prompts/layered-fs.js';
import { createMarkdownJournal } from '../adapters/journal/markdown.js';
import { createEventsJournal } from '../adapters/journal/events.js';
import { createCompositeJournal } from '../adapters/journal/composite.js';
import { createRunResolver } from '../application/resolve-run.js';
import { createValidator } from '../application/validate.js';
import { createEnqueue } from '../application/enqueue-job.js';
import { createStageExecutor } from '../application/execute-stage.js';
import { createAgenticFallback } from '../application/agentic-fallback.js';
import { createSettler } from '../application/settle.js';
import { createStageWorker } from '../application/stage-worker.js';
import { createGovernor } from '../application/governor.js';
import { createWorkspace } from '../adapters/workspace/fs.js';
import { createContexts } from '../application/context.js';
import { readStatus } from '../application/status.js';
import { newJobId, sleep } from '../application/util.js';

export async function createContainer({ repoRoot, configFile = 'orchestrator.config.json', env = process.env, logger }) {
  const config = await loadConfig(path.join(repoRoot, configFile), repoRoot);
  const clock = { now: () => new Date() };
  const { createStore } = await loadPlugin('queue', config.store.adapter);
  const store = await createStore({ ...config.store, root: repoRoot, clock, env });

  const root = path.join(repoRoot, config.root);
  const descriptors = createFsDescriptorSource({ root });
  const prompts = createLayeredPromptSource({ root });
  const agents = createAgentRegistry({ descriptors, deps: { env } });
  const handlers = createRegistry('handlers');
  const checks = createRegistry('checks');
  const journal = createCompositeJournal([createMarkdownJournal({ dir: path.join(repoRoot, config.journalDir), clock }), createEventsJournal(store.events)], logger);
  const workspace = createWorkspace({ root: path.join(repoRoot, config.workspace) });
  const governor = createGovernor({ resources: store.resources, capacity: config.governor.capacity, leaseMs: config.governor.leaseMs, sleep });
  const resolver = createRunResolver({ descriptors });
  const validator = createValidator({ descriptors, prompts, handlers, checks });
  const contexts = createContexts({ repoRoot, config, workspace, env });
  const fallback = createAgenticFallback({ agents, prompts, checks, jobs: store.jobs, journal, governor, workspace, descriptors });
  const executor = createStageExecutor({ jobs: store.jobs, handlers, checks, fallback, governor, journal, contexts });
  const settle = createSettler({ queue: store.queue, jobs: store.jobs, journal, clock });
  const enqueue = createEnqueue({ descriptors, resolver, validator, jobs: store.jobs, queue: store.queue, journal, clock, newId: newJobId });
  const owner = `${os.hostname()}:${process.pid}`;

  return {
    config, store, descriptors, prompts, resolver, validator, enqueue, owner,
    makeWorker: (stage) => createStageWorker({ stage, queue: store.queue, executor, settle, logger, sleep, options: { ...config.worker, owner, leaseMs: stage.leaseMs ?? 120_000 } }),
    status: () => readStatus({ store, descriptors, config, clock }),
    close: () => store.close?.(),
  };
}
```

### 5.9 CLI

`bin/orchestrator`

```bash
#!/usr/bin/env bash
set -euo pipefail
here=$(cd "$(dirname "$0")/.." && pwd)
exec node --disable-warning=ExperimentalWarning "$here/src/orchestrator/cli.js" "$@"
```

| Command | Does |
|---|---|
| `validate [--site slug]` | Loads every descriptor and resolves every run for every site. Prints every problem. Exit 1 if any. |
| `explain <site> [--run ref] [--set k=v]` | Prints the resolved run, the layer files root first, each stage's source layer, its agent, and its prompt files. |
| `enqueue <site\|domain> [--run ref] [--priority p] [--resilience r] [--pages u,u] [--set k=v] [--note text]` | Resolves, validates, snapshots, and queues on the first stage. |
| `run [--stages a,b] [--until-idle] [--once]` | Starts one worker per stage in the library (or per named stage), heartbeats every `heartbeatMs`, and stops cleanly on SIGINT/SIGTERM. `--until-idle` exits when every stage queue is empty and nothing is leased. |
| `status [--json]` | The monitor text: per-stage holder, attempt, and agent; next 5; queue length; dead letters; workers; `STALLED`. |
| `retry <jobId> [--stage id] [--refresh]` | Revives the job's dead message (or re-enqueues the stage), resets the stage counters, and re-resolves the run with `--refresh`. |
| `dlq [--stage id]` / `dlq revive <messageId>` | Lists or revives dead letters. |
| `cancel <jobId>` | Marks the job cancelled. Its message settles as failed on the next delivery. |
| `jobs [--status s]`, `show <jobId>` | The job record and the last 20 events. |

`cli.js` parses with `node:util` `parseArgs`, calls the container, prints JSON on stdout, and maps `OrchestratorError.exitCode` to the process exit code. `run` keeps a worker-registry heartbeat with `setInterval`, and it removes its row on exit.

### 5.10 Status, with liveness

`application/status.js` combines `queue.stats()`, `jobs.list({status: ['queued', 'running']})`, `workers.list()`, and `events.tail()`:

```text
Stages:
naming: sayiioficial.com — page 2/3, attempt 1, fallback kimi-cli 1/1 — worker mbp:4412 (alive 4s ago)
analysis: jormands.com.co — STALLED: lease held by mbp:3990, last heartbeat 9m ago
bundle: empty (1 ready)
...
Next 5:
1. vitasei.com.co — high — full — waiting for naming
Queue length: 3 (2 in a stage, 1 waiting). Done 4. Blocked 0. Failed 0. Dead letters 0.
Workers: 1 alive (mbp:4412, stages naming…style-pdf).
```

A stage is `STALLED` when its lease owner's `lastSeen` is older than 3 × `heartbeatMs`. It also stalls when the queue has ready messages and no live worker serves that stage. The monitor skill reports this text and does not change anything.

### 5.11 Phase 1 descriptors and prompts

`orchestration/general/runs/default.run.json`

```json
{ "id": "default", "extends": "general:naming-only" }
```

During Phase 1, `default` and each site's `run` name `naming-only`, because naming is the only stage with a handler. The other seven stages use the `pending` handler and the `pending` check, so a job that reaches one fails with a clear reason. `full` still resolves for `explain` and for `--run full`. Phase 2 points `default` back at `general:full` once the analysis handler lands.

`orchestration/general/runs/naming-only.run.json`

```json
{ "id": "naming-only", "description": "Name every page in the site's collection.", "defaults": { "window": { "days": 30, "end": "yesterday" } }, "pages": { "source": "site", "fallback": "home" }, "stages": ["naming"] }
```

`orchestration/sites/sayii/runs/full.run.json`

```json
{
  "id": "full",
  "extends": "general:full",
  "defaults": { "priority": "high" },
  "patch": { "naming": { "params": { "note": "Spanish storefront" } } }
}
```

`orchestration/general/prompts/system/agent-rules.md`

```md
You are working inside the analysis-engine repository at {{paths.repo}}, unattended. Nobody will answer a question. Decide, act, and verify.

Rules that always apply:
- Do not print secrets. ClickHouse credentials are in the environment. Use them, and never echo them.
- Do not commit, push, or open pull requests.
- Do not edit process/queue/queue.json, process/orchestrator.db, or another job's run directory.
- Do not invent an idsite, a page, an order, or a number. If the data is not there, say so in the result file.
- Do not write an empty or stand-in artifact to make a check pass. The check is there to prove the work happened.
- Keep long-running commands in the foreground with their own log file under {{run.dir}}.
- Repair scope for this job ({{resilience.level}}): {{resilience.repairScope}}
```

`orchestration/general/prompts/system/result-contract.md`

````md
## Result

Before you stop, write `{{run.resultFile}}` as JSON:

```json
{ "status": "fixed | blocked | gave_up", "summary": "one or two sentences", "blocker": "only when blocked", "changes": ["every file you changed"] }
```

Use `blocked` only for something a person must do: the merchant site is down after retries, a login wall, an unknown idsite, missing credentials, or a decision only the user can make. The orchestrator runs the completion check itself after you stop. `fixed` with a failing check counts as not fixed.
````

`orchestration/general/prompts/fallback/naming.md`

````md
{{> system/agent-rules}}

# Finish the naming stage for {{site.domain}}

Attempt {{run.attempt}} of {{run.limit}}. The orchestrator ran naming for one page, and the stage is not complete. Make it complete, verify it, and stop.

- Page: {{unit.page.url}}
- idsite: {{site.idsite}}
- Command: `{{failure.command}}`
- Exit: {{failure.exit}} · timed out: {{failure.timedOut}}
- Classified: {{failure.class}}, {{failure.reason}}

Completion check results:

```text
{{failure.check}}
```

Last log lines:

```text
{{failure.logTail}}
```

## Done means

{{check.description}}

## How to work

1. Read `{{stage.skill}}` and follow it. It is the authority for this stage.
2. Run the harvest as `bin/seed-named-page.sh {{unit.page.url}} {{site.idsite}}` in the background with its own log under `{{run.dir}}`. A subshell of a tool call gets killed.
3. Known traps on this workstation:
   - Seed stdout is fully buffered until exit. Silence is not a hang.
   - Node at 0% CPU with a Chromium renderer near 100% means the page main thread is inside the injected engine. Wait several minutes before killing it.
   - Never run two seeds at once.
   - Use `seed`, not `page`. `page` needs a writer and a pre-built catalog and exits before the harvest.
4. The naming bot is in `{{config.naming.botDir}}`. The engine overlay is in `{{config.naming.engineDir}}`. Change either only if the repair scope above allows it.
5. When the folder passes the check, stop.

{{> system/result-contract}}
````

`orchestration/sites/sayii/prompts/fallback/naming.md`

```md
---
mode: append
---
## Sayii notes

- The domain is sayiioficial.com, with two i's. The live origin is https://www.sayiioficial.com/ (the apex redirects there).
- The add control reads "Añadir Al Carrito". The English regex in bot-draft misses it. That is a descriptor problem for the analysis stage, not a naming failure.
```

`orchestration/general/prompts/fallback/stage.md` is the generic recovery prompt that any stage without its own uses. It has the same sections, with `{{stage.label}}` and `{{stage.skill}}` in place of the naming specifics.

### 5.12 Scenario tests (`test/orchestrator/execute-stage.test.js`, `stage-worker.test.js`)

These use the memory store, the fake agent, and a fake handler and check that read a map of unit → state:

1. **Happy path.** Three pages. The handler makes each one complete. The job advances to the next queue, and the journal has three `unit.done` lines.
2. **Pre-check skips.** Page 1 is already complete. The handler is called twice, not three times.
3. **Transient, then success.** The first delivery fails with `ENOTFOUND`, and the outcome is `retry` with the backoff from the policy. The second delivery succeeds.
4. **Defect, fallback fixes.** The handler fails with an unmatched error. The fake agent writes `fixed` and makes the unit complete. The stage advances with `recoveredBy: fake`.
5. **The agent lies.** The fake agent writes `fixed` and changes nothing. With `rerunPrimary` the handler fails again. Fallback attempts run out, and the job is `failed` with the last check summary.
6. **The agent reports blocked.** The job is `blocked`. The message is dead-lettered, and the blocker text is on the job.
7. **The resilience limit.** `top` allows three fallback attempts, and `standard` allows one, from `resilience.json` and the stage's `maxAttempts`.
8. **Redelivery after done.** The job shows the stage `done`, and the message comes back after a crash. The executor returns `advance` without running anything, and dedupe stops a second message on the next queue.
9. **Lost lease.** `extend` throws `LeaseLostError`. The run is aborted, and the worker does not settle.
10. **Graceful stop.** `stop()` during a run aborts the handler and releases the message with no delay.
11. **The governor.** Two stages declare `chromium` with capacity 1. The second waits for the first.

`resolve-run.test.js` covers the selection table in 2.3: an explicit general ref, an explicit site ref, a missing site ref (error), auto that picks the site's run, auto that falls back to general, a file path, an `extends` chain, a cycle, and `--set`. `run-descriptor.test.js` covers each merge rule in 2.2, including the errors for a patch or removal that names a missing stage.

### 5.13 Phase 1 exit check, on this workstation

```bash
bin/orchestrator validate
bin/orchestrator explain sayii
bin/orchestrator enqueue sayii --run naming-only
bin/orchestrator run --until-idle &
bin/orchestrator status
# Break it on purpose. Point the seed at a missing bot dir for one job:
bin/orchestrator enqueue jormands --run naming-only --set stages.naming.handler.env.CNN_AI_BOT_DIR=/nope
# Expect: unit.failed (defect), then fallback.started kimi-cli, then a passing check after the agent, or a clear failure with the transcript in process/runs/.
# Crash recovery:
kill -9 <run pid> during a seed; bin/orchestrator status   # STALLED
bin/orchestrator run --until-idle                          # lease reclaimed, the finished pages are skipped, the job completes
```

## 6. Later phases: contracts to keep in mind now

- **Stage outputs (phase 2).** `HandlerResult.facts` lets `resolve-site` write `site.idsite`, and lets `analysis-qualify` add the focus page to `job.pages`. The settler merges facts into the job before forwarding. Later stages read them through `values`.
- **Deterministic repairs (phase 2).** A stage's `repairs: [{ match, handler }]` runs between a failed retry and the agent. This is where known fixes go: requeue a `failed` AE site with `updateSite({ status: 'queued', reason: '' })` and rerun, or add `--site-source static-idsites` to a capture that exited `ANALYSIS_SITE_SOURCE is not set`. An agent is expensive. A known fix is not.
- **The `agent` handler (phase 3).** It is the same `CodingAgentPort`, with a `primary/` or `report/` prompt, and with the stage's check as the judge. The report stages read the full bundle and write `docs/analysis/<slug>/`. A report stage's fallback can use a different agent descriptor from its primary.
- **Network failures are not lost leases.** With a remote store, a failed `reserve` backs off and retries, and a failed `extend` is retried until the lease is within a second of expiring. Only a `LeaseLostError`, or an actual expiry, aborts the running delivery. A scenario test covers it: the memory store throws a transport error on two `extend` calls in a row, and the delivery still completes.
- **Server adapters (phase 5).** `adapters/queue/postgres.js` exports the same `createStore` and five ports. Reserve uses `UPDATE … WHERE id = (SELECT id … FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`. `maxInFlight` uses an advisory lock per queue. It passes `queue-contract.js` unchanged.
- **Agent unavailable is blocked.** `agentUnavailable` matches a usage-limit or quota message in the agent's output. The fallback returns `blocked` on the first such result, so a billing stop does not spend the remaining attempts. A scenario covers it.
- **Other agents (phase 6).** `adapters/agents/claude-code.js` (`claude -p --output-format stream-json`), `codex.js`, and `cursor-agent.js` implement the same `CodingAgentPort`. They pass `test/orchestrator/agent-contract.js`, which drives each adapter against a scripted fake CLI.

## 7. Risks and decisions to confirm

| Item | Decision or check |
|---|---|
| `node:sqlite` is experimental | Works on Node 25.6.1 here. Unflagged from 22.13. Phase 1 sets `engines.node` to `>=22.13` and checks the EC2 Node version in task 1.0. If the server stays older until phase 5, it can run the memory store for single-shot runs, or upgrade Node. |
| Kimi prompt mode | Spike 1.0 (13 Oct, Kimi 2.0.1): `-p` is already non-interactive, and `--auto` / `--yolo` cannot be combined with it. The adapter sends neither. `mode` on the agent descriptor is a record, not a flag. `--skills-dir` and `--add-dir` were confirmed in the same spike. The recorded stream is `test/fixtures/orchestrator/kimi-stream.jsonl`: `system.version`, assistant `tool_calls`, `tool` results, assistant `content`, and a final `session.resume_hint` with a session id. The EC2 Node version was not reached; the SSH check did not connect. |
| A coding agent hits its usage limit | Classified as `blocked` (agent unavailable) from the agent's output, before more fallback attempts. Seen 13 Oct: Kimi returned 403 "monthly usage limit" and the Phase 1 session stopped. A later agent descriptor (phase 6) can be the next resort. The check runs only when the agent wrote no `result.json`, and it matches the provider's error wording, because transcripts echo the prompt and the result contract mentions usage limits. The 13 Oct exit check hit exactly that: Kimi fixed the page and was still read as unavailable until the order changed. |
| A worker dies with a child still running | Handlers and agents run in their own process group, so `SIGINT`, `SIGTERM`, and `SIGHUP` abort the delivery and kill the group. A `kill -9` of the worker leaves the child running as an orphan. In the 13 Oct exit check, the orphaned Sayii seed finished the page, and the reclaimed delivery passed it at the pre-check. A reclaim can still overlap an orphan that is mid-write. Phase 5 records the child's process group in the run directory and stops a stale group before the next delivery of the same unit. |
| Four Macs, decided 13 Oct | **Site affinity.** One machine runs every stage of a job and keeps its files locally: raw extracts (3–7 GB a site), bundles, naming datasets, and run directories. Only the queue, jobs, events, and governor live in cloud Postgres. Phase 2 keeps every artifact path in config values or the stage workspace, never in the job, so a job's paths resolve on whichever machine holds it. Phase 5 adds the affinity: the first stage that a machine reserves pins the job to that host, and later stages reserve only on that host. **Resource scope.** A capacity is either a number (cluster-wide) or `{ "limit": n, "scope": "machine" }`. Chromium is per machine; `clickhouse-heavy` is cluster-wide, because all four machines share one ClickHouse. **Escaped URLs.** Fixed first in phase 2, under R2.6, with a reviewed update to the R0.1 fixtures. |
| Phase 1 exit check (13 Oct) | Run on this workstation. Sayii `naming-only`: two pages skipped at the pre-check, one seeded. The worker was killed mid-seed, `status` showed `STALLED`, and the next `run --until-idle` reclaimed the lease and finished the job. Jormands with `CNN_AI_BOT_DIR=/nope`: `unit.failed` (defect), `fallback.started kimi-cli`, Kimi reran the seed with the configured path (732 rows), and the check passed after `retry`. |
| ClickHouse capacity | `clickhouse-heavy: 1` serializes analysis runs and exports. Raise it only after the governor shows idle time. |
| Report quality is not a file-exists question | Phase 3's `markdown-report` check covers structure. A judgment check (a second agent grading against the style guide) is optional and comes after. |
| Refactors change behaviour by accident | Every refactor item starts with a characterization test (rule 1 in 4A.1). The persistence role split keeps the old port as a facade, so no caller has to move in the same commit as the adapter. |
| The v1 path still runs on the server | `docs/RUNBOOK.md` has two cron lines that run `src/index.js`, and `deploy/analysis-naming.service` runs it too. Only its port fixes (R2.3) are done before phase 5, when the orchestrator takes over the cron and v1 is retired (R4.3). |
| Generalizing the DVF scripts loses DVF-specific analysis | The DVF one-offs are deleted only after `orchestration/sites/dvf/` regenerates the committed DVF hypothesis data within rounding (R2.7). |
| Migration | Done in phase 4. `import-legacy` brought the four `queue.json` items into the store, and `scripts/queue.mjs` is deleted. `queue.json` stays as history; `bin/orchestrator` is the only queue. |
