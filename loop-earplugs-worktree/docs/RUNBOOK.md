# Analysis Engine Run Book

How to deploy the analysis engine to a server and run it with multiple
agents: the analysis pipeline (multi-site, parallel workers) and the capture
consumer (the agents that drive the naming bot and, from Phase 4, the render
and saliency artifacts). Written for a fresh operator context; every command
is copy-pasteable.

Companion documents: `IMPLEMENTATION-PLAN.md` (the original contract),
`CAPTURE-BEFORE-ANALYSIS.md` (the capture integration contract; supersedes
`NAMING-BEFORE-ANALYSIS.md`), `../data-capture-plan.md` (schema 2).

Repository: `https://bitbucket.org/thegrowthteam/site-analysis-bot`.
Commit on `development`. `main` accepts merges only, and a merge to `main`
deploys to `kimi.heatmapcommand.ai`. See §11.

> **Deprecated: the v1 path.** `src/index.js`, `src/runner.js`, and
> `src/naming-consumer.js` are the v1 pipeline. They run on the server
> through the two cron lines in §6.3 and `deploy/analysis-naming.service`
> until phase 5 of `docs/ORCHESTRATOR-PLAN.md`. In phase 5 the
> orchestrator's units take over and the v1 path is removed (R4.3). The
> site queue is run with `bin/orchestrator`, as described in
> `skills/analysis-queue/CONTRACT.md`.

## 1. What runs where

```
                       ClickHouse (cloud cluster, database disp)
                      ┌──────────────────────────────────────────────────┐
  analysis engine ──► │ ae_batch / ae_site_queue / ae_page_target        │
  (this package,      │ ae_capture_queue / ae_page_capture               │
   Node 20, src/cli.js)│ ae_element_binding / ae_dataset_row              │
                      │ ae_requirement_status / ae_strategy_card         │
                      │ ae_page_analysis / ae_site_analysis              │
                      │ (+ reference, descriptor, ingest tables)         │
                      └────────────▲───────────────────────▲─────────────┘
                                   │ claims / writes       │ claims / writes
        capture consumer           │                       │
        (node src/cli.js           │                       │
         --capture --agents N)     │                       │
              │ runs as subprocess │                       │
              ▼                    │                       │
        capture bot                │                       │
        (cnn-ai-bot, pnpm cnn-name)│                       │
```

The engine writes 49 `ae_` tables, each ReplacingMergeTree versioned on
`generated_at`; 47 of them have a `<table>_current` view reading through
`FINAL`. The seven v1 tables (`landing_page_batch`, `site_queue`,
`landing_page_analysis`, `landing_page_dataset`, `page_naming`,
`naming_queue`, `page_element_name`) and their `_current` views persist
alongside until cutover step 10, when `scripts/rebuild-schema.mjs --scope
legacy` drops them (§6.5). See `../data-capture-plan.md` §8 for the full
table list.

- The **analysis engine** never calls the bot and never calls an LLM. Its
  output is rows in `disp` (batch, site queue, page targets,
  dataset rows, requirement status, strategy cards, page/site analysis).
- The **capture consumer** is a separate CLI mode in this package. It claims
  rows from `ae_capture_queue`, runs the naming bot as a **configured
  external command**, reads the harvested `names.json`, maps the rows onto
  the element taxonomy, and calls `completeCapture` — the same port the
  analysis runner's capture gate waits on.
- The **naming bot** (`cnn-ai-bot`) harvests page controls. Its `page` verb
  requires `--catalog <file> --url <url>` and writer configuration — see
  §4.3. It gains the `render.json` artifact in Phase 4
  (`CAPTURE-BEFORE-ANALYSIS.md`).

## 2. Prerequisites

