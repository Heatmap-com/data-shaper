# Plan: declarative segmentation

**Written:** 14 October 2026
**Status:** built through SG11 on `initiative/segmentation`, merged into `scale/11-completion`; SG12 ran on DVF
**Requirements:** `docs/plans/segmentation-requirements.md` (R1–R27, N1–N8, strategy S1–S8)
**Builds on:** `src/domain/channel-rules/` (R2.6), the trigger definition versioning (`src/triggers/definitions.js`), and Part T of `docs/plans/scale-and-profiles-initiative.md`

This plan replaces the hardcoded trend segmentations with one registry of declared and computed segmentations. The trend, tag-trend, experiment, bundle, and trigger read paths all read that registry. It is written in the order it should be built. Each phase leaves the engine runnable, and the default output stays identical until a phase changes it on purpose.

## Working rules

- Each phase is a branch `seg/<n>-<name>` off `initiative/scale-and-profiles`. It merges back with `--no-ff` when its tests pass. Branches stay local until the user asks for a push.
- Each numbered item is its own commit. A refactor records a characterization test on the old code first, then compares after. A behaviour change writes its failing test first.
- Live checks read ClickHouse and write only to the in-memory persistence adapter. Nothing in this plan writes production tables, alters a table, or enqueues a job. The new table is written and tested against the memory adapter and the fake client. Creating it on ClickHouse waits for the user.
- One heavy query in flight. No `system.*` queries. No passwords or keys in output.
- New code says "segmentation." Existing names that say "strategy" for a segmentation are renamed in the phase that touches them, not in a separate sweep.

## Phase map

| Phase | Delivers | Depends on |
|---|---|---|
| SG0 | Characterization on the old code; medium-source probe; fan-out cost probe | nothing |
| SG1 | Typed fields, named lists, and the generalized condition language in `src/domain/segmentation/` | SG0 |
| SG2 | Declaration checker, compiler, and the shipped catalog in `src/catalog/segmentations/` | SG1 |
| SG3 | The segmentation port, the `segmentations` adapter role with `return-intent`, and the registry | SG2 |
| SG4 | Site files, run selection, and the `--segmentations` flag | SG3 |
| SG5 | Fan-out SQL in the trend and tag-trend aggregates | SG3, SG4 |
| SG6 | Rollup and verification over any segmentation list; old constants removed | SG5 |
| SG7 | Experiments and the analyst bundle read the registry | SG5 |
| SG8 | `ae_segmentation_definition`, versions, and `metrics.segmentation_version` | SG6 |
| SG9 | Backfill on a version change, and retired values | SG8, Part T2 and T3 |
| SG10 | The trigger read path segments by a declared segmentation | SG2 |
| SG11 | `--segmentation-check`, the authoring skill, and the docs | SG4, SG8 |
| SG12 | Live acceptance, read-only, run by the user | all |

SG10 can run in parallel with SG5 to SG8. SG9 waits for Part T to land `readTrendWeeks` and per-subject start weeks.

---

## SG0. Characterization and probes

Nothing in this phase changes behaviour.

### SG0.1 Extend the local warehouse

`test/support/local-warehouse.js` `TABLES.udp_hsrce_visits` lacks columns the trend and the bundle read. Add `referer_name: 'Nullable(String)'`, `custom_var_v1: 'Nullable(String)'`, `custom_var_v4: 'Nullable(String)'`, and `config_id` stays. Today's tests pass unchanged because missing columns take defaults.

`test/support/site-fixture.js` `warehouseRows()` gains variety on the visit row, so every shipped segmentation has every value at least once:

- `custom_var_k5` cycles through `facebook`, `ig`, `fb`, `instagram`, `facebookads`, `igshopping`, `klaviyo`, `''`, and `null`;
- `referer_type` cycles through 0, 1, 2, 3, 6, 7;
- `referer_name` cycles through `Facebook`, `instagram`, `klaviyo`, `google`, `shopmy`, `''`;
- `custom_var_v1` cycles through `paid`, `email`, `cpc`, `flow`, `''`, `null`;
- `custom_var_v4` alternates between `fall_sale` and `''`;
- every third visit has a rage click (`meta1 = 'rage'`), and the existing buyers and returning visits stay.

The existing fixture-based snapshots change only if a test reads the new columns. Re-record nothing in this item. If a snapshot moves, the fixture change is wrong.

### SG0.2 Record the trend and tag-trend rows

New `test/characterization/segmentation-parity.test.js`, on `clickhouse local`, skipped when it is absent, as the other local tests are:

1. Run `runTrend` over `createLocalWarehouse(warehouseRows())` with the memory trend store, for site `IDSITE`, window 2026-09-08 to 2026-09-14, path limit 3, with one trend selector page seeded on page 12.
2. Run `runTagTrend` over the same warehouse, lookback 30. The fixture is too small for `traffic-variance` to select anything, so pass a stub selector (the run takes `opts.selector`) that marks the fixture's `utm_source` key selected with its two largest values. At least one key is then trended.
3. Store both row sets as snapshots, sorted by their full identity: `(rowType, rowKey, rowKey1, rowKey2, viewportType, segment, segmentValue, week, idsitehsr)` for trend rows, and `(tagKey, tagValue, viewportType, segment, segmentValue, week)` for tag rows. The `batchId` and `generatedAt` fields are dropped before the snapshot.

Row order is not part of the contract. The sort makes the snapshot independent of grid order, which changes in SG6.

### SG0.3 Record the experiment rows

Extend `test/experiment-analysis.test.js`, or add a characterization beside it, so the experiment fact rows (`experimentFactSql` through the readout) for the fixture's A/B arm are snapshotted with the same sorted-identity rule, including the `traffic_source` and `returning` rows.

### SG0.4 Record the bundle's channel columns

