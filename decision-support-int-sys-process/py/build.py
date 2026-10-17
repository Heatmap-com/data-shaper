import json, re, sys, datetime as dt
import numpy as np, pandas as pd

OUT = sys.argv[1]
T = {}            # raw-derived tables
P = {}            # pipeline datasets
SEL = {}          # selector -> id

def table(df, description, grain, source, notes=None):
    df = df.copy()
    for c in df.columns:
        if pd.api.types.is_float_dtype(df[c]):
            df[c] = df[c].round(4)
        elif pd.api.types.is_bool_dtype(df[c]):
            df[c] = df[c].astype(int)
        elif pd.api.types.is_datetime64_any_dtype(df[c]):
            df[c] = df[c].dt.strftime('%Y-%m-%d')
    rows = json.loads(df.to_json(orient='values', double_precision=4))
    t = {'description': description, 'grain': grain, 'source': source, 'row_count': len(rows), 'columns': list(df.columns), 'rows': rows}
    if notes: t['notes'] = notes
    return t

def sel_id(s):
    if not s: return None
    if s not in SEL: SEL[s] = len(SEL)
    return SEL[s]

# ---------------------------------------------------------------- visits
df = pd.read_pickle('/tmp/dvf.pkl')
df['src'] = np.where(df.utm != '', df.utm, df.rn)

def link_channel(src, med, camp):
    s, m = src or '', med or ''
    if m == 'flow' or 'abandon' in s or 'welcome' in s or m == 'browse_abandonment': return 'automated_email_flow'
    if m == 'affiliate' or s.startswith('ran') or s == 'shopmy': return 'affiliate'
    if m == 'cpc': return 'google_ads'
    if m in ('email', 'text', 'sms', 'newsletter'): return 'campaign_email_sms'
    if s in ('facebook', 'facebookads', 'ig', 'instagram', 'igshopping') or m in ('paid', 'paidsocial', 'paid_social'):
        return 'meta' if (m or camp) else 'meta_no_link'
    if not m and not camp: return 'no_campaign_link'
    return 'other_tagged'
df['link_ch'] = [link_channel(a, b, c) for a, b, c in zip(df.src, df.med, df.camp)]

df['dev_s'] = df.dev.map({1: 'desktop', 2: 'tablet', 3: 'mobile'}).fillna('unknown')
df['period'] = np.select([df.d < '2026-09-10', df.d <= '2026-09-23', df.d <= '2026-10-04'], ['pre', 'full', 'promo'], 'post')
df['week'] = (df.d - pd.to_timedelta(df.d.dt.dayofweek, unit='D'))
df['atc'] = (df.e_atc > 0).astype(int)
df['co'] = (df.e_co > 0).astype(int)
df['hist14'] = np.select([df.prior_buy > 0, df.prior_atc > 0, df.prior_visits > 0], ['bought_lt14d', 'left_bag_lt14d', 'visited_lt14d'], 'no_visit_lt14d')
nb = df[~df.bot].copy()

agg = dict(visits=('buy', 'size'), buyer_visits=('buy', 'sum'), orders=('n', 'sum'), revenue=('rev', 'sum'), atc_visits=('atc', 'sum'), checkout_visits=('co', 'sum'))

# ---------------------------------------------------------------- orders
orders = pd.DataFrame(json.load(open('/tmp/pc/orders.json')))
orders['d'] = pd.to_datetime(orders.d)
full_price = orders[(orders.d >= '2026-09-10') & (orders.d <= '2026-09-22') & (orders.price > 0)].groupby('title').price.median()
orders['title_fullprice_median'] = orders.title.map(full_price)
orders['marked_down'] = (orders.price > 0) & (orders.price < 0.95 * orders.title_fullprice_median)
orders['paid_to_item'] = np.where(orders.price > 0, orders.rev / (orders.price * orders.qty.clip(lower=1)), np.nan)
orders['paid_below_item'] = orders.paid_to_item < 1

# ---------------------------------------------------------------- 30-day history (Opportunity 1)
sc = pd.DataFrame(json.load(open('/tmp/pc/visit_scroll_max.json')))
hx = pd.DataFrame(json.load(open('/tmp/pc/history_extra.json')))
hx['t0'] = pd.to_datetime(hx.t0, errors='coerce'); hx['d'] = pd.to_datetime(hx.d)
cur = nb[['idvisit', 'cid', 't0', 'd', 'pvs', 'secs', 'clicks', 'e_atc', 'e_co', 'n', 'ret']].merge(sc, on='idvisit', how='left')
hh = pd.concat([hx.assign(ret=0, cur=False), cur.assign(cur=True)], ignore_index=True)
hh = hh[hh.cid != ''].copy()
hh['ts'] = hh.t0.fillna(hh.d)
hh['bag'] = (hh.e_atc > 0) | (hh.e_co > 0)
hh['deep'] = (hh.pvs > 3) | ((hh.clicks > 0) & (hh.sc.fillna(0) >= 250) & (hh.secs > 60))
hh = hh.sort_values(['cid', 'ts'])
res = {}
for cid, g in hh.groupby('cid', sort=False):
    ts = g.ts.values; bag = g.bag.values; buy = (g.n.values > 0); deep = g.deep.values; iv = g.idvisit.values; cu = g.cur.values
    for i in range(len(g)):
        if not cu[i]: continue
        m = (ts < ts[i]) & (ts >= ts[i] - np.timedelta64(30, 'D'))
        if not m.any():
            res[iv[i]] = None; continue
        last = np.where(m)[0][-1]
        res[iv[i]] = 'bought_before' if buy[m].any() else 'left_bag' if bag[m].any() else 'browsed_deeply_last_visit_no_bag' if deep[last] else 'browsed_before'