| Requirement | Notes |
| --- | --- |
| Node.js ≥ 20 | Developed on v25; `"engines": { "node": ">=20" }` |
| npm | `package-lock.json` is the lockfile — use `npm ci` |
| Network to ClickHouse | HTTPS port 8443 (or 8123 for local docker) |
| ClickHouse grants | `SELECT` on `default.*` (fact tables), full rights on `disp` (the schema is created automatically) |
| Naming bot checkout | Only when naming agents are enabled: `cnn-ai-bot`, `pnpm install` inside it, per-site catalogs in its `catalogs/`, and its own runtime env (writer provider) |

Environment variables (export before running; the password is never logged
and never written into `metadata`):

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `CLICKHOUSE_HOST` | yes | — | full URL incl. protocol, e.g. `https://….clickhouse.cloud` |
| `CLICKHOUSE_PORT` | no | `8443` | only used when host has no protocol |
| `CLICKHOUSE_USER` / `CLICKHOUSE_PASSWORD` | yes | — | service account (e.g. `heatmap`) |
| `CLICKHOUSE_DATABASE` | no | `disp` | must be a database the account can create tables in |
| `LOG_LEVEL` | no | `info` | pino levels only: `info`, `warn`, `error` (not `warning`) |
| `ANALYSIS_CONFIG` | no | `./analysis.config.json` | config file path (see §4) |
| `ANALYSIS_ELEMENT_NAMES` | no | — | optional element-names.json for selector names |
| `ANALYSIS_SITE_SOURCE` | no | required flag/env | `static-idsites` or `active-ecommerce-sites` |
| `ANALYSIS_PERSISTENCE` | no | `clickhouse` | `memory` is the test double |
| `ANALYSIS_AGENTS` / `NAMING_AGENTS` | no | `1` / `1` | agent-count overrides (§6) |
| `AE_ENABLE_SALIENCY` | no | unset | `1` enables the saliency worker (§6.1); ships off until the model/licence question Q8 resolves (D-08) |
| `AE_SALIENCY_COMMAND` | no | — | model command template for the saliency worker: placeholders `{screenshot}` `{device}` `{idsite}` `{idsitehsr}`; must print one JSON object mapping `node_id` → `{share, quartile}`; empty = the enabled worker idles |

## 3. Install on the server

The deploy host is `kimi.heatmapcommand.ai` (`ec2-user`, Amazon Linux 2023).
Landing Page Analysis already owns `~/landing-page-analysis`, ports 4770 /
5672 / 15672, the `lpa-app` image, and the `landing-page-analysis_*` volumes.
This engine is a separate checkout and must not touch those.

```bash
# on the server, once
git clone git@bitbucket.org:thegrowthteam/site-analysis-bot.git ~/analysis-engine
cd ~/analysis-engine
npm ci
cp .env.example .env          # fill ClickHouse credentials; never commit .env
cp analysis.config.example.json analysis.config.json
```

After that, merges to `main` update the checkout. `scripts/ci-deploy.sh`
fetches `origin/main`, runs `npm ci --omit=dev`, and restarts the capture
unit only when both `~/analysis-engine/.env` and `analysis-capture.service`
are already installed. Node 22 is on the box at `/usr/local/bin/node`.

The first command that connects to ClickHouse runs `ensureAeSchema` (v2,
`src/cli.js`): creates the 49 `ae_` tables and 47 `_current` views from
`src/persistence/schema2.sql` if missing — create-only, idempotent, safe on
every start. It also runs the v1 `ensureSchema` (seven v1 tables + views)
for coexistence until cutover step 10 drops them; destructive DDL exists
only in `scripts/rebuild-schema.mjs` (§6.5), never in the schema templates.

## 4. Configuration

### 4.1 `analysis.config.json`

```json
{
  "agents": { "analysis": 2, "naming": 3 },
  "naming": {
    "botDir": "/home/ec2-user/naming-bot",
    "container": "naming-bot",
    "command": "/home/ec2-user/analysis-engine/bin/name-page.sh {url} {idsite}",
    "datasetRoot": "/home/ec2-user/naming-bot/dataset",
    "botTimeoutMs": 600000
  }
}
```

