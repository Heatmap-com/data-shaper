"""Turn one site's extracts (py/bundle-export.mjs --out) into the analyst file bundle.

Usage: python3 py/bundle-build.py <extract-dir> <outdir>
"""
import io, json, os, sys
import numpy as np
import pandas as pd

SRC, OUTDIR = os.path.expanduser(sys.argv[1]), os.path.expanduser(sys.argv[2])
meta = json.load(open(os.path.join(SRC, 'meta.json')))
os.makedirs(OUTDIR, exist_ok=True)
REPEAT = 100
HV = float(meta['hv'])
W0, W1 = meta['window0'], meta['window1']
FIRST_END = meta['firstEnd']
PRE = meta['preStart']
FOCUS = meta['focusPath'].rstrip('/') or '/'
DOMAIN = meta['domain']
# A site calendar comes from site.json through meta.json. Without one, the
# window's calendar halves stand in, and the wording says so.
SITE_CALENDAR = bool(meta.get('periods'))
PERIODS = meta['periods'] if SITE_CALENDAR else [
    {'name': 'pre', 'start': PRE, 'end': None},
    {'name': 'first', 'start': W0, 'end': FIRST_END, 'baseline': True},
    {'name': 'second', 'start': None, 'end': W1},
]
PERIOD_NAMES = [p['name'] for p in PERIODS]
BASELINE = next(p for p in PERIODS if p.get('baseline'))
IN_WINDOW = [p['name'] for p in PERIODS[1:] if not SITE_CALENDAR or p['start'] >= W0]
NOTES = meta.get('readingNotes') or {}


def period_of(d):
    """Before the second period starts, then on or before each middle end, else the last."""
    conditions = [d < PERIODS[1]['start']] + [d <= p['end'] for p in PERIODS[1:-1]]
    return np.select(conditions, PERIOD_NAMES[:-1], PERIOD_NAMES[-1])


def table(df, description, grain, source, notes=None):
    df = df.copy()
    if df.empty:
        return {'description': description, 'grain': grain, 'source': source, 'row_count': 0,
                'columns': list(df.columns), 'rows': [], 'notes': notes or []}
    for c in df.columns:
        if pd.api.types.is_float_dtype(df[c]):
            df[c] = df[c].round(4)
        elif pd.api.types.is_bool_dtype(df[c]):
            df[c] = df[c].astype(int)
        elif pd.api.types.is_datetime64_any_dtype(df[c]):
            df[c] = df[c].dt.strftime('%Y-%m-%d')
    rows = json.loads(df.to_json(orient='values', double_precision=4))
    return {'description': description, 'grain': grain, 'source': source, 'row_count': len(rows),
            'columns': list(df.columns), 'rows': rows, 'notes': notes or []}

def frame_of(t):
    df = pd.DataFrame(t['rows'], columns=t['columns'])
    for c in df.columns:
        if pd.api.types.is_float_dtype(df[c]) and len(df) and df[c].dropna().apply(lambda v: float(v).is_integer()).all():
            df[c] = df[c].astype('Int64')
        elif df[c].dtype == object:
            df[c] = df[c].map(lambda v: v.replace('\r', ' ').replace('\n', ' ') if isinstance(v, str) else v)
    return df

print('loading visits', flush=True)
parts = []
for chunk in pd.read_json(os.path.join(SRC, 'visits.jsonl'), lines=True, chunksize=250_000, dtype={'idvisit': str, 'cid': str}):
    parts.append(chunk)
df = pd.concat(parts, ignore_index=True) if parts else pd.DataFrame()
if df.empty:
    raise SystemExit('no visits')
df['d'] = pd.to_datetime(df['d'])
df['buy'] = (df.n > 0).astype(int)
df['atc'] = (df.e_atc > 0).astype(int)
df['co'] = (df.e_co > 0).astype(int)
df['bot'] = (df.pvs <= 1) & (df.clicks == 0) & (df.sc_max == 0) & (df.n == 0)
df['dev_s'] = df.dev.map({1: 'desktop', 2: 'tablet', 3: 'mobile'}).fillna('unknown')
df['period'] = period_of(df.d)
df['week'] = (df.d - pd.to_timedelta(df.d.dt.dayofweek, unit='D')).dt.strftime('%Y-%m-%d')
df['d'] = df['d'].dt.strftime('%Y-%m-%d')
df['email_kind'] = np.where(df.ch == 'email_sms', np.where(df.med == 'flow', 'flow', 'campaign'), '')
df['entry_path'] = df.eurl.fillna('').str.replace(r'^https?://[^/]+', '', regex=True).str.replace(r'\?.*$', '', regex=True).str.rstrip('/')
df.loc[df.entry_path == '', 'entry_path'] = '/'
for c in ['saw_home', 'saw_product', 'saw_collection', 'saw_cart', 'saw_search', 'saw_account', 'saw_content', 'coll_to_prod']:
    df[c] = df[c].fillna(0).astype(int)
print(f"visits {len(df)} bots {int(df.bot.sum())}", flush=True)

order_rows = json.load(open(os.path.join(SRC, 'orders.json')))
order_cols = ['oid', 'idvisit', 'd', 't', 'rev', 'odev', 'title', 'price', 'qty', 'items']
orders = pd.DataFrame(order_rows, columns=order_cols) if len(order_rows) == 0 else pd.DataFrame(order_rows)
orders['d'] = pd.to_datetime(orders.d)
orders['idvisit'] = orders.idvisit.astype(str)
base = orders[(orders.d >= BASELINE['start']) & (orders.d <= BASELINE['end']) & (orders.price > 0)].groupby('title').price.median()
orders['title_fullprice_median'] = orders.title.map(base)
orders['marked_down'] = (orders.price > 0) & orders.title_fullprice_median.notna() & (orders.price < 0.95 * orders.title_fullprice_median)
orders['paid_to_item'] = np.where(orders.price > 0, orders.rev / (orders.price * orders.qty.clip(lower=1)), np.nan)
orders['paid_below_item'] = orders.paid_to_item < 1
win = orders[(orders.d >= W0) & (orders.d <= W1)]
daily_rev = win.groupby(win.d.dt.strftime('%Y-%m-%d')).rev.sum()
peak_days = set(daily_rev.nlargest(3).index) if len(daily_rev) else set()
df['peak'] = df.d.isin(peak_days)