nb['hist30'] = nb.idvisit.map(res)
nb['hist30'] = np.where(nb.hist30.isna(), np.where(nb.ret == 1, 'returning_last_seen_over_30d', 'first_visit'), nb.hist30)
nb.loc[nb.cid == '', 'hist30'] = 'no_device_id'

# ---------------------------------------------------------------- join orders to visits
vcols = ['idvisit', 'dev_s', 'ch', 'link_ch', 'src', 'med', 'camp', 'utm_content', 'entry', 'eurl', 'pvs', 'secs', 'n_prod_urls', 'clicks', 'saw_private', 'saw_sale',
         'saw_size', 'saw_account', 'saw_newfall', 'e_search', 'ret', 'nvisits', 'prior_visits', 'prior_atc', 'prior_buy', 'prior_email', 'hist30', 'country']
od = orders.merge(nb[vcols], on='idvisit', how='left')
od['matched_visit'] = od.dev_s.notna()
od['odev'] = od.odev.map({1: 'desktop', 2: 'tablet', 3: 'mobile'})
od['eurl'] = od.eurl.fillna('').str.replace('https://dvf.com', '', regex=False)
od = od[['oid', 'd', 't', 'rev', 'title', 'price', 'qty', 'items', 'title_fullprice_median', 'marked_down', 'paid_to_item', 'paid_below_item', 'odev', 'matched_visit'] + vcols[1:]]
od = od.rename(columns={'t': 't_utc', 'rev': 'order_revenue', 'title': 'item_title', 'price': 'item_price', 'odev': 'order_device', 'dev_s': 'visit_device', 'eurl': 'entry_path'})
T['orders'] = table(od, 'Every order from 5 Aug to 10 Oct 2026, with its item and, where the order matched a tracked visit (about 78%), the visit\'s channel, entry page, behaviour and shopper history.',
    'one row per order', 'udp_conversions (FINAL) + conversion_item, left-joined to the visit-level export',
    ['oid is a cityHash64 of the Shopify order id, not the id itself.', 'item_title/item_price come from conversion_item, which carries one item row per order for DVF (multi-item baskets are not itemised).',
     'paid_to_item = order revenue / (item price x qty). About 1.07 at full price (tax and shipping); below 1 means a checkout discount.',
     'marked_down = item price < 95% of that title\'s median item price on 10-22 Sep orders.', 'Visit fields are null when the order did not match a tracked visit, or the visit is outside 26 Aug - 9 Oct.',
     'hist30 is meaningful for visits from 14 Sep onward (see definitions.shopper_history_30d).'])

# ---------------------------------------------------------------- daily site
dv = df.groupby('d').agg(visits_all=('buy', 'size'), bot_visits=('bot', 'sum')).join(nb.groupby('d').agg(**agg))
for dname in ['mobile', 'desktop', 'tablet']:
    dv[f'visits_{dname}'] = nb[nb.dev_s == dname].groupby('d').size()
dv['returning_visits'] = nb[nb.ret == 1].groupby('d').size()
do = orders.groupby('d').agg(orders_all=('oid', 'size'), revenue_all=('rev', 'sum'), orders_ge_1000=('rev', lambda s: (s >= 1000).sum()), orders_ge_2000=('rev', lambda s: (s >= 2000).sum()),
    orders_marked_down=('marked_down', 'sum'), orders_paid_below_item=('paid_below_item', 'sum'), orders_with_item_price=('price', lambda s: (s > 0).sum()),
    median_paid_to_item=('paid_to_item', 'median'))
daily = do.join(dv, how='outer').reset_index().rename(columns={'index': 'd'})
daily['avg_order'] = daily.revenue_all / daily.orders_all
daily['conversion_rate_visits'] = daily.buyer_visits / daily.visits
T['daily_site'] = table(daily, 'Daily site totals: all orders and revenue (5 Aug - 10 Oct) and tracked visits, funnel and device mix (26 Aug - 9 Oct).', 'one row per server date',
    'udp_conversions, conversion_item, udp_hsrce_visits, journey_events_map',
    ['orders_all/revenue_all count every order; buyer_visits/orders/revenue count only orders matched to non-bot tracked visits.', 'visits excludes the Facebook desktop bot burst (bot_visits).',
     'atc_visits / checkout_visits = visits with an add_to_cart / checkout_started event.'])

