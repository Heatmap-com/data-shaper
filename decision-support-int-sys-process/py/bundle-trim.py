import csv, io, json, os, re, shutil, sys
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lib.bundle_io import TABLE_RE, read_body, write_body  # noqa: E402

SRC = os.path.expanduser(sys.argv[1])
OUT = os.path.expanduser(sys.argv[2])
report = []


def num(v):
    try:
        return float(v) if v != '' else 0.0
    except ValueError:
        return 0.0


def fmt(v, digits=2):
    if v == int(v):
        return str(int(v))
    return f"{v:.{digits}f}".rstrip('0').rstrip('.')


def short_selector(sel, head=2, tail=5):
    parts = [p.strip() for p in sel.split(' > ')]
    if len(parts) <= head + tail + 1:
        return sel
    return ' > '.join(parts[:head]) + ' > … > ' + ' > '.join(parts[-tail:])


def unique_shortener(values, head=2, tail=5):
    """Shorten each CSS path, lengthening the kept tail until no two paths collapse to the same text."""
    values = sorted(set(values))
    parts = {v: [p.strip() for p in v.split(' > ')] for v in values}
    tails = {v: tail for v in values}
    def render(v):
        p, k = parts[v], tails[v]
        return v if len(p) <= head + k + 1 else ' > '.join(p[:head]) + ' > … > ' + ' > '.join(p[-k:])
    while True:
        seen = defaultdict(list)
        for v in values:
            seen[render(v)].append(v)
        clashes = [v for vs in seen.values() if len(vs) > 1 for v in vs if render(v) != v]
        if not clashes:
            return {v: render(v) for v in values}
        for v in clashes:
            tails[v] += 1


def shorten_column(header, rows, col):
    i = header.index(col)
    short = unique_shortener(r[i] for r in rows if r[i])
    for r in rows:
        if r[i]:
            r[i] = short[r[i]]
    return rows


def fold(header, rows, keep, key_cols, label, sum_cols, digits=None):
    """Keep rows passing `keep`; sum the rest into one row per key_cols, with `label` filling the others."""
    idx = {c: i for i, c in enumerate(header)}
    kept, tail = [], defaultdict(lambda: [0.0] * len(sum_cols))
    for r in rows:
        if keep(r, idx):
            kept.append(r)
        else:
            acc = tail[tuple(r[idx[c]] for c in key_cols)]
            for j, c in enumerate(sum_cols):
                acc[j] += num(r[idx[c]])
    for key, acc in sorted(tail.items()):
        row = [''] * len(header)
        for c, v in zip(key_cols, key):
            row[idx[c]] = v
        for c, v in label.items():
            row[idx[c]] = v
        for c, v in zip(sum_cols, acc):
            row[idx[c]] = fmt(v, (digits or {}).get(c, 2))
        kept.append(row)
    return kept, len(tail)


def drop_cols(header, rows, cols):
    keep = [i for i, c in enumerate(header) if c not in cols]
    return [header[i] for i in keep], [[r[i] for i in keep] for r in rows]


def map_col(header, rows, col, f):
    i = header.index(col)
    for r in rows:
        if r[i]:
            r[i] = f(r[i])
    return rows


def t_page_period(h, rows):
    rows, n = fold(h, rows, lambda r, i: num(r[i['visits']]) >= 25, ['pc', 'period', 'dev'],
                   {'url': '(pages under 25 visits, summed)'},
                   ['visits', 'buyer_visits', 'buyer_visit_revenue', 'entries', 'entry_buyer_visits'])
    return h, rows, [f"note: Trimmed: page x period x device rows under 25 visits are summed into one '(pages under 25 visits, summed)' row per page class x period x device ({n} rows). Summed visits count a visit once per page it reached."]


def t_product_entry(h, rows):
    rows, n = fold(h, rows, lambda r, i: num(r[i['visits']]) >= 10 or num(r[i['buyer_visits']]) > 0,
                   ['period', 'entry_path'], {'dev_s': '(small)', 'link_ch': '(small)', 'src': '(small)'},
                   ['visits', 'buyer_visits', 'orders', 'revenue', 'atc_visits', 'checkout_visits'])
    return h, rows, [f"note: Trimmed: device x channel x source combinations under 10 visits and with no buyer are summed into dev_s = link_ch = src = '(small)' per period x product URL ({n} rows), so product totals per period are unchanged."]


def t_campaign_daily(h, rows):
    rows, n = fold(h, rows, lambda r, i: num(r[i['visits']]) >= 5 or num(r[i['buyer_visits']]) > 0,
                   ['d', 'link_ch'], {'src': '(small)', 'med': '(small)', 'camp': '(campaigns under 5 visits, no buyer)'},
                   ['visits', 'buyer_visits', 'orders', 'revenue', 'atc_visits', 'checkout_visits'])
    return h, rows, [f"note: Trimmed: campaign-days under 5 visits and with no buyer are summed into one row per date x link_ch with camp '(campaigns under 5 visits, no buyer)' ({n} rows), so daily channel totals are unchanged."]


