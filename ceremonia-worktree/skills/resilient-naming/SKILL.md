---
name: resilient-naming
description: >-
  Names one site by driving the naming bot against the Heatmap extension
  engine, and keeps going through hangs, bot failures, and extension bugs
  until the harvest is on disk. Use when the user asks to name a site, build
  a naming profile, or run the naming bot.
---

# Resilient naming

Name one site until the harvest is on disk. A hang, a typed failure, or a stale bundle is a step in the loop. It is not a reason to stop.

Two repos do the work. The bot is `/Users/kennpalm/source/heatmap/cnn-ai-bot`. The naming engine is the Chrome extension overlay in `/Users/kennpalm/source/heatmap/Heatmap-extension` (`onsite-heatmap`). This repo only starts the harvest, with `bin/seed-named-page.sh`.

Do not reimplement heuristics in the bot. Do not bump `TAXONOMY_VERSION`. Do not write an empty `names.json` to skip the bot. Do not print ClickHouse passwords or writer keys.

## Done

The seed command exits 0, and this directory exists:

`/Users/kennpalm/source/heatmap/cnn-ai-bot/dataset/<idsite>/<kind>/<slug>/`

It contains:

- `names.json` with at least one row
- `render.desktop.json` and `render.mobile.json`
- `console.json` whose naming log reached a terminal step (`naming.complete`, or a run snapshot with `running` false and percent at 100)

The homepage is kind `landing`, slug `index`. State the directory, the row count, and that both renders exist.

## 1. Resolve the site

Look up `idsite` from `default.sites`. Match `main_url` to the domain. Do not invent it. If `CLICKHOUSE_HOST` is not in the environment, load it without printing it. If more than one active row matches, stop and ask.

Open the live origin and name `https://<origin>/` unless the user names a URL. Keep the www or apex host the site actually serves.

## 2. Run the harvest

Run this from the analysis-engine repo as its own background job, with stdout in a log file. A command that is only a subshell of a tool call gets killed when the call returns, which looks like a bot crash.

```bash
bin/seed-named-page.sh <url> <idsite>
```

That writes a throwaway catalog and runs `cnn-name seed`. Seed does not need a writer. `NAMING_ENGINE_ASSETS` is required and must contain `cnn-extension.js`, `heatmap-package.min.js`, and `main.global.js`. On the host path `CNN_AI_BOT_DIR` is required too. Exit 0 means the page was named, 2 means bad arguments, 3 means a required variable is unset, and any other code is the child's status. A variable that is set but points at a missing directory is not exit 3.

Use `seed`, not `page`. The `page` verb requires a writer and a pre-built catalog, and it exits before the harvest.

## 3. On failure, fix the owner and run the same command again

Read the typed error, or the hang, before editing either repo.

| What you see | Owner | What to do |
| --- | --- | --- |
| `navigation-failed`, HTTP 503, bot wall | Merchant, then the bot | The runner already retries the goto once and abort-routes `shop.app`. Run once more. If the merchant still blocks the browser, say so and stop. |
| `hook-missing`, `HeatmapOnsite` missing after inject | Extension bundle | The three asset files are missing or stale. Rebuild the overlay and point the next run at that directory. |
| `config-invalid` | Bot env | The message names the variable. Seed needs `NAMING_ENGINE_ASSETS` only. Leave `PERSIST_POLICY` unset. |
| `pass-timeout`, or the process alive with no dataset | Extension naming pass, unless the last step is outside the page | Diagnose the hang below. |
| Exit before Chromium starts (missing flag, bad catalog) | Bot invocation | Fix the flag or the catalog. Do not patch the extension. |

### A hang

Node at 0% CPU and the Chromium renderer near 100% means the page main thread is inside the injected engine. `page.evaluate` cannot return, so the bot's 180-second wait often never fires. The capture consumer kills the command at 600 seconds (`botTimeoutMs`).

1. Reproduce with `bin/seed-named-page.sh` itself, not inside the capture consumer.
2. Read the last `heatmap-naming-log` step from the console buffer, or from `console.json` if a previous run wrote one.
3. Pause the renderer and map the stack in `main.global.js` through its sourcemap to `onsite-heatmap/src/naming/`.
4. Fix that source. Add a regression test that does not finish on the unfixed code.
5. Rebuild and rerun against the new assets. Do not hand-edit `/Users/kennpalm/work/landing-page-analysis/deploy/context/naming-assets` as the only fix.

### Rebuild the overlay

```bash
cd /Users/kennpalm/source/heatmap/Heatmap-extension/onsite-heatmap
npm run build
```

That syncs `main.global.js` into `heatmap-extension-preact/public/assets/`. Copy `cnn-extension.js`, `heatmap-package.min.js`, and the new `main.global.js` into a fresh directory and set `NAMING_ENGINE_ASSETS` to it for the next seed. Leave the shared assets directory unchanged until a seed finishes on the rebuilt bundle.

Run the overlay tests you touched (`npm test` in `onsite-heatmap`, or the single file).

### Fix the bot

Change `cnn-ai-bot` only for drive, catalog, timeout, navigation, or dataset-write bugs. Run the tests that cover the change. A naming rule (price walk, tile, FAQ, header) stays in the extension even when the symptom showed up in the bot log.

## 4. Repeat

Rerun the same URL and `idsite`. A new failure is a new row in the table above. Stop when the Done check passes, or when the blocker is outside both repos (merchant down, login wall, `idsite` unknown). Say which.

Do not commit `dataset/` or `out/`.