# ---------------------------------------------------------------- daily channel x device
T['daily_channel_device'] = table(nb.groupby(['d', 'dev_s', 'ch', 'link_ch']).agg(**agg).reset_index(), 'Daily visits, buyers and revenue by device, referrer channel and campaign-link channel (non-bot).',
    'date x device x referrer channel (ch) x campaign-link channel (link_ch)', 'visit-level export (udp_hsrce_visits + udp_conversions + journey_events_map)')

# ---------------------------------------------------------------- weekly cube for channel / watch sections
wk = nb.groupby(['week', 'dev_s', 'ch', 'link_ch', 'entry', 'ret']).agg(**agg).reset_index()
T['weekly_entry_cube'] = table(wk, 'Weekly visits, buyers and revenue by device, channel, campaign-link channel, entry page type and returning flag (non-bot).',
    'ISO week (Monday) x device x ch x link_ch x entry page class x returning', 'visit-level export',
    ['Week of 5 Oct covers Mon-Fri (5-9 Oct) only; week of 25 Aug starts 26 Aug.'])

# ---------------------------------------------------------------- weekly by source / campaign (Meta, search, affiliates)
src = nb.groupby(['week', 'dev_s', 'link_ch', 'src', 'med', 'camp']).agg(**agg).reset_index()
src = src[src.visits >= 5]
T['weekly_source_campaign'] = table(src, 'Weekly visits, buyers and revenue by device, campaign-link channel, source, medium and campaign name (combinations with 5+ visits in the week).',
    'week x device x link_ch x source x medium x campaign', 'visit-level export (session-tag UTMs, else custom_var_k5 / v1 / v4; source falls back to referer_name)')

# ---------------------------------------------------------------- campaign daily (email/sms/affiliate)
cd = nb[nb.link_ch.isin(['campaign_email_sms', 'automated_email_flow', 'affiliate'])].groupby(['d', 'link_ch', 'src', 'med', 'camp']).agg(**agg).reset_index()
cd = cd[cd.visits >= 3]
T['campaign_daily'] = table(cd, 'Daily visits, buyers and revenue for email, SMS, flow and affiliate campaign links (3+ visits per day). This is the campaign calendar behind Opportunity 2.',
    'date x link_ch x source x medium x campaign', 'visit-level export')

# ---------------------------------------------------------------- Meta creative
mc = nb[nb.link_ch == 'meta'].groupby(['period', 'dev_s', 'utm_content']).agg(**agg).reset_index()
mc = mc[mc.visits >= 30]
T['meta_creative_period'] = table(mc, 'Meta campaign-link visits by ad creative (utm_content) and period (30+ visits).', 'period x device x utm_content', 'udp_session_tags utm_content')

# ---------------------------------------------------------------- products
pr = orders[orders.title != ''].groupby(['d', 'title']).agg(orders=('oid', 'size'), revenue=('rev', 'sum'), median_item_price=('price', 'median'), min_item_price=('price', 'min'),
    marked_down_orders=('marked_down', 'sum'), paid_below_item_orders=('paid_below_item', 'sum')).reset_index()
pr['title_fullprice_median'] = pr.title.map(full_price)
T['product_daily'] = table(pr, 'Daily orders and prices by product title, 5 Aug - 10 Oct (Sasha, markdown and dresses-share figures).', 'date x item title', 'conversion_item + udp_conversions')

# ---------------------------------------------------------------- Sasha / product-page entries by source
ent = nb[nb.entry == 'product'].copy()
ent['entry_path'] = ent.eurl.str.replace('https://dvf.com', '', regex=False).str.replace(r'\?.*$', '', regex=True)
pe = ent.groupby(['period', 'entry_path', 'dev_s', 'link_ch', 'src']).agg(**agg).reset_index()
keep = pe.groupby('entry_path').visits.sum()
pe = pe[pe.entry_path.isin(keep[keep >= 100].index) & (pe.visits >= 3)]
T['product_entry_period'] = table(pe, 'Visits that landed directly on a product page, by period, product URL, device and source (products with 100+ entries in 26 Aug - 9 Oct; combinations with 3+ visits).',
    'period x product URL x device x link_ch x source', 'visit-level export (entry URL)')
sd = ent[ent.entry_path.str.contains('sasha', case=False)].groupby(['d', 'entry_path', 'dev_s', 'link_ch', 'src']).agg(**agg).reset_index()
T['sasha_entry_daily'] = table(sd, 'Daily visits that landed directly on a Sasha Dress product page, by device and source. Shows the ShopMy (Anne Sisteron) and Instagram surge on 25-26 Sep.',
    'date x Sasha URL x device x link_ch x source', 'visit-level export (entry URL)')

# ---------------------------------------------------------------- pages
pp = pd.DataFrame(json.load(open('/tmp/pc/page_period.json')))
pp['url'] = pp.url.str.replace('https://dvf.com', '', regex=False)
pp['dev'] = pp.dev.map({1: 'desktop', 2: 'tablet', 3: 'mobile'})
T['page_period'] = table(pp, 'Visits, buyer visits, entries and entry-buyers by page URL, period and device (10+ visits).', 'page URL x period x device',
    'udp_hsrce_pageviews + site_hsr page rules + udp_conversions', ['buyer_visits = visits to the page in a visit that ordered (not necessarily attributed to the page).', 'Periods here: pre = 1-9 Sep.'])