Precedence: environment variables beat the config file, which beats
defaults. `command` is optional — without it the consumer reads an existing
`names.json` from `datasetRoot` (useful when the harvest runs on another
machine).

### 4.2 Command template placeholders

| Placeholder | Expands to |
| --- | --- |
| `{url}` | the queued page URL (from `naming_queue.landing_page_url`) |
| `{idsite}` | the site id |
| `{idsitehsr}` | the page id |
| `{botDir}` | `naming.botDir` |

The command is split on whitespace (no shell quoting); keep it simple or
point it at a wrapper script (recommended, §4.3). Child processes inherit
the consumer's environment, so anything the bot needs (`PATH` to pnpm,
writer keys) must be exported before starting the consumer.

### 4.3 Wiring the real naming bot

The bot's `page` verb is stricter than the integration contract's shorthand:

- it requires `--catalog <file>` (per-site YAML in `cnn-ai-bot/catalogs/`,
  e.g. `latico.yaml`), and
- it refuses to run without writer configuration (`WRITER_PROVIDER`), i.e.
  the LLM-backed script writer.

`bin/name-page.sh` requires `NAMING_CONTAINER` (the example above sets `naming.container` to `naming-bot`, and the consumer exports it). Set that in the server config or `.env` before deploying a build that removed the old default, or naming exits 3.

On the kimi box the naming bot is already the `naming-bot` container
(image `naming-bot:latest`, `127.0.0.1:4780`, nginx host
`naming.heatmapcommand.ai`). That container's process is the health
server. `bin/name-page.sh` is the consumer's command: it `docker exec`s
`pnpm cnn-name page` in that container, then `docker cp`s
`dataset/<idsite>/` out to `~/naming-bot/dataset` so the consumer can read
`names.json`. The command string is split on whitespace, so keep the
wrapper path absolute (`/home/ec2-user/...`), not `~`.

The `page` verb still refuses to run without writer configuration
(`WRITER_PROVIDER`, `GUIDES_ROOT`, `LATICO_SAMPLES`, and the provider
key). Those values come from the consumer's environment and are passed
into the container. They are not in this repo. Do not start naming agents
until that environment is present; a missing writer config fails the
queue row and leaves the page `awaiting_naming`.

The bot writes `dataset/<idsite>/<pageKind>/<slug>/names.json` (slug = last
URL path segment, lowercased; `index` for the site root); the consumer reads
it from `naming.datasetRoot`. **Keep `botTimeoutMs` under the 15-minute
claim TTL** (§6.1) or a slow harvest can be reclaimed by another agent.

On this 8 GB box, Landing Page Analysis already runs Chromium. Keep
`NAMING_AGENTS` at 1 here. Three agents is for a machine that is not also
hosting that stack.

## 5. Queueing sites for analysis

Sites enter through a **site source adapter**; there is no other queueing
API. Two sources ship:

**Static list** (the `--idsites` flag; a run without it is an error):

```bash
node src/index.js --site-source static-idsites --idsites 3199,3207,3228
```

**Fleet scan** (every active Shopify site, ~2,800 — heavy):

```bash
ANALYSIS_SITE_SOURCE=active-ecommerce-sites \
node src/index.js --site-source active-ecommerce-sites
```

A run does, in order: create the batch (window = last 7 complete UTC days,
computed from the server clock) → enqueue every site → per site: qualify
(prefer a non-home page with orders, then the 100-hit gate on that
page over the last 7 complete UTC days) → **naming freshness gate** → datasets → analysis row. A qualified
page without a fresh name is set to `awaiting_naming` and a row is inserted
into `naming_queue`; nothing else runs for that site. The batch finishes
with counts (`qualified`, `skipped`, `failed`, and `awaitingNaming` in the
log).

For large fleets prefer slices over the fleet source — one batch per chunk
keeps the per-batch ClickHouse cost predictable (the bot-rule fleet scan
runs once per batch, ~1–2 minutes; everything else is per-site and
sub-second):