`test/characterization/bundle-sql.test.js` pins the bundle SQL text. Add a `clickhouse local` check that runs the bundle's visit extract over the fixture and snapshots `(idvisit, ch, link)` per visit, where `link` is the `LINK_CHANNEL` column. This snapshot, not the SQL text, is the bundle's parity guard in SG7.

### SG0.5 Probe the UTM medium source

`scripts/probes/medium-source.mjs`, read-only, on the live gateway, for DVF (5795) and Mellow (4879), for the last complete week. One bounded query per site, labelled `probe:medium-source`:

- per visit: `lower(trim(argMin(custom_var_v1, visit_first_action_time)))` from `udp_hsrce_visits`, and the first non-empty value of a session-tag key matching `medium` by `idloghsr`, from `udp_session_tags`;
- output counts: both empty, only the variable, only the tag, both and equal, both and different, with the ten most common disagreeing pairs.

Write the result to `docs/probes/2026-10-medium-source.md`. Record the choice as `docs/decisions/2026-10-xx-d14-utm-medium-source.md` (D-10 to D-13 are reserved for Part P). The decision names the source of the `utm_medium` field in SG1. If the two disagree on more than 1% of the visits where both are set, the decision says which wins and why. It does not average them.

### SG0.6 Probe the fan-out cost

`scripts/probes/segmentation-fanout.mjs`, read-only, on DVF's proof window (2026-09-14 to 2026-10-09):

1. Time today's `pathAggregateSql('template')` with the stored path list.
2. Time a hand-written fan-out variant of the same query: the four segmentations as `arrayJoin` tuples (the SG5 shape), plus `all`.
3. Time the fan-out with two more tuples: a seven-value channel from `channelSql(VISIT_CHANNEL)` and a constant six-value column standing in for return intent.

Report wall-clock seconds and result rows for each, three runs each, median reported. Write to `docs/probes/2026-10-segmentation-fanout.md`. The result sets the budget (R20, default 48) and confirms N4. If the fan-out with six segmentations exceeds twice today's seconds, stop and bring the numbers to the user before SG5.

**Done when** the snapshots are committed and green on the old code, both probe documents exist, and D-14 is recorded.

---

## SG1. Typed fields, lists, and conditions

### SG1.1 Move the condition language

Create `src/domain/segmentation/` and move `src/domain/channel-rules/conditions.js` into it as `conditions.js`. `src/domain/channel-rules/` keeps its public exports by re-exporting, so `py/bundle-export.mjs` and the tests do not change in this item. Architecture tests must still pass: the directory imports only domain code.

Move `canonical` from `src/triggers/definitions.js` to `src/domain/canonical.js`, and re-export it from `definitions.js`. The trigger tests are the guard.

### SG1.2 The field registry

`src/domain/segmentation/fields.js`, deep-frozen:

```js
export const FIELDS = deepFreeze({
  referer_type:   { type: 'number', source: 'udp_hsrce_visits.referer_type, at the first action' },
  referer_name:   { type: 'string', source: 'udp_hsrce_visits.referer_name, at the first action, lowercased and trimmed' },
  utm_source:     { type: 'string', source: 'udp_hsrce_visits.custom_var_k5, at the first action, lowercased and trimmed' },
  source_or_referrer: { type: 'string', source: 'utm_source when it is not empty, else referer_name' },
  utm_medium:     { type: 'string', source: 'per D-14' },
  utm_campaign:   { type: 'string', source: 'udp_hsrce_visits.custom_var_v4, at the first action, trimmed' },
  returning:      { type: 'number', source: 'udp_hsrce_visits.visitor_returning, at the first action, 1 or 0' },
  country:        { type: 'string', source: 'udp_hsrce_visits.location_country, at the first action' },
  has_order:      { type: 'number', source: 'udp_conversions, one row per (idvisit, idorder); 1 when the visit has an order', needs: 'orders' },
  has_checkout:   { type: 'number', source: 'journey_events_map checkout_started; 1 when the visit started checkout', needs: 'checkout' },
  has_rage_click: { type: 'number', source: "udp_clicksce_clicks meta1 = 'rage'; 1 when the visit has a rage click", needs: 'ragers' },
});
```

The registry holds names, types, sources, and needs. It does not hold SQL. Each grain maps fields to its own SQL in a column map (SG5, SG7, SG10), because the same field has a different alias in the trend query (`k.referer_type`) and in the bundle (`v.rt`). Device is not a field, because device is `viewport_type`.

### SG1.3 Named lists

`src/domain/segmentation/lists.js`, deep-frozen:

| Name | Values | Today's home |
|---|---|---|
| `meta_utm_sources_trend` | facebook, ig, fb, instagram, facebookads | `META_SOURCES` in `trend-sql.js` |
| `meta_utm_sources` | facebook, facebookads, ig, instagram, igshopping | `META_SOURCES` in `channel-rules/rules.js` |
| `meta_referers` | facebook, instagram | `META_REFERERS` |
| `paid_mediums` | paid, paidsocial, paid_social | `PAID` |

A condition names a list with an `@` prefix in place of an `in` array: `{"field": "utm_source", "in": "@meta_utm_sources"}`.

### SG1.4 Typed checks and list resolution

In `src/domain/segmentation/conditions.js`:

- Each operator gains `types`: `eq`, `ne`, and `in` accept `string` and `number`. `like` and `startsWith` accept `string`.
- `checkCondition(condition, {fields, lists}, owner)` replaces the channel module's private check. It throws, naming the owner (the segmentation id and the value), on an unknown field, an operator the field's type does not allow, a value of the wrong type (`eq: 1` on a string field, `in: ['1']` on a number field), an unknown list, or an empty `any` / `all`.
- `resolveLists(condition, lists)` returns a copy with every `@name` replaced by the list's values. The compiler, the classifier, and the stamp all read resolved conditions, so a list edit changes the stamp.
- `toPredicate` reads a missing value as the field type's default: `''` for strings and `0` for numbers. Today it always reads `''`, which matters only once number fields can be null (R7).