nb = df[~df.bot].copy()
agg = dict(visits=('buy', 'size'), buyer_visits=('buy', 'sum'), orders=('n', 'sum'), revenue=('rev', 'sum'),
           atc_visits=('atc', 'sum'), checkout_visits=('co', 'sum'))

vcols = ['idvisit', 'dev_s', 'ch', 'link_ch', 'src', 'med', 'camp', 'utm_content', 'entry', 'entry_path', 'pvs', 'secs',
         'n_prod_urls', 'clicks', 'saw_home', 'saw_product', 'saw_collection', 'saw_cart', 'saw_search', 'saw_account',
         'saw_content', 'coll_to_prod', 'e_search', 'ret', 'nvisits', 'prior_visits', 'prior_atc', 'prior_buy',
         'prior_email', 'hist30', 'country']
od = orders.merge(nb[vcols], on='idvisit', how='left')
od['matched_visit'] = od.dev_s.notna().astype(int)
od['odev'] = od.odev.map({1: 'desktop', 2: 'tablet', 3: 'mobile'})
od['d'] = od['d'].dt.strftime('%Y-%m-%d')
od = od.rename(columns={'t': 't_utc', 'rev': 'order_revenue', 'title': 'item_title', 'price': 'item_price', 'odev': 'order_device', 'dev_s': 'visit_device'})
tail = ['visit_device' if c == 'dev_s' else c for c in vcols[1:]]
od = od[['oid', 'd', 't_utc', 'order_revenue', 'item_title', 'item_price', 'qty', 'items', 'title_fullprice_median',
         'marked_down', 'paid_to_item', 'paid_below_item', 'order_device', 'matched_visit'] + tail]
T = {}
T['orders'] = table(od, f'One row per order from {meta["orderStart"]} to {meta["orderEnd"]}. Where the order matched a tracked visit that is not a dead session, the visit channel, entry and shopper history are attached.',
    'one row per order', 'udp_conversions (FINAL) + conversion_item, left-joined to the visit extract',
    ['oid is a cityHash64 of the Shopify order id, not the id itself.',
     'item_title is the highest-priced line. items is the number of lines. A multi-item basket is not itemised.',
     f'marked_down = item price under 95% of that title\'s median price on orders from {BASELINE["start"]} to {BASELINE["end"]} ' +
     (f'(the {BASELINE["name"]} period of the site calendar, its price baseline).' if SITE_CALENDAR else '(the first half of the report window, a calendar baseline, not a confirmed full-price period).'),
     'paid_to_item = order revenue / (item price x qty). Below 1 means the order paid less than the stored item price.',
     'Visit fields are empty when the order did not match a visit in the visit extract, or that visit is a dead session.',
     f'hist30 is complete for visits from {W0} onward.'])

# daily
dv = df.groupby('d').agg(visits_all=('buy', 'size'), bot_visits=('bot', 'sum')).join(nb.groupby('d').agg(**agg))
for name in ['mobile', 'desktop', 'tablet']:
    dv[f'visits_{name}'] = nb[nb.dev_s == name].groupby('d').size()
dv['returning_visits'] = nb[nb.ret == 1].groupby('d').size()
do = orders.copy()
do['d'] = do['d'].dt.strftime('%Y-%m-%d') if not pd.api.types.is_string_dtype(do['d']) else do['d']
# orders.d already string on od; original orders still datetime. Use a fresh daily from orders before string... 
# orders['d'] is still datetime because od is a copy of renamed columns from a merge of orders. Wait, merge doesn't change orders.d. od has string d. orders.d is datetime.
daily_o = orders.assign(ds=orders.d.dt.strftime('%Y-%m-%d')).groupby('ds').agg(
    orders_all=('oid', 'size'), revenue_all=('rev', 'sum'),
    orders_ge_hv=('rev', lambda s: (s >= HV).sum()),
    orders_ge_2hv=('rev', lambda s: (s >= 2 * HV).sum()),
    orders_marked_down=('marked_down', 'sum'),
    orders_paid_below_item=('paid_below_item', 'sum'),
    orders_with_item_price=('price', lambda s: (s > 0).sum()),
    median_paid_to_item=('paid_to_item', 'median'))
daily = daily_o.join(dv, how='outer').reset_index().rename(columns={'ds': 'd'})
daily['avg_order'] = daily.revenue_all / daily.orders_all
daily['conversion_rate_visits'] = daily.buyer_visits / daily.visits
T['daily_site'] = table(daily, 'Daily orders and revenue, and tracked visits by device. bot_visits are dead sessions: one page or none, no click, no scroll, and no order.',
    'one row per server date', 'udp_conversions, conversion_item, udp_hsrce_visits, udp_hsrce_pageviews, udp_clicksce_clicks, journey_events_map',
    ['orders_all and revenue_all count every order. buyer_visits, orders and revenue on this row count orders matched to a non-dead tracked visit.',
     f'orders_ge_hv is orders at or above {HV:.0f}, the report-window 90th percentile rounded to the nearest 10. orders_ge_2hv uses twice that line.',
     'atc_visits and checkout_visits are visits with an add_to_cart or checkout_started event.'])

T['daily_channel_device'] = table(nb.groupby(['d', 'dev_s', 'ch', 'link_ch'], dropna=False).agg(**agg).reset_index(),
    'Daily visits, buyers and revenue by device, referrer channel and campaign-link channel. Dead sessions are excluded.',
    'date x device x referrer channel x campaign-link channel', 'visit extract')

