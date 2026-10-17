# Plan: the export stage handler

**Written:** 16 October 2026
**Builds on:** `skills/analyst-data-bundle/SKILL.md`, `skills/analyst-data-bundle-4mb/SKILL.md`, and the command-handler pattern in `orchestration/stages/analysis.stage.json`

`full.run.json` runs `bundle`, then `bundle-4mb`, after analysis and before chart-render. Both stage files name `handler.use` and `check.use` as `pending`. A pending handler returns "this stage has no handler yet", and the stage's error rule classifies that as blocked, "this stage lands in a later phase". FrankAndEileen is in that state now: analysis finished, the bundle message is a dead letter, and the job will not move until the check is real and the job is retried.

This plan replaces those two descriptors. It does not add a handler type. The export work already exists as three programs; the stage's job is to call them, to fill the one input they refuse to invent, and to judge the folder they write.

## What is already built

| Step | Program | What it does |
| --- | --- | --- |
| Extract | `node py/bundle-export.mjs --site <site.json> --window-start <day> --window-end <day> --out <dir>` | Warehouse reads. Writes `meta.json`, `orders.json`, `visits.jsonl`, `page_period.json`, `hv_page_reach.json`, `pipeline.jsonl`, `trigger_chains.json`, `dwell.json`, `rage_totals.json`. Prints `<slug> visits done` when the visit shards finish. |
| Build | `python3 py/bundle-build.py <extract> <bundle>` | Turns the extract into the analyst folder. Writes `00_site_profile.json` with an `anchors` array, `01_orders.csv`, and `.anchors.json`. |
| Trim | `python3 py/bundle-trim.py <bundle> <bundle>-4mb` | Copies the bundle, drops column `d` from orders, and rolls orders up if the folder is still over 4.2 MB. Rewrites the trimmed profile's anchors to the new grain. Does not copy `.anchors.json`. |

`exportSpec` in `py/bundle-export.mjs` throws before any query when `site.focus` lacks `path` or an integer `idsitehsr`. Loop Earplugs and Ceremonia have that object. Frank & Eileen, Peter Thomas Roth, and Dennys do not: their `site.json` files stop at currency. That is the gap the handler has to close. The id comes from the analysis batch's primary page target. It is not invented and it is not typed in by hand.

Chart-render already reads `{{paths.analysis}}/{{site.slug}}`, which `loadConfig` expands from `analysisRoot` (`~/work/analysis`). The full bundle must be written at that path. The trimmed bundle is the sibling directory with `-4mb` appended. Later report stages keep those paths.

## The design

Two stages, one check module, two command scripts. No new adapter kind.

```
bundle stage
  command → bin/export-bundle.mjs
              1. resolve focus, write it into site.json when it is missing
              2. node py/bundle-export.mjs
              3. python3 py/bundle-build.py
              4. exit 1 when the anchors do not hold
  check   → bundle-anchors on ~/work/analysis/<slug>

bundle-4mb stage
  command → bin/export-bundle-4mb.mjs
              1. refuse to run unless the full bundle's anchors already hold
              2. python3 py/bundle-trim.py
              3. exit 1 when the trimmed anchors do not hold
  check   → bundle-anchors on ~/work/analysis/<slug>-4mb
```

The command handler in `src/orchestrator/adapters/handlers/command.js` is the one analysis already uses. It renders every arg, merges `spec.env` on top of the worker environment (so `CLICKHOUSE_*` is inherited and never written into the stage file), writes stdout and stderr to `<runDir>/primary.log`, and returns ok only on exit 0.

`execute-stage.js` runs the check before the handler. A bundle whose profile window, analysed page, and anchors already match is skipped. A handler that exits 0 with a failing check is still a failure: "handler exited cleanly but the check failed". The check is the judge. The script repeats the same comparison so the log shows the mismatch before the check does.

`files-exist` is the wrong check. A present `01_orders.csv` can hold the wrong revenue. The check evaluates the anchors the builder wrote.

Only `bundle` takes `clickhouse-heavy`. Visit extract is the warehouse work; trim is local. Capacity stays 1. This plan does not raise it.

## Files

