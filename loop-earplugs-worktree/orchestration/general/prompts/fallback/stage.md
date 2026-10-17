{{> system/agent-rules}}

# Finish {{stage.label}} for {{site.domain}}

Attempt {{run.attempt}} of {{run.limit}}. The orchestrator ran this stage, and it is not complete. Make it complete, verify it, and stop.

- Unit: {{unit.key}}
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
2. Keep long commands in the foreground, with a log under `{{run.dir}}`.
3. When the check passes, stop.

{{> system/result-contract}}
