{{> system/agent-rules}}

# Write the {{stage.report.title}} for {{site.name}}

This is attempt {{run.attempt}}. Write one finished client document, {{stage.report.job}}. Verify it against the check below, and stop.

{{> report/inputs}}

## The document

1. Read `{{stage.skill}}` and follow it end to end. It sets the section order, what each section computes, and how opportunities are sized and ranked.
2. Compute the numbers the skill lists before drafting. Keep the working in `{{run.dir}}`.
3. Write `{{paths.reports}}/{{site.slug}}/{{site.name}} — {{stage.report.title}}.md`. Write only this document; the other reports and the media files belong to other stages.
4. Check the anchors: the orders and revenue in the report window in your text match `00_site_profile.json`.

## Done means

{{check.description}}

{{> system/result-contract}}