### SG1.5 Rename the channel tables' fields

`VISIT_CHANNEL` and `LINK_CHANNEL` move to canonical field names: `rt` → `referer_type`, `rn` → `referer_name`, `med` → `utm_medium`, `camp` → `utm_campaign`, and `src` → `source_or_referrer`. Their literal lists become list references. `channelSql(table, columns)` gains a column map, and `py/bundle-export.mjs` passes `{referer_type: 'rt', referer_name: 'rn', utm_medium: 'med', utm_campaign: 'camp', source_or_referrer: 'src'}`, so the bundle's SQL text is the same. `test/domain/channel-rules.test.js` renames its row keys and keeps every expectation.

**Tests:** `test/domain/segmentation-fields.test.js` covers each check error. The channel-rules parity test runs on renamed fields and adds `null` to every column of its grid. `rule-tables.test.js` stays green.

**Done when** every existing test passes, the channel parity test covers nulls, and `py/bundle-export.mjs` SQL text is unchanged (`bundle-sql` snapshot).

---

## SG2. Declarations, compiler, and catalog

### SG2.1 The declaration checker

`src/domain/segmentation/declaration.js`:

```js
/**
 * @param {object} doc a declaration as written
 * @param {{fields, lists, bases: {visit: ChannelTable, link: ChannelTable}}} registry
 * @param {string} where file name or site slug, for error messages
 * @returns {ResolvedSegmentation} {id, label, purpose, data, rules: [{value, when}], fallback, values, fields, needs}
 */
export function checkDeclaration(doc, registry, where) { ... }
```

Rules, each a named error:

- `id` matches `^[a-z][a-z0-9_]*$` and is not `all`.
- `label`, `purpose`, and `data` are non-empty strings.
- Exactly one of `rules` or `base` is present. With `base`, `prepend`, `remove`, `append`, and `fallback` adjust it, as in `resolveChannelRules`. `remove` names values.
- Each rule is `{value, when}`. `when` passes `checkCondition`.
- `fallback` is a value string.
- Values are the distinct rule values in first-appearance order, then the fallback. There are 2 to 16 of them, each matching `^[a-z0-9_]+$`, and none is `all`.
- `fields` is the set of fields the resolved rules read. `needs` is the set of their `needs`.

### SG2.2 The compiler

`src/domain/segmentation/compile.js`:

```js
/**
 * @param {ResolvedSegmentation} seg
 * @param {Record<string, string>} columns field name -> SQL in the target query; every field the rules read must be mapped
 * @returns {{sql: string}} a multiIf over the mapped columns, the SQL twin of classify
 */
export function segmentationSql(seg, columns) { ... }

/** @returns {(row: Record<string, unknown>) => string} the JS twin, over rows keyed by field name */
export function segmentationClassifier(seg) { ... }

/** canonical(rules with lists resolved, fallback); the version input */
export function segmentationStamp(seg) { ... }
```

`segmentationSql` throws when a field the rules read has no entry in `columns`, naming the field and the segmentation. Literals go through `sqlString`, and column expressions come only from the caller's map, never from the declaration (N2).

### SG2.3 The shipped catalog

`src/catalog/segmentations/`, one file per segmentation:

`traffic_source.json`:

```json
{
  "id": "traffic_source",
  "label": "Traffic source",
  "purpose": "Where the visit came from, as the first trend delivery defined it. Frozen: a different meaning is a new segmentation.",
  "data": "meta when the UTM source is in meta_utm_sources_trend; otherwise the referrer type: 1 direct, 2 search, 3 website, 6 campaign, 7 social; anything else other.",
  "rules": [
    { "value": "meta", "when": { "field": "utm_source", "in": "@meta_utm_sources_trend" } },
    { "value": "direct", "when": { "field": "referer_type", "eq": 1 } },
    { "value": "search", "when": { "field": "referer_type", "eq": 2 } },
    { "value": "website", "when": { "field": "referer_type", "eq": 3 } },
    { "value": "campaign", "when": { "field": "referer_type", "eq": 6 } },
    { "value": "social", "when": { "field": "referer_type", "eq": 7 } }
  ],
  "fallback": "other"
}
```

`returning.json`: `returning eq 1` → `returning`, fallback `new`. `buyer.json`: `has_order eq 1` → `buyer`, fallback `non_buyer`. `rager.json`: `has_rage_click eq 1` → `rager`, fallback `non_rager`. `channel.json`: `{"base": "visit"}`. `link_channel.json`: `{"base": "link"}`. Each carries a `purpose` and `data` written for a coach, and `buyer` repeats the vision's warning that it describes buyers and is not a rate to optimize.

`src/catalog/segmentations.js` exports `loadSegmentationCatalog()`. It reads the directory, checks each file, and fails on a duplicate id or a file name that differs from its id, naming both. It follows the style of `src/catalog/index.js`.

### SG2.4 Prove the shipped declarations equal the old expressions

`test/domain/segmentation-compile.test.js`, on `clickhouse local`:

- A grid of `utm_source` (each Meta spelling, `klaviyo`, `''`, `null`) × `referer_type` (0 to 8, `null`). Compare `segmentationSql(traffic_source, {utm_source: 'utm_source', referer_type: 'referer_type'})` with today's `TRAFFIC_EXPR`, rewritten over the same columns, row by row. They must be equal.
- The same for `returning`, `buyer`, and `rager` against their inline `if(...)` expressions, including nulls and the `LEFT JOIN` zero that `r.idvisit = k.idvisit` reads.
- For every shipped declaration, SQL equals `segmentationClassifier` on a grid built from every field's edge values, nulls included (R10).

**Done when** the catalog loads, every check error has a test, and the old-expression comparisons pass.

---

## SG3. Port, computed adapters, and the registry

### SG3.1 The port