hv = pd.DataFrame(json.load(open('/tmp/pc/hv_page_reach.json')))
hv['url'] = hv.url.str.replace('https://dvf.com', '', regex=False)
hv['hv_share'] = hv.hv_visitors / hv.hv_visitors_total
hv['all_share'] = hv.visitors / hv.all_visitors_total
hv['over_index'] = hv.hv_share / hv.all_share
T['high_value_page_reach'] = table(hv, 'Opportunity 4: share of $1,000+ buyers (by device id) who visited each page during 10 Sep - 9 Oct, against the share of all visitors.', 'page URL',
    'udp_conversions (orders >= $1,000) + udp_hsrce_pageviews', ['187 high-value device ids here vs 188 buyers in the report (one buyer lacks a device id in this join).'])

# ---------------------------------------------------------------- history 30 (Opportunity 1)
h30 = nb[nb.d >= '2026-09-14'].groupby(['hist30', 'dev_s', 'link_ch']).agg(**agg).reset_index()
T['shopper_history_30d'] = table(h30, 'Opportunity 1: visits 14 Sep - 9 Oct by what the same device did in the prior 30 days, by device and the campaign link the visit arrived on.',
    'history class x device x link_ch', 'visit-level export + 12-25 Aug history export',
    ['Recomputed for this bundle with the rules in definitions.shopper_history_30d; counts land within a few percent of the report table, which came from an earlier session.'])

# ---------------------------------------------------------------- cohorts (Opportunity 2 behaviour)
c = nb.copy()
c['n_prod'] = pd.cut(c.n_prod_urls, [-1, 0, 1, 2, 4, 8, 1e6], labels=['0', '1', '2', '3-4', '5-8', '9+']).astype(str)
c['search'] = np.where(c.e_search > 0, 'searched', 'no search')
c['gap'] = pd.cut(c.hrs_since_last, [0, 1, 24, 72, 168, 336], labels=['<1h', '1-24h', '1-3d', '3-7d', '7-14d']).astype(str)
c['hist_email'] = np.where(c.prior_email > 0, 'email click <14d', 'none')
bands = [-1, 0, 10, 25, 50, 75, 90, 101]; blab = ['0', '1-10', '11-25', '26-50', '51-75', '76-90', '91-100']
for col in ['sc_home', 'sc_coll', 'sc_prod']:
    c[col + '_band'] = np.where(c[col] > 0, pd.cut(c[col] / 10, bands, labels=blab).astype(str), 'not seen')
c['secs_prod_band'] = np.where(c.n_prod_urls > 0, pd.cut(c.secs_prod, [-1, 0, 15, 60, 180, 600, 1e9], labels=['0', '<15s', '15-60s', '1-3m', '3-10m', '10m+']).astype(str), 'no product page')
c['clicks_band'] = pd.cut(c.clicks, [-1, 0, 2, 5, 10, 25, 1e9], labels=['0', '1-2', '3-5', '6-10', '11-25', '26+']).astype(str)
def collapse(p):
    o = []
    for s in p.split('>'):
        if s and (not o or o[-1] != s): o.append(s)
    return '>'.join(o[:3])
c['journey3'] = c.path.map(collapse)
top_c = c.country.value_counts().index[:20]
c['country_top'] = np.where(c.country.isin(top_c), c.country, 'other')
fams = ['ch', 'link_ch', 'email_kind', 'dev_s', 'ret', 'entry', 'hist14', 'hist30', 'hist_email', 'gap', 'n_prod', 'search', 'saw_private', 'saw_sale', 'saw_home', 'saw_size', 'saw_account',
        'saw_content', 'saw_newfall', 'coll_to_prod', 'sc_home_band', 'sc_coll_band', 'sc_prod_band', 'secs_prod_band', 'clicks_band', 'journey3', 'country_top']
ck = pd.read_pickle('/tmp/dvf_ck.pkl')
cflags = [x for x in ck.columns if x.startswith('c_')]
c = c.merge(ck[['idvisit'] + cflags], on='idvisit', how='left')
parts = []
for f in fams + cflags:
    for per_col, frame in [('period', c), ('peak', c[c.peak])]:
        g = frame.groupby([f, 'period']).agg(**agg).reset_index().rename(columns={f: 'value'})
        if per_col == 'peak': g['period'] = 'peak'
        if f in cflags:
            g = g[g.period.isin(['full', 'promo', 'peak'])]
        g.insert(0, 'family', f); g['value'] = g.value.astype(str)
        parts.append(g)
coh = pd.concat(parts)
coh = coh[(coh.family != 'journey3') | (coh.groupby(['family', 'value']).visits.transform('sum') >= 200)]
T['visit_cohorts'] = table(coh, 'Opportunity 2 behaviour cohorts: visits, buyer visits and revenue for each behaviour value, per period (pre, full, promo, post, and peak = 25-27 Sep, a subset of promo).',
    'cohort family x value x period', 'visit-level export + click export (c_* flags)',
    ['Click-behaviour families (c_*) cover full and promo periods only.', 'journey3 keeps journeys with 200+ visits across periods.', 'Conversion = buyer_visits / visits.'])