| Path | Change |
| --- | --- |
| `orchestration/stages/bundle.stage.json` | Replace the pending descriptor. |
| `orchestration/stages/bundle-4mb.stage.json` | Replace the pending descriptor. |
| `bin/export-bundle.mjs` | Focus, extract, build, anchor exit code. |
| `bin/export-bundle-4mb.mjs` | Trim and anchor exit code. |
| `src/orchestrator/domain/bundle-focus.js` | Pure focus resolution. |
| `src/orchestrator/domain/bundle-anchors.js` | Pure anchor evaluation. |
| `src/orchestrator/adapters/checks/bundle-anchors.js` | Check plugin. `adapter.id` is `bundle-anchors`, matching the filename `loadPlugin` imports. |
| `test/bundle-focus.test.js` | Path, label, and the refusal to overwrite. |
| `test/bundle-anchors.test.js` | Both grains, both tolerances, the window guard. |

Nothing in `py/bundle-export.mjs`, `py/bundle-build.py`, or `py/bundle-trim.py` changes. The handler speaks their existing argv.

## Focus

### Where the page comes from

Analysis writes `process/runs/<jobId>/analysis/attempt-<n>/batch.json`:

```json
{ "batchId": "<uuid>", "profile": "lp", "idsite": 6277, "windowDays": 30 }
```

`page-primary` stores the qualifier's page in `ae_page_target` with `role: "primary"`. `ae_page_target_current` is the `FINAL` view. The handler reads the newest attempt directory that contains `batch.json`, then the primary row for that batch and idsite.

An existing `site.focus` with both `path` and an integer `idsitehsr` is kept. The handler does not query and does not rewrite it. Loop and Ceremonia take this path.

### Pure resolution

`src/orchestrator/domain/bundle-focus.js`:

```js
/**
 * @param {string} url absolute page URL from ae_page_target.url
 * @returns {string} site.json focus path. The site root is "/".
 */
export function focusPath(url) {
  const pathname = new URL(url).pathname || '/';
  if (pathname.length > 1 && pathname.endsWith('/')) return pathname.slice(0, -1);
  return pathname;
}

/**
 * @param {{path?: string, idsitehsr?: number, label?: string}|undefined} existing
 * @param {{idsitehsr: number, url: string, pageTitle?: string}|null} page
 * @returns {{path: string, label: string, idsitehsr: number}}
 */
export function resolveFocus(existing, page) {
  if (existing?.path && Number.isInteger(existing.idsitehsr)) {
    return {
      path: existing.path,
      label: existing.label || existing.path,
      idsitehsr: existing.idsitehsr,
    };
  }
  if (!page || !Number.isInteger(page.idsitehsr) || !page.url) {
    throw new Error('site.json has no focus and the analysis batch has no primary page');
  }
  const path = focusPath(page.url);
  return { path, label: page.pageTitle?.trim() || path, idsitehsr: page.idsitehsr };
}
```

`exportSpec` requires an integer `idsitehsr`. Coerce the warehouse value with `Number` and reject it unless `Number.isInteger` holds. A string that happens to look numeric is a defect, not a focus.

### The read

In `bin/export-bundle.mjs`, after loading `site.json`:

```js
async function pageForBatch(client, database, batchId, idsite) {
  const result = await client.query({
    query: `
      SELECT idsitehsr, url, page_title AS pageTitle, role
      FROM ${database}.ae_page_target_current
      WHERE batch_id = {batchId:UUID}
        AND idsite = {idsite:UInt32}
        AND status = 'selected'
        AND role = 'primary'
      LIMIT 1
    `,
    query_params: { batchId, idsite },
    format: 'JSONEachRow',
  });
  const rows = await result.json();
  return rows[0] ?? null;
}
```

Newest batch file:

```js
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

export async function latestBatchFile(runsRoot, jobId) {
  const dir = path.join(runsRoot, jobId, 'analysis');
  const attempts = await readdir(dir).catch(() => []);
  const found = [];
  for (const name of attempts) {
    const file = path.join(dir, name, 'batch.json');
    const info = await stat(file).catch(() => null);
    if (info) found.push({ file, mtimeMs: info.mtimeMs });
  }
  found.sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (!found.length) throw new Error(`site.json has no focus and ${dir} has no analysis batch`);
  return JSON.parse(await readFile(found[0].file, 'utf8'));
}
```

