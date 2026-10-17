---
name: site-analysis
description: >-
  Runs one site through stored analysis: batch, page, capture, datasets,
  descriptors, replay, and trend rows. Use when a queued site reaches the
  analysis step, after naming and before the data export.
---

# Site analysis

Store one site's analysis. The naming step has already produced the harvest. This step does not write `~/work/analysis/<slug>/` and does not write the three reports. The export skills write the files. The report skills are the final stage, and they read those files.

Do not print ClickHouse passwords. If `CLICKHOUSE_HOST` is not in the environment, load the repo `.env` without printing it. Resolve `idsite` from `default.sites`. Do not invent it.

Record the slug, `idsite`, batch id, and window on the job with `bin/orchestrator note <job> --text "..."`. The export step uses that same slug.

## Done

All of these are true:

- One batch, 30-day window ending yesterday UTC, `static-idsites`, `prefer-non-home`, `primary-only`, catalogs `LP PG PI PO TD TG TI`
- The first `--run` stopped at `awaiting_capture`. That gate is expected.
- Capture is `complete` on the current taxonomy, with desktop and mobile renders, and the harvest imported as bindings
- The later `--run` finished with failed 0 and one page analyzed. Trigger hits and chains are stored.
- Page descriptors were checked and promoted, and `s30.platform` is stored
- Replay rewrote the strategy cards. `template-weekly` and `kind-fleet-weekly` have rows
- Trend rows exist for journey, page, and element. Tag-trend rows exist. Each trend check returned ok
- `docs/analysis/<slug>/PROJECT-LOG.md` records the batch, the page, and each step's result

## Run

One site. `--agents 1`. `TELEMETRY=0`. Give `--run` a 32 GB heap (`--max-old-space-size=32768`). Log each command to its own file and let it finish. A command that is only a subshell of a tool call gets killed when the call returns.

```bash
node src/cli.js --batch --sites <idsite> --window-days 30 \
  --catalogs LP,PG,PI,PO,TD,TG,TI \
  --site-source static-idsites --qualifier prefer-non-home --page-selector primary-only

node src/cli.js --run --batch <batch_id> --sites <idsite> --agents 1 \
  --site-source static-idsites --qualifier prefer-non-home --page-selector primary-only

node src/cli.js --capture --agents 1

node src/cli.js --run --batch <batch_id> --sites <idsite> --agents 1 \
  --site-source static-idsites --qualifier prefer-non-home --page-selector primary-only
```

The second `--run` is the full analysis. Check the drafted descriptors against the harvest and the page, correct the ones that are wrong, and add `s30.platform`. Dry-run the import, then import:

```bash
node src/cli.js --descriptor-import <file> --dry-run
node src/cli.js --descriptor-import <file>
```

Leave `bot-draft` out of the replay so the corrected rows stand.

```bash
node src/cli.js --replay --batch <batch_id> --sites <idsite>
node src/cli.js --trend --sites <idsite> --window-start <window0> --window-end <window1>
node src/cli.js --tag-trend --sites <idsite> --window-start <window0> --window-end <window1> \
  --lookback-days 30 --tag-selector traffic-variance
```

Element rows stay empty until the analysed page has active selectors in `ae_trend_selector`. The built-in seed is the DVF homepage and does not apply here. Store this page's selectors through `writeTrendSelectors` (see `docs/TREND-ENRICHMENT.md`), using bound controls on the page, then run `--trend` again. Do not copy another site's selectors.

## When capture or the bot fails

Read `skills/resilient-naming/SKILL.md` and follow it. Do not invent a second naming procedure. Re-run capture after the harvest is on disk.

A failed `--run` on a large site is a reason to read the log, keep the checkpoints, and run again. It is not a reason to skip descriptors, replay, or trends.

## Project log

Write `docs/analysis/<slug>/PROJECT-LOG.md` as this step's record: window, batch, selected page, capture, analysis, descriptors, replay, trends. Numbers in that log come from this run.