def t_tap_geometry(h, rows):
    i = {c: j for j, c in enumerate(h)}
    kept = [r for r in rows if num(r[i['m_off_target_taps']]) > 0 or num(r[i['m_correction_pairs']]) > 0 or r[i['m_median_offset_from_center_px']] != '']
    return h, kept, ["note: Trimmed: only selector-weeks with an off-target tap, a correction pair, or a measured offset are kept. Click counts for every selector-week are in selector-weekly."]


SW_DROP = {'m_p25_y', 'm_p75_y', 'm_median_time_since_load'}


def t_selector_weekly(h, rows):
    h, rows = drop_cols(h, rows, SW_DROP)
    rows, n = fold(h, rows, lambda r, i: num(r[i['m_clicks']]) >= 3, ['dim_week', 'dim_device'],
                   {'dim_element_class': '(selectors under 3 clicks, summed)'},
                   ['m_clicks', 'm_clicking_sessions', 'm_sessions_with_order', 'm_revenue_udp', 'm_first_click_sessions', 'm_clicks_under_8s'])
    return h, rows, [f"note: Trimmed: selector-weeks under 3 clicks are summed into one row per week x device with dim_element_class '(selectors under 3 clicks, summed)' and no selector_id ({n} rows); they held about 4% of clicks. Dropped columns m_p25_y, m_p75_y, m_median_time_since_load (m_median_y and m_median_x remain)."]


def t_exposure(h, rows):
    rows = shorten_column(h, rows, 'x_element')
    return h, rows, ["note: Trimmed: long x_element CSS paths keep their first 2 steps and enough final steps to stay unique (at least 5), with ' > … > ' between."]


def t_render(h, rows):
    if 'm_selector' in h:
        rows = shorten_column(h, rows, 'm_selector')
    return h, rows, ["note: Trimmed: long m_selector CSS paths keep their first 2 steps and enough final steps to stay unique (at least 5), with ' > … > ' between."]


TRANSFORMS = {
    'page_period': t_page_period,
    'product_entry_period': t_product_entry,
    'campaign_daily': t_campaign_daily,
    'tap-geometry-weekly': t_tap_geometry,
    'selector-weekly': t_selector_weekly,
    'exposure-weekly': t_exposure,
    'render-snapshot': t_render,
}


def rewrite_table(name, meta, header, rows, extra_notes):
    meta = re.sub(r"^rows: \d+$", f"rows: {len(rows)}", meta, flags=re.M)
    meta = re.sub(r"^columns: .*$", "columns: " + ', '.join(header), meta, flags=re.M)
    meta = re.sub(r"^(rows: )", '\n'.join(extra_notes) + "\n" + r"\1", meta, count=1, flags=re.M) if extra_notes else meta
    return f"=== TABLE: {name} ===\n{meta}--- BEGIN CSV ---\n{write_body(name, header, rows)}--- END CSV ---"


def process_txt(text, pass_two=None):
    out, pos, referenced = [], 0, set()
    for m in TABLE_RE.finditer(text):
        name, meta, body = m.group(1), m.group(2), m.group(3)
        out.append(text[pos:m.start()])
        pos = m.end()
        transforms = pass_two if pass_two else TRANSFORMS
        if name in transforms:
            header, rows = read_body(body)
            h, rows, notes = transforms[name](header, rows)
            out.append(rewrite_table(name, meta, h, rows, notes))
            report.append((name, len(read_body(body)[1]), len(rows)))
        else:
            out.append(m.group(0))
            header, rows = read_body(body)
        if 'selector_id' in header and name != 'selectors':
            i = header.index('selector_id')
            referenced |= {r[i] for r in rows if r[i]}
    out.append(text[pos:])
    return ''.join(out), referenced


os.makedirs(OUT, exist_ok=True)
texts, referenced = {}, set()
for f in sorted(os.listdir(SRC)):
    if f.endswith('.txt'):
        texts[f], ref = process_txt(open(os.path.join(SRC, f), encoding='utf-8').read())
        referenced |= ref


def t_selectors(h, rows):
    i, s = h.index('selector_id'), h.index('selector')
    kept = shorten_column(h, [r for r in rows if r[i] in referenced], 'selector')
    return h, kept, ["note: Trimmed: only selectors referenced by a table in this bundle are kept. Long CSS paths keep their first 2 steps and enough final steps to stay unique (at least 5), with ' > … > ' between."]


for f, text in texts.items():
    if '=== TABLE: selectors ===' in text:
        texts[f], _ = process_txt(text, {'selectors': t_selectors})
    open(os.path.join(OUT, f), 'w', encoding='utf-8').write(texts[f])