# email multi-click (device level)
em = nb[nb.period.isin(['full', 'promo', 'post'])].groupby(['period', 'cid']).agg(email_visits=('ch', lambda s: (s == 'email_sms').sum()), bought=('buy', 'max')).reset_index()
em = em[(em.cid != '') & (em.email_visits > 0)]
em['email_visits_band'] = pd.cut(em.email_visits, [0, 1, 2, 1e6], labels=['1', '2', '3+']).astype(str)
T['email_multi_click'] = table(em.groupby(['period', 'email_visits_band']).agg(devices=('cid', 'size'), buyers=('bought', 'sum')).reset_index(),
    'Devices that arrived from email/SMS during a period, by how many email/SMS visits they made, and whether they bought on any visit in that period.', 'period x email visit count', 'visit-level export')

# ---------------------------------------------------------------- pipeline datasets
pl = pd.DataFrame(json.load(open('/tmp/pc/pipeline_datasets.json')))
PIPE_DESC = {}
def flat(sub):
    m = pd.json_normalize([json.loads(x) if x else {} for x in sub.metrics])
    e = pd.json_normalize([json.loads(x) if x and x.startswith('{') else {} for x in sub.dim_extra])
    e.columns = ['x_' + k for k in e.columns]
    m.columns = ['m_' + k for k in m.columns]
    base = sub[['dim_week', 'dim_device', 'dim_source', 'dim_returning', 'dim_element_class', 'dim_surface', 'dim_tool']].reset_index(drop=True)
    base.insert(0, 'selector_id', [sel_id(s) for s in sub.dim_selector])
    out = pd.concat([base, e.reset_index(drop=True), m.reset_index(drop=True)], axis=1)
    out = out[[k for k in out.columns if out[k].notna().any() and not (out[k].astype(str).isin(['', 'None', '[]', '{}']).all())]]
    for k in out.columns:
        if out[k].map(lambda v: isinstance(v, (list, dict))).any():
            out[k] = out[k].map(lambda v: json.dumps(v, separators=(',', ':')) if isinstance(v, (list, dict)) else v)
    return out

pl = pl[~pl.dataset_id.isin(['audit-template', 'audit-funnel', 'descriptor-snapshot'])]
for (ds, bf), sub in pl.groupby(['dataset_id', 'bot_filter']):
    note = None
    if ds == 'trigger-chains':
        x = pd.json_normalize([json.loads(v) for v in sub.dim_extra])
        m = pd.json_normalize([json.loads(v) for v in sub.metrics])
        f = pd.concat([sub[['dim_device']].reset_index(drop=True), x[['trigger_key', 'server_date']], m], axis=1)
        f = f.groupby(['server_date', 'trigger_key', 'dim_device', 'level', 'final']).agg(chains=('purchased', 'size'), returned=('returned', 'sum'), purchased=('purchased', 'sum'),
            recovered=('recovered', 'sum'), revenue=('revenue', 'sum')).reset_index()
        P[ds] = table(f, 'Trigger chains (abandoned_cart, showed_interest, super_shopper) aggregated from one row per triggering visit to hit date x trigger x device. Each chain is followed 14 days.',
            'hit date x trigger x device x level x final', 'journey_events.ae_dataset_row_current (dataset trigger-chains)', ['Aggregated for size: the source has 61,038 per-visit rows.', 'final = 1 when the 14-day window had closed by 10 Oct.'])
        continue
    if ds == 'dwell-model-inputs':
        m = pd.json_normalize([json.loads(v) for v in sub.metrics])
        f = pd.concat([sub[['dim_week', 'dim_device']].reset_index(drop=True), m[['total_engaged_ms', 'orders', 'revenue']]], axis=1)
        f = f.groupby(['dim_week', 'dim_device']).agg(sessions=('orders', 'size'), sessions_with_order=('orders', lambda s: (s > 0).sum()), revenue=('revenue', 'sum'),
            median_engaged_ms=('total_engaged_ms', 'median'), p75_engaged_ms=('total_engaged_ms', lambda s: s.quantile(.75))).reset_index()
        P[ds] = table(f, 'Homepage dwell inputs aggregated from one row per session to week x device.', 'week x device', 'ae_dataset_row_current (dwell-model-inputs)', ['Aggregated for size: the source has ~27k per-session rows.'])
        continue
    f = flat(sub)
    if ds == 'rage-clicks':
        tot = f.groupby([k for k in ['dim_week', 'dim_device', 'dim_element_class'] if k in f]).agg(clicking_sessions=('m_clicking_sessions', 'sum'), rage_sessions=('m_rage_sessions', 'sum')).reset_index()
        P[ds + ':totals'] = table(tot, 'Homepage rage-click totals by week, device and element class.', 'week x device x element class', 'ae_dataset_row_current (rage-clicks)')
        f = f[f.m_rage_sessions > 0]
        note = ['Only selectors with at least one rage session are kept; totals are in rage-clicks:totals.']
    if ds == 'tap-geometry-weekly':
        f = f[f.m_clicks >= 3]
        note = ['Only selector-weeks with 3+ clicks are kept.']
    if ds == 'render-snapshot' and 'm_w' in f:
        f = f[(f.m_w > 0) & (f.m_h > 0)]
        note = ['Only nodes with on-screen geometry (w > 0 and h > 0) are kept.']
    if ds == 'descriptor-snapshot':
        note = ['Store/page descriptor JSON as captured; long text fields kept verbatim.']
    key = ds if bf in ('', 'exclude_confirmed', 'none') else f'{ds}'
    P[key] = table(f, f'Pipeline dataset {ds} (bot filter: {bf or "n/a"}).', 'see columns; dims prefixed dim_, extra dims x_, metrics m_', 'journey_events.ae_dataset_row_current', note)
    P[key]['bot_filter'] = bf or None

