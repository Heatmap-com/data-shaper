# Analysis queue contract

The queue is the orchestrator's job store, `process/orchestrator.db`. The work journal is one markdown file per job in `process/journal/<job id>.md`. Change both only with `bin/orchestrator`, from the repo root. Do not open the database, and do not hand-edit a journal.

`process/queue/queue.json` is the retired queue. It is history: `bin/orchestrator import-legacy` read it into the store under the same ids, and nothing writes it now.

Every command prints JSON. Most results carry a `message`; tell the user that text.

## Job

A job is one site going through one run. It has an `id`, the `site` (slug, domain, idsite, name), the `run`, `priority`, `resilience`, `status`, and one entry per stage under `stages`.

| Field | Values |
| --- | --- |
| `priority` | `critical`, `high`, `normal`, `low`. Default `normal`. |
| `resilience` | `standard` or `top`. Default `standard`. |
| `status` | `queued`, `running`, `done`, `blocked`, `failed`, `cancelled`. |
| `run` | `full` is the full process. `orchestration/general/runs/` lists the others. |

Wherever a command takes `<job>`, pass the job id, or the domain or site slug. A domain with one open job means that job; with none open, it means the newest one.

Queue length is the count of `queued` and `running` jobs. Within one priority, the job queued first runs first. A higher priority waits in front of every lower priority. It does not take a stage another job already holds.

## Sites

`orchestration/sites/<slug>/site.json` describes a site. `enqueue <domain>` for a site with no `site.json` looks the domain up in `default.sites`. It takes the one active row whose main URL is that domain, writes the `site.json`, and queues the job. With no active row, or more than one, it stops and says so. Never invent an idsite.

## Stages

Each step of a run is a stage, with its own queue. Workers run the stages. One job holds a stage at a time, across every worker (the stage's `concurrency`, default 1). When a job finishes a stage, the next stage is queued, and the stage it left takes the next job. A job never skips a stage: export waits on that site's own analysis, and the reports wait on that site's export.

`full` runs these stages in order:

| Phase | Stage | Skill the stage follows |
| --- | --- | --- |
| Analyze | `naming` | `skills/resilient-naming/SKILL.md` |
| Analyze | `analysis` | `skills/site-analysis/SKILL.md` |
| Export | `bundle` | `skills/analyst-data-bundle/SKILL.md` |
| Export | `bundle-4mb` | `skills/analyst-data-bundle-4mb/SKILL.md` |
| Report | `chart-render` | the report charts, from the full bundle |
| Report | `site-opportunity-report` | `skills/site-opportunity-report/SKILL.md` and `skills/analysis-doc-standards.md` |
| Report | `today-opportunities` | `skills/today-opportunities/SKILL.md` and `skills/analysis-doc-standards.md` |
| Report | `user-journey` | `skills/user-journey-opportunity-analysis/SKILL.md` and `skills/analysis-doc-standards.md` |
| Report | `style-pdf` | `skills/style-reports/SKILL.md` |

Each stage has a completion check. The check is the judge: a stage is done when its check passes, and a stage whose check already passes is not run again. A handler that fails is retried, classified, and, when it is a defect, handed to the agentic fallback within the job's resilience.

`analysis` runs `bin/analyze-site.mjs`, which creates and runs one engine batch for the site under the stage's profile (`lp` unless the run, the site's `site.json` `profile` or `stageParams`, or a `--set` names another). When the run leaves pages awaiting capture, the command runs the capture consumer and the batch again; a page whose capture fails blocks the stage. Its check, `ae-batch-complete`, passes when that stored batch is complete with no failed site and no site still waiting. The stage holds `clickhouse-heavy`, so one analysis runs at a time. Each profile has a general run: `pdp-full`, `collection-full`, and `quiz-full` over `full`, and `experiment`, `funnel`, and `journey` as the analysis stage alone.

`bundle` and `bundle-4mb` have no handler or check yet. A job reaching one of them is `blocked` with "this stage lands in a later phase". Do that stage by its skill, then record it with `complete`. Do not write a stand-in artifact to get a stage past its check.

## Resilience

`orchestration/general/resilience.json` holds both profiles. **standard** gives the fallback one attempt, within this repository's inputs and configuration. **top** gives it three, with any repair the stage needs, including the naming bot and the Chrome extension; it fails only when blocked.

## Commands

```bash
bin/orchestrator enqueue <domain-or-slug> --run full --priority <level> --resilience <standard|top> [--start] [--note "<why>"]
bin/orchestrator start
bin/orchestrator run --until-idle
bin/orchestrator status
bin/orchestrator status --json
bin/orchestrator priority <job> <critical|high|normal|low>
bin/orchestrator note <job> --text "<journal line>"
bin/orchestrator complete <job> [--stage <id>] --note "<the done check, in one line>"
bin/orchestrator retry <job> [--stage <id>] [--refresh]
bin/orchestrator cancel <job> --reason "<why>"
bin/orchestrator clear
bin/orchestrator clear --finished
bin/orchestrator clear --all
bin/orchestrator show <job>
bin/orchestrator jobs [--status queued,running]
bin/orchestrator dlq
```

`enqueue --start` and `start` launch one background worker, `run --until-idle`, when no live worker serves the queued stages. It exits once the queues are empty, and its log is under `process/runs/workers/`.

`clear` cancels jobs no stage has started. `clear --finished` removes done, blocked, failed, and cancelled jobs from the store. `clear --all` does both. A job in a stage is kept whichever flag is passed. Journal files stay.

`retry` puts a failed or blocked stage back on its queue and keeps the stages already done. `--refresh` re-reads the run descriptors first. `complete` is only for a stage whose check is still `pending`; for any other stage, `retry`, and the check decides.

`status` shows each stage's holder, attempt, and worker, the next 5 jobs, the queue length, and the live workers. `STALLED` marks a stage whose lease holder stopped sending heartbeats, or a stage with ready work and no live worker.
