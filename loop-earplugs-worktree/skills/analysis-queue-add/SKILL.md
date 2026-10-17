---
name: analysis-queue-add
description: >-
  Adds a site to the analysis queue with bin/orchestrator enqueue. Use when
  the user says to add a site or domain to the queue, the backlog, or the
  full process, including a priority or a resilience such as high priority
  or top resilience.
---

# Add to the analysis queue

Read [CONTRACT.md](../analysis-queue/CONTRACT.md). Then add the site with one `bin/orchestrator enqueue` command from the repo root.

## Read the request

| They say | Flag |
| --- | --- |
| a host or URL | that host as the first argument, without the path. Keep `www` when they said it. |
| a site we already have | its slug, for example `sayii` |
| full process | `--run full` |
| high priority | `--priority high` |
| low priority | `--priority low` |
| critical, or first ahead of high | `--priority critical` |
| top resilience | `--resilience top` |
| no priority named | `--priority normal` |
| no resilience named | `--resilience standard` |
| no process named | `--run full` |
| a reason or context for the site | `--note "<their words>"` |

High priority puts the site ahead of lower priority. It waits behind a high or critical job already queued, and it does not take a stage another job holds.

Top resilience is not a priority. "High priority, and top resilience" sets both.

Add `--start` so a worker picks the job up. It starts one only when no live worker serves the queued stages.

## Command

```bash
bin/orchestrator enqueue tennispremium.co --run full --priority high --resilience top --start
```

That is the command for: "Add tennispremium.co to the queue for full process. This is high priority, and top resilience."

A domain with no `orchestration/sites/<slug>/site.json` is looked up in `default.sites`. The one active row gives the idsite and name, and the command writes the `site.json`. With no active row, or more than one, it exits 2 with the reason. Tell the user the reason. Do not invent an idsite, and do not write the `site.json` by hand to get past it unless the user gives you the idsite.

If it exits 2 because the site already has an open job, say so. Do not add a second copy.

## Tell the user

Say the domain, the run, the priority, the resilience, the waiting position, how many lower-priority jobs it sits ahead of, the queue length, and whether a worker was started. The `message` has all of it. When the result says a `site.json` was written, name the file and the idsite.