# ---------------------------------------------------------------- assemble
report_index = [
    {'section': 'The month in numbers / daily orders table', 'tables': ['daily_site', 'orders', 'daily_channel_device']},
    {'section': 'Opportunity 1 - abandoned bags (14-day follow-up)', 'tables': ['pipeline:trigger-chains', 'daily_site']},
    {'section': 'Opportunity 1 - what the last visit says / how bag shoppers come back', 'tables': ['shopper_history_30d', 'visit_cohorts (family hist30, hist14)']},
    {'section': 'Opportunity 1 - homepage returning vs new', 'tables': ['pipeline:page-segment-weekly', 'pipeline:site-baselines', 'weekly_entry_cube']},
    {'section': 'Opportunity 2 - promotion timeline, markdowns, paid vs item price, Sasha', 'tables': ['daily_site', 'orders', 'product_daily', 'product_entry_period', 'sasha_entry_daily', 'campaign_daily']},
    {'section': 'Opportunity 2 - channel lift, entry pages, buyer cohorts, behaviour', 'tables': ['daily_channel_device', 'weekly_entry_cube', 'visit_cohorts', 'email_multi_click', 'page_period', 'meta_creative_period']},
    {'section': 'Opportunity 3 - dresses carousel', 'tables': ['pipeline:product-grid', 'pipeline:selector-weekly', 'pipeline:tap-geometry-weekly', 'pipeline:render-snapshot', 'pipeline:element-binding', 'pipeline:cards-pg', 'pipeline:exposure-weekly']},
    {'section': 'Opportunity 4 - high-value orders and buyers', 'tables': ['orders', 'high_value_page_reach', 'pipeline:order-value-hist', 'pipeline:line-items']},
    {'section': 'Opportunity 5 - spend by channel', 'tables': ['daily_channel_device', 'weekly_source_campaign', 'meta_creative_period', 'pipeline:campaign-weekly', 'pipeline:entry-by-channel']},
    {'section': 'Worth watching - All Clothing desktop traffic, search, Meta', 'tables': ['weekly_entry_cube', 'weekly_source_campaign', 'page_period']},
    {'section': "What's working - hero, navigation, rage clicks, pop-up, engagement", 'tables': ['pipeline:exposure-weekly', 'pipeline:selector-weekly', 'pipeline:nav-next-page', 'pipeline:rage-clicks', 'pipeline:rage-clicks:totals', 'pipeline:scroll-decile', 'pipeline:journey-weekly', 'pipeline:funnel-sequence-weekly']},
]