with open(os.path.join(SRC, '01_orders.csv'), encoding='utf-8', newline='') as fh, \
        open(os.path.join(OUT, '01_orders.csv'), 'w', encoding='utf-8', newline='') as oh:
    r, w = csv.reader(fh), csv.writer(oh, lineterminator='\n')
    header = next(r)
    di = header.index('d')
    w.writerow(header[:di] + header[di + 1:])
    for row in r:
        w.writerow(row[:di] + row[di + 1:])

for f in sorted(os.listdir(SRC)):
    if f.startswith('00_') or f.startswith('10_'):
        shutil.copy(os.path.join(SRC, f), os.path.join(OUT, f))


def bundle_bytes():
    return sum(os.path.getsize(os.path.join(OUT, f)) for f in os.listdir(OUT) if not f.startswith('.'))


def fold_orders():
    """Roll orders up when the trimmed bundle is still far above 4 MB."""
    import json
    profile = json.load(open(os.path.join(OUT, '00_site_profile.json')))
    w0, w1 = profile['report_window']['start'], profile['report_window']['end']
    hv = 0
    for a in profile['anchors']:
        found = re.search(r'order_revenue >= ([0-9.]+)', a.get('where', ''))
        if found:
            hv = float(found.group(1))
    with open(os.path.join(SRC, '01_orders.csv'), encoding='utf-8', newline='') as fh:
        rows = list(csv.DictReader(fh))
    acc = defaultdict(lambda: [0, 0.0, 0.0])
    for r in rows:
        if not (w0 <= r['d'] <= w1):
            continue
        rev = num(r.get('order_revenue', ''))
        key = (r['d'], r.get('item_title', ''), r.get('marked_down', ''), r.get('order_device', ''), '1' if rev >= hv else '0')
        acc[key][0] += 1
        acc[key][1] += rev
        acc[key][2] += num(r.get('qty', ''))
    header = ['d', 'item_title', 'marked_down', 'order_device', 'high_value', 'orders', 'order_revenue', 'qty']
    with open(os.path.join(OUT, '01_orders.csv'), 'w', encoding='utf-8', newline='') as oh:
        w = csv.writer(oh, lineterminator='\n')
        w.writerow(header)
        for key in sorted(acc):
            n, rev, qty = acc[key]
            w.writerow([*key, n, fmt(rev), fmt(qty)])
    profile['orders_grain'] = 'day x item title x marked_down x order device x high_value (trimmed bundle only)'
    kept = []
    for a in profile['anchors']:
        if str(a.get('label', '')).startswith('median'):
            continue
        a['where'] = f"d >= '{w0}' and d <= '{w1}'" + (' and high_value == 1' if 'high-value' in a.get('label', '') else '')
        if a['agg'] == 'count':
            a['agg'] = 'sum'
            a['column'] = 'orders'
        elif a['agg'] == 'sum':
            a['column'] = 'order_revenue'
        kept.append(a)
    profile['anchors'] = kept
    profile['reading_notes'].append('In this trimmed bundle, orders are one row per day, product title, markdown flag and device. The full bundle has one row per order.')
    json.dump(profile, open(os.path.join(OUT, '00_site_profile.json'), 'w'), indent=2)
    guide = open(os.path.join(OUT, '00_README_data_guide.md'), encoding='utf-8').read()
    guide = guide.replace('### orders  -  `01_orders.csv`',
                          '### orders  -  `01_orders.csv`\n\nTrimmed: one row per day x product title x markdown flag x device, report window only. The full bundle keeps one row per order.\n')
    open(os.path.join(OUT, '00_README_data_guide.md'), 'w', encoding='utf-8').write(guide)
    print('orders rolled up to', len(acc), 'rows')


def t_weekly_source(h, rows):
    rows, n = fold(h, rows, lambda r, i: num(r[i['visits']]) >= 20 or num(r[i['buyer_visits']]) > 0,
                   ['week', 'dev_s', 'link_ch'],
                   {'src': '(small)', 'med': '(small)', 'camp': '(campaigns under 20 visits, summed)'},
                   ['visits', 'buyer_visits', 'orders', 'revenue', 'atc_visits', 'checkout_visits'])
    return h, rows, [f"note: Trimmed further: source-weeks under 20 visits and with no buyer are summed per week x device x link_ch ({n} rows)."]


def t_meta(h, rows):
    rows, n = fold(h, rows, lambda r, i: num(r[i['visits']]) >= 100 or num(r[i['buyer_visits']]) > 0,
                   ['period', 'dev_s'], {'utm_content': '(creatives under 100 visits, summed)'},
                   ['visits', 'buyer_visits', 'orders', 'revenue', 'atc_visits', 'checkout_visits'])
    return h, rows, [f"note: Trimmed further: creatives under 100 visits and with no buyer are summed per period x device ({n} rows)."]


