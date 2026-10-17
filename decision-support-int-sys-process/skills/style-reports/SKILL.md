---
name: style-reports
description: >-
  Styles analysis reports as PDFs in the Heatmap brand. Use when the user
  asks to style reports, convert reports to PDF, apply Heatmap styles, or
  mentions the Heatmap style guide or logo.
---

# Style reports

`docs/style-guide.md` is how a report reads. This skill is the page. The page is Heatmap, not the gold and black Word specimen.

Tokens live in `scripts/report-style/tokens.mjs`. They were taken from heatmap.com (`.hm-web`, release 2026-10-06) and from `/Users/kennpalm/Documents/heatmap-style-guide/style-guide.md`. Where those two disagree, heatmap.com wins.

- Brand green is `#10b068`. The portal guide's `#079455` is the older green.
- Display type is Poppins. Body type is Inter. Montserrat is not on heatmap.com.
- The logo is forest `#004225`. Do not recolor it. The file is `scripts/report-style/logo.svg`, copied from the guide's `logo.svg`.
- Warning is `#d97230`.
- Table headers are muted on `#f9fafb`. They are not black.

## Command

```bash
node scripts/report-style/style-reports.mjs docs/analysis/<slug>/*.md
```

A PDF is written next to each markdown file. Pass `--out <dir>` to write them somewhere else, and `--chrome <path>` for a Chrome or Chromium binary outside `/Applications` (the orchestrator's `style-pdf` stage passes `config.report.chromePath`). Charts resolve from `media/` beside the markdown. Pandoc and Chrome have to be installed.

Run the script. Do not restyle a report by hand. When the Heatmap tokens change, edit `scripts/report-style/tokens.mjs` and run the script again.