`src/ports/segmentation.js`, typedefs only:

```js
/**
 * @typedef {Object} Segmentation
 * @property {string} id                       stored in `segment`
 * @property {'declared' | 'computed'} kind
 * @property {string[]} values                 closed, ordered; never `all`
 * @property {string[]} needs                  shared CTEs the value reads: 'orders', 'checkout', 'ragers'
 * @property {(columns: Record<string, string>) => string} sql   the value expression in the grain's query
 * @property {((row: Record<string, unknown>) => string) | null} classify   the JS twin, or null
 * @property {string} stamp                    canonical definition, for the version
 * @property {(opts: object) => string} [ctes]    extra CTEs (computed only)
 * @property {(opts: object) => string} [joins]   extra joins onto `k` (computed only)
 * @property {(opts: object) => object} [params]  extra query parameters (computed only)
 * @property {{id: string, purpose: string, data: string}} descriptor
 */

/**
 * @typedef {Object} SegmentationAdapter        a module in src/adapters/segmentations
 * @property {string} id
 * @property {string[]} values
 * @property {string[]} needs
 * @property {(columns: Record<string, string>) => string} sql
 * @property {(opts: object) => string} ctes
 * @property {(opts: object) => string} joins
 * @property {(opts: object) => object} params
 * @property {(opts: object) => object} stampInputs   what, besides the code version, changes the meaning
 * @property {number} codeVersion             bumped by hand when the SQL changes meaning
 */
```

### SG3.2 `return-intent` as an adapter

`src/adapters/segmentations/return-intent.js` and its descriptor. It moves `historyCtes`, `RETURN_INTENT_EXPR`, and `RETURN_INTENT_VALUES` out of `tag-trend-sql.js`:

- `values`: today's six.
- `ctes(opts)`: today's `historyCtes()`.
- `joins()`: `LEFT JOIN prior AS p ON p.idvisit = k.idvisit`.
- `params(opts)`: `p0`, `lookback`, `minPages`, `minClicks`, `minScroll`, `minDurationMs`, computed as `tag-trend-run.js` computes them today.
- `stampInputs(opts)`: the lookback days and the four thresholds, because a change to any of them changes who is `prior_high_intent`.
- `sql()` returns `RETURN_INTENT_EXPR`. It reads `k.returning` directly and needs no column map.

`discoverAdapterRoles` mounts the role without a change to `src/discover.js`. The loader already requires `purpose` and `data`.

### SG3.3 The registry

`src/application/segmentation/registry.js`, pure (no file reads):

```js
/**
 * @param {{catalog: ResolvedSegmentation[], adapters: SegmentationAdapter[], sites: SiteSegmentationSpec[]}} input
 * @returns {{
 *   forSite(idsite: number): Map<string, Segmentation>,
 *   defaults(idsite: number, grain: 'trend' | 'tagTrend' | 'experiments'): string[],
 *   select(idsite: number, grain, ids?: string[]): Segmentation[],
 * }}
 */
export function createSegmentationRegistry(input) { ... }
```

- The shipped defaults: `trend` is `traffic_source, returning, buyer, rager`. `tagTrend` is those four plus `return_intent`. `experiments` is `traffic_source, returning`.
- `forSite` applies the site's overrides (SG4) to declared segmentations and adds the site's own declarations. A site cannot override a computed segmentation. Its parameters come from the run's options.
- A duplicate id across the catalog, the adapters, and a site's own declarations throws, naming each source.
- `select` throws on an unknown id, listing the ids the site has.

Composition (`src/composition/engine.js`) builds the registry once per command from `loadSegmentationCatalog()`, the discovered `segmentations` role, and `ctx.registries.segmentations()` (SG4), and passes it on the command context.

**Tests:** `test/segmentation-registry.test.js` covers the defaults, an override, a site declaration, a duplicate across catalog and adapter, an override of a computed segmentation (refused), and an unknown id.

**Done when** the registry builds in composition and the tag trend reads `return_intent` from the adapter, with the SG0.2 tag snapshot unchanged.

---

## SG4. Site files and selection

### SG4.1 The site file

`orchestration/sites/<slug>/segmentations.json`:

```json
{
  "idsite": 5795,
  "defaults": {
    "trend": ["traffic_source", "returning", "buyer", "rager", "channel"],
    "tagTrend": ["traffic_source", "returning", "buyer", "rager", "return_intent"]
  },
  "overrides": {
    "channel": {
      "prepend": [
        { "value": "google_paid", "when": { "all": [ { "field": "referer_type", "in": [2, 6] }, { "field": "utm_medium", "eq": "cpc" } ] } }
      ],
      "remove": ["affiliate"]
    }
  },
  "declarations": []
}
```

- `defaults` is optional per grain. A missing grain uses the shipped default.
- `overrides` keys must be declared segmentations, and each override must leave a declaration that passes `checkDeclaration`.
- `declarations` holds whole site-only segmentations, checked as catalog files are, whose ids must not collide with shipped ids.

### SG4.2 Loading

`loadSegmentationSpecs(root)` in `src/composition/registries.js`, beside `loadTrendSeeds`, reads every `sites/*/segmentations.json`. Two files naming one `idsite` is an error naming both slugs. `ctx.registries.segmentations` is wired where `ctx.registries.trendSeeds` is.

No idsite appears in `src/`. The architecture test `no-site-literals.test.js` stays green.

### SG4.3 The flag

`--segmentations a,b,c` on `--trend` and `--tag-trend` in `src/application/commands/enrichment.js`. The flag replaces the site's default for that run. An unknown id is a usage error listing the site's ids, raised before `ctx.ensure` or any query. The usage strings and `src/cli.js` header gain the flag.

**Tests:** `test/registries.test.js` loads a fixture `orchestration` tree with two sites. `test/engine-commands.test.js` covers an unknown id with no gateway calls, and a bad override, which fails before any query.

