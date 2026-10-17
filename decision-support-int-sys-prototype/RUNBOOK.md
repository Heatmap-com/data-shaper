# Query tool prototype

How to run the decision-support prototype on a laptop. The page is a static
site. It reads JSON snapshots from `data/` and does not query ClickHouse
while you use it.

Repository: `https://bitbucket.org/thegrowthteam/decision-support-int-sys-prototype`.

## 1. What you get

`npm start` serves this directory on `http://127.0.0.1:8765/`. The root
redirects to the current revision, Grok K3. Older revisions stay in
`revisions/` and open by their own URL.

The server binds to `127.0.0.1` only. There is no install step and no
compile step. `package.json` has no dependencies.

| Revision | Status | URL |
| --- | --- | --- |
| Grok K3 | current, the default | `http://127.0.0.1:8765/revisions/grok-k3/` |
| ChatGPT V1 | current | `http://127.0.0.1:8765/revisions/chatgpt-v1/` |
| Cursor Opus 5.5 V1 | current | `http://127.0.0.1:8765/revisions/cursor-opus-5-5-v1/` |
| Quick Concept | frozen | `http://127.0.0.1:8765/revisions/quick-concept/` |

`revisions.json` is the list of those takes: name, date, status, and what
each one changed.

## 2. Prerequisites

| Requirement | Notes |
| --- | --- |
| Node.js ≥ 20 | `node` and `npm` on `PATH`. Nothing to install from the registry. |
| A local `data/` directory | Site snapshots. Git ignores this directory. A fresh clone has no sites until `data/` is copied in. |
| Google Chrome | Only for `capture.mjs` screenshots. The default binary is `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`. Set `CHROME_BIN` to use another build. |

## 3. Start and stop

From the repository root:

```bash
npm start
```

That runs `node serve.mjs --port 8765` and prints
`query tool: http://127.0.0.1:8765/`. Leave the process in the foreground.
Stop it with Ctrl-C.

Another port:

```bash
node serve.mjs --port 8766
```

`npm start` always uses 8765. A second start on the same port fails with
`EADDRINUSE`. Free it, or pick another port:

```bash
lsof -nP -iTCP:8765 -sTCP:LISTEN
```

Open the printed URL in a browser. The address `file://` leaves the panels
empty: the page loads its JSON with `fetch`, and browsers block that from
a file URL.

## 4. Local snapshots

`data/sites.json` is the site list. Each site is a directory of JSON files
plus `manifest.json`:

```text
data/sites.json
data/sites/<slug>/manifest.json
data/sites/<slug>/<dataset>.json
```

The copy used while this repository was split out has two sites:

| Slug | Name | idsite |
| --- | --- | --- |
| `loop-earplugs` | Loop Earplugs | 558 |
| `mellow` | Mellow | 4879 |

`manifest.json` records when the snapshot was taken, which warehouse
database it was read from, the trend weeks, and the analyst-bundle window.
The page shows that stamp in the header.

Copy `data/` from a machine that already has it when you clone somewhere
new. Leave it uncommitted.

## 5. Open a site and a question

Grok K3 keeps the selection in the URL hash. The site menu, the question
menu, and the context bar (week, compare, split, device) write that hash,
so a reload returns to the same place.

```text
http://127.0.0.1:8765/revisions/grok-k3/#site=mellow&tab=home
```

Grok K3 questions:

| `tab` | Question |
| --- | --- |
| `homework` | Ideas: what needs my attention this week? |
| `home` | This week: is the site OK, and what moved? |
| `change` | What moved: where did the change come from? |
| `health` | Site health: am I OK? |
| `acquisition` | Acquisition: who is coming, and are they worth it? |
| `journeys` | How do visitors move, and which paths make money? |
| `funnels` | Where do visitors drop out on the way to buying? |
| `pages` | Which pages take traffic, and which convert it? |
| `elements` | What on the page earns, and what is broken? |
| `returning` | Visitors over time: do they come back and buy? |
| `orders` | Orders and products: what do they buy, and at what price? |
| `experiments` | Is the test real, and is it winning? |
| `verdicts` | What does the platform think I should do? |

The other revisions use the same `#site=` and `#tab=` form. Their tab ids
are the `tabs` array in that revision's `views.json`.

## 6. Check

With `data/` present, from the repository root:

```bash
npm run check
```

Each revision's `check.mjs` reads `views.json` and every snapshot. It
fails when a panel names a dataset or a column the snapshot does not have.
ChatGPT V1 and Cursor Opus 5.5 V1 also run `selftest.mjs`, which checks
the arithmetic on the Mellow snapshot and on a small synthetic case.
Grok K3 and Quick Concept have the snapshot check only.

The check does not start the server and does not contact ClickHouse.

## 7. Screenshots

Start the server first. `capture.mjs` drives headless Chrome on debugging
port 9333 and writes PNGs to `--out`.

```bash
node capture.mjs --revision grok-k3 --out /tmp/qt-cap/grok-k3
```

| Flag | Default | Meaning |
| --- | --- | --- |
| `--revision` | required | `grok-k3`, `chatgpt-v1`, `cursor-opus-5-5-v1`, `quick-concept`, or `entry` |
| `--out` | required | Directory for the PNGs |
| `--base` | `http://127.0.0.1:8765` | Server to shoot |
| `--sites` | both sites in `data/sites.json` | Comma-separated slugs |
| `--panels` | off | Also write one PNG per panel. Pass a site slug, for example `--panels mellow` |
| `--width` | `1440` | Viewport width in pixels |

One capture at a time. A second run fights for port 9333.

## 8. Refreshing a snapshot

`snapshot.mjs` and `flows.mjs` still import the process engine from the
layout they had inside that repository (`../../src` and
`orchestration/sites/<slug>/site.json`, two directories above
`prototype/query-tool`). From this repository those imports do not
resolve, so a refresh is not run from here. Use the `data/` directory you
already have.

When a refresh is wired to the process repository again, the flags those
scripts already accept are:

```bash
node snapshot.mjs --site mellow
node snapshot.mjs --site loop-earplugs --bundle ~/work/analysis/loop-earplugs
node snapshot.mjs --site mellow --skip-flows
node flows.mjs --site mellow
```

`--site` is required. The site record is `orchestration/sites/<slug>/site.json`
in the process repository. The bundle defaults to `~/work/analysis/<slug>`.
`--skip-flows` leaves out journeys and the funnel, which take minutes.
`--allow-partition-miss` keeps a snapshot whose cells do not partition
cleanly. ClickHouse comes from `CLICKHOUSE_HOST`, `CLICKHOUSE_PORT`,
`CLICKHOUSE_USER`, `CLICKHOUSE_PASSWORD`, and `CLICKHOUSE_DATABASE` in the
environment, or from a `.env` file next to the process engine. The script
writes under `data/sites/<slug>/` and updates `data/sites.json`. It does
not write to the warehouse.