The batch's `idsite` must equal `site.idsite`. A mismatch throws `analysis batch <id> is for idsite <n>, site.json says <m>` and is a defect.

### Writing site.json

Only when the file had no usable focus. Parse, set `focus`, write the whole object with two-space indent and a trailing newline. Leave every other key as it was. The handler does not commit the file. The change is an ordinary working-tree edit for the operator to review after the run.

```js
export function withFocus(site, focus) {
  return { ...site, focus: { path: focus.path, label: focus.label, idsitehsr: focus.idsitehsr } };
}
```

The message `site.json has no focus and the analysis batch has no primary page` is the blocked error. Do not fall through into `bundle-export.mjs` without a focus: that program throws the same condition later, after more setup, and the stage rule would not match its wording.

## Anchor evaluation

`src/orchestrator/domain/bundle-anchors.js` is pure. It takes the parsed `00_site_profile.json` and the text of `01_orders.csv`. The check and both scripts call it. Tests call it with fixtures and never open a warehouse connection.

### What the builder writes

`py/bundle-build.py` writes five anchors into `00_site_profile.json`:

```js
[
  { label: 'orders in report window', where: "d >= 'W0' and d <= 'W1'", agg: 'count', expect: N },
  { label: 'revenue in report window', where: "d >= 'W0' and d <= 'W1'", agg: 'sum', column: 'order_revenue', expect: R, tolerance: 1 },
  { label: 'median order revenue in report window', where: "d >= 'W0' and d <= 'W1'", agg: 'median', column: 'order_revenue', expect: M, tolerance: 0.01 },
  { label: 'high-value orders in report window', where: "d >= 'W0' and d <= 'W1' and order_revenue >= HV", agg: 'count', expect: H },
  { label: 'high-value revenue in report window', where: "d >= 'W0' and d <= 'W1' and order_revenue >= HV", agg: 'sum', column: 'order_revenue', expect: HR, tolerance: 1 },
]
```

Counts are exact (`tolerance` absent means 0). Revenue may differ by at most 1. The median may differ by at most 0.01. An empty window stores `expect: null` for the median; the check passes that anchor only when the filtered row set is empty.

`01_orders.csv` columns on the full bundle include `oid`, `d`, `t_utc`, `order_revenue`. There is no `hv` column. High value is the predicate in the anchor's `where`.

Trim does two different things to that file:

1. Always, it drops column `d`. The day is the first 10 characters of `t_utc`. Anchors are still the original five, and they still say `d`.
2. When the folder is still over 4.2 MB, `fold_orders` rewrites `01_orders.csv` to `d, item_title, marked_down, order_device, high_value, orders, order_revenue, qty`, sets `orders_grain`, drops the median anchor, and rewrites each remaining anchor: `count` becomes `sum` of column `orders`, sums point at `order_revenue`, and a high-value where becomes `high_value == 1`. The `expect` numbers stay the original ones.

The evaluator follows the anchors in the profile it was given. It does not recompute high value from the full bundle, and it does not assume a grain. That is what lets one function judge both folders.

### Predicates

Parse `where` by splitting on ` and `. Accept only these atoms, and fail the anchor when one does not match:

```
d >= 'YYYY-MM-DD'
d <= 'YYYY-MM-DD'
order_revenue >= <number>
high_value == 1
```

```js
const ATOM = /^(d|order_revenue|high_value)\s*(>=|<=|==)\s*(?:'([^']*)'|([0-9.]+))$/;

export function parseWhere(where) {
  return where.split(' and ').map((part) => {
    const match = ATOM.exec(part.trim());
    if (!match) throw new Error(`anchor where is not one the check evaluates: ${part.trim()}`);
    return { column: match[1], op: match[2], value: match[3] ?? Number(match[4]) };
  });
}
```

A row matches when every atom matches. Column lookup:

```js
function cell(row, header, column) {
  if (column === 'd' && !header.includes('d')) return String(row.t_utc ?? '').slice(0, 10);
  return row[column];
}
```

