# laticoleathers.com

| | |
| --- | --- |
| id | laticoleathers-20261014-194614-bldp |
| run | full |
| priority | normal |
| resilience | standard |
| domain | laticoleathers.com |

## Log
- 2026-10-14T19:46:14.383Z — queued. Run full (/Users/kennpalm/work/analysis-engine-i/orchestration/general/runs/full.run.json), normal priority, standard resilience, 1 page(s), window 2026-09-14 to 2026-10-13. Site found in default.sites (idsite 1425, Latico Leathers); wrote /Users/kennpalm/work/analysis-engine-i/orchestration/sites/laticoleathers/site.json. initiative e2e run 1: full process with the day store on
- 2026-10-14T19:46:26.920Z — stage naming started, attempt 1.
- 2026-10-14T19:47:52.709Z — https://laticoleathers.com/ complete.
- 2026-10-14T19:47:52.711Z — step naming done. Queued for analysis.
- 2026-10-14T19:47:55.936Z — stage analysis started, attempt 1.
- 2026-10-14T20:07:57.144Z — site complete.
- 2026-10-14T20:07:57.146Z — step analysis done. Queued for bundle.
- 2026-10-14T20:08:11.053Z — stage bundle started, attempt 1.
- 2026-10-14T20:08:11.054Z — site: blocked, this stage lands in a later phase.
- 2026-10-14T20:08:11.056Z — blocked. bundle on site: this stage lands in a later phase
- 2026-10-14T20:20:27.394Z — paused: the e2e validation resumes after declarative segmentation is merged into scale/11-completion
- 2026-10-14T20:38:07.923Z — step bundle done by the operator: ~/work/analysis/laticoleathers, 13 MB, window 2026-09-14 to 2026-10-13: 3,656 orders, $787,847.37; all five order anchors match 01_orders.csv Queued for bundle-4mb.
- 2026-10-14T20:38:08.320Z — step bundle-4mb done by the operator: ~/work/analysis/laticoleathers-4mb, 7.4 MB after both trim passes (07_page_clicks 3.4 MB); orders rolled up to day x product; the four kept anchors match (median dropped by the rollup) Queued for chart-render.
- 2026-10-14T20:38:14.314Z — stage chart-render started, attempt 1.
- 2026-10-14T20:38:19.976Z — site complete.
- 2026-10-14T20:38:19.978Z — step chart-render done. Queued for site-opportunity-report.
- 2026-10-14T20:38:20.363Z — stage site-opportunity-report started, attempt 1.
- 2026-10-14T20:52:13.409Z — site complete.
- 2026-10-14T20:52:13.496Z — step site-opportunity-report done. Queued for today-opportunities.
- 2026-10-14T20:52:13.509Z — stage today-opportunities started, attempt 1.
- 2026-10-14T20:59:26.388Z — site complete.
- 2026-10-14T20:59:26.391Z — step today-opportunities done. Queued for user-journey.
- 2026-10-14T20:59:28.565Z — stage user-journey started, attempt 1.
- 2026-10-14T21:06:20.036Z — site complete.
- 2026-10-14T21:06:20.038Z — step user-journey done. Queued for style-pdf.
- 2026-10-14T21:06:28.639Z — stage style-pdf started, attempt 1.
- 2026-10-14T21:06:37.841Z — site complete.
- 2026-10-14T21:06:37.842Z — step style-pdf done. The job is done.
