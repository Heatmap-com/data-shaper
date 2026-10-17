---
name: analysis-queue-priority
description: >-
  Changes a queued site's priority with bin/orchestrator priority, which
  reorders the stage queues so higher priority runs first. Use when the user
  says to change, raise, lower, or set priority on the queue or the backlog.
---

# Change queue priority

Read [CONTRACT.md](../analysis-queue/CONTRACT.md). Change priority with `bin/orchestrator priority`, from the repo root.

## Levels

`critical` runs before `high`, then `normal`, then `low`. Within one level, the job queued earlier stays ahead.

| They say | Level |
| --- | --- |
| critical, or ahead of the high-priority items | `critical` |
| high priority | `high` |
| normal, default | `normal` |
| low priority | `low` |

A priority change does not interrupt a stage in progress. It reorders the job's waiting messages, so its next stage is taken in the new order.

If the job is done, blocked, failed, or cancelled, the command says so. When they ask to run it again, `bin/orchestrator retry <job>` first, then set the priority.

## Command

```bash
bin/orchestrator priority tennispremium.co high
```

Pass the job id when the command says more than one open job matches.

## Tell the user

Say the domain, the previous priority, the new priority, the waiting position or the stage it is on, and the queue length. Use the `message`.