`>=` and `<=` on `d` are string comparisons of `YYYY-MM-DD`, which is the comparison the builder uses. `>=` on `order_revenue` is numeric. `==` on `high_value` is string equality with `'1'`, because the rolled CSV writes the character `1`.

No `eval`. An anchor whose `where` the parser rejects fails that anchor with the message above and fails the check.

### Aggregation

```js
function aggregate(rows, anchor) {
  if (anchor.agg === 'count') return rows.length;
  const values = rows.map((row) => Number(row[anchor.column])).filter((n) => Number.isFinite(n));
  if (anchor.agg === 'sum') return round2(values.reduce((s, n) => s + n, 0));
  if (anchor.agg === 'median') {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    return round2(median);
  }
  throw new Error(`anchor agg is not one the check evaluates: ${anchor.agg}`);
}

const round2 = (n) => Math.round(n * 100) / 100;
```

Pandas' median averages the two central values on an even count. `round2` matches the builder's `round(..., 2)`. Compare with `Math.abs(got - expect) <= (anchor.tolerance ?? 0)`. A null expect passes only when `got === null`.

### The result the check returns

```js
/**
 * @returns {{ok: boolean, summary: string, details: {name: string, ok: boolean, message: string}[]}}
 */
export function evaluateAnchors(profile, csvText, expectedWindow) {
  const details = [];
  const window = profile?.report_window;
  const windowOk = window?.start === expectedWindow.start && window?.end === expectedWindow.end;
  details.push({
    name: 'report_window',
    ok: windowOk,
    message: windowOk ? `${window.start} to ${window.end}` : `profile window ${window?.start} to ${window?.end}`,
  });
  if (!windowOk) {
    return { ok: false, summary: 'anchor mismatch: report window', details };
  }
  const rows = parseCsv(csvText);
  for (const anchor of profile.anchors ?? []) {
    let got;
    let ok = true;
    let message = '';
    try {
      const matched = rows.filter((row) => parseWhere(anchor.where).every((atom) => holds(row, rows.header, atom)));
      got = aggregate(matched, anchor);
      ok = got === anchor.expect || (typeof got === 'number' && typeof anchor.expect === 'number'
        && Math.abs(got - anchor.expect) <= (anchor.tolerance ?? 0));
      message = ok ? String(got) : `got ${got}, expected ${anchor.expect}`;
    } catch (err) {
      ok = false;
      message = err.message;
    }
    details.push({ name: anchor.label, ok, message });
  }
  const bad = details.filter((row) => !row.ok);
  return {
    ok: bad.length === 0,
    summary: bad.length === 0 ? `${details.length - 1} anchor(s) hold` : `anchor mismatch: ${bad.map((row) => row.name).join(', ')}`,
    details,
  };
}
```

`parseCsv` is a small RFC-style reader for this file: pandas writes a header and one record per line, fields may be quoted, and a quoted field may contain a comma. Do not split on commas. A header that lacks `order_revenue` fails the check with `01_orders.csv has no order_revenue column`.

The summary always contains `anchor mismatch` when it fails, so the stage error rule can match a check failure as well as a script failure.

## The check plugin

`src/orchestrator/adapters/checks/bundle-anchors.js` exports `adapter` (no ports, so no `createAdapter`):

```js
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { evaluateAnchors } from '../../domain/bundle-anchors.js';

export const adapter = {
  id: 'bundle-anchors',
  describe(ctx, spec) {
    return `anchors in ${ctx.render(spec.bundle)} hold for ${ctx.values.window.start} to ${ctx.values.window.end}`;
  },
  validate(spec) {
    return spec.bundle ? [] : ['bundle-anchors needs bundle'];
  },
  async evaluate(ctx, spec) {
    const dir = ctx.render(spec.bundle);
    const window = ctx.values.window;
    let profileText;
    let csvText;
    try {
      profileText = await readFile(path.join(dir, '00_site_profile.json'), 'utf8');
      csvText = await readFile(path.join(dir, '01_orders.csv'), 'utf8');
    } catch (err) {
      return { ok: false, summary: `missing bundle files in ${dir}`, details: [{ name: dir, ok: false, message: err.code ?? 'missing' }] };
    }
    const profile = JSON.parse(profileText);
    const result = evaluateAnchors(profile, csvText, window);
    if (spec.page === 'focus') {
      const focus = ctx.job.site.focus;
      const page = profile.analysed_page;
      const same = Boolean(focus?.path) && page?.path === focus.path && Number(page?.idsitehsr) === focus.idsitehsr;
      result.details.push({
        name: 'analysed_page',
        ok: same,
        message: same ? page.path : `profile page ${page?.path} (${page?.idsitehsr})`,
      });
      if (!same) {
        result.ok = false;
        result.summary = 'anchor mismatch: analysed page';
      }
    }
    return result;
  },
};
```