wk = nb.groupby(['week', 'dev_s', 'ch', 'link_ch', 'entry', 'ret'], dropna=False).agg(**agg).reset_index()
T['weekly_entry_cube'] = table(wk, 'Weekly visits, buyers and revenue by device, channel, campaign-link channel, entry page class and returning flag.',
    'Monday week x device x ch x link_ch x entry class x returning', 'visit extract',
    ['The first and last weeks are partial where the visit extract does not cover the whole Monday-Sunday week.'])

src = nb.groupby(['week', 'dev_s', 'link_ch', 'src', 'med', 'camp'], dropna=False).agg(**agg).reset_index()
src = src[src.visits >= 5]
T['weekly_source_campaign'] = table(src, 'Weekly visits, buyers and revenue by device, campaign-link channel, source, medium and campaign (5+ visits in the week).',
    'week x device x link_ch x source x medium x campaign', 'visit extract (session-tag UTMs, else custom_var_k5 / v1 / v4; source falls back to referer_name)')

cd = nb[nb.link_ch.isin(['campaign_email_sms', 'automated_email_flow', 'affiliate'])].groupby(['d', 'link_ch', 'src', 'med', 'camp'], dropna=False).agg(**agg).reset_index()
cd = cd[cd.visits >= 3]
T['campaign_daily'] = table(cd, 'Daily visits, buyers and revenue for email, SMS, flow and affiliate campaign links (3+ visits that day).',
    'date x link_ch x source x medium x campaign', 'visit extract')

mc = nb[nb.link_ch == 'meta'].groupby(['period', 'dev_s', 'utm_content'], dropna=False).agg(**agg).reset_index()
mc_min = 30 if (mc.visits >= 30).any() else 5
mc = mc[mc.visits >= mc_min]
T['meta_creative_period'] = table(mc, f'Meta campaign-link visits by ad creative (utm_content) and period ({mc_min}+ visits).',
    'period x device x utm_content', 'udp_session_tags utm_content')

pr = orders[orders.title != ''].assign(ds=orders.d.dt.strftime('%Y-%m-%d')).groupby(['ds', 'title']).agg(
    orders=('oid', 'size'), revenue=('rev', 'sum'), median_item_price=('price', 'median'), min_item_price=('price', 'min'),
    marked_down_orders=('marked_down', 'sum'), paid_below_item_orders=('paid_below_item', 'sum')).reset_index().rename(columns={'ds': 'd', 'title': 'title'})
pr['title_fullprice_median'] = pr.title.map(base)
T['product_daily'] = table(pr, 'Daily orders and prices by the highest-priced line title.', 'date x item title', 'conversion_item + udp_conversions')

ent = nb[nb.entry == 'product'].copy()
pe = ent.groupby(['period', 'entry_path', 'dev_s', 'link_ch', 'src'], dropna=False).agg(**agg).reset_index()
totals = pe.groupby('entry_path').visits.sum()
threshold = 50 if (totals >= 50).sum() >= 5 else 10
pe = pe[pe.entry_path.isin(totals[totals >= threshold].index) & (pe.visits >= 3)]
T['product_entry_period'] = table(pe, f'Visits that landed on a product URL, by period, product, device and source. Products with {threshold}+ entries; combinations with 3+ visits.',
    'period x product URL x device x link_ch x source', 'visit extract (entry URL)',
    [f'Product keep threshold is {threshold} entries across the visit extract.'])

focus = nb[nb.entry_path == FOCUS].groupby(['d', 'entry_path', 'dev_s', 'link_ch', 'src'], dropna=False).agg(**agg).reset_index()
T['focus_entry_daily'] = table(focus, f'Daily visits that landed on the analysed page ({meta["focusLabel"]}), by device and source.',
    'date x entry path x device x link_ch x source', 'visit extract (entry URL)',
    [f'Analysed page path {FOCUS}. Pipeline datasets in files 07-09 are this page, not the site homepage.'])

pp = pd.DataFrame(json.load(open(os.path.join(SRC, 'page_period.json'))))
if len(pp):
    pp['url'] = pp.url.fillna('').str.replace(r'^https?://[^/]+', '', regex=True)
    pp['dev'] = pp.dev.map({1: 'desktop', 2: 'tablet', 3: 'mobile'}).fillna('unknown')
T['page_period'] = table(pp, 'Visits, buyer visits, entries and entry-buyers by page URL, period and device (10+ visits). Dead sessions are not removed from this table.',
    'page URL x period x device', 'udp_hsrce_pageviews + site_hsr + udp_conversions',
    ['buyer_visits counts a visit that ordered and also reached the page. The order is not attributed to the page.',
     ('Periods: ' + ', '.join(f'{p["name"]} {p["start"]} to {p["end"]}' for p in PERIODS) + '.') if SITE_CALENDAR else f'Periods: pre before {W0}, first through {FIRST_END}, then second.'])

hv = pd.DataFrame(json.load(open(os.path.join(SRC, 'hv_page_reach.json'))))
if len(hv):
    hv['url'] = hv.url.fillna('').str.replace(r'^https?://[^/]+', '', regex=True)
    hv['hv_share'] = hv.hv_visitors / hv.hv_visitors_total.replace(0, np.nan)
    hv['all_share'] = hv.visitors / hv.all_visitors_total.replace(0, np.nan)
    hv['over_index'] = hv.hv_share / hv.all_share
T['high_value_page_reach'] = table(hv, f'Share of device ids with an order of {HV:.0f} or more who visited each page in the report window, against the share of all visitors.',
    'page URL', 'udp_conversions + udp_hsrce_pageviews',
    [f'High value is order revenue >= {HV:.0f}, the report-window 90th percentile rounded to the nearest 10.',
     'Pages with under 100 visitors are kept only when at least 3 high-value visitors reached them.'])

h30 = nb[nb.d >= W0].groupby(['hist30', 'dev_s', 'link_ch'], dropna=False).agg(**agg).reset_index()
T['shopper_history_30d'] = table(h30, f'Visits from {W0} to {W1} by what the same device did in the prior 30 days, split by device and campaign-link channel.',
    'history class x device x link_ch', 'visit extract',
    ['Priority: bought_before, then left_bag, then browsed_deeply_last_visit_no_bag (last prior visit had more than 3 pages, or a click with scroll >= 250 and more than 60 seconds), then browsed_before.',
     'A visit after a purchase in the prior 30 days is bought_before.',
     'returning_last_seen_over_30d is a returning flag with no visit in the prior 30 days. first_visit is the rest. no_device_id has an empty config_id.',
     'Dead sessions are excluded.'])

