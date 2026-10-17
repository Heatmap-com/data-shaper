---
name: kimi-analysis
description: >-
  Runs the remote analysis that reads a site's full data and three reports
  and writes enhanced versions of those same three documents. Use when the
  user asks to run Kimi analysis, enhance the client reports, or send the
  analysis prompt to the remote project.
---

# Kimi analysis

Read `skills/upload-full-site/SKILL.md` first. This skill is that upload plus the analysis prompt. Kimi is the provider id. The prompt and the script do not contain Kimi's API.

## What the prompt asks for

The prompt is `scripts/remote-llm-projects/prompts/enhance-reports.md`. It tells the model to:

- Read the three source reports, the full data bundle, and `style-guide.md`.
- Rebuild the same three documents from the data, styled by the style guide, rather than lightly editing the prose.
- Check every finding against the files, and independently look for other opportunities, findings, areas of interest, and areas of concern.
- Write the enhanced documents back into the project under `enhanced/`. The source reports are left as they are.

Monthly sizes stay upper bounds. Numbers stay anchored. The model does not invent a benchmark.

## Command

```bash
node scripts/remote-llm-projects/analyze-site.mjs --provider kimi --site <slug>
```

Leave `KIMI_API_BASE_URL` unset. The project API is on `https://api.moonshot.cn`. A key for `https://api.moonshot.ai` cannot create the project. See `skills/upload-full-site/SKILL.md`.

The script does five things, in order:

1. Create the project for the slug, or reuse it if that name already exists.
2. Upload the full data set from `~/work/analysis/<slug>/`.
3. Upload the three reports from `docs/analysis/<slug>/`.
4. Update `style-guide.md` in the project from `docs/style-guide.md`.
5. Send the prompt. The session can take a long time. Leave it running.

Enhanced reports are saved to `docs/analysis/<slug>/enhanced/`. The three source reports are not overwritten. `response.md` in that folder is the model's note on what it changed, not a fourth client document.

A re-run uploads again and starts a new session on the same project. If the session fails after the upload, the files are already there. Run the same command again.

Do not print `KIMI_API_KEY`.
