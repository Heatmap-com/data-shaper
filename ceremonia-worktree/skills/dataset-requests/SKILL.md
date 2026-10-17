---
name: dataset-requests
description: >-
  Turns a question or a call transcript into dataset requests, answers them
  with node src/cli.js --shape, and reports what was built, what reads stored
  rows, what is blocked, and what needs a person. Use when the user asks for
  data cut a new way (by day, month, or a window; rolling; against the period
  before; by campaign, landing page, region, or a site's custom variable;
  joined with Meta Ads spend, GA4, or the site catalog), or hands over a
  transcript and asks what data it asks for.
---

# Answer dataset requests

A dataset request is a JSON object that says what rows the requester wants. `--shape` plans each one against what the engine knows, reads the sources it needs, builds it, checks it, and writes it with a dictionary of its columns. Nothing it does writes a table.

The vocabulary is in four places. Read them before writing a request:

- Attributes a row can be keyed or filtered by: `src/catalog/attributes.json`, plus a site's `orchestration/sites/<slug>/attributes.json`, plus `<kind>.<column>` for each column of a lookup kind.
- Segmentations: `src/catalog/segmentations/` and the site's `segmentations.json` (see `skills/segmentation-authoring/SKILL.md`).
- Source kinds and their measures: `src/catalog/sources/*.json`. A site reads a kind only when `orchestration/sites/<slug>/sources.json` connects it.
- Measures: sessions, buyers, orders, revenue, progressed; `<kind>.<measure>`; and the ratios conversion_rate, revenue_per_session, aov, and checkout_rate, or one the request declares.

## 1. Separate the requests

From a transcript, list each thing someone asked to see, in their words. Leave out what is not data: introductions, scheduling, opinions. Something the warehouse cannot hold, such as what the merchant has already tested, is a question for the merchant; say so instead of writing a request.

## 2. Write each request

One file, `{ "requests": [...] }`. Each request:

```json
{
  "id": "meta_campaign_payback",
  "question": "Which Meta campaigns are we paying for that do not bring buyers?",
  "idsite": 5795,
  "window": { "start": "2026-08-31", "end": "2026-10-11" },
  "period": { "grain": "week" },
  "by": ["utm_campaign"],
  "segmentations": [],
  "filter": null,
  "measures": ["sessions", "orders", "revenue", "meta_ads.spend", "roas"],
  "derived": [{ "id": "roas", "label": "Return on ad spend", "data": "Tracker revenue over Meta spend.", "ratio": ["revenue", "meta_ads.spend"] }],
  "rank": { "by": "meta_ads.spend", "limit": 15 },
  "floor": { "sessions": 30 }
}
```

- `question` is the requester's words; it heads the dataset's dictionary.
- `window` is whole days, ending yesterday at the latest. At most 400 days are read, lead-in included.
- `period.grain` is `day`, `week` (`weekStart` `monday` or `sunday`), `month`, `quarter`, or `window` (one row for the whole window). `rolling: N` (day grain, 2 to 90) gives trailing N-day sums. `compare: "previous"` adds `<measure>_previous` and `<measure>_change`, and needs a window on period bounds. `partial: "drop"` leaves out periods the window cuts; by default they are kept with `period_complete` 0.
- `by` is up to three attributes. `segmentations` is up to eight ids or inline declarations, each fanned out beside `segment = all`.
- `filter` is a condition over attributes the query computes, in the segmentation condition language. A lookup attribute cannot be filtered.
- `rank` keeps the top key combinations over the window and folds the rest into `(other)`, or drops them with `"other": false`.
- `floor` flags rows under a minimum as `below_floor`; it does not remove them.
- `sources: { "<kind>": { "partial": "allow" } }` lets a source with missing days build, those days reading 0. Use it only when the user agrees.
- `subject` is `sessions` by default. `journeys`, `pages`, and `elements` read the stored trend rows when they hold the answer.
- `quality` changes the data-quality screens for this request only: `{ "rules": { "whale_orders": { "method": { "params": { "k": 5 } } } } }` patches a screen's constants, `"add": [ <screen> ]` adds one, and `"off": true` builds without any. Use it only when the user asks. Constants for every dataset of a site go in `orchestration/sites/<slug>/quality.json` instead.

