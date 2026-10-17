import json, sys, os, io
import pandas as pd

SRC, OUTDIR = sys.argv[1], sys.argv[2]
os.makedirs(OUTDIR, exist_ok=True)
b = json.load(open(SRC))
T, P = b['tables'], b['pipeline_datasets']
SELECTORS = b['lookups']['selectors']
REPEAT = 100

def frame(t):
    df = pd.DataFrame(t['rows'], columns=t['columns'])
    for c in df.columns:
        if pd.api.types.is_float_dtype(df[c]) and df[c].dropna().apply(float.is_integer).all():
            df[c] = df[c].astype('Int64')
        elif df[c].dtype == object:
            df[c] = df[c].map(lambda v: v.replace('\r', ' ').replace('\n', ' ') if isinstance(v, str) else v)
    return df

used_sel = set()
for t in P.values():
    if 'selector_id' in t['columns']:
        i = t['columns'].index('selector_id')
        used_sel.update(int(r[i]) for r in t['rows'] if r[i] is not None)
sel_table = {'description': 'CSS selector lookup for pipeline datasets: selector_id -> full CSS selector on the DVF homepage.', 'grain': 'one row per selector', 'source': 'ae_dataset_row_current.dim_selector',
             'columns': ['selector_id', 'selector'], 'rows': [[i, SELECTORS[i]] for i in sorted(used_sel)]}
sel_table['row_count'] = len(sel_table['rows'])

FILES = [
    ('01_orders.csv', 'Orders', [('tables', 'orders')]),
    ('02_daily_and_campaigns.txt', 'Daily site, channel and campaign series',
     [('tables', 'daily_site'), ('tables', 'daily_channel_device'), ('tables', 'campaign_daily')]),
    ('03_weekly_channels.txt', 'Weekly channel, entry-page, source and Meta creative tables',
     [('tables', 'weekly_entry_cube'), ('tables', 'weekly_source_campaign'), ('tables', 'meta_creative_period')]),
    ('04_products.txt', 'Products: daily sales and prices, product-page entries, the Sasha Dress',
     [('tables', 'product_daily'), ('tables', 'product_entry_period'), ('tables', 'sasha_entry_daily'), ('pipeline', 'line-items')]),
    ('05_pages_and_high_value.txt', 'Site pages by period and the high-value buyer page reach',
     [('tables', 'page_period'), ('tables', 'high_value_page_reach')]),
    ('06_shoppers_and_cohorts.txt', 'Shopper history, abandoned-bag chains, behaviour cohorts, email frequency',
     [('tables', 'shopper_history_30d'), ('pipeline', 'trigger-chains'), ('tables', 'visit_cohorts'), ('tables', 'email_multi_click')]),
    ('07_homepage_clicks.txt', 'Homepage click behaviour by element, plus the CSS selector lookup',
     [('pipeline', 'selector-weekly'), ('pipeline', 'nav-next-page'), ('pipeline', 'tap-geometry-weekly'), ('pipeline', 'rage-clicks'), ('pipeline', 'rage-clicks:totals'),
      ('pipeline', 'element-binding'), ('pipeline', 'kind-fleet-weekly'), ('lookup', 'selectors')]),
    ('08_homepage_layout_engagement.txt', 'Homepage layout, carousel grid, exposure, scroll, journeys and segments',
     [('pipeline', 'product-grid'), ('pipeline', 'render-snapshot'), ('pipeline', 'exposure-weekly'), ('pipeline', 'scroll-decile'), ('pipeline', 'viewport-weekly'),
      ('pipeline', 'dwell-model-inputs'), ('pipeline', 'journey-weekly'), ('pipeline', 'funnel-sequence-weekly'), ('pipeline', 'page-segment-weekly'),
      ('pipeline', 'recordings-sample'), ('pipeline', 'page-speed')]),
    ('09_homepage_channels_and_pipeline_verdicts.txt', 'Homepage channel and order reads, data coverage, and the pipeline\'s automated strategy verdicts',
     [('pipeline', 'entry-by-channel'), ('pipeline', 'campaign-weekly'), ('pipeline', 'campaign-coverage'), ('pipeline', 'site-baselines'), ('pipeline', 'sister-pages'),
      ('pipeline', 'template-weekly'), ('pipeline', 'page-country'), ('pipeline', 'order-value-hist'), ('pipeline', 'coverage'), ('pipeline', 'audit-readiness'),
      ('pipeline', 'audit-context'), ('pipeline', 'requirement-status'), ('pipeline', 'structural-screen'), ('pipeline', 'strategy-triggers'), ('pipeline', 'card-history'),
      ('pipeline', 'cards-lp'), ('pipeline', 'cards-pg'), ('pipeline', 'cards-pi'), ('pipeline', 'cards-po'), ('pipeline', 'cards-td'), ('pipeline', 'cards-tg'), ('pipeline', 'cards-ti')]),
]

def get(kind, name):
    return T[name] if kind == 'tables' else P[name] if kind == 'pipeline' else sel_table

placed = {(k, n) for _, _, items in FILES for k, n in items}
missing = [('tables', n) for n in T if ('tables', n) not in placed] + [('pipeline', n) for n in P if ('pipeline', n) not in placed]
assert not missing, missing

