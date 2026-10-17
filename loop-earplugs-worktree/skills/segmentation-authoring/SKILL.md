---
name: segmentation-authoring
description: >-
  Declares or overrides a segmentation for one site in
  orchestration/sites/<slug>/segmentations.json and checks it with --segmentation-check
  before it is committed. Use when the user asks to split a site's trend,
  tag-trend, experiment, or trigger numbers by a new dimension, to add or
  correct a channel such as Google paid, or to change which segmentations a
  site's runs read.
---

# Author a segmentation

A segmentation splits every session of a week into exactly one value. The shipped ones are in `src/catalog/segmentations/` (declared) and `src/adapters/segmentations/` (computed). The fields a declaration may read are in `src/domain/segmentation/fields.js`. A site changes them only through `orchestration/sites/<slug>/segmentations.json`.

## 1. Restate the question as a partition

Write down each value and what it means, in the user's words. Then say what happens to a session that fits none: that is the fallback value. If two values can both hold one session, decide which rule wins, since the first matching rule wins. If the user cannot say what a value means, ask before writing anything.

## 2. Prefer an override

Read the shipped declarations. If one already answers the question with a value missing or wrong, override it:

```json
{
  "idsite": 5795,
  "overrides": {
    "channel": {
      "prepend": [
        { "value": "google_paid", "when": { "all": [{ "field": "referer_type", "in": [2, 6] }, { "field": "utm_medium", "eq": "cpc" }] } }
      ],
      "remove": ["affiliate"]
    }
  }
}
```

`prepend` rules run before the shipped rules, `remove` drops a value's rules, `append` runs after them, and `fallback` renames the catch-all. A new id under `declarations` needs a purpose no shipped segmentation covers. It carries `id`, `label`, `purpose`, `data`, and either `rules` and `fallback`, or `base` naming a shipped declaration plus the override keys.

To change what a site's runs read by default, add `defaults` with any of the grains `trend`, `tagTrend`, and `experiments`, each a list of ids. Keep `traffic_source` in each list unless the user says otherwise, since the reports read it.

## 3. Use only registered fields

A condition is `{ "field", "eq" | "ne" | "in" | "like" | "startsWith" | "gt" | "gte" | "lt" | "lte": value }` (the last four on number fields only), or `{ "any": [...] }` / `{ "all": [...] }`. The field must be in `FIELDS`, and the value must fit its type. Named lists such as `"@meta_referers"` come from `src/domain/segmentation/lists.js`.

If the question needs a field that is not registered, stop. A new field is an engine change: a column in the trend SQL, the trigger sessions, and the bundle. Tell the user that and leave it to a person.

## 4. Write the site file

Write or edit `orchestration/sites/<slug>/segmentations.json`. Its keys are `idsite`, `defaults`, `overrides`, and `declarations`, and nothing else. Keep one file per site.

## 5. Check it on the last complete week

Use the Monday of the last complete week:

```bash
node src/cli.js --segmentation-check --sites <idsite> --week <monday> --segmentation-file orchestration/sites/<slug>/segmentations.json
```

To check one declaration before it goes in the file, pass a file holding only that declaration. To check a segmentation already in force, pass `--segmentation <id>` instead.

It runs one query per segmentation the file touches and writes nothing. For each value it prints sessions, share, orders, and revenue, then the partition sum against all sessions and the version the definition would get. Exit 0 means it passed. Exit 1 means a validation error, a partition that does not add up, or no sessions. Exit 2 means the command was used wrongly.

Read the shares. A value at zero, or one value over 98%, means a rule is wrong or the merchant tags differently from what the rule assumes. Ask the user what the site's tagging is. Do not guess a rule to make the numbers look right.

## 6. Commit the site file

Commit `orchestration/sites/<slug>/segmentations.json`. The next routine trend and tag-trend run gives the changed segmentation a new version and rewrites its stored weeks, up to `trend.maxBackfillWeeks` (26 by default). When more weeks are stored than that, the run stops and says so. Rerun it with `--backfill-all` only when the user agrees to the cost.
