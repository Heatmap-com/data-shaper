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
   - `CNN_AI_BOT_DIR` and `NAMING_ENGINE_ASSETS` are required. There is no default path. Exit 3 means the config is missing; that is blocked, not a defect.
4. The naming bot is in `{{config.naming.botDir}}`. The engine overlay is in `{{config.naming.engineDir}}`. Change either only if the repair scope above allows it.
5. When the folder passes the check, stop.

{{> system/result-contract}}
