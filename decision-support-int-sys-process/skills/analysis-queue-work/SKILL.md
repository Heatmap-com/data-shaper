---
name: analysis-queue-work
description: >-
  Runs the queued site analyses with the orchestrator's workers and does the
  stages that are not automated yet. Use when the user says to start, run,
  work, or process the queue, the backlog, or the next site analysis.
---

# Work the analysis queue

Read [CONTRACT.md](../analysis-queue/CONTRACT.md). Change the queue only with `bin/orchestrator`, from the repo root.

## Lifecycle

A `full` job moves through three phases, and each step is its own stage. One job holds a stage at a time. When a job moves on, the stage it left takes the next job.

1. **Analyze.** `naming`, then `analysis`. This builds the naming profile and stores the site data.
2. **Export.** `bundle`, then `bundle-4mb`. These are the data export files. A job enters export only after its own analyze stages are done.
3. **Report.** `chart-render`, the three reports, then `style-pdf`. The reports are written from that site's full export.

The workers keep this order. Do not write an export file for a site that has not finished analysis, and do not draft a report for a site that has not finished export.

## Start the workers

```bash
bin/orchestrator start
bin/orchestrator status
```

`start` launches one background worker when no live worker serves the queued stages. It runs every stage and exits when the queues are empty. To watch it in the foreground instead, run `bin/orchestrator run --until-idle` in a background shell and read its output.

The worker runs each stage's handler, judges it with the stage's completion check, retries transient failures, and gives defects to the agentic fallback within the job's resilience. Do not run a stage's commands yourself while a worker holds that stage.

## Loop

1. Run `bin/orchestrator status`.
2. If the queue length is 0, say the queue is empty and stop.
3. If a stage is `STALLED` with ready work and no live worker, run `bin/orchestrator start`.
4. For each blocked or failed job (`bin/orchestrator jobs --status blocked,failed`), run `bin/orchestrator show <job>`, read the blocker, and handle it as below.
5. Wait a few minutes (use the await tool, not `sleep`), then go back to 1.

Keep going until the queue is empty. Do not finish every stage of one site before the next site starts. Do not stop between sites to ask whether to continue.

## A stage that is not automated yet

`analysis`, `bundle`, and `bundle-4mb` block with "this stage lands in a later phase". That is your step to do:

1. Read the stage's skill from the contract table, and every file it names. Do not work from memory of a previous site.
2. Use the job's `site` (slug, domain, idsite), `pages`, and `window` from `show`.
3. Do the work that skill describes, until its own done condition holds.
4. Record it:

```bash
bin/orchestrator complete <job> --note "<the done check, in one line>"
```

`complete` marks the stage done and queues the next one, which the worker picks up. Record a fix or a meaningful finding with:

```bash
bin/orchestrator note <job> --text "<what happened>"
```

Do not complete a stage because a file exists from an older window, and do not write a stand-in artifact to get past it.

## A blocked or failed automated stage

Read the blocker and the last events before editing anything. The fallback already tried within the job's resilience, so this is what it could not fix.

**standard.** Repair only inputs and configuration in this repository. Do not patch the naming bot or the extension.

**top.** Top resilience - use agentic inference to overcome blockers, fixing issues with the naming bot, with the chrome extension, with any process necessary to try to complete the task, only fail the task if you get blocked.

Journal the attempt, naming the owner and the change, then put the stage back:

```bash
bin/orchestrator note <job> --text "<failure, owner, change>"
bin/orchestrator retry <job>
```

Add `--refresh` when you changed a stage or run descriptor. A new failure is a new note and a new fix. Do not repeat a fix that already failed.

You are blocked when you cannot proceed: the merchant is down or walls the browser after the naming skill's retries, the page needs a login, the idsite cannot be resolved, credentials are missing from the environment and from `.env`, or the next action needs a decision only the user can make. Then leave the job blocked, note the reason, and say which site is blocked and why:

```bash
bin/orchestrator note <job> --text "blocked: <the blocker>"
```

A blocked job holds no stage, so the other jobs keep moving.

## Tell the user

When a stage gains a site, say the domain, the stage, the priority, and the resilience. When a site finishes, say what was produced and which stages are still held. When you stop, say what is left waiting and whether a worker is still running.