index = []
for fname, title, items in FILES:
    path = os.path.join(OUTDIR, fname)
    if fname.endswith('.csv'):
        t = get(*items[0])
        frame(t).to_csv(path, index=False)
        index.append((fname, items[0][1], t))
        continue
    buf = io.StringIO()
    buf.write(f'# {fname} - {title}\n')
    buf.write(f'# Part of the DVF Site Opportunity Report data (dvf.com, 10 Sep - 9 Oct 2026). See 00_README_data_guide.md for definitions.\n')
    buf.write(f'# Tables in this file: {", ".join(n for _, n in items)}\n')
    buf.write('# Format: each table starts with a TABLE marker line, then metadata lines, then CSV between BEGIN CSV and END CSV marker lines.\n')
    buf.write(f'# Lines starting with "@@" inside the CSV repeat the table name and header every {REPEAT} rows; skip them when parsing.\n\n')
    for kind, name in items:
        t = get(kind, name)
        df = frame(t)
        group = {'tables': 'analyst table (site-wide)', 'pipeline': 'pipeline dataset (homepage or site scope)', 'lookup': 'lookup'}[kind]
        buf.write(f'=== TABLE: {name} ===\n')
        buf.write(f'type: {group}\n')
        buf.write(f'description: {t["description"]}\n')
        buf.write(f'grain: {t["grain"]}\n')
        buf.write(f'source: {t["source"]}\n')
        if t.get('bot_filter'): buf.write(f'bot_filter: {t["bot_filter"]}\n')
        for n in t.get('notes') or []: buf.write(f'note: {n}\n')
        buf.write(f'rows: {len(df)}\n')
        buf.write(f'columns: {", ".join(df.columns)}\n')
        buf.write('--- BEGIN CSV ---\n')
        lines = df.to_csv(index=False).splitlines()
        header = lines[0]
        buf.write(header + '\n')
        for i, line in enumerate(lines[1:], 1):
            buf.write(line + '\n')
            if i % REPEAT == 0 and i < len(lines) - 1:
                buf.write(f'@@ {name} | columns: {header}\n')
        buf.write('--- END CSV ---\n\n')
        index.append((fname, name, t))
    open(path, 'w').write(buf.getvalue())

# ---------------------------------------------------------------- README
d = b['definitions']; r = b['reconciliation']
md = io.StringIO()
w = md.write
w('# DVF Site Opportunity Report - Data Guide\n\n')
w(f'{b["bundle"]["purpose"]}\n\n')
w(f'- **Site:** DVF (Diane von Furstenberg), dvf.com, Shopify, USD. Internal site id 5795.\n- **Report window:** 10 Sep - 9 Oct 2026.\n- **Data coverage:** {d["periods"]["data_coverage"]}\n')
w(f'- **Generated:** {b["bundle"]["generated_utc"]}\n- **Sources:** {", ".join(b["bundle"]["sources"])}\n\n')
w('## Files\n\n| File | Contents |\n| --- | --- |\n| 00_README_data_guide.md | This guide: definitions, reconciliation with the report, table catalog |\n')
for fname, title, items in FILES:
    w(f'| {fname} | {title}: {", ".join(n for _, n in items)} |\n')
w('\n## How to load a file in code\n\n```python\nimport re, io, pandas as pd\n\ndef load_tables(path):\n    if path.endswith(".csv"):\n        return {"orders": pd.read_csv(path)}\n    txt = open(path, encoding="utf-8").read()\n    out = {}\n    for m in re.finditer(r"^=== TABLE: (\\S+) ===$.*?^--- BEGIN CSV ---\\n(.*?)^--- END CSV ---$", txt, re.S | re.M):\n        body = "\\n".join(l for l in m.group(2).splitlines() if not l.startswith("@@"))\n        out[m.group(1)] = pd.read_csv(io.StringIO(body))\n    return out\n\nt = load_tables("02_daily_and_campaigns.txt")\ndaily = t["daily_site"]\n```\n\n')
w('## Periods\n\n')
for k, v in d['periods'].items():
    if k != 'data_coverage': w(f'- **{k}:** {v}\n')
w(f'\nDates: {d["dates"]}\n\n')
w('## Definitions\n\n')
for k, v in d.items():
    if k in ('site', 'periods', 'dates'): continue
    if isinstance(v, dict):
        w(f'**{k}**\n\n'); [w(f'- `{kk}`: {vv}\n') for kk, vv in v.items()]; w('\n')
    else:
        w(f'**{k}:** {v}\n\n')
w('## Reconciliation with the report\n\nRead this before comparing bundle numbers with the report.\n\n**Exact matches**\n\n')
for x in r['exact_matches']: w(f'- {x}\n')
w('\n**Recomputed with different counting (expected gaps, not errors)**\n\n')
for x in r['recomputed_with_different_counting']: w(f'- Report: {x["report"]}\n  Bundle: {x["bundle"]}\n')
w('\n**Likely errors or inconsistencies in the report**\n\n')
for x in r['likely_errors_in_report']: w(f'- {x}\n')
w('\n**Not included**\n\n')
for x in r['not_included']: w(f'- {x}\n')
w('\n## Report section -> tables\n\n| Report section | Tables |\n| --- | --- |\n')
loc = {n: f for f, n, _ in index}
for s in b['report_section_index']:
    names = []
    for x in s['tables']:
        base = x.replace('pipeline:', '').split(' ')[0]
        names.append(f'{base} ({loc.get(base, "?")[:2]})')
    w(f'| {s["section"]} | {", ".join(names)} |\n')
w('\n## Table catalog\n\n')
for fname, name, t in index:
    w(f'### {name}  -  `{fname}`\n\n{t["description"]}\n\n- Grain: {t["grain"]}\n- Rows: {t["row_count"]}\n- Columns: {", ".join(t["columns"])}\n')
    for n in t.get('notes') or []: w(f'- Note: {n}\n')
    w('\n')
open(os.path.join(OUTDIR, '00_README_data_guide.md'), 'w').write(md.getvalue())

tot = 0
for f in sorted(os.listdir(OUTDIR)):
    s = os.path.getsize(os.path.join(OUTDIR, f)); tot += s
    print(f'{s:>9}  {f}')
print(f'{tot:>9}  total')
