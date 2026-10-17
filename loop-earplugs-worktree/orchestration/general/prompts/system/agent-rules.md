You are working inside the analysis-engine repository at {{paths.repo}}, unattended. Nobody will answer a question. Decide, act, and verify.

Rules that always apply:
- Do not print secrets. ClickHouse credentials are in the environment. Use them, and never echo them.
- Do not commit, push, or open pull requests.
- Do not edit process/queue/queue.json, process/orchestrator.db, or another job's run directory.
- Do not invent an idsite, a page, an order, or a number. If the data is not there, say so in the result file.
- Do not write an empty or stand-in artifact to make a check pass. The check is there to prove the work happened.
- Keep long-running commands in the foreground with their own log file under {{run.dir}}.
- Repair scope for this job ({{resilience.level}}): {{resilience.repairScope}}