c = nb.copy()
c['n_prod'] = pd.cut(c.n_prod_urls, [-1, 0, 1, 2, 4, 8, 1e6], labels=['0', '1', '2', '3-4', '5-8', '9+']).astype(str)
c['search'] = np.where(c.e_search > 0, 'searched', 'no search')
c['gap'] = pd.cut(c.hrs_since_last, [0, 1, 24, 72, 168, 336], labels=['<1h', '1-24h', '1-3d', '3-7d', '7-14d']).astype(str).replace('nan', '')
c['hist_email'] = np.where(c.prior_email > 0, 'email click <14d', 'none')
c['hist14'] = np.select([c.prior_buy > 0, c.prior_atc > 0, c.prior_visits > 0], ['bought_lt14d', 'left_bag_lt14d', 'visited_lt14d'], 'no_visit_lt14d')
bands = [-1, 0, 10, 25, 50, 75, 90, 101]
blab = ['0', '1-10', '11-25', '26-50', '51-75', '76-90', '91-100']
for col in ['sc_home', 'sc_coll', 'sc_prod']:
    c[col + '_band'] = np.where(c[col] > 0, pd.cut(c[col] / 10, bands, labels=blab).astype(str), 'not seen')
c['secs_prod_band'] = np.where(c.n_prod_urls > 0, pd.cut(c.secs_prod, [-1, 0, 15, 60, 180, 600, 1e9], labels=['0', '<15s', '15-60s', '1-3m', '3-10m', '10m+']).astype(str), 'no product page')
c['clicks_band'] = pd.cut(c.clicks, [-1, 0, 2, 5, 10, 25, 1e9], labels=['0', '1-2', '3-5', '6-10', '11-25', '26+']).astype(str)
top_c = c.country.value_counts().index[:20]
c['country_top'] = np.where(c.country.isin(top_c), c.country, 'other')
fams = ['ch', 'link_ch', 'email_kind', 'dev_s', 'ret', 'entry', 'hist14', 'hist30', 'hist_email', 'gap', 'n_prod', 'search',
        'saw_home', 'saw_product', 'saw_collection', 'saw_cart', 'saw_search', 'saw_account', 'saw_content', 'coll_to_prod',
        'sc_home_band', 'sc_coll_band', 'sc_prod_band', 'secs_prod_band', 'clicks_band', 'journey3', 'country_top']
cflags = [x for x in c.columns if x.startswith('c_')]
parts = []
for f in fams + cflags:
    g = c.groupby([f, 'period'], dropna=False).agg(**agg).reset_index().rename(columns={f: 'value'})
    g.insert(0, 'family', f)
    g['value'] = g.value.astype(str)
    parts.append(g)
    pk = c[c.peak]
    if len(pk):
        g2 = pk.groupby(f, dropna=False).agg(**agg).reset_index().rename(columns={f: 'value'})
        g2.insert(0, 'family', f)
        g2.insert(1, 'period', 'peak')
        g2['value'] = g2.value.astype(str)
        parts.append(g2)
coh = pd.concat(parts, ignore_index=True)
journey_min = 200 if len(nb) > 500_000 else 50
jsum = coh.loc[coh.family == 'journey3'].groupby('value').visits.sum()
keep_paths = set(jsum[jsum >= journey_min].index)
coh = coh[(coh.family != 'journey3') | coh.value.isin(keep_paths)]
T['visit_cohorts'] = table(coh, f'Behaviour cohorts: visits, buyer visits and revenue for each value, per period. peak is the three highest-revenue days in the report window and overlaps {" or ".join(IN_WINDOW)}.',
    'cohort family x value x period', 'visit extract + click selector flags',
    [f'journey3 keeps paths with {journey_min}+ visits.',
     'Click flags (c_*) are keyword matches on the click selector, for every period including peak.',
     'Conversion = buyer_visits / visits. Dead sessions are excluded.'])

em = nb[(nb.period.isin(IN_WINDOW)) & (nb.ch == 'email_sms') & (nb.cid != '')]
em = em.groupby(['period', 'cid']).agg(email_visits=('ch', 'size'), bought=('buy', 'max')).reset_index()
em['email_visits_band'] = pd.cut(em.email_visits, [0, 1, 2, 1e6], labels=['1', '2', '3+']).astype(str)
T['email_multi_click'] = table(em.groupby(['period', 'email_visits_band'], dropna=False).agg(devices=('cid', 'size'), buyers=('bought', 'sum')).reset_index() if len(em) else pd.DataFrame(columns=['period', 'email_visits_band', 'devices', 'buyers']),
    'Devices that arrived from email or SMS during a period, by how many such visits they made, and whether they bought on any visit in that period.',
    'period x email visit count', 'visit extract')

# pipeline
SEL = {}
def sel_id(s):
    if not s: return None
    if s not in SEL: SEL[s] = len(SEL)
    return SEL[s]

def flat_rows(rows):
    if not rows: return pd.DataFrame()
    sub = pd.DataFrame(rows)
    m = pd.json_normalize([json.loads(x) if isinstance(x, str) and x else {} for x in sub.metrics])
    e = pd.json_normalize([json.loads(x) if isinstance(x, str) and x.startswith('{') else {} for x in sub.dim_extra])
    e.columns = ['x_' + k for k in e.columns]
    m.columns = ['m_' + k for k in m.columns]
    base = sub[['dim_week', 'dim_device', 'dim_source', 'dim_returning', 'dim_element_class', 'dim_surface', 'dim_tool']].reset_index(drop=True)
    base.insert(0, 'selector_id', [sel_id(s) for s in sub.dim_selector.fillna('')])
    out = pd.concat([base, e.reset_index(drop=True), m.reset_index(drop=True)], axis=1)
    keep = []
    for k in out.columns:
        if out[k].notna().any() and not out[k].astype(str).isin(['', 'None', '[]', '{}']).all():
            keep.append(k)
    out = out[keep]
    for k in out.columns:
        if out[k].map(lambda v: isinstance(v, (list, dict))).any():
            out[k] = out[k].map(lambda v: json.dumps(v, separators=(',', ':')) if isinstance(v, (list, dict)) else v)
    return out

