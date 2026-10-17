---
name: upload-full-site
description: >-
  Uploads one site's full analyst bundle, its three client reports, and the
  report style guide into a remote LLM project. Use when the user asks to
  upload a full site, create the remote project for a site, or refresh the
  files a later analysis prompt will read.
---

# Upload a full site

Read this skill before uploading. The script is provider-neutral. Kimi is the provider that exists today. Nothing about Kimi's HTTP belongs in the command the user runs, apart from the provider id and the key's host.

## What gets uploaded

From `~/work/analysis/<slug>/`, every file in the full bundle, under `data/` in the project. This is the full folder, not the `-4mb` copy.

From `docs/analysis/<slug>/`, only the three reports:

- `{Brand} — Site Opportunity Report.md`
- `{Brand} — Today Opportunities.md`
- `{Brand} — User Journey Opportunity Analysis.md`

`PROJECT-LOG.md` and `media/` stay local. Charts are not uploaded. The style guide is `docs/style-guide.md`, stored as `style-guide.md` and replaced if it is already there.

The project name is the site slug. A second run finds the same project and replaces files. It does not create a second project, and it does not modify the local reports.

## Command

```bash
node scripts/remote-llm-projects/analyze-site.mjs --provider kimi --site <slug> --upload-only
```

`KIMI_API_KEY` comes from the environment. Do not print it. Leave `KIMI_API_BASE_URL` unset unless you are deliberately overriding the descriptor. Hosted projects are on `https://api.moonshot.cn`, which is the default. A key issued for `https://api.moonshot.ai` can list models and files, and that host returns 404 for `/v1/memory-stores`. Creating the project needs a key from platform.kimi.com.

The full command, without `--upload-only`, uploads and then runs the analysis. Use `--upload-only` when the user asked only to upload.

## Before running

The full bundle and the three reports have to exist. Build the bundle with `skills/analyst-data-bundle/SKILL.md` and the reports with the three document skills if they do not. Do not upload the trimmed folder.