definitions = {
    'site': {'name': 'DVF (Diane von Furstenberg)', 'domain': 'dvf.com', 'idsite': 5795, 'platform': 'Shopify', 'currency': 'USD'},
    'periods': {'pre': '26 Aug - 9 Sep 2026 (contains the 1-7 Sep sale; page_period uses 1-9 Sep)', 'full': '10-23 Sep 2026, full price baseline',
                'promo': '24 Sep - 4 Oct 2026 (markdowns from 23 Sep; 20% off at checkout / Private Sale 25 Sep - 4 Oct)', 'peak': '25-27 Sep 2026 (subset of promo)',
                'post': '5-9 Oct 2026 (Mon-Fri)', 'report_window': '10 Sep - 9 Oct 2026', 'data_coverage': 'Orders 5 Aug - 10 Oct 2026 (5 Aug is the earliest order in the tracking data); visits, behaviour and channels 26 Aug - 9 Oct 2026 (orders before 26 Aug have no visit fields).', 'channel_and_history_window': '14 Sep - 9 Oct 2026'},
    'dates': 'server_date (UTC). t_utc is order server time in UTC.',
    'device': {'1': 'desktop', '2': 'tablet', '3': 'mobile'},
    'bot_filter': 'Visits with referer_name = facebook, empty utm_medium, empty utm_campaign and desktop device are treated as automated (about 4,000 on 25 Sep and 2,600 on 28 Sep, zero orders). They are excluded from every visit-level table and counted in daily_site.bot_visits. Pipeline datasets use their own exclude_confirmed filter.',
    'ch (referrer channel)': {'direct': 'referer_type 1', 'search': 'referer_type 2', 'email_sms': 'referer klaviyo, or medium email/flow/sms, or source containing abandon/welcome',
                              'meta_paid': 'facebook/instagram with medium paid/paidsocial/paid_social', 'meta_untagged': 'facebook/instagram without a paid medium',
                              'affiliate': 'ran (Rakuten), shopmy, or medium affiliate', 'other': 'everything else'},
    'link_ch (campaign-link channel, Opportunity 5 style)': {
        'automated_email_flow': 'utm_medium flow or browse_abandonment, or source containing abandon/welcome', 'affiliate': 'utm_medium affiliate or source ran*/shopmy',
        'google_ads': 'utm_medium cpc', 'campaign_email_sms': 'utm_medium email/text/sms/newsletter', 'meta': 'facebook/facebookads/ig/instagram/igshopping source or paid/paidsocial medium, with a medium or campaign',
        'meta_no_link': 'Meta referrer with no medium or campaign', 'no_campaign_link': 'no utm_medium and no utm_campaign (search, direct, organic)', 'other_tagged': 'any other tagged link',
        'note': 'source = the session-tag utm_source, else custom_var_k5, else referer_name; medium = the session-tag utm_medium, else custom_var_v1; campaign = the session-tag utm_campaign, else custom_var_v4. Recomputed rules; Opportunity 5 counts were built in an earlier session and may differ by a few percent.'},
    'entry / page classes': {'home': 'dvf.com/', 'private_sale': '/collections/private-sale', 'sale_coll': '/collections/*sale*', 'product': '/products/*',
                             'new_fall_coll': '/collections/new*, *fall*, *zankov*', 'other_coll': 'other /collections/*', 'search': '/search', 'cart': '/cart or checkout',
                             'size_guide': '*size-guide*', 'account': '/account*', 'content': '/pages/*', 'other': 'anything else', 'untracked': 'pageview with no page rule'},
    'shopper_history_14d (hist14, prior_*)': 'Same config_id (device fingerprint) in the 14 days before the visit start. Priority: bought_lt14d > left_bag_lt14d (any add_to_cart) > visited_lt14d > no_visit_lt14d. Lookback data starts 26 Aug.',
    'shopper_history_30d (hist30)': 'Same config_id in the 30 days before the visit (lookback data from 12 Aug). Priority: bought_before > left_bag (add_to_cart or checkout_started) > browsed_deeply_last_visit_no_bag (last prior visit had >3 pageviews, or clicked + scrolled 25%+ + >60s) > browsed_before; with no prior visit in 30 days: returning_last_seen_over_30d if visitor_returning, else first_visit. Only meaningful for visits from 14 Sep.',
    'scroll': 'scroll_y_max_relative is stored on a 0-1000 scale; bands are in percent (value / 10). sc_home / sc_coll / sc_prod are the max scroll on that page class within the visit.',
    'click flags (c_*)': 'From udp_clicksce_clicks CSS selectors matched by keyword: c_size (size selector), c_zoom (image zoom), c_tile_arrows (product-tile image arrows), c_filter, c_sort, c_cart_drawer, c_menu, c_details (product details accordion), c_swatch, c_quick (quick add), c_pay (express pay), c_reviews, c_wish, c_recs, c_sizeguide, c_cookie, c_popup, c_carousel, c_tile.',
    'conversion': 'buyer_visits / visits (share of visits containing an order). orders and revenue are summed over matched orders.',
    'markdown detection': 'An order is marked_down when its item price is below 95% of the median item price that title sold at on 10-22 Sep.',
    'discount detection': 'paid_to_item = order revenue / item price. ~1.07 at full price (tax + shipping); 0.88-0.94 median during the checkout offer.',
    'coverage': 'About 78% of orders match a tracked visit. Visit-level revenue is therefore lower than order totals.',
    'pipeline datasets': 'Rows produced by the analysis-engine pipeline for the DVF homepage (idsitehsr scope) and site. Column prefixes: dim_* stored dimensions, x_* fields from dim_extra, m_* metrics. selector_id points into lookups.selectors.',
}