def t_campaign_weekly(h, rows):
    if 'm_sessions' not in h:
        return h, rows, []
    sum_cols = [c for c in h if c.startswith('m_')]
    label = {c: '(campaigns under 20 sessions, summed)' for c in h if c.startswith('x_')}
    rows, n = fold(h, rows, lambda r, i: num(r[i['m_sessions']]) >= 20, ['dim_week'], label, sum_cols)
    return h, rows, [f"note: Trimmed further: campaign-weeks under 20 sessions are summed per week ({n} rows)."]


def t_line_items(h, rows):
    idx = {c: i for i, c in enumerate(h)}
    if 'x_product_name' not in idx:
        return h, rows, []
    acc = defaultdict(lambda: [0, 0.0, 0.0])
    for r in rows:
        sku = r[idx['x_sku']] if 'x_sku' in idx else ''
        key = (r[idx['x_product_name']], sku)
        acc[key][0] += 1
        acc[key][1] += num(r[idx['m_quantity']]) if 'm_quantity' in idx else 0
        acc[key][2] += num(r[idx['m_line_revenue']]) if 'm_line_revenue' in idx else 0
    nh = ['x_product_name', 'x_sku', 'orders', 'm_quantity', 'm_line_revenue']
    out = [[name, sku, str(n), fmt(q), fmt(rev)] for (name, sku), (n, q, rev) in sorted(acc.items(), key=lambda kv: -kv[1][2])]
    return nh, out, ['note: Trimmed further: order lines are summed to product name x sku. The order id and visit id stay in the full bundle.']


def tighten():
    extra = {
        'weekly_source_campaign': t_weekly_source,
        'meta_creative_period': t_meta,
        'campaign-weekly': t_campaign_weekly,
        'line-items': t_line_items,
    }
    for f in sorted(os.listdir(OUT)):
        if not f.endswith('.txt'):
            continue
        path = os.path.join(OUT, f)
        text, _ = process_txt(open(path, encoding='utf-8').read(), extra)
        open(path, 'w', encoding='utf-8').write(text)
    prof_path = os.path.join(OUT, '00_site_profile.json')
    if os.path.exists(prof_path):
        profile = json.load(open(prof_path))
        prefixes = profile.setdefault('catchall_prefixes', [])
        for pfx in ['(creatives under', '(campaigns under 20']:
            if pfx not in prefixes:
                prefixes.append(pfx)
        profile['reading_notes'].append('This trimmed bundle also rolls up low-volume source weeks, ad creatives, campaign weeks, and order lines. The full bundle keeps those rows.')
        json.dump(profile, open(prof_path, 'w'), indent=2)


if bundle_bytes() > 4_200_000:
    fold_orders()

if bundle_bytes() > 4_200_000:
    tighten()

guide = open(os.path.join(OUT, '00_README_data_guide.md'), encoding='utf-8').read()
counts = {}
for f in os.listdir(OUT):
    if not f.endswith('.txt'):
        continue
    for m in TABLE_RE.finditer(open(os.path.join(OUT, f), encoding='utf-8').read()):
        rm = re.search(r'^rows: (\d+)$', m.group(2), re.M)
        if rm:
            counts[m.group(1)] = rm.group(1)
for name, n in counts.items():
    guide = re.sub(rf'(### {re.escape(name)}  -  `[^`]+`\n\n(?:.*\n)*?- Rows: )\d+', rf'\g<1>{n}', guide, count=1)
note = (
    '\n## Trimmed for size\n\n'
    'This folder is the trimmed copy. Page rows under 25 visits, product-entry splits under 10 visits with no buyer, '
    'campaign-days under 5 visits with no buyer, and selector-weeks under 3 clicks are summed into catch-all rows. '
    'Tap geometry keeps only selector-weeks with a mis-tap signal. Long CSS paths keep their first two steps and enough '
    'of the tail to stay unique. `orders` drops the `d` column when it still has one row per order; the date is the first '
    '10 characters of `t_utc`. Catch-all labels start with the prefixes in `00_site_profile.json`.\n'
)
if '## Trimmed for size' not in guide:
    guide = guide.replace('\n## Files\n', note + '\n## Files\n', 1)
open(os.path.join(OUT, '00_README_data_guide.md'), 'w', encoding='utf-8').write(guide)

for name, before, after in report:
    print(f"{name:<24} rows {before:>6} -> {after:>6}")
total = 0
for f in sorted(os.listdir(OUT)):
    if f.startswith('.'):
        continue
    b = os.path.getsize(os.path.join(OUT, f))
    total += b
    print(f"{f:<52} {b:>9}")
print('total', total)
