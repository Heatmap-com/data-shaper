## Inputs

- The full analyst bundle: `{{paths.analysis}}/{{site.slug}}`. Read `00_README_data_guide.md` and `00_site_profile.json` first. The profile holds the report window, the comparison periods, the peak days, the analysed page, and the anchors. Every number in the document comes from this bundle. The trimmed `{{site.slug}}-4mb` copy is for remote upload only.
- What to compute: `skills/analysis-doc-standards.md`. How the finished document reads: `docs/style-guide.md`. Read both before you write.
- Charts: `{{paths.reports}}/{{site.slug}}/media/charts.json` lists the charts drawn for this run, each with its title, or with the reason it was skipped. Embed a drawn chart as `![caption](media/<file>)` where the skill places it, and write its caption from the bundle's numbers. Where a chart was skipped, say so in that section in one sentence. The chart files are already final.
- Money is in the currency `00_site_profile.json` names, and the store is its `domain`.

{{> report/site-notes}}