bundle = {
    'bundle': {'title': 'DVF Site Opportunity Report - portable data bundle', 'report': 'docs/analysis/dvf/DVF-CLIENT-REPORT.md', 'generated_utc': dt.datetime.now(dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
               'purpose': 'All data behind the DVF report (10 Sep - 9 Oct 2026, with 26 Aug - 10 Oct context), aggregated so an analyst or LLM can verify and extend every finding without database access.',
               'format': 'Each table is {description, grain, source, row_count, columns, rows}; rows are arrays aligned to columns.',
               'sources': ['ClickHouse default.udp_hsrce_visits', 'default.udp_hsrce_pageviews', 'default.udp_conversions (FINAL)', 'default.conversion_item', 'default.journey_events_map',
                           'default.udp_clicksce_clicks', 'default.udp_session_tags', 'default.site_hsr', 'journey_events.ae_dataset_row_current']},
    'definitions': definitions,
    'report_section_index': report_index,
    'reconciliation': {
        'exact_matches': [
            'Orders 2,054 and revenue $1,150,879 for 10 Sep - 9 Oct (orders table); average order $560, median $426.',
            'Peak days 25/26/27 Sep: 149 / 144 / 111 orders, $74,177 / $63,450 / $55,124.',
            '$1,000+ orders: 234, $410,982, 35.7% of revenue; largest order $13,559.',
            'Sasha Dress: 36 orders on 25-26 Sep.',
            'Returns & Exchanges page reached by 24 of 187 high-value device ids (12.8%) vs 0.32% of all visitors.'],
        'recomputed_with_different_counting': [
            {'report': 'Opportunity 1 abandoned-bag cohort: 2,699 shoppers, 221 bought within 14 days (8.2%).', 'bundle': 'trigger-chains counts chains (one per triggering visit), not shoppers: 3,356 abandoned_cart chains on 10-25 Sep, 364 purchased. A shopper can trigger several chains. Compare rates by hit date, not absolute counts.'},
            {'report': "Opportunity 1 'What the last visit says' (30-day history).", 'bundle': 'shopper_history_30d is a recomputation. first_visit 116,408 (report 116,345) and left_bag revenue per visit $23.57 (report $23.56) match closely; class sizes differ: left_bag 9,046 vs 10,219, browsed_deeply 13,849 vs 10,842, bought_before 3,038 vs 644. The bundle counts any visit within 30 days after a purchase on the same device (including post-purchase visits) as bought_before; the report evidently did not.'},
            {'report': 'Opportunity 5 channel table (14 Sep - 9 Oct).', 'bundle': 'daily_channel_device with link_ch rebuilt from the rules in definitions. Revenue per visit: flows $18.49 (report $17.77), affiliates $9.03 ($10.26), Google ads $8.18 ($7.65), campaign email/SMS $4.91 ($5.69), no campaign link $4.81 ($4.81), Meta $2.50 ($2.39). Visit counts differ by up to ~15% because channel rules and the bot filter differ.'},
            {'report': "Opportunity 5 'Facebook 7,239 desktop visits, 2 orders'.", 'bundle': 'The bundle removes untagged Facebook desktop visits as bots, so Meta campaign-link desktop visits are 1,131 with 4 orders (14 Sep - 9 Oct). The report counted Facebook desktop visits including untagged ones.'},
            {'report': 'Returns policy over-index 43x.', 'bundle': '12.83% / 0.3205% = 40x in high_value_page_reach (187 device ids vs 188 buyers in the report).'},
            {'report': 'About 78% of orders match a tracked visit.', 'bundle': '80% of 10 Sep - 9 Oct orders match a visit in the 26 Aug - 9 Oct visit export.'},
            {'report': 'n/a', 'bundle': "hist30 'no_device_id' (378 visits, 25% conversion) are visits with no config_id, mostly checkout-adjacent; exclude them from history analysis."}],
        'likely_errors_in_report': [
            "Opportunity 4 says 87% of $1,000+ orders (203 of 234) happened on the shopper's first recorded visit. The tracker's visit-count field (orders.nvisits) is 1 on every order, so it cannot support this. Better measures on the 200 matched high-value orders: 47% had no visit from that device in the prior 30 days (hist30 = first_visit), 57% none in the prior 14 days (prior_visits = 0), 70.5% carry the tracker's new-visitor flag (ret = 0). A further 51 (26%) had left a bag within 30 days. Treat 87% as overstated; roughly half to 70% is defensible depending on definition.",
            "Meta desktop orders: 'The biggest wins' item 4 says 5 orders in four weeks; At a glance row 5 and Opportunity 5 say 2.",
            "'The biggest wins' item 1 says about one in five bag returns arrives from an email flow. The Opportunity 1 table shows ~21% from all email (440 automated flow + 1,645 campaign email of 10,096); only ~4% came from the automated flow.",
            'Opportunity 1 notes the 8.2% bag-to-order rate blends a pre-promotion cohort (~6%) and a promotion cohort (~10%); the biggest-wins framing uses the blended figure as if it were a full-price baseline.'],
        'not_included': [
            'Raw visit-level rows (306k visits) and raw click rows; the bundle carries aggregates and order-level rows only.',
            'Margin, cost of goods, discount-code totals, ad spend, returns/refunds: not in the tracking data. The discount given can be estimated from item_price x qty x ~1.07 minus order_revenue; margin cannot.',
            'Pipeline datasets omitted as unused by the report: an earlier audit run (audit-template, audit-funnel, 6 Oct) and the store descriptor snapshot.',
            'Opportunity 3 carousel figures come from homepage pipeline datasets (selector-weekly, tap-geometry-weekly, product-grid, render-snapshot); tile slots require joining selector_id to the selectors lookup.'],
    },
    'tables': T,
    'pipeline_datasets': P,
    'lookups': {'selectors': [s for s, _ in sorted(SEL.items(), key=lambda kv: kv[1])]},
}
s = json.dumps(bundle, separators=(',', ':'), ensure_ascii=False, allow_nan=False, default=str)
open(OUT, 'w').write(s)
print('bytes', len(s.encode()))
sizes = sorted([(len(json.dumps(v, separators=(',', ':'), default=str)), 'T:' + k) for k, v in T.items()] + [(len(json.dumps(v, separators=(',', ':'), default=str)), 'P:' + k) for k, v in P.items()], reverse=True)
for b, k in sizes[:25]: print(f'{b:>9} {k}')
print('selectors', len(SEL), len(json.dumps(bundle['lookups'])))