`spec.page === 'focus'` is set on the full bundle only. The job's site object gains `focus` during the handler, but the pre-check reads the site as the job stored it at enqueue. A site enqueued without focus therefore fails the pre-check (`analysed_page` against an empty focus, or missing files), the handler runs, and the post-check sees the focus the handler just wrote onto `ctx.job.site` as well as onto disk. The handler must set `ctx.job.site.focus` in memory before it exits, not only the file. The stage command cannot touch `ctx.job`. So the page comparison belongs in the script's own exit check against the file it just wrote, and the stage check compares the profile with the focus file on disk:

```js
const site = JSON.parse(await readFile(ctx.render(spec.site), 'utf8'));
const focus = site.focus;
```

`spec.site` is `orchestration/sites/{{site.slug}}/site.json`. The check reads that file inside `evaluate` when `spec.page === 'focus'`. It does not trust `ctx.job.site.focus`, which can be stale for the whole attempt. After the handler writes the file, the post-check reads the new bytes.

A missing focus file entry fails `analysed_page` and the handler runs. That is the skip rule: a finished bundle for this window and this focus is left alone; anything else is rebuilt.

## `bin/export-bundle.mjs`

Same shape as `bin/analyze-site.mjs`: an exported function that takes argv and an io object, and a `main` guard so tests can call it without spawning.

```
node bin/export-bundle.mjs \
  --site orchestration/sites/<slug>/site.json \
  --window-start YYYY-MM-DD \
  --window-end YYYY-MM-DD \
  --extract ~/work/analysis/.extract/<slug>/<start>_<end> \
  --out ~/work/analysis/<slug> \
  --job <jobId> \
  --runs process/runs \
  --attempt <n>
```

Exit 2 is usage (`export-bundle: --site is required` and the same for the other flags). Exit 1 is a failed extract, build, or anchor. Exit 0 is anchors holding.

Steps, in order:

1. Parse flags. Reject a window that is not two `YYYY-MM-DD` dates with start first. This duplicates `exportSpec`'s check so a bad template fails here with the usage wording.
2. Read site.json. Require `slug`, `idsite` (positive integer), `domain`, `currency`, and `platform` in lower case. A missing one exits 1 with `site.json has no <field>`. `platform` that is not already lower case exits 1 with `site.json platform must be lower case`. Do not rewrite it.
3. Resolve focus as above. Write site.json when it changed.
4. Resume. Read `<extract>/meta.json` when `--attempt` is greater than 1. Set `BUNDLE_RESUME=1` for the child only when that meta names the same slug, the same window, and the same idsite. Otherwise leave the variable unset and delete nothing: a different window uses a different extract directory because the directory name contains the window. Never set `BUNDLE_VISIT_SHARDS`. The default is 8. A memory failure is a blocked stage, not a reason to shrink the shards.
5. Spawn `node py/bundle-export.mjs` with the four args, `cwd` the repo, env the current process env plus `BUNDLE_RESUME` when step 4 said so. Stream its output to this process's stdout so the command handler's `primary.log` keeps it. Wait for exit 0. If the combined output does not contain `<slug> visits done`, exit 1 with `extract finished without "<slug> visits done"`.
6. Spawn `python3 py/bundle-build.py <extract> <out>`. The python binary is the `--python` flag, which the stage sets from `{{config.report.python}}`.
7. Read `<out>/00_site_profile.json` and `<out>/01_orders.csv`, call `evaluateAnchors` with the job window, and also require `analysed_page` to equal the focus just resolved. On failure print `anchor mismatch: ...` and exit 1.
8. Print `bundle <slug> anchors hold` and exit 0.