P = {}
tc = pd.DataFrame(json.load(open(os.path.join(SRC, 'trigger_chains.json'))))
P['trigger-chains'] = table(tc, 'Trigger chains aggregated from one row per triggering visit to hit date x trigger x device x level x final. Each chain is followed 14 days.',
    'hit date x trigger x device x level x final', 'journey_events.ae_dataset_row_current (trigger-chains)',
    ['final = 1 when the 14-day window had closed by the as-of date of the analysis run.'])
P['trigger-chains']['bot_filter'] = 'exclude_confirmed'
dw = pd.DataFrame(json.load(open(os.path.join(SRC, 'dwell.json'))))
P['dwell-model-inputs'] = table(dw, 'Engaged time on the analysed page, aggregated from one row per session to week x device.',
    'week x device', 'ae_dataset_row_current (dwell-model-inputs)',
    ['median_engaged_ms and p75_engaged_ms are the median and 75th percentile of total engaged time.'])
P['dwell-model-inputs']['bot_filter'] = 'exclude_confirmed'
rt = pd.DataFrame(json.load(open(os.path.join(SRC, 'rage_totals.json'))))
P['rage-clicks:totals'] = table(rt, 'Rage-click totals on the analysed page by week, device and element class.',
    'week x device x element class', 'ae_dataset_row_current (rage-clicks)')
P['rage-clicks:totals']['bot_filter'] = 'exclude_confirmed'

pipe_parts = []
pipe_path = os.path.join(SRC, 'pipeline.jsonl')
if os.path.getsize(pipe_path):
    for chunk in pd.read_json(pipe_path, lines=True, chunksize=100_000):
        pipe_parts.append(chunk)
pl = pd.concat(pipe_parts, ignore_index=True) if pipe_parts else pd.DataFrame()
if len(pl):
    for (ds, bf), sub in pl.groupby(['dataset_id', 'bot_filter'], dropna=False):
        f = flat_rows(sub.to_dict('records'))
        note = []
        if ds == 'rage-clicks':
            note = ['Only selectors with at least one rage session are kept. Totals are in rage-clicks:totals.']
        if ds == 'tap-geometry-weekly':
            note = ['Only selector-weeks with 3+ clicks are kept.']
        if ds == 'render-snapshot':
            note = ['Only nodes with on-screen width and height are kept.']
        key = ds
        P[key] = table(f, f'Pipeline dataset {ds} for the analysed page (bot filter: {bf or "n/a"}).',
            'see columns; dims prefixed dim_, extra dims x_, metrics m_', 'journey_events.ae_dataset_row_current', note)
        P[key]['bot_filter'] = bf or None

bot_total = int(df.bot.sum())
del df, nb, c
print('tables', len(T), 'pipeline', len(P), flush=True)

FILES = [
    ('01_orders.csv', 'Orders', [('tables', 'orders')]),
    ('02_daily_and_campaigns.txt', 'Daily site, channel and campaign series',
     [('tables', 'daily_site'), ('tables', 'daily_channel_device'), ('tables', 'campaign_daily')]),
    ('03_weekly_channels.txt', 'Weekly channel, entry-page, source and Meta creative tables',
     [('tables', 'weekly_entry_cube'), ('tables', 'weekly_source_campaign'), ('tables', 'meta_creative_period')]),
    ('04_products.txt', 'Products: daily sales and prices, product-page entries, the analysed page',
     [('tables', 'product_daily'), ('tables', 'product_entry_period'), ('tables', 'focus_entry_daily'), ('pipeline', 'line-items')]),
    ('05_pages_and_high_value.txt', 'Site pages by period and high-value buyer page reach',
     [('tables', 'page_period'), ('tables', 'high_value_page_reach')]),
    ('06_shoppers_and_cohorts.txt', 'Shopper history, trigger chains, behaviour cohorts, email frequency',
     [('tables', 'shopper_history_30d'), ('pipeline', 'trigger-chains'), ('tables', 'visit_cohorts'), ('tables', 'email_multi_click')]),
    ('07_page_clicks.txt', 'Analysed-page click behaviour by element, plus the CSS selector lookup',
     [('pipeline', 'selector-weekly'), ('pipeline', 'nav-next-page'), ('pipeline', 'tap-geometry-weekly'), ('pipeline', 'rage-clicks'), ('pipeline', 'rage-clicks:totals'),
      ('pipeline', 'element-binding'), ('pipeline', 'kind-fleet-weekly')]),
    ('08_page_layout_engagement.txt', 'Analysed-page layout, exposure, scroll, journeys and segments',
     [('pipeline', 'product-grid'), ('pipeline', 'render-snapshot'), ('pipeline', 'exposure-weekly'), ('pipeline', 'scroll-decile'), ('pipeline', 'viewport-weekly'),
      ('pipeline', 'dwell-model-inputs'), ('pipeline', 'journey-weekly'), ('pipeline', 'funnel-sequence-weekly'), ('pipeline', 'page-segment-weekly'),
      ('pipeline', 'recordings-sample'), ('pipeline', 'page-speed')]),
    ('09_page_channels_and_pipeline.txt', 'Channel and order reads, coverage, and the pipeline strategy verdicts',
     [('pipeline', 'entry-by-channel'), ('pipeline', 'campaign-weekly'), ('pipeline', 'campaign-coverage'), ('pipeline', 'site-baselines'), ('pipeline', 'sister-pages'),
      ('pipeline', 'template-weekly'), ('pipeline', 'page-country'), ('pipeline', 'order-value-hist'), ('pipeline', 'coverage'), ('pipeline', 'audit-readiness'),
      ('pipeline', 'audit-context'), ('pipeline', 'requirement-status'), ('pipeline', 'structural-screen'), ('pipeline', 'strategy-triggers'), ('pipeline', 'card-history'),
      ('pipeline', 'cards-lp'), ('pipeline', 'cards-pg'), ('pipeline', 'cards-pi'), ('pipeline', 'cards-po'), ('pipeline', 'cards-td'), ('pipeline', 'cards-tg'), ('pipeline', 'cards-ti')]),
]
placed = {n for _, _, items in FILES for _, n in items}
extras = [n for n in P if n not in placed]
if extras:
    FILES[-1][2].extend(('pipeline', n) for n in sorted(extras))