```bash
for chunk in "3199,3207,3228" "3368,4211,5149"; do
  node src/index.js --site-source static-idsites --idsites "$chunk"
done
```

`site_queue.status` values: `queued → qualifying → qualified → analyzing →
analyzed`, or terminal `skipped_volume`, `skipped_no_page`, `failed`, and
the wait state `awaiting_naming`. `naming_queue.status`: `queued →
claiming → complete | failed` (rows older than the TTL in `claiming` are
reclaimable).

## 6. Running the bots (multi-agent)

### 6.1 Capture agents

```bash
node src/cli.js --capture --agents 3
```

Count comes from (highest wins): the `--agents` flag → `NAMING_AGENTS` →
`agents.naming` in the config → `1`. Agents poll `ae_capture_queue`, claim
rows **token-exclusively**, run the bot, read the harvested `names.json`
from `naming.datasetRoot`, map the harvest onto the taxonomy
(`src/naming-mapper.js` — conservative, non-taxonomy classes are dropped),
and call `completeCapture`, which writes `ae_page_capture` +
`ae_element_binding` and flips every `awaiting_capture` page target and
site row for that page back to the queue. The consumer exits when the queue
is drained; it is safe to run it continuously (systemd unit below) or on
demand.

Claim semantics (both queues, enforced in the persistence adapters): a claim
inserts a row carrying a UUID; a re-read confirms the token won. Claims are
exclusive for **15 minutes** (`CLAIM_TTL_MS`, default), refreshed by every
status write (heartbeat). A crashed agent's work is reclaimed after the TTL;
a live agent's work is never stolen. Bot failures mark the naming row
`failed` with the stderr tail — they do **not** re-queue automatically.

Sizing: each naming agent runs a full browser harvest — budget roughly one
agent per 2 cores and ~2 GB RAM, and mind the upstream site. Three parallel
agents is the proven configuration (claims at +0 ms / +200 ms / +700 ms,
all three completing simultaneously).

The unit file is `deploy/analysis-capture.service`. Install it only after
`~/analysis-engine/.env` exists (ClickHouse, and writer variables if capture
should run). One capture agent on this box:

```bash
sudo cp ~/analysis-engine/deploy/analysis-capture.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now analysis-capture.service
```

**Saliency worker.** `node src/cli.js --saliency --once` sweeps
`ae_page_capture_current` for pages with `has_render = 1`,
`has_saliency = 0`, `status = 'complete'` — one idsite per gateway query
(sites from `AE_SALIENCY_SITES`, else a `fleet:`-labelled distinct-idsite
scan of `ae_page_render_current`, LIMIT 100) — runs `AE_SALIENCY_COMMAND`
once per device screenshot, rewrites the page's `ae_render_node` rows with
`saliency_share`/`saliency_quartile`/`saliency_model`, and flips
`has_saliency = 1`; a missing screenshot or a failed/unparsable model run
skips that page (reason in the log, `has_saliency` stays 0) and the sweep
continues. It is gated by `AE_ENABLE_SALIENCY=1` — with the flag unset (the
shipped default) it logs one line and exits, so M04 stays `missing` with
detail `model_not_selected` — and it exits quietly on pre-cutover clusters
whose `ae_` tables do not exist yet. The unit is `deploy/analysis-saliency.service`
and it ships **masked**: keep `systemctl mask analysis-saliency.service`
until the saliency model and licence question (Q8, decision D-08) is
resolved; even unmasked it is inert until `AE_SALIENCY_COMMAND` is set in
`~/analysis-engine/.env` (the unit sets the flag but leaves the command
empty on purpose).

### 6.2 Analysis agents

`agents.analysis` (or `ANALYSIS_AGENTS`) sets the number of concurrent
claim loops inside one batch run. The same token+TTL claim semantics make
it safe to also run **multiple batch processes** (e.g. chunked fleets on
different hosts) against the same tables — at worst two agents claim the
same site within the race window and the work is duplicated, never
corrupted: every write is keyed and idempotent (`row_key` + versioned
`generated_at`, one current row per key). Do not raise analysis agents
beyond what ClickHouse likes: per-site queries are sub-second, but each
agent holds a full site's dataset fan-out.