Spawn through `node:child_process` `spawn` with `stdio: 'inherit'` when run as main. On a non-zero child status, exit with that status if it is a number, otherwise 1. Do not swallow stderr.

The extract directory is `{{paths.analysis}}/.extract/{{site.slug}}/{{window.start}}_{{window.end}}`. It sits beside the analyst folders, not inside them. `bundle-build.py` takes the extract as its source and writes only to `--out`. A later chart stage lists the analyst folder; the extract must not be in it.

Attempt 1 of a fresh window starts a new extract directory. Attempt 2 reuses it and may resume. `BUNDLE_RESUME` only skips work when `orders.json` is already there (`bundle-export.mjs` checks that itself). A resume after a failed visit shard continues the visit file. A resume whose meta window does not match must not happen, because the directory is per window; the meta check is the guard against a hand-copied directory.

## `bin/export-bundle-4mb.mjs`

```
node bin/export-bundle-4mb.mjs \
  --src ~/work/analysis/<slug> \
  --out ~/work/analysis/<slug>-4mb \
  --window-start YYYY-MM-DD \
  --window-end YYYY-MM-DD \
  --python python3
```

1. Usage failures exit 2 with the `export-bundle-4mb:` prefix.
2. Run `evaluateAnchors` on `--src` first. If the full bundle does not hold, exit 1 with `full bundle anchors do not hold; not trimming`. Trim never queries ClickHouse and never repairs a bad full bundle.
3. Spawn `python3 py/bundle-trim.py <src> <out>`. Trim creates `<out>` itself.
4. Run `evaluateAnchors` on `--out`. The trimmed profile's anchors are whatever trim left there: five anchors with `d` mapped to `t_utc`, or the rolled anchors with `orders` and `high_value`. The same function covers both. Exit 1 on `anchor mismatch`.
5. Print `bundle-4mb <slug> anchors hold`.

There is no focus write and no resume flag. Trim is deterministic over the full folder. A retry deletes nothing; it runs trim again over the same source.

## Stage descriptors

`orchestration/stages/bundle.stage.json`:

```json
{
  "id": "bundle",
  "label": "Full analyst bundle",
  "phase": "export",
  "skill": "skills/analyst-data-bundle/SKILL.md",
  "concurrency": 1,
  "resources": ["clickhouse-heavy"],
  "leaseMs": 120000,
  "timeoutMs": 14400000,
  "handler": {
    "use": "command",
    "command": "node",
    "args": [
      "bin/export-bundle.mjs",
      "--site", "orchestration/sites/{{site.slug}}/site.json",
      "--window-start", "{{window.start}}",
      "--window-end", "{{window.end}}",
      "--extract", "{{paths.analysis}}/.extract/{{site.slug}}/{{window.start}}_{{window.end}}",
      "--out", "{{paths.analysis}}/{{site.slug}}",
      "--job", "{{job.id}}",
      "--runs", "process/runs",
      "--attempt", "{{run.attempt}}",
      "--python", "{{config.report.python}}"
    ]
  },
  "check": {
    "use": "bundle-anchors",
    "bundle": "{{paths.analysis}}/{{site.slug}}",
    "site": "orchestration/sites/{{site.slug}}/site.json",
    "page": "focus"
  },
  "retry": { "maxAttempts": 2, "backoffMs": 300000, "factor": 2, "maxBackoffMs": 1800000 },
  "errors": [
    { "match": "ECONNREFUSED|ETIMEDOUT|ECONNRESET|socket hang up|Timeout error", "class": "transient", "reason": "ClickHouse not reachable" },
    { "match": "MEMORY_LIMIT_EXCEEDED|Code: 241|memory limit", "class": "blocked", "reason": "the visit extract hit a ClickHouse memory limit; do not lower BUNDLE_VISIT_SHARDS" },
    { "match": "site\\.json has no focus and the analysis batch has no primary page|has no analysis batch", "class": "blocked", "reason": "the analysed page is not in site.json and not in the analysis batch" },
    { "match": "anchor mismatch", "class": "defect", "reason": "the bundle's orders do not meet the profile anchors" },
    { "match": "export-bundle: |\\bexit 2\\b", "class": "defect", "reason": "bundle command usage error" }
  ]
}
```