**Done when** a run's selection comes from the flag, the site file, or the shipped default, in that order, and is recorded in the run's notes.

---

## SG5. Fan-out SQL

All of this phase's changes are in `src/enrichment/`. The SG0.2 snapshots are the guard after every item.

### SG5.1 The session CTEs carry every field

`sessionCtes({ragers})` in `trend-sql.js`:

- `visits` gains `referer_name_lc` (`lower(trim(toString(argMin(referer_name, visit_first_action_time))))`), `utm_medium` (per D-14), `utm_campaign` (`trim(toString(argMin(custom_var_v4, visit_first_action_time)))`), and `country` (`trim(toString(argMin(location_country, visit_first_action_time)))`). `referer_name` stays raw, because the bot predicate reads it.
- If D-14 picks the session tag for medium, `utm_medium` is a `medium` CTE over `udp_session_tags` bounded by `idsite` and `server_date`, joined onto `kept`. It is included only when a selected segmentation reads `utm_medium`.
- The `ragers` CTE is included only when `ragers` is in the selection's needs. `orders` and `checkout` are always included, because the measures read them.

### SG5.2 The trend column map

`TREND_COLUMNS` in `trend-sql.js`:

```js
export const TREND_COLUMNS = Object.freeze({
  referer_type: 'k.referer_type',
  referer_name: 'k.referer_name_lc',
  utm_source: 'k.utm_source',
  source_or_referrer: "if(k.utm_source != '', k.utm_source, k.referer_name_lc)",
  utm_medium: 'k.utm_medium',
  utm_campaign: 'k.utm_campaign',
  returning: 'toUInt8(k.returning)',
  country: 'k.country',
  has_order: 'toUInt8(ifNull(o.orders, 0) > 0)',
  has_checkout: 'toUInt8(ck.idvisit = k.idvisit)',
  has_rage_click: 'toUInt8(r.idvisit = k.idvisit)',
});
```

A test checks that every key of `FIELDS` has an entry, so a new field cannot be registered without a trend column.

### SG5.3 The fan-out and the query plan

`src/enrichment/segmentation-sql.js`:

```js
/** arrayJoin of (segment, value) tuples; `withAll` adds ('all', 'all') */
export function fanoutSql(segmentations, columns, { withAll }) { ... }

/**
 * Packs segmentations into query groups whose value counts sum to at most
 * `budget`, in selection order. The first group carries the `all` tuple.
 * @returns {Array<{segmentations: Segmentation[], withAll: boolean}>}
 */
export function planGroups(segmentations, budget) { ... }
```

`planGroups` throws if one segmentation alone exceeds the budget. That cannot happen with the 16-value cap and a budget of 48, but the error keeps the rule explicit. The budget is `trend.segmentationBudget` in `analysis.config.json`, default from SG0.6.

### SG5.4 The aggregate queries

`pathAggregateSql(kind, group)`, `pageAggregateSql(group)`, and `selectorAggregateSql(group)` take a group from `planGroups`. Each runs the fan-out in a subquery, as `experimentFactSql` does, because `arrayJoin` reads ungrouped columns:

```sql
WITH ${sessionCtes({ragers})}, ${journeyPathsCte()} ${computedCtes}
SELECT week_start, viewport_value, segment, segment_value, path,
       uniqExact(idvisit) AS sessions,
       uniqExactIf(idvisit, v_orders > 0) AS buyers,
       sum(v_orders) AS orders,
       sum(v_revenue) AS revenue,
       uniqExactIf(idvisit, v_progressed) AS progressed
FROM (
    SELECT toString(k.week) AS week_start,
           ${VIEWPORT_EXPR} AS viewport_value,
           ${fanoutSql(group.segmentations, TREND_COLUMNS, group)} AS seg,
           tupleElement(seg, 1) AS segment,
           tupleElement(seg, 2) AS segment_value,
           s.${column} AS path,
           k.idvisit AS idvisit,
           ifNull(o.orders, 0) AS v_orders,
           ifNull(o.revenue, 0) AS v_revenue,
           ck.idvisit = k.idvisit AS v_progressed
    FROM kept AS k
    INNER JOIN paths AS s ON s.idvisit = k.idvisit
    LEFT JOIN orders AS o ON o.idvisit = k.idvisit
    LEFT JOIN checkout AS ck ON ck.idvisit = k.idvisit
    ${ragers ? 'LEFT JOIN ragers AS r ON r.idvisit = k.idvisit' : ''}
    ${computedJoins}
    WHERE ...the path match, unchanged...
)
GROUP BY week_start, viewport_value, segment, segment_value, path
```

The selector query keeps `sum(c.clicks) AS clicks` over the inner rows. The measures are the same functions on the same per-visit values, so each `(segment, value)` cell equals the sum of today's crossed cells for that value. `trend-run.js` runs each group as its own query, under the same label with a `:g<n>` suffix, and concatenates the cells.

### SG5.5 The tag-trend query

`tagTrendAggregateSql(group)` applies the same shape after the `CROSS JOIN selected_keys` and the tag join. `return_intent` contributes its CTEs, join, and parameters through the adapter. The `p0` and `lookback` parameters are added only when `return_intent` is in the group.

### SG5.6 Cells

`cellsOf` in `trend-run.js` and `tagCellsOf` in `tag-trend-aggregate.js` read `segment` and `segment_value` in place of the five named columns.

### SG5.7 Bounds

`test/trend-aggregate.test.js` "trend sql bounds" runs `queryBoundGaps` over a query compiled from every shipped segmentation in one group, and over one with `utm_medium` from the session tag. Both must return no gaps (N1).

**Done when** the SG0.2 snapshots match row for row with the default selection, after SG6.1 makes the rollup read the new cells. SG5 and SG6.1 land on one branch for that reason.

---

## SG6. Rollup and verification