def get(kind, name):
    if kind == 'tables': return T[name]
    if kind == 'pipeline': return P.get(name)
    return None

index = []
for fname, title, items in FILES:
    items = [(k, n) for k, n in items if k == 'tables' or n in P or k == 'lookup']
    path = os.path.join(OUTDIR, fname)
    if fname.endswith('.csv'):
        frame_of(get(*items[0])).to_csv(path, index=False)
        index.append((fname, items[0][1], get(*items[0])))
        continue
    buf = io.StringIO()
    buf.write(f'# {fname} - {title}\n')
    buf.write(f'# {meta["name"]} ({DOMAIN}), report window {W0} to {W1}. See 00_README_data_guide.md.\n')
    buf.write(f'# Tables in this file: {", ".join(n for _, n in items)}\n')
    buf.write('# Format: each table starts with a TABLE marker, then metadata, then CSV between BEGIN CSV and END CSV.\n')
    buf.write(f'# Lines starting with "@@" inside the CSV repeat the header every {REPEAT} rows. Skip them when parsing.\n\n')
    # selectors lookup is appended on file 07 after we know used ids. Collect during write of other files first.
    open(path, 'w').write('')  # placeholder
    file_items = items
    index.append((fname, None, file_items))

used_sel = set()
for t in P.values():
    if 'selector_id' in t['columns']:
        i = t['columns'].index('selector_id')
        used_sel.update(int(r[i]) for r in t['rows'] if r[i] is not None)
sel_table = {'description': 'CSS selector lookup for pipeline datasets on the analysed page.', 'grain': 'one row per selector',
             'source': 'ae_dataset_row_current.dim_selector', 'columns': ['selector_id', 'selector'],
             'rows': [[i, s] for s, i in sorted(SEL.items(), key=lambda kv: kv[1]) if i in used_sel], 'notes': []}
sel_table['row_count'] = len(sel_table['rows'])
sel_table['rows'] = [[i, s] for s, i in sorted(SEL.items(), key=lambda kv: kv[1]) if i in used_sel]

def write_block(buf, kind, name, t):
    df = frame_of(t)
    group = {'tables': 'analyst table (site-wide)', 'pipeline': 'pipeline dataset (analysed page or site)', 'lookup': 'lookup'}[kind]
    buf.write(f'=== TABLE: {name} ===\n')
    buf.write(f'type: {group}\n')
    buf.write(f'description: {t["description"]}\n')
    buf.write(f'grain: {t["grain"]}\n')
    buf.write(f'source: {t["source"]}\n')
    if t.get('bot_filter'): buf.write(f'bot_filter: {t["bot_filter"]}\n')
    for n in t.get('notes') or []: buf.write(f'note: {n}\n')
    buf.write(f'rows: {len(df)}\n')
    buf.write(f'columns: {", ".join(map(str, df.columns))}\n')
    buf.write('--- BEGIN CSV ---\n')
    lines = df.to_csv(index=False).splitlines()
    if not lines:
        buf.write('--- END CSV ---\n\n')
        return
    header = lines[0]
    buf.write(header + '\n')
    for i, line in enumerate(lines[1:], 1):
        buf.write(line + '\n')
        if i % REPEAT == 0 and i < len(lines) - 1:
            buf.write(f'@@ {name} | columns: {header}\n')
    buf.write('--- END CSV ---\n\n')

catalog = []
for fname, title, items in FILES:
    items = [(k, n) for k, n in items if k == 'tables' or n in P]
    if fname == '07_page_clicks.txt':
        items.append(('lookup', 'selectors'))
    path = os.path.join(OUTDIR, fname)
    if fname.endswith('.csv'):
        catalog.append((fname, 'orders', T['orders']))
        continue
    buf = io.StringIO()
    buf.write(f'# {fname} - {title}\n')
    buf.write(f'# {meta["name"]} ({DOMAIN}), report window {W0} to {W1}. See 00_README_data_guide.md.\n')
    buf.write(f'# Tables in this file: {", ".join(n for _, n in items)}\n')
    buf.write('# Format: each table starts with a TABLE marker, then metadata, then CSV between BEGIN CSV and END CSV.\n')
    buf.write(f'# Lines starting with "@@" inside the CSV repeat the header every {REPEAT} rows. Skip them when parsing.\n\n')
    for kind, name in items:
        t = sel_table if kind == 'lookup' else get(kind, name)
        write_block(buf, kind, name, t)
        catalog.append((fname, name, t))
    open(path, 'w').write(buf.getvalue())