`orchestration/stages/bundle-4mb.stage.json`:

```json
{
  "id": "bundle-4mb",
  "label": "Trimmed analyst bundle",
  "phase": "export",
  "skill": "skills/analyst-data-bundle-4mb/SKILL.md",
  "concurrency": 1,
  "leaseMs": 120000,
  "timeoutMs": 1800000,
  "handler": {
    "use": "command",
    "command": "node",
    "args": [
      "bin/export-bundle-4mb.mjs",
      "--src", "{{paths.analysis}}/{{site.slug}}",
      "--out", "{{paths.analysis}}/{{site.slug}}-4mb",
      "--window-start", "{{window.start}}",
      "--window-end", "{{window.end}}",
      "--python", "{{config.report.python}}"
    ]
  },
  "check": {
    "use": "bundle-anchors",
    "bundle": "{{paths.analysis}}/{{site.slug}}-4mb"
  },
  "retry": { "maxAttempts": 2, "backoffMs": 60000, "factor": 2, "maxBackoffMs": 300000 },
  "errors": [
    { "match": "full bundle anchors do not hold", "class": "blocked", "reason": "the full bundle failed its anchors, so the trim was not run" },
    { "match": "anchor mismatch", "class": "defect", "reason": "the trimmed orders do not meet the profile anchors" },
    { "match": "export-bundle-4mb: |\\bexit 2\\b", "class": "defect", "reason": "trim command usage error" },
    { "match": "ModuleNotFoundError|No module named", "class": "blocked", "reason": "config.report.python is missing pandas" }
  ]
}
```

`bundle-4mb` has no `resources` entry. It does not take the ClickHouse slot, so a trim can run while another site holds `clickhouse-heavy` for analysis. Concurrency is still 1 because `fold_orders` loads the full orders frame. Two of those beside a Node heap is the overlap that produced the earlier out-of-memory stop. One trim at a time is the bound this plan sets.

`classifyFailure` uses the first matching rule against `failure.message` plus `failure.logTail`. The script's own `anchor mismatch` line is in the log tail when the script exits 1, and it is the check summary when the script exits 0 and the check disagrees. Both classifications land on the defect rule.

A timeout is a defect (`failure.js` does that when no rule matches and `timedOut` is set). Four hours is the same budget analysis has. The visit extract is the long step. Do not put a timeout rule that retries it as transient: a four-hour run that died at the limit should be looked at, not started again blind.

## How a delivery runs

For a site whose `site.json` has no focus, attempt 1:

1. The check reads `~/work/analysis/<slug>/00_site_profile.json`. It is missing. The check returns not ok. The handler starts.
2. The script finds `process/runs/<job>/analysis/attempt-*/batch.json`, queries the primary page, and writes `focus` into `site.json`.
3. Extract, then build. The script checks anchors and exits 0.
4. The check reads the new profile and the new `site.json`. Window, page, and anchors hold. The stage advances and `bundle-4mb` is queued.

For a site that already has focus and a bundle for this window, step 1 returns ok and the handler is not started. That is the pre-check in `execute-stage.js`. The window comparison is what stops an older folder from counting.

For a retry after a visit-shard failure, `run.attempt` is 2, the extract directory is the same, meta matches, and `BUNDLE_RESUME=1` is set. The script still runs the build and the anchor check. Resume is only the extract.

## Tests

`test/bundle-focus.test.js`

- `https://frankandeileen.com/` becomes `/`.
- `https://loopearplugs.com/pages/lp-homepage-lp2/` becomes `/pages/lp-homepage-lp2`.
- An existing focus is returned unchanged when the page argument is null.
- A missing focus and a null page throws the blocked sentence, exactly: `site.json has no focus and the analysis batch has no primary page`.
- `idsitehsr` of `17315997.5` is rejected. `Number.isInteger` is the gate.

