## Result

Before you stop, write `{{run.resultFile}}` as JSON:

```json
{ "status": "fixed | blocked | gave_up", "summary": "one or two sentences", "blocker": "only when blocked", "changes": ["every file you changed"] }
```

Use `blocked` only for something a person must do: the merchant site is down after retries, a login wall, an unknown idsite, missing credentials, or a decision only the user can make. A usage limit on your own account is `blocked` too: say which account and when it refreshes. The orchestrator runs the completion check itself after you stop. `fixed` with a failing check counts as not fixed.