Source measures sit on `segment = all` only, and split only by the attributes the source keys: Meta Ads by `utm_campaign`, GA4 by `source_or_referrer` and `utm_medium`. A filter on a request with source measures may read only those attributes. Do not work around this; the planner blocks it because the source cannot know the answer.

## 3. Plan

```bash
node src/cli.js --shape requests.json --plan
```

It reads only the column list of `udp_hsrce_visits`, the stored trend weeks for a `journeys`, `pages`, or `elements` request, and the source files. Each line is one request's status:

| Status | What to do |
|---|---|
| `ready` | Build it. |
| `read` | The rows are stored; the answer holds the query. Nothing to build. |
| `invalid` | Fix the request as the reason says, and plan again. |
| `blocked` | Report the reason. It is missing data: a connection, source days, a warehouse column, a split a source cannot make, or trend rows not stored for the weeks. Do not change the request to make it pass. |

A `blocked` journeys, pages, or elements request whose reason names a `--trend` run means the trend job has not stored those weeks. It does not mean the site has no journeys. The run writes `ae_trend_row`, so ask the user before running it.
| `needs_person` | Report each need with its level. A `declare` need you may do when the user agrees: a visit attribute in the site's `attributes.json`, a segmentation, or a ratio in the request. An `extend` or `new_grain` need is engine work; leave it to a person. |

A site attribute is a `visit` attribute over one column of `udp_hsrce_visits` that `VISIT_COLUMNS` in `src/domain/shaping/attributes.js` lists, such as a custom variable the site's tag fills. Ask the user what the column holds before declaring it.

## 4. Build

```bash
node src/cli.js --shape requests.json --out ~/work/analysis/<slug>/shapes/<YYYY-MM-DD>
```

Each built request gets `<id>/data.csv`, `<id>/dataset.json`, and `<id>/DATA.md`. `ANSWER.md` and `answer.json` cover the whole set. A build fails, with exit 1, when the segment values do not add up to `all` or the source totals are not all in the rows; report that, do not retry with changes.

Before each build the data-quality screens run over the site's sessions in the window: whale orders, resolutions that never buy (the 0x0 viewport), and sources that never buy. Each request also gets `<id>/QUALITY.md` and `<id>/quality.json`. A finding the screen's triage cannot settle waits for a person. Until someone answers, the build applies the screen's pending disposition (for the shipped screens, keep the data), and the run still exits 0. Do not decide a finding yourself. Put each waiting question to the user in its own words, from `QUALITY.md` or the `Waiting for you` section of `ANSWER.md`, and record the user's answer:

```bash
node src/cli.js --quality-decide <finding id> --from <out>/<id>/quality.json --exclude --by <user> --note "<their reason>"
```

`--include` keeps the rows. `--reprocess '<patch>'` screens again under the constants the user gives, such as `'{"method":{"params":{"k":5}}}'`. `--for-rule` applies the answer to every finding of that screen, and `--dataset-only` limits it to this dataset. The answer goes in `orchestration/sites/<slug>/quality-decisions.json`, so tell the user it is a file change to commit. Build again to apply it. `--no-quality` builds without screening; use it only when the user asks.

## 5. Report

Give the user `ANSWER.md`, then for each built dataset the one or two caveats in its `DATA.md` that change how it reads: cut periods, `below_floor` rows, sources on `segment = all` only, Meta's attribution beside the tracker's orders, `returning` as a browser id. Say which requests were blocked or need a person, and why, in the answer's words. Say what each dataset's data-quality screens excluded, and list any finding still waiting for the user.

## Sources today

The only adapter is `synthetic-file`. It reads `<dir>/<kind>.jsonl` and, when present, `<dir>/<kind>.coverage.json`. `node scripts/synthetic-sources.mjs --out <dir> --from <day> --to <day>` writes synthetic Meta Ads, GA4, and site catalog files. A dataset built from them shows how the real one will read; its source numbers are not the merchant's. Say so whenever a source measure is reported.