### SG6.1 The rollup reads one pair per cell

In `trend-aggregate.js`:

- `expandTrendRows(spec)` takes `spec.segmentations: Array<{id, values}>` in place of `spec.strategies`. Each cell carries one `(segment, segmentValue)` pair. The loop adds the cell to the bucket for that pair under `all` and its device, and no longer expands one cell into every strategy.
- `emptyGrid(weeks, segmentations)` builds the grid from `[['all', 'all'], ...each segmentation's values]`, as today.
- `journeyRows`, `pageRows`, `selectorRows`, and `tagTrendRows` pass the selection through.

### SG6.2 Verification over every segmentation

- `verifyTrend(rows, expected)` takes `expected.segmentations`. `partitionErrors` checks, for the sampled path and URL path, that every segmentation's values sum to the `all` row's sessions, not only `traffic_source` (R11).
- `verifyTagTrend` loops the selection in place of `TAG_STRATEGIES`.
- A new test builds rows where one value of `channel` is dropped, and expects `verifyTrend` to name `channel`.

### SG6.3 Remove the old constants

Delete `TRAFFIC_EXPR`, `META_SOURCES` in `trend-sql.js`, `TRAFFIC_VALUES`, `RETURNING_VALUES`, `BUYER_VALUES`, `RAGER_VALUES`, `TREND_STRATEGIES`, `TAG_STRATEGIES`, and `FIRST_SEGMENTS`. The tests that import them read the catalog instead. `KEY_GUIDE` in `trend-row.js` is corrected to the keys `journeyRows` writes, as `docs/TREND-ENRICHMENT.md` notes it should be.

**Done when** the SG0.2 snapshots match, a run with `channel` selected writes `channel` rows that pass the partition check, and `rg TRAFFIC_EXPR src` finds nothing.

---

## SG7. Experiments and the bundle

### SG7.1 Experiments

`experimentFactSql({withViewed, segmentations})` in `src/experiments/sql.js` replaces its hardcoded tuple list `[tuple('all', 'all'), tuple('traffic_source', ...), tuple('returning', ...)]` with `fanoutSql(selection, EXPERIMENT_COLUMNS, {withAll: true})`. The multi-arm branch still emits only `('all', 'all')`. The experiment queries build their own visit CTEs (`visitCtes` in `src/experiments/sql.js`), so those gain the SG5.1 columns, and the `ragers` CTE when a selected segmentation needs it. `EXPERIMENT_COLUMNS` maps fields to the experiment query's aliases, which use `k`, `o`, and `ck` as the trend does. The experiment readout reads the selection from the registry's `experiments` default.

The SG0.3 snapshot must match.

### SG7.2 The bundle

`py/bundle-export.mjs` builds `ch` with `segmentationSql(registry.forSite(idsite).get('channel'), BUNDLE_COLUMNS)` and `link` with `link_channel`, where `BUNDLE_COLUMNS` maps to its aliases (`rt`, `rn`, `med`, `camp`, `src`). The site's override now applies to the bundle too, which is the point of R24. For sites without an override, the SG0.4 snapshot must match.

If D-14 changes the medium source away from `custom_var_v1`, the bundle's `med` changes with it in this item. Its snapshot is re-recorded as a reviewed change, naming D-14 in the commit message.

**Done when** both snapshots match, or the bundle snapshot changes only as D-14 requires.

---

## SG8. Definitions and versions

### SG8.1 The table

`src/persistence/schema2.sql`:

```sql
-- One version of one segmentation for one site. idsite 0 is the shipped
-- default. stamp is the canonical resolved definition; a different stamp is
-- a new version. values is the closed value list, in order. The latest
-- generated_at replaces a version row.
CREATE TABLE IF NOT EXISTS ${DATABASE}.ae_segmentation_definition
(
    idsite        UInt32,
    segmentation  LowCardinality(String),
    version       UInt32,
    kind          LowCardinality(String),
    stamp         String,
    definition    String,
    `values`      Array(String),
    generated_at  DateTime64(3)
)
ENGINE = ReplacingMergeTree(generated_at)
ORDER BY (idsite, segmentation, version);

CREATE OR REPLACE VIEW IF NOT EXISTS ${DATABASE}.ae_segmentation_definition_current AS
SELECT * FROM ${DATABASE}.ae_segmentation_definition FINAL;
```

`test/ddl-lint.test.js` moves from 61 tables and 59 views to 62 and 60. The table is reference data: it is not added to the gateway's `AE_FACT_TABLE_RE`, the same as `ae_trigger_definition`. `ensure('trend')` creates it.

### SG8.2 The store

`src/ports/persistence/segmentation-store.js`: `writeSegmentationDefinitions(rows)` and `readSegmentationDefinitions(idsite)`. The read returns the site's rows and the `idsite = 0` rows, latest version per segmentation, with a site row winning. Both adapters, memory and ClickHouse, and a shared contract test in `test/ae-persistence-contract.test.js`.

### SG8.3 Version resolution

`resolveSegmentationVersions(selection, recorded)` in `src/domain/segmentation/versions.js`, following `resolveDefinitions`:

- the stamp is `segmentationStamp(seg)` for a declared segmentation, and `canonical({id, codeVersion, ...stampInputs(opts)})` for a computed one;
- an equal stamp keeps the recorded version;
- a different stamp gives the recorded version plus one, or 1 when nothing is recorded;
- the result lists `{id, version, stamp, changed}`.

### SG8.4 Rows carry the version

The trend, tag-trend, and experiment runs resolve versions before their first query, write any changed definitions after the rows are written, and add `metrics.segmentation_version` to every row whose `segment` is not `all`. The run result gains `segmentations: [{id, version, changed}]`.

This is the one deliberate change to the parity snapshots. They are re-recorded in this commit, and the diff must be only the added key. A test asserts that by removing the key from every row and comparing with the SG0.2 snapshot.