# anchors
ow = od[(od.d >= W0) & (od.d <= W1)]
median_revenue = ow.order_revenue.median()
median_expect = None if len(ow) == 0 or pd.isna(median_revenue) else round(float(median_revenue), 2)
anchors = [
    {'label': 'orders in report window', 'table': 'orders', 'where': f"d >= '{W0}' and d <= '{W1}'", 'agg': 'count', 'expect': int(len(ow))},
    {'label': 'revenue in report window', 'table': 'orders', 'where': f"d >= '{W0}' and d <= '{W1}'", 'agg': 'sum', 'column': 'order_revenue', 'expect': round(float(ow.order_revenue.sum() or 0), 2), 'tolerance': 1},
    {'label': 'median order revenue in report window', 'table': 'orders', 'where': f"d >= '{W0}' and d <= '{W1}'", 'agg': 'median', 'column': 'order_revenue', 'expect': median_expect, 'tolerance': 0.01},
    {'label': 'high-value orders in report window', 'table': 'orders', 'where': f"d >= '{W0}' and d <= '{W1}' and order_revenue >= {HV}", 'agg': 'count', 'expect': int((ow.order_revenue >= HV).sum())},
    {'label': 'high-value revenue in report window', 'table': 'orders', 'where': f"d >= '{W0}' and d <= '{W1}' and order_revenue >= {HV}", 'agg': 'sum', 'column': 'order_revenue', 'expect': round(float(ow.loc[ow.order_revenue >= HV, 'order_revenue'].sum()), 2), 'tolerance': 1},
]
peak_note = ', '.join(sorted(peak_days))
profile = {
    'site': meta['name'], 'domain': DOMAIN, 'platform': meta['platform'], 'currency': meta['currency'],
    'idsite': meta['idsite'], 'analysed_page': {'path': FOCUS, 'label': meta['focusLabel'], 'idsitehsr': meta['idsitehsr']},
    'guide_file': '00_README_data_guide.md', 'report_file': '10_SITE-NOTES.md',
    'report_window': {'start': W0, 'end': W1},
    'coverage': {'orders': {'start': meta['orderStart'], 'end': meta['orderEnd']}, 'visits': {'start': PRE, 'end': W1}},
    'periods': {**({p['name']: f'{p["start"]} to {p["end"]}' for p in PERIODS} if SITE_CALENDAR else
                   {'pre': f'{PRE} to the day before {W0}', 'first': f'{W0} to {FIRST_END}', 'second': f'the day after {FIRST_END} to {W1}'}),
                'peak': f'three highest-revenue days in the report window: {peak_note}'},
    'catchall_prefixes': ['(small)', '(pages under', '(selectors under', '(campaigns under'],
    'anchors': anchors,
    'reading_notes': [
        'Pipeline datasets in files 07, 08 and 09 are the analysed page named in analysed_page, not the site homepage.',
        'Dead sessions (one page or none, no click, no scroll, no order) are removed from visit-level analyst tables and counted in daily_site.bot_visits. They stay in page_period.',
        f'Periods follow the site calendar: {", ".join(PERIOD_NAMES)}. marked_down uses {BASELINE["name"]} as the price baseline.' if SITE_CALENDAR else
        'There is no confirmed promotion calendar. first and second are calendar halves. marked_down uses the first half as the price baseline.',
        f'High value is order revenue >= {HV:.0f}.',
        *(NOTES.get('profile') or ['Amounts are the revenue stored on the order.']),
    ],
}
json.dump(profile, open(os.path.join(OUTDIR, '00_site_profile.json'), 'w'), indent=2)
json.dump({'anchors': anchors, 'hv': HV, 'peak_days': sorted(peak_days), 'orders': int(len(ow)), 'revenue': anchors[1]['expect']},
          open(os.path.join(OUTDIR, '.anchors.json'), 'w'))

notes = f'''# {meta["name"]} data notes

This file is the report slot in the bundle. There is no separate client opportunity report for this site yet.

- Site: {meta["name"]}, {DOMAIN}, {meta["platform"]}, {meta["currency"]}. Internal site id {meta["idsite"]}.
- Report window: {W0} to {W1}.
- Analysed page: {meta["focusLabel"]} (`{FOCUS}`, idsitehsr {meta["idsitehsr"]}). The pipeline tables describe this page.
- Orders in the window: {len(ow):,}. Revenue: {anchors[1]["expect"]:,.2f}.
- High-value line: {HV:.0f} (90th percentile of order revenue in the window, rounded to the nearest 10).
- Peak days (highest revenue): {peak_note}.
- Dead sessions removed from visit tables: {bot_total:,}. See daily_site.bot_visits.

The full folder keeps every row the extract produced. The `-4mb` folder applies the same trimming rules as the DVF 4mb bundle: small pages, campaigns and selectors are summed into catch-all rows, and long CSS paths are shortened. Where order volume would keep that folder far above 4 MB, orders there are rolled up to day x product x device. The full folder still has one row per order.
'''
# bot count was deleted with df. Read from daily.
open(os.path.join(OUTDIR, '10_SITE-NOTES.md'), 'w').write(notes)

md = io.StringIO()
w = md.write
w(f'# {meta["name"]} data guide\n\n')
w(f'Analyst bundle for {meta["name"]} ({DOMAIN}). The report window is {W0} to {W1}. Pipeline tables are the analysed page `{FOCUS}`, not the site homepage.\n\n')
w(f'- **Site:** {meta["name"]}, {DOMAIN}, {meta["platform"]}, {meta["currency"]}. Internal site id {meta["idsite"]}.\n')
w(f'- **Report window:** {W0} to {W1}.\n')
w(f'- **Visits:** {PRE} to {W1}. **Orders:** {meta["orderStart"]} to {meta["orderEnd"]}.\n')
w(f'- **Generated:** {meta["generated_utc"]}\n')
w('- **Sources:** udp_hsrce_visits, udp_hsrce_pageviews, udp_clicksce_clicks, udp_conversions, conversion_item, journey_events_map, udp_session_tags, site_hsr, journey_events.ae_dataset_row_current\n\n')
w('## Files\n\n| File | Contents |\n| --- | --- |\n| 00_README_data_guide.md | This guide |\n| 00_site_profile.json | Site, periods, anchors, catch-all labels |\n| 10_SITE-NOTES.md | Window, analysed page, and headline counts |\n')
for fname, title, items in FILES:
    names = [n for k, n in items if k == 'tables' or n in P or (fname.startswith('07') and n == 'selectors')]
    if fname.startswith('07'):
        names = [n for k, n in [(k, n) for k, n in items if k == 'tables' or n in P]] + ['selectors']
    w(f'| {fname} | {title}: {", ".join(n for _, n in [(k, n) for k, n in items if k == "tables" or n in P or n == "selectors"])} |\n')
