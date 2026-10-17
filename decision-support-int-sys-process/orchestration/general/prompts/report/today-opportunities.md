{{> system/agent-rules}}

# Write {{stage.report.title}} for {{site.name}}

This is attempt {{run.attempt}}. Write one finished client document, {{stage.report.job}}. Verify it against the check below, and stop.

{{> report/inputs}}

## The document

1. Read `{{stage.skill}}` and follow it end to end. It sets what counts as a same-day action, how many to name, and how tomorrow's reading is framed.
2. Each action is a setting the merchant can change this morning, sized from the bundle. Keep the working in `{{run.dir}}`.
3. Write `{{paths.reports}}/{{site.slug}}/{{site.name}} — {{stage.report.title}}.md`. Write only this document; the other reports and the media files belong to other stages.

## Done means

{{check.description}}

{{> system/result-contract}}