### 6.3 The steady-state loop

```bash
# 1. naming consumer always on (or run on demand until drained)
node src/index.js --naming-agents 3 &

# 2. a batch over the sites you want
node src/index.js --site-source static-idsites --idsites 3199,3207,3228

# 3. drain naming again if the batch queued pages
node src/index.js --naming-agents 3

# 4. resume the batch id printed in step 2's log (re-runs step 2 with
#    --resume <batch_id> when naming completed after the batch finished)
```

Steps 2–4 are what a cron line needs for a daily window. These two lines
are the deprecated v1 path, and phase 5 replaces them with the
orchestrator (R4.3):

```cron
17 3 * * * cd ~/analysis-engine && /usr/local/bin/node src/index.js --site-source static-idsites --idsites 3199,3207,3228 >> /var/log/analysis.log 2>&1
47 3 * * * cd ~/analysis-engine && /usr/local/bin/node src/index.js --naming-agents 1 >> /var/log/naming.log 2>&1
```

(the naming gate runs inside every batch too, so late names are picked up
by the next batch even without an explicit resume.)

### 6.4 Descriptor and governance imports (operator)

Operator-supplied descriptor fields and governance records enter through
two validated JSON imports (data-capture-plan.md §9.6). Both validate every
row against `src/catalog/descriptor.schema.json` (descriptor paths, with
sub-paths allowed when the base path exists; provenance/confidence enums),
print each violation and exit 1 when anything is wrong, and write nothing
until the whole file validates. `--dry-run` validates only. Successful
descriptor imports print counts per provenance; governance imports print
counts per kind.

```bash
node src/cli.js --descriptor-import descriptors.json [--dry-run]
node src/cli.js --governance-import governance.json [--dry-run]
```

Descriptor rows: `idsite` (int, required), `idsitehsr` (optional — sets
`template_key` to `url:<idsitehsr>` for a URL override; otherwise a page
row defaults to the `'template'` family, which operators override with an
explicit `template_key`), `field_path`, `value` (anything; `null`/absent is
stored as `'null'` = Unknown), `provenance` and `confidence` from the
schema enums, `owner` (non-empty). `device_class` defaults to `'all'`,
`captured_at` to now, `expires_at` to captured_at + 90 days (operator
fields expire, §7), `human_confirmed_by` to `''`. Rows with a
`template_key` land in `ae_page_descriptor`; store-field rows (s16–s36)
land in `ae_store_descriptor` and must not carry a `template_key`.

```json
[
  {"idsite": 3199, "idsitehsr": 63918696, "field_path": "p01.job",
   "value": "bundle landing", "provenance": "operator", "confidence": "high",
   "owner": "ken"},
  {"idsite": 3199, "field_path": "s20.returns_policy",
   "value": {"exchange_types": ["variant", "cross_collection"]},
   "provenance": "operator", "confidence": "high", "owner": "ken"}
]
```

Governance rows carry a `kind`: `experiment` → `ae_experiment`
(`experiment_id`, `arms: [{arm, allocation}]`, optional `source`, `partner`,
`name`, `unit`, `test_code`, `mde`, `analysis_plan`, `started_at`,
`status`), `review_verdict` → `ae_review_verdict` (`subject_kind`,
`subject_ref`, `verdict_kind`, `outcome`, `reviewed_by`; a `verdict_id`
uuid is minted when omitted), `change` → `ae_change_log` (`change_kind`,
`effective_at`, `subject`; `change_id` is the deterministic sha1 of
`change_kind|subject|effective_at`, so re-imports replace), and
`calendar_event` → one `ae_store_descriptor` row per event on
`s35.calendar` (provenance `operator`). All writes are idempotent on their
table ORDER BY keys.