**Done when** a first run records version 1 for each selected segmentation, a rerun records nothing new, and a run after an override edit records version 2 and reports `changed`.

---

## SG9. Backfill on a version change

This phase waits for Part T: T2's `readTrendWeeks` and T3's per-subject start weeks.

### SG9.1 Plan the backfill

When `resolveSegmentationVersions` reports `changed` for a segmentation, the run plans a backfill for it:

- weeks: from the earliest stored week of that segmentation for the site through the run's last week. `readTrendWeekRange(idsite, segment)` is added to the trend store beside T2's `readTrendWeeks`, on both adapters, in the contract test;
- subjects: every subject stored for the site (the frozen path, URL path, page, and selector lists), not only this run's;
- query groups: the changed segmentations only, without the `all` tuple, because `all` did not change.

A backfill longer than `trend.maxBackfillWeeks` (default 26) stops with a usage error naming the weeks, unless `--backfill-all` is passed. This keeps an accidental override edit from rescanning a year without warning.

### SG9.2 Retired values

Before writing, the run reads the distinct stored `segment_value`s for the segmentation and site. A stored value missing from the new value list gets a zero row for every stored subject, week, and viewport, with `metrics.retired = true` and the new version. The partition still holds, and nothing is deleted.

### SG9.3 The same for the tag trend and experiments

`ae_session_tag_trend` follows the same rule. `ae_experiment_row` is backfilled only for experiments whose stored days overlap the change, because experiment rows are keyed by day.

**Tests:** on the memory adapter, a six-week store, an override edit, and a run that rewrites all six weeks for `channel` only. A removed value gets zero rows marked retired. `traffic_source` rows are untouched. A 30-week backfill without `--backfill-all` is refused.

**Done when** those tests pass and the run notes name the segmentation, the old and new versions, the weeks rewritten, and the retired values.

---

## SG10. The trigger read path

### SG10.1 Sessions carry raw fields

`assembleSessions` in `src/triggers/facts.js` keeps the named dimensions it has today and adds `fields: {referer_type, referer_name, utm_source, source_or_referrer, utm_medium, utm_campaign, returning, country, has_order}`, filled from the same query rows. The day record (`src/scan/day-record.js`) gains whatever columns are missing, with a characterization test on the old trigger output first, since the trigger lane folds from it.

### SG10.2 Segment by a declared segmentation

`queryTriggerTrends` accepts `segment_by` entries `segmentation:<id>`. It classifies each hit's session with `segmentationClassifier` over `session.fields`, and groups by the value. The input gains `segmentations`, the site's registry map. A computed segmentation is refused with a message saying it has no JS twin. An unknown id is refused, listing the ids.

**Tests:** `test/triggers.test.js` segments chains by `channel` and by a site override, and checks that the counts per value sum to the unsegmented row.

**Done when** the trigger trends and the trend rows agree on `channel` for the same sessions in a fixture.

---

## SG11. The check, the skill, and the docs

### SG11.1 `--segmentation-check`

`src/application/commands/segmentation-check.js`:

```text
node src/cli.js --segmentation-check --sites <idsite> --week YYYY-MM-DD
    (--segmentation <id> | --segmentation-file <path>)
```

- `--segmentation-file` accepts either one declaration or a whole site file. A site file is checked as SG4 checks it, and every declared segmentation it touches is checked.
- It runs one query per segmentation over `kept` for that Monday's week, labelled `trend:segmentation-check`, with the fan-out of that one segmentation plus `all`.
- It prints, per value: sessions, orders, revenue, share of sessions. Then the partition sum against the total, and the version the definition would get against the stored one.
- Exit 0 when it passes. Exit 1 on a validation error, a partition mismatch, or one value holding more than 98% of sessions. Exit 2 on a usage error.
- It writes nothing.

### SG11.2 The skill

`skills/segmentation-authoring/SKILL.md`, added to `.cursorrules`:

1. Restate the question as a partition: what each value means, and that every session must sit in one.
2. Prefer an override of a shipped segmentation. A new id needs a purpose no shipped one covers.
3. Use only registered fields. If the question needs a field that is not registered, stop: that is an engine change for a person.
4. Write the declaration or override in the site file.
5. Run `--segmentation-check` on the last complete week. Read the shares. A value at zero or one at 98% means a rule is wrong or the merchant tags differently; ask, do not guess.
6. Commit the site file. The next routine run versions it and backfills.

### SG11.3 The docs

- `docs/TREND-ENRICHMENT.md`: the segment table points at the catalog, the "Not done" line about strategies is removed, and the new flags are documented.
- `docs/VISION.md`: the "Segments read from the channel rules" status row moves to built.
- `docs/ARCHITECTURE.md`: the adapter roles list gains `segmentations`, and §13 notes the registry.
- `docs/plans/scale-and-profiles-initiative.md`: Part P's profile descriptor gains an optional `segmentations` field naming ids from the registry.

**Done when** the check passes on the fixture for each shipped segmentation, fails on a broken override with exit 1, and the skill's steps run end to end on the fixture site.

---

## SG12. Live acceptance (read-only, run by the user)

`scripts/segmentation-acceptance.mjs`, on the live gateway with memory persistence:

1. **DVF parity.** Run the trend for DVF over the proof window with the default selection. Read the stored `ae_trend_row_current` rows for the same window, written by the old code. Report row counts, and the rows whose sessions, buyers, orders, clicks, or progressed differ, or whose revenue differs by more than one cent. Late-arriving rows can make a few cells differ. The report separates cells that also differ in a fresh `segment = 'all'` query from ones that differ only in a segmentation. Only the second kind is a fault.
2. **Cost.** Time the default selection, then the default plus `channel` and `return_intent`, three runs each. Compare with N4.
3. **A real override.** Run `--segmentation-check` with a Google-paid override for DVF on the last complete week, and print the shares.

