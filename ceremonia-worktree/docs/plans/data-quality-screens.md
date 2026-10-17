# Data-quality screens: outliers, suspect data, and a person's decision

Written 14 October 2026. Branch `initiative/data-quality`, from `main` (82f2e0b).

## Why

The Frank & Eileen review (`~/work/DataAnalysis/frank-and-eileen-findings-and-data-gaps.md`) reproduced its numbers exactly, and still carried data that should have been questioned before anyone read a verdict: sessions the UTM fix recovered that converted at five to twenty times the site rate, email sessions with no recorded page, a direct channel that gained 9,800 sessions and no buyers. Nothing in the engine looks for that. The bot predicate and the viewport-dead traffic model are fixed rules; neither asks a person, and neither can be told "not on this site" or "not for this dataset".

Two examples set the bar:

- A store has 1,000 transactions. 998 are $10 to $60 and 2 are $2,000 each. The engine should find the two, say what they do to revenue and AOV, and let a person keep or drop them. Either way the dataset says what was done.
- "You have 2,100,000 visits with a resolution of 0x0. They have 2 checkouts and 0 sales. Should I exclude them?"

## What is built

A **screen** is a declared rule. It names a **subject** (the rows it looks at), a **method** (an adapter that finds suspect rows in them), a **triage** (an adapter that decides whether a person must look), and the dispositions: what it proposes, what applies while a person has not answered, and what applies when triage says no person is needed. Every constant a method or triage reads is a parameter in the declaration.

A screen produces **findings**. A finding is the suspect rows (its members), the evidence, the impact on the dataset's totals, the question for a person, and its status:

| Status | Meaning | What applies |
|---|---|---|
| `auto` | Triage did not ask: the impact is under the bars | the rule's `auto` disposition |
| `awaiting_decision` | Triage asked | the rule's `pending` disposition, so the run completes |
| `decided` | A person answered | the person's decision |

A **decision** is a person's answer, kept in the site's folder: `exclude`, `include`, or `reprocess` with new parameters. It applies to the finding's members (two order ids, one resolution), so the same rows are not asked about again; a new whale next week is a new finding. A decision can instead stand for the whole rule at the site (`applies: rule`), and can be limited to one dataset.

The run always completes. Suspect data is flagged, the dataset is built with the dispositions that apply, and the dataset's folder documents every finding: `QUALITY.md` for a reader, `quality.json` for the decide command. `ANSWER.md` lists the questions waiting for a person.

### Ports and adapters

`src/ports/quality.js` holds two contracts:

- **Method** (`src/adapters/quality-methods/`): `screen({subject, rows, params, totals})` returns candidates, each with members, evidence, and a reason. Pure; no warehouse. Shipped: `iqr-fence` (Tukey fences on a measure), `robust-z` (median and MAD), `dead-cohort` (a large group whose conversion and checkout rates are a small fraction of the rest of the site's).
- **Triage** (`src/adapters/quality-triage/`): `triage({finding, impact, params})` returns `{ask, why}`. Shipped: `impact` (ask when the finding moves any declared share or rate past its bar) and `always-ask`.

A new method or triage is one file and its descriptor; discovery mounts it, and a declaration names it by id.

### Declarations and layers

Shipped screens are JSON in `src/catalog/quality/`. Constants resolve in this order, each layer patching the one before it field by field:

1. the shipped screen;
2. the shipped screen's `datasets.<dataset id>` patch (dataset-specific everywhere);
3. the site's `orchestration/sites/<slug>/quality.json` `rules.<screen id>` patch (site-specific);
4. the site file's `datasets.<dataset id>.rules.<screen id>` patch (site and dataset);
5. the request's own `quality.rules.<screen id>` patch (this request only);
6. a `reprocess` decision's parameters, for the site or for one dataset.

A site or dataset can also `add` screens of its own and switch any off with `enabled: false`. Every resolved screen records which layer set which field, so `QUALITY.md` can say where a constant came from.

### Subjects

| Subject | Rows | Exclusion scopes |
|---|---|---|
| `orders` | one per order of a kept session: idorder, idvisit, revenue | `order` drops the order's revenue and count and keeps the session; `session` drops the buying session |
| `groups` | one per value of an attribute from the shaping catalog: sessions, buyers, orders, revenue, checkout sessions | `session` drops every session with that value |

A screen reads the site's kept sessions over the request's query window, not the request's filter, so one whale is one whale in every dataset of the run. The subject rows are read once per site and window and shared across the requests of a set.

### Applying a disposition

An `exclude` becomes part of the shaped query, not a post-filter: the orders CTE drops excluded order ids, and the session `WHERE` drops excluded visits and `NOT (attribute IN values)` for an excluded group. Partition and conservation checks run on the result as before. With no exclusion, the SQL is byte for byte what it was.

### The decide command

```
node src/cli.js --quality-decide <finding id> --from <out>/<dataset>/quality.json \
  (--exclude | --include | --reprocess '<patch JSON>') --by <name> --note "<why>" \
  [--for-rule] [--dataset-only]
```

It checks the finding is in the file, that a reprocess patch resolves against the screen's adapters, records the decision with a copy of its evidence in `orchestration/sites/<slug>/quality-decisions.json`, and says to build again with `--shape`. The site folder is found from any site file that names the idsite (`site.json`, `segmentations.json`, `attributes.json`, `sources.json`, `quality.json`), so a site needs no quality file before its first decision.

## Phases

| Phase | What | State |
|---|---|---|
| Q1 | Port, domain, the five adapters, three shipped screens, `--shape` integration, `--quality-decide`, tests on clickhouse-local | Built on this branch |
| Q2 | More subjects: days (a spike or a hole in one day's sessions), session-tag coverage by outcome (the Frank & Eileen UTM bias), funnel-event reconciliation (checkout events against orders), the email link-scanner pattern | Proposed |
| Q3 | The same screens in the trend job and the analysis batch, with the ledger in a table (`ae_quality_finding`, `ae_quality_decision`) instead of site files | Proposed; needs a schema change and a person's go-ahead |
| Q4 | A request-filter population (screen only the dataset's own sessions), and a variant build (`--quality-variant`) that writes the proposed dataset beside the applied one | Proposed |

### As built (Q1)

- Code: `src/ports/quality.js`; `src/domain/quality/` (stats, screens and layers, decisions, findings); `src/adapters/quality-methods/` and `quality-triage/`; `src/catalog/quality/` (the three shipped screens) and the `resolution` visit attribute; `src/application/quality/` (site files, registry, screening, output, decide); `src/application/commands/quality-decide.js`; `src/composition/quality.js`; `src/enrichment/quality-sql.js` and the optional exclusions in `shape-sql.js` and `trend-sql.js`.
- `--no-quality` builds without screening. `--plan` does not screen.
- Money values in questions print without a currency sign, because the screen does not know the store's currency.
- Tests: `test/quality/quality.test.js` (the 998-plus-2 whale store, the 2.1 million 0x0 sessions, layering through dataset and site-plus-dataset, decisions, the decide record, the example site file `examples/shaping/quality.json`) and `test/quality/shape-quality.test.js` (on clickhouse-local: screen, decide, rebuild with exclusions, reprocess for one dataset; partition and conservation hold on the cleaned rows).
- Not yet run against the live warehouse. The first live run should be one request on one site, with the subject queries' rows and seconds read from the gateway log, because the group subject reads one attribute over the whole site window.

## Constraints kept

- `--shape` still writes no table. Decisions are a site file, as segmentations are.
- Every query is `shape:`-labelled and bounds every fact alias, so the gateway's bound check applies.
- Domain code imports only domain code. Methods and triage are pure.
