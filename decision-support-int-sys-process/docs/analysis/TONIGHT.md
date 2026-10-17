# Overnight backlog — 2026-10-12

The user is offline. Do not wait for confirmation. Do not commit. Push until this list is done.

Window is the engine's 30 days (`--window-days 30`). Same shape as Latico: `--site-source static-idsites`, qualifier `prefer-non-home`, page selector `primary-only`, catalogs LP PG PI PO TD TG TI. Heap `NODE_OPTIONS=--max-old-space-size=32768`. `TELEMETRY=0`. `--agents 1`. One `--run` at a time. Do not query `system.metrics`, `system.processes`, or `system.query_log`. Load for each update comes from that run's own log: query count, total query seconds, and the slowest query in the last 5 minutes.

Full maturity, in order, for each site: create the batch and select the page, naming bot, capture import, `--run`, promote checked descriptors (do not re-run the naming bot after operator writes; do not extend the naming mapper), replay without `bot-draft`, fill `template-weekly` and `kind-fleet-weekly`, trend rows and tag-trend rows. Journal wall-clock time in `docs/analysis/<site>/PROJECT-LOG.md`.

Loop Earplugs must be fully finished before 12:00 UTC (07:00 US Central). If Kurk Uk is blocked in a way that would miss that, do Kurk Uk naming only, record why, and move on.

Kurk Aus (idsite 2181) is cancelled. Do not batch, name, or analyze it. The user will research why it recorded no revenue.

| Order | Site | idsite | Status |
| --- | --- | ---: | --- |
| 1 | Mellow | 4879 | Done. Tag-trend 03:32:09 UTC: 36,000 rows, 9 keys, `ok: true`. Batch `6b5f8c7f-1ff8-46cf-9279-ef04a69a61c4`. |
| 2 | Kurk Uk | 3616 | Done. Tag-trend 04:01:22 UTC: 32,000 rows, 9 keys, 85,455 sessions, `ok: true`. Batch `7cb8cac9-0871-47cd-b963-0cd42fe46ee3`. |
| 3 | Loop Earplugs | 558 | Done. Tag-trend 05:26:23 UTC: 28,000 rows, 7 keys, 2,185,961 sessions, `ok: true`. Batch `0ad53e36-30fc-4394-a5df-f68dcf02e2ff`. |
| — | Kurk Aus | 2181 | Cancelled. No revenue in the window. User is researching that. |