`experiment_descriptor` → `ae_experiment_descriptor` (provenance
`operator`) describes one detected experiment for the `experiment-analysis`
dataset. `experiment_key` is required and is the key that dataset reports,
`{partner}:{partner experiment id}` (for example
`shoplift:01a0f672-2e59-70ea-a61d-15ba87c4e5c8`). Optional fields:
`name`, `hypothesis`, `description`, `experiment_kind` (`experiment`,
`rollout`, `personalization`, `internal`, `single_arm`), `scope` (`site`,
`template`, `page`, `redirect`, `script`), `templates` (`home`, `pdp`,
`plp`, `cart`, `search`, `content`, `checkout`, `account`, `other`),
`pages` (idsitehsr), `elements` (`[{selector, idsitehsr?, arm?,
element_class?, section?}]`), `zones` (`[{section, role?}]`: rollup
sections by the `section_name` the section tracker reports, `role`
`treated` (default) or `guardrail`), `arms` (`[{arm, label?, is_control?,
allocation?, aliases?}]`, where `aliases` folds other variant ids into the
arm), `device_scope` (`mobile`, `desktop`), and `start` / `end`
(YYYY-MM-DD). The next batch applies them over what it inferred. Declared
allocations replace the even-split SRM assumption, pages add the `exposed`
basis and per-page rows and limit the section and element scans to those
pages, zones and elements are always reported even below the 100-visit
floor, and `start` / `end` clamp the analysis range. Without any operator
descriptor the dataset still reports the 40 busiest sections and the 40
busiest selectors per experiment. The import creates the schema-2 tables if
they are missing.

```json
[
  {"kind": "experiment", "idsite": 3199, "experiment_id": "hero-b1",
   "arms": [{"arm": "control", "allocation": 0.5}, {"arm": "long", "allocation": 0.5}],
   "unit": "session", "test_code": "AB", "status": "running"},
  {"kind": "review_verdict", "idsite": 3199, "subject_kind": "event",
   "subject_ref": "faq.expand", "verdict_kind": "event_validation",
   "outcome": "pass", "sample_size": 40, "reviewed_by": "ken"},
  {"kind": "change", "idsite": 3199, "change_kind": "theme_deploy",
   "effective_at": "2026-10-01T00:00:00Z", "subject": "pdp"},
  {"kind": "calendar_event", "idsite": 3199, "name": "black friday",
   "window": {"start": "2026-11-27", "end": "2026-11-30"}, "flags": {"sale": true}},
  {"kind": "experiment_descriptor", "idsite": 5769,
   "experiment_key": "shoplift:01a0f672-2e59-70ea-a61d-15ba87c4e5c8",
   "hypothesis": "A review-count headline on the home hero lifts PDP entry",
   "scope": "template", "templates": ["home"],
   "arms": [{"arm": "control", "is_control": true, "allocation": 0.5},
            {"arm": "sl-a29ef047", "allocation": 0.5}],
   "zones": [{"section": "custom-hero-v1"}, {"section": "header", "role": "guardrail"}],
   "start": "2026-10-01", "end": "2026-10-05"}
]
```

The bot-draft descriptor source (`src/adapters/descriptor-sources/`)
drafts the schema's `bot_may_draft` paths from render artifacts and
measured datasets at `confidence: low`; those rows count as Unknown for
gating until an operator import with `human_confirmed_by` replaces them.

## 7. Verifying a deployment

1. **Unit tests**: `npm test` → 324/324, no ClickHouse needed.
2. **Smoke batch**: `node src/index.js --site-source static-idsites --idsites 3199,3207,3228`. First-ever run: all three sites should land in
   `awaiting_naming` (nothing is named yet) and three rows appear in
   `naming_queue`.