Mellow and Loaded Tea wait for the massive-site phase, with the rest of Part D's large-site runs.

**As run** (14 October 2026, DVF 5795, on `scale/11-completion` after the merge). The script's stored-row query aliased `toString(week)` as `week`, which shadows the column in its own `WHERE`; it now reads it as `week_text`.

- Parity against stored rows: 6,384 rows over the weeks of 2026-09-14 to 2026-09-28, 747 late-data cells, 14 faults. The 2,128 stored rows the run leaves out are all in the week of 2026-10-05, after the run's last whole Sunday. Each fault is one session moving between two values of one segmentation, with its `all` cell equal. The stored rows predate the week-keyed sessions (Part T), which take a visit's fields from each week's own rows.
- Parity against the code before the registry: the trend at `38f3329` (week-keyed, before segmentation) and after the merge, each seeded with the same stored rows and selectors, write the same 6,384 rows with no cell differing. The `38f3329` rows show all 14 faults against the stored rows too, so they come from Part T.
- Cost, three runs each, query seconds: `38f3329` median 3.4 s; the default selection 2.1 s (0.62 times); the default plus `channel` and `return_intent` 3.6 s (1.06 times; 12,312 rows). N4 is met.
- Override: the Google-paid `channel` override on the week of 2026-10-05 partitions all 59,987 sessions; `google_paid` holds 1,183 sessions (2.0%), 10 orders, and $4,379.52.

## Status

Built on `initiative/segmentation`, branched from `initiative/scale-and-profiles` at `scale/6-acceptance` (fcb531b). Each phase merged with `--no-ff`.

| Phase | State | Merge |
|---|---|---|
| SG0 | built | be88f5e |
| SG1 | built | 7de1b3c |
| SG2 | built | f181050 |
| SG3 | built | 80a70e4 |
| SG4 | built | f7ab569 |
| SG5 | built, with SG6 | 1cb2611 |
| SG6 | built, with SG5 | 1cb2611 |
| SG7 | built | bfb0bdc |
| SG8 | built; `ae_segmentation_definition` and its view exist on `journey_events` (created by `ensure` on 14 October 2026) | f97396a |
| SG9 | built | 05fee08 |
| SG10 | built | 1193c1c |
| SG11 | built | 421d659 |
| SG12 | ran on DVF: rows equal the code before the registry, N4 met, the Google-paid override partitions every session (see SG12, As run) | 421d659 |

### As built

Where the build departs from this plan:

- SG0.4. The bundle's channel parity rests on the bundle SQL text snapshot, which SG7 keeps byte-identical, rather than a separate `clickhouse local` snapshot of `(idvisit, ch, link)`.
- SG0.6. The fan-out probe was rewritten after SG5 to time the shipped `pathAggregateSql` against the default and wide selections; the pre-SG5 numbers stay in `docs/probes/2026-10-segmentation-fanout.md`.
- SG5 to SG7. SG6's rollup and verification and SG7.1's experiment read landed in the same branch as SG5, since the fan-out changed the row shape all three read.
- Query labels gain `:g<n>` only when a run splits its segmentations into more than one group, so a run within the budget keeps the old labels.
- SG4. No DVF site file was added. The shipped defaults are unchanged, and a Google-paid override is checked by SG12 before it is committed.
- SG8. `resolveSegmentationVersions` takes each segmentation's stamp and returns `isNew` (record a definition row) and `changed` (a recorded version exists and its stamp differs) separately. Only `changed` starts a backfill, so the first run after this lands records version 1 everywhere and rewrites nothing.
- SG8. The shipped definitions are read as site `SHIPPED_SITE` (0), a constant and a query parameter, so no source file carries a site literal. The schema counts move from 63 tables and 61 views to 64 and 62.
- SG8. Run results name where the selection came from in `segmentationSource` (`run`, `site`, or `shipped`), and list each segmentation's version in `segmentations`.
- SG9. `readTrendWeekRange` and `readTagTrendWeekRange` return each stored subject's first and last week (page rows include the URL in their identity) and the distinct stored values, not one range per segmentation. Each subject's backfill ends the day before this run reads that subject, so the two passes never write the same week.
- SG9. Experiments get no backfill. Each readout rewrites every day of each analyzed experiment, so a changed definition reaches the experiment rows on the next readout. A retired value's experiment rows keep their old version.
- SG9. The backfill limit is `trend.maxBackfillWeeks` (default 26, env `ANALYSIS_MAX_BACKFILL_WEEKS`), and the refusal happens before any query.
- SG10. The visit loads for the trigger lane, the day records, and the open visits gain `referer_name`, `utm_medium`, and `utm_campaign`. `DAY_RECORD_VERSION` moves to 2, so every stored day record is read live once after this lands. A trigger `segment_by: segmentation:<id>` is refused for a computed segmentation and for one that reads a field outside `TRIGGER_FIELDS` (`has_checkout`, `has_rage_click`).
- SG11. `--segmentation-check` accepts either a whole site file or one declaration. It also fails a week with no kept sessions, and prints the version as unknown when the stored definitions cannot be read; it never creates the table. `segmentedSelect` accepts an empty key list for the check's one-cell query.

### Integration with scale-and-profiles

Points to reconcile when the rest of `initiative/scale-and-profiles` lands:

- Day records. `DAY_RECORD_VERSION` 2 and the three new visit columns in `src/scan/day-record.js`, `open-visits.js`, and `views.js`. Any later change to the day record must start from version 2.
- Config. `trend.segmentationBudget` and `trend.maxBackfillWeeks` sit in the `trend` section of `src/config.js`.
- Schema. `ae_segmentation_definition` and its view bring the counts in `ddl-lint`, the persistence contract, and `rebuild-schema` to 64 tables and 62 views. A new table on either side moves both counts.
- Profiles. Part P's profile descriptor gains an optional `segmentations` field, not yet built.
