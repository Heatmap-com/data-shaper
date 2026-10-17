---
name: analysis-queue-clear
description: >-
  Removes waiting sites, or finished history, from the analysis queue with
  bin/orchestrator clear. Use when the user says to clear, empty, or wipe
  the queue or the backlog.
---

# Clear the analysis queue

Read [CONTRACT.md](../analysis-queue/CONTRACT.md). Clear with `bin/orchestrator clear`, from the repo root. Do not delete `process/orchestrator.db` or the journal files.

## Which clear

| They say | Command |
| --- | --- |
| clear the queue, empty the backlog | `bin/orchestrator clear` |
| clear finished work, clear history | `bin/orchestrator clear --finished` |
| wipe waiting items and history | `bin/orchestrator clear --all` |
| drop one site | `bin/orchestrator cancel <job> --reason "<their words>"` |

`clear` cancels jobs no stage has started. `--finished` removes done, blocked, failed, and cancelled jobs from the store. A job in a stage, or waiting between stages, is kept whichever flag you use. Journal files stay.

## Tell the user

Say how many jobs were removed, which domains, whether a job in a stage was kept, and the queue length after the clear. Use the `message` and the `removed` list.