3. **Manual naming** (bypass the bot while bringing the pipeline up):

   ```bash
   echo '[{"selector":"header > button.menu","element_class":"nav_toggle","name":"Menu"}]' > /tmp/names.json
   node src/index.js --naming-complete --idsite 3199 --idsitehsr 63918696 \
     --url 'https://curiouselixirs.com/pages/7r-bundle-builder' --names /tmp/names.json
   ```

   Classes must come from the taxonomy in `src/domain/taxonomy.js`; any
   other value aborts with no rows written (fail closed). An empty
   `--names` file (or omitting it) legitimately completes a page with zero
   named elements.
4. **Resume**: `node src/index.js --resume <batch_id>` → named sites run
   datasets and land on `analyzed`.
5. **Reconciliation** (the acceptance check — stored unfiltered totals vs a
   fresh query, tolerance 0.5% or 5):

   ```bash
   node scripts/reconcile.mjs <batch_id>
   ```

6. **Health queries**:

```sql
-- batches
SELECT batch_id, status, sites_queued, sites_analyzed, sites_failed, window_start, window_end
  FROM disp.ae_batch_current ORDER BY created_at DESC LIMIT 5;

-- per-site state of the newest batch
SELECT idsite, status, reason FROM disp.ae_site_queue_current
 WHERE batch_id = '<batch_id>' ORDER BY idsite;

-- capture backlog
SELECT idsite, idsitehsr, url, status, reason
  FROM disp.ae_capture_queue_current WHERE status IN ('queued', 'claimed', 'failed');

-- cards at a glance
SELECT idsite, idsitehsr, cards_include, cards_conditional, cards_blocked, cards_silent
  FROM disp.ae_page_analysis_current WHERE batch_id = '<batch_id>';
```

### 6.5 Backup and rebuild (operator only)

Schema changes that drop anything go through two operator scripts
(data-capture-plan.md §8); `ensureSchema`/`ensureAeSchema` are create-only
and never drop.

```bash
# 1. quiesce: stop the services (analysis-capture.service and the batch
#    cron) so no queue row is claimed younger than the claim TTL
# 2. back up the seven v1 tables (read-only; writes <out>/<UTC-ts>/)
node scripts/backup-legacy.mjs --out ~/ae-backup/$(date +%F)

# 3. dry-run the plan, read every statement, then execute by re-adding
#    --execute (scope ae builds schema 2 next to v1; scope legacy drops the
#    14 v1 objects after the pilot — cutover step 10)
node scripts/rebuild-schema.mjs --scope ae --confirm-database journey_events --backup ~/ae-backup/<date>
node scripts/rebuild-schema.mjs --scope ae --confirm-database journey_events --backup ~/ae-backup/<date> --execute
# V1–V8 print and must pass; then, after the pilot:
node scripts/rebuild-schema.mjs --scope legacy --confirm-database journey_events --backup ~/ae-backup/<date> --execute
```

The rebuild still refuses unless `--confirm-database` is `journey_events` and that name is also the configured database. It is the proof-of-concept wipe, not a wipe of `disp`. It also refuses when
the backup manifest row counts differ from a fresh `count()`, or when any
queue has young claimed rows. Copy the backup directory off the box before
the legacy drop.

## 8. Operations cookbook

**Retry failed naming rows** (reasons are in the row):

```sql
INSERT INTO disp.naming_queue
    (idsite, idsitehsr, landing_page_url, page_type, status, reason, requested_on, claim_token, generated_at)
SELECT idsite, idsitehsr, landing_page_url, page_type, 'queued',
       'retry: ' || reason, today(), '', now64(3)
  FROM disp.naming_queue_current WHERE status = 'failed';
```

**Force a site to re-analyze**: insert a fresh `site_queue` version with
`status = 'queued'` for its `(batch_id, idsite)`, then `--resume`.

**Stuck in `claiming`/`analyzing`**: nothing to do — reclaim happens after
15 minutes of write silence; to hurry it, update the row (any write
refreshes liveness, so bump it, then wait out the TTL, or restart with a
shorter TTL via `claimTtlMs` in `runBatch` deps if running embedded).