`test/bundle-anchors.test.js`, all on strings in the test file, no fixtures on disk required beyond what the test writes in `os.tmpdir` for the plugin test:

- Three orders inside the window and one dated the day before. Count, revenue, median, and both high-value anchors match a hand-computed profile. The early order is excluded.
- Revenue `expect` off by `1` passes. Off by `1.01` fails, and `summary` starts with `anchor mismatch`.
- Even row count: revenues 10 and 20, expect 15, tolerance 0.01, passes. Expect 15.02 fails.
- Median `expect: null` with zero in-window rows passes. The same expect with one row fails.
- A CSV whose header has no `d` and whose `t_utc` is `2026-10-01T15:00:00` filters on `2026-10-01`.
- A rolled CSV (`orders`, `order_revenue`, `high_value`, `d`) against a rewritten anchor `{ agg: 'sum', column: 'orders', where: "d >= '...' and d <= '...' and high_value == 1" }` sums `orders` only on `high_value == 1`.
- A profile window of a different end date fails on `report_window` and does not report a false anchor pass.
- A `where` of `status == 'paid'` fails that anchor with `anchor where is not one the check evaluates`.

`test/bundle-anchors-check.test.js` builds a temp directory, writes a profile and a CSV, and calls `adapter.evaluate` with a fake context whose `render` returns the temp path and whose `values.window` is the profile window. Assert `ok`. Delete the CSV and assert the missing-file summary.

No test starts `bundle-export.mjs` against ClickHouse. The scripts' spawn path is covered by passing an `io.spawn` that records the argv and returns a fake exit 0 plus a stdout containing `frankandeileen visits done`, the same injection `analyzeSite` uses with its `io` argument. One test asserts `BUNDLE_RESUME` is absent when `attempt` is 1, and present when `attempt` is 2 and the fake meta matches. One test asserts it is absent when the meta window differs.

Run `npx vitest run test/bundle-focus.test.js test/bundle-anchors.test.js test/bundle-anchors-check.test.js` and `node bin/orchestrator validate`. Validate is what catches a check id whose file was not created: `loadPlugin` throws `no checks adapter "bundle-anchors"`.

## Jobs already on the queue

A job stores the stage objects it resolved at enqueue. Editing the two JSON files does not change Frank's stored `bundle` stage, which still says `pending`. `retry` without `--refresh` puts that same stored stage back on the queue. `retry --refresh` re-resolves the run from the files, keeps finished stages, and queues the stage it was asked to retry.

The running worker loads an adapter the first time a stage names it (`createRegistry` dynamic-imports by id). New files `bundle-anchors.js`, `export-bundle.mjs`, and `export-bundle-4mb.mjs` are picked up without a restart. A restart is not required and is not part of landing this.

Rollout, after the tests pass:

1. Leave the job that is inside analysis alone until that attempt finishes. `retry --refresh` on a running analysis job would also queue `bundle` immediately, and the two stages would run together.
2. For FrankAndEileen, which is blocked on `bundle` with analysis already done: `bin/orchestrator retry frankandeileen --refresh`. That revives the dead letter. Do not `complete` the stage. `complete` refuses a stage whose check is no longer `pending`.
3. Each of the other full jobs still has the pending descriptor stored. When its analysis finishes, settle will queue that stored stage, the pending handler will block it, and the same command applies: `bin/orchestrator retry <domain> --refresh`. The block is one cheap failed delivery, not a second analysis.

There is no refresh that only swaps `job.run` and leaves the queue untouched. Adding one is not required to land the handler. The sequence above uses the admin command that already exists.

## What this plan does not change

- `clickhouse-heavy` stays 1.
- `BUNDLE_VISIT_SHARDS` stays at the program default of 8. The blocked memory rule says so in the reason string so a fallback agent does not "fix" it by lowering the shard count.
- Anchors are not edited by hand. A mismatch is a defect in the extract or the build, and the stage fails.
- The naming bot, the analysis engine, and the three Python and Node bundle programs keep their current behaviour.
- The handler does not start work. Landing the files does not enqueue, retry, or complete anything. The operator runs the retry commands after the check exists.
