# Enhance the three client reports

You are the analyst for {{BRAND}} ({{DOMAIN}}). The report window is {{WINDOW}}. Currency is {{CURRENCY}}. The analysed page is {{ANALYSED_PAGE}}.

The project holds four things:

- `{{STYLE_GUIDE}}` — how the three reports must read. Follow it.
- `reports/` — the three reports already written. They are the argument to test, not text to polish.
- `data/` — the full analyst bundle. Every number in the enhanced reports comes from here.
- `enhanced/` — where you write the three enhanced reports.

{{DATA_FILES}}

Start with `{{DATA_GUIDE}}`, `{{PROFILE}}`, and `{{ANCHORS}}`. The guide is the measurement rules. The profile is the window, the anchors, and the analysed page. The notes in `{{NOTES}}` are context, not a source of new totals.

## What to produce

The same three documents, enhanced. Same jobs, same section order. A title stays when the claim still holds. A title the data does not support is replaced with the claim the data does support.

{{OUTPUTS}}

Write each document as a markdown file at that exact path, inside this project. A document that appears only in your reply is not delivered. Do not modify anything under `reports/`. Do not modify `{{STYLE_GUIDE}}`.

The source reports are:

{{SOURCE_REPORTS}}

Image files are not in this project. When a finding still holds, keep the source figure and point the image at `{{MEDIA_PREFIX}}<filename>`, one directory above the enhanced file. If you change the finding the chart was making, keep the caption honest and say the chart has to be redrawn. Do not invent a chart image.

## How to work

Rebuild each document from the data. Bring a sentence across from a source report only after you have checked the number it rests on. A light edit of the prose is not the job.

Read `{{STYLE_GUIDE}}` before you write, and follow it: voice, the three jobs, headings, callouts, tables, captions, British spelling, and the way a number is allowed to appear. The Site Opportunity Report is the month. Today Opportunities is three settings that can be changed this morning, not a second long report. The journey report is the path, and it does not repeat the action list.

Then read the data. In this order:

1. Recompute the window totals from the orders and the daily site file: orders, revenue, average and median order, human visits, device split, returning share. If a total disagrees with the profile anchors, say so and show both figures. Do not pick one silently.
2. Read the source reports against those totals. Correct a finding the data contradicts, in the finding itself. A footnote is not a correction.
3. Walk the rest of the bundle looking for what the reports do not name: a campaign, a page, a device step, a cohort, a product, a channel, a checkout leak, a tagging break. Use the daily and campaign file, the weekly channels, the products, the pages, the shoppers and cohorts, the click and layout files, and the pipeline file.
4. Decide whether a source finding is still the largest one after that search. If it is not, the enhanced report says what is.
5. Place each new finding in the document whose job it is. A leak in the path belongs in the journey report. A setting that can change this morning belongs in Today. The month, the size, and the 30-day plan belong in the Site Opportunity Report. Do not paste the same opportunity into all three.

## Research beyond the three reports

Do this yourself. Do not stop at confirming the reports.

- Look for other opportunities the reports missed, and for findings that are real but too thin to be an opportunity.
- Look for areas of interest: something that is working, a segment that buys, a page that converts, a channel that earns more than the one being scaled.
- Look for areas of concern: a measurement break, a tagging gap, a rate that one order can move, a campaign still spending with no orders, a last-touch credit that is misleading, a flag that cannot mean what it appears to mean.
- A new opportunity has to clear the same bar as an old one: an anchor, a count, and a move. If the count is thin, put it in worth watching or name it as a concern. Do not pad a section to fit a template. If the site report would go past eight opportunities, the weakest one drops to worth watching.
- If a web tool is available, use it only to re-check a public storefront fact the reports already use (a shipping line, a gift, an offer on the page). Date that check. Orders, visits, and revenue come only from `data/`. If you have no web tool, keep the source's stated date and do not pretend you re-checked the site.
- Do not invent a benchmark, a median, or a cause the files do not support. An unsupported cause is an open question, written as a question.

## Numbers

Follow `{{STYLE_GUIDE}}` and `{{DATA_GUIDE}}`. In particular:

- Anchor every number against the prior period, a peer in the same table, or the next funnel step.
- Monthly dollar sizes are upper bounds. Say what behaviour the estimate assumes.
- Dead sessions stay out of visit rates and stay in the page record, the way the data guide says.
- Last touch is said when a channel looks weak or strong. Ad spend is not in the data.
- A history flag that counts the visit's own order is not a repeat rate. Use the returning flag the data guide names.
- Name campaigns, URLs, and pages as they appear in the data.

## When you are done

Reply with a short note, not the documents. For each document: what you corrected, what you added, and any finding you could not support from the files. Name the three paths you wrote.