w('\n## How to load a file in code\n\n```python\nimport re, io, pandas as pd\n\ndef load_tables(path):\n    if path.endswith(".csv"):\n        return {"orders": pd.read_csv(path)}\n    txt = open(path, encoding="utf-8").read()\n    out = {}\n    for m in re.finditer(r"^=== TABLE: (\\S+) ===$.*?^--- BEGIN CSV ---\\n(.*?)^--- END CSV ---$", txt, re.S | re.M):\n        body = "\\n".join(l for l in m.group(2).splitlines() if not l.startswith("@@"))\n        out[m.group(1)] = pd.read_csv(io.StringIO(body))\n    return out\n```\n\n')
w('## Periods\n\n')
if SITE_CALENDAR:
    for p in PERIODS:
        about = ' '.join(filter(None, [p.get('about'), 'Markdown detection uses this period as the price baseline.' if p.get('baseline') else None]))
        w(f'- **{p["name"]}:** {p["start"]} through {p["end"]}.{" " + about if about else ""}\n')
else:
    w(f'- **pre:** {PRE} through the day before {W0}. Context before the report window.\n')
    w(f'- **first:** {W0} through {FIRST_END}. First half of the report window. Markdown detection uses this half as the price baseline.\n')
    w(f'- **second:** the day after {FIRST_END} through {W1}.\n')
w(f'- **peak:** {peak_note}. The three highest-revenue days inside the report window. A subset, not a fourth slice of the calendar.\n\n')
w('Dates are server dates. `t_utc` is the order timestamp. `week` is the Monday of the week.\n\n')
w('## Definitions\n\n')
w('**Dead sessions.** A visit with one pageview or none, no click, no scroll, and no order. Removed from visit-level analyst tables (daily channel, weekly, cohorts, history, product entries). Counted in `daily_site.bot_visits`. A buyer who left no page trail is kept, because the visit has an order.\n\n')
w('**ch (referrer channel)**\n\n')
w('- `direct`: referer_type 1\n- `search`: referer_type 2\n- `email_sms`: referer klaviyo, or medium email/flow/sms, or source containing abandon or welcome\n- `meta_paid`: facebook or instagram with a paid medium\n- `meta_untagged`: facebook or instagram with no paid medium\n- `affiliate`: ran, shopmy, or medium affiliate\n- `other`: everything else\n\n')
w('**link_ch (campaign-link channel).** Built from source (utm_source, otherwise the referrer name), medium and campaign.\n\n')
w('- `automated_email_flow`: medium flow or browse_abandonment, or source containing abandon or welcome\n- `affiliate`: medium affiliate, source starting with ran, or shopmy\n- `google_ads`: medium cpc\n- `campaign_email_sms`: medium email, text, sms or newsletter\n- `meta`: facebook, instagram or a paid-social medium, with a medium or campaign set\n- `meta_no_link`: those sources with neither medium nor campaign\n- `no_campaign_link`: no medium and no campaign\n- `other_tagged`: anything else with a tag\n\n')
w('**Shopper history, prior 30 days (`hist30`).** For visits in the report window, using the same device id. Priority is bought, then left a bag (add to cart or checkout), then the last prior visit browsed deeply with no bag, then any earlier browse. A visit after a purchase counts as `bought_before`.\n\n')
w('**Prior 14 days.** `prior_visits`, `prior_atc`, `prior_buy`, `prior_email` and `hrs_since_last` look back 14 days on the same device.\n\n')
w(f'**High value.** Order revenue at or above {HV:.0f}. That is the 90th percentile of order revenue in the report window, rounded to the nearest 10.\n\n')
w('**Click flags (`c_*`).** A visit flag is 1 when any click selector on that visit contains the keyword: cart/bag, menu/drawer/nav, search, swatch/color, add-to-cart, checkout, shop-pay/paypal/afterpay/klarna/affirm, review, faq/accordion, cookie, popup/klaviyo, size.\n\n')
w('**Page class.** From the page rule URL: home (the site root), product (`/products/`), collection (`/collections/`), search, cart or checkout, account, content (`/pages/`), other.\n\n')
w('## Reconciliation\n\nThere is no client opportunity report in this bundle. The anchors in `00_site_profile.json` are computed from `orders` and should match a fresh load of that file.\n\n**Expected gaps**\n\n')
w('- `daily_site.orders` counts orders joined to a non-dead visit. `daily_site.orders_all` counts every order. Unmatched orders and orders on dead-session visits sit in the gap.\n')
w('- `page_period` does not remove dead sessions. Visit tables do.\n')
w('- Pipeline rows use the analysis engine bot filter stored on the dataset (`exclude_confirmed` when that filter was written). Analyst visit tables use the dead-session rule above.\n')
w(f'- Markdown flags use the {BASELINE["name"]} period of the site calendar as the price baseline.\n\n' if SITE_CALENDAR else
  '- Markdown flags use the first half of the window as a baseline. They are not a confirmed promotion calendar.\n\n')
w('**Not included**\n\n- Trend rows and tag-trend rows (they live in the analysis store, not in this extract).\n- A client opportunity write-up.\n')
for note in NOTES.get('notIncluded') or []:
    w(f'- {note}\n')
w('\n## Table catalog\n\n')
for fname, name, t in catalog:
    w(f'### {name}  -  `{fname}`\n\n{t["description"]}\n\n- Grain: {t["grain"]}\n- Rows: {t["row_count"]}\n- Columns: {", ".join(t["columns"])}\n')
    for n in t.get('notes') or []: w(f'- Note: {n}\n')
    w('\n')
open(os.path.join(OUTDIR, '00_README_data_guide.md'), 'w').write(md.getvalue())

total = 0
for f in sorted(os.listdir(OUTDIR)):
    if f.startswith('.'): continue
    s = os.path.getsize(os.path.join(OUTDIR, f))
    total += s
    print(f'{s:>12}  {f}')
print(f'{total:>12}  total')