**Taxonomy change**: bump `TAXONOMY_VERSION` in `src/domain/taxonomy.js`
and ship the new class list in the same change. Every stored name becomes
stale on next batch (freshness compares versions) and pages re-enter
`awaiting_naming` automatically.

**Move naming to another machine**: run the consumer there with the same
ClickHouse env and a `NAMING_COMMAND`/wrapper reachable on that box. The
queue is shared; the TTL keeps two consumers from double-harvesting.

## 9. Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `ACCESS_DENIED … CREATE DATABASE` | `CLICKHOUSE_DATABASE` points at a missing database the account cannot create. Default is `disp`; `ensureSchema` checks existence before creating. |
| `unknown identifier claim_token` | Old code against new views or vice versa. Redeploy a consistent copy and re-run any command (schema self-heals). |
| Sites sit in `awaiting_naming` | Consumer not running, or bot failing. Check `naming_queue_current` for `failed` rows and their reasons. |
| `bot command failed …` | Command/env problem: pnpm not on `PATH` for the service (use a wrapper + absolute paths), bot env not exported (children inherit the consumer's env), missing `--catalog`, or writer config absent. The stderr tail is in the `failed` reason. |
| `element_class "…" is not in taxonomy` | Mapper bug or harvest label outside the taxonomy; the page stays unnamed (fail closed). Add the class to `ELEMENT_CLASSES` only together with a `TAXONOMY_VERSION` bump. |
| `reconciliation … MISS` | Usually a window/clock skew (server UTC vs expectation) or a partial-day boundary; the stored and fresh numbers are printed side by side — investigate >0.5% gaps, misses don't block other sites. |
| `default level:warning must be included in custom levels` | `LOG_LEVEL=warning`; pino wants `warn`. |
| Batch slow | The one-time-per-batch fleet bot scan (~1–2 min) dominates; per-site work is sub-second. More analysis agents help fleets, not the scan. |
| `names.json not found at …` | Bot ran but wrote elsewhere: check `datasetRoot` matches the bot's `dataset/` and the URL→slug rule (last path segment lowercased, root → `index`). |

## 10. Safety notes

- The ClickHouse password is never logged and never written into table
  `metadata`; keep it in the environment or a root-only `EnvironmentFile`.
- The engine writes **only** its `ae_` tables in `disp` (49
  tables; the seven v1 tables until cutover step 10 drops them); it never
  touches facet tables, `default.*` writes, or the bot's dataset. Facet's
  ban on `udp_hsrce_*` reads/writes in its own repo is unchanged.
- The analysis path contains no LLM calls; the only AI cost is inside the
  naming bot's writer, on the `cnn-name` commands you configure.
- Known demo residue: element names for sites 3207/3228 were reset after a
  parallelism demonstration; both pages are re-queued and awaiting a real
  bot run. Do not read their strategy triggers as meaningful until named.

## 11. Repository, branches, and CI

| | |
| --- | --- |
| Repo | `git@bitbucket.org:thegrowthteam/site-analysis-bot.git` |
| Commit here | `development` |
| Production | `main`, merges only |
| Deploy | merge to `main` SSHes to the box and runs `scripts/ci-deploy.sh` |

`development` is the branch that accepts commits. Open a pull request from
`development` into `main`. The pipeline runs `npm test` on that pull
request and on every push to `development`. Merging the pull request runs
the tests again, then deploys. A direct push to `main` is rejected.

The deploy key can only run `~/analysis-engine/scripts/ci-deploy.sh`. It
does not have a shell on the box and it does not call the landing-page
deploy. Repository variables, all secured:

- `DEPLOY_HOST` — `kimi.heatmapcommand.ai`
- `DEPLOY_USER` — `ec2-user`
- `DEPLOY_SSH_KEY` — the private key paired with that forced command

`~/analysis-engine/.env` stays on the box, untracked. `git reset --hard`
does not delete it. Do not copy `~/landing-page-analysis/.env.ec2`; this
app uses its own ClickHouse user.
