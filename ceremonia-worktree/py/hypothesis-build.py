"""
CSV attachments for the DVF P0 hypothesis brief.

    python3 py/hypothesis-build.py /tmp/hyp/raw docs/analysis/dvf/hypotheses/data

Reads the JSON extracts written by py/hypothesis-export.mjs and the PDP scrape
(pdp_scrape.json in the same folder). Writes one CSV per table plus key_numbers.json,
which holds the figures quoted in the brief.
"""
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

RAW = Path(sys.argv[1])
OUT = Path(sys.argv[2])
OUT.mkdir(parents=True, exist_ok=True)

SEP0, SEP1 = '2026-09-01', '2026-09-30'
OCT0, OCT1 = '2026-10-01', '2026-10-11'
DEV = {1: 'desktop', 2: 'tablet', 3: 'mobile'}
SANA = 'dvf-sana-two-dress-in-black'
PROMO_SHARE = 0.45
KEY = {}


def load(name):
    return pd.DataFrame(json.load(open(RAW / f'{name}.json')))


def write(df, name):
    df.to_csv(OUT / f'{name}.csv', index=False, float_format='%.4f')
    print(f'{name}.csv', len(df))


def monday(d):
    d = pd.to_datetime(d)
    return (d - pd.to_timedelta(d.dt.weekday, unit='D')).dt.strftime('%Y-%m-%d')


def rate(a, b):
    return np.where(b > 0, a / np.maximum(b, 1), np.nan)


def with_all(df, col='device'):
    return pd.concat([df, df.assign(**{col: 'all'})], ignore_index=True)


def cmap_get(m, *keys):
    if not isinstance(m, dict):
        return 0
    return sum(int(m.get(k, 0)) for k in keys)


# ---------------------------------------------------------------- orders and price periods
orders = load('orders')
orders['paid_below_item'] = (orders.item_value > 0) & (orders.rev < orders.item_value * 0.995)
orders['order_device'] = orders.odev.map(DEV)
daily_orders = orders.groupby('d').agg(orders=('oid', 'size'), revenue=('rev', 'sum'),
                                       share_orders_paid_below_item_price=('paid_below_item', 'mean')).reset_index()
daily_orders['promo_day'] = daily_orders.share_orders_paid_below_item_price >= PROMO_SHARE
PROMO_DAYS = set(daily_orders.loc[daily_orders.promo_day, 'd'])


def period_of(d):
    if SEP0 <= d <= SEP1:
        return 'sep_promo_days' if d in PROMO_DAYS else 'sep_full_price_days'
    if OCT0 <= d <= OCT1:
        return 'oct_1_11'
    return 'other'


# ---------------------------------------------------------------- F1 daily site
ev = load('events_daily')
evd = ev.groupby('d')[['event_visits', 'home_visits', 'pdp_visits', 'atc_visits', 'cartpage_visits', 'co_visits', 'done_visits']].sum().reset_index()
f1 = daily_orders.merge(evd, on='d', how='left')
f1['weekday'] = pd.to_datetime(f1.d).dt.day_name().str[:3]
f1['aov'] = rate(f1.revenue, f1.orders)
f1['cart_to_checkout'] = rate(f1.co_visits, f1.atc_visits)
f1['checkout_completion'] = rate(f1.done_visits, f1.co_visits)
f1['period'] = f1.d.map(period_of)
f1 = f1[['d', 'weekday', 'period', 'promo_day', 'share_orders_paid_below_item_price', 'orders', 'revenue', 'aov',
         'pdp_visits', 'atc_visits', 'co_visits', 'done_visits', 'cart_to_checkout', 'checkout_completion']]
write(f1.rename(columns={'d': 'date'}), 'F1_daily_site')

# ---------------------------------------------------------------- visits (recorded sample)
v = load('visits')
v['device'] = v.dev.map(DEV)
v['buy'] = (v.n > 0).astype(int)
v['period'] = v.d.map(period_of)
v['week'] = monday(v.d)
v['seq_l'] = v.seq.fillna('').map(lambda s: [tuple(x.split(':', 1)) for x in s.split('|')] if s else [])
v['pcs'] = v.seq_l.map(lambda l: [p for p, _ in l])
for pc in ['home', 'product', 'collection', 'help', 'size_guide', 'search', 'cart']:
    v[f'saw_{pc}'] = v.pcs.map(lambda l, pc=pc: int(pc in l))
v['saw_sana'] = v.seq_l.map(lambda l: int(any(p == 'product' and h == SANA for p, h in l)))
v['help_pages'] = v.seq_l.map(lambda l: ','.join(sorted({h for p, h in l if p == 'help'})))
v['has_clicks'] = (v.clicks > 0).astype(int)
for k, keys in {
    'c_qty_change': ('cart_qty_plus', 'cart_qty_minus', 'cart_qty_input', 'cart_qty_other'),
    'c_qty_plus': ('cart_qty_plus',), 'c_qty_minus': ('cart_qty_minus',), 'c_qty_input': ('cart_qty_input',),
    'c_remove': ('cart_remove',), 'c_drawer_close': ('drawer_close',), 'c_drawer_checkout': ('drawer_checkout',),
    'c_cartpage_checkout': ('cartpage_checkout',), 'c_cart_recs': ('cart_recs',), 'c_header_cart': ('header_cart',),
    'c_add_to_bag': ('pdp_add_to_bag',), 'c_buy_now': ('pdp_buy_now',), 'c_waitlist': ('pdp_waitlist',),
    'c_size_guide': ('pdp_size_guide_open',), 'c_size_fit': ('pdp_acc_9',), 'c_quick_add': ('quick_add',),
    'c_search_close': ('search_close',),
}.items():
    v[k] = v.cmap.map(lambda m, keys=keys: int(cmap_get(m, *keys) > 0))

sep = v[(v.d >= SEP0) & (v.d <= SEP1)].copy()


def funnel(g):
    return pd.Series(dict(
        recorded_visits=len(g), home_visits=g.saw_home.sum(), pdp_visits=g.saw_product.sum(),
        atc_visits=g.e_atc.sum(), checkout_started_visits=g.e_co.sum(), checkout_completed_visits=g.e_done.sum(),
        buyer_visits=g.buy.sum(), orders=g.n.sum(), revenue=g.rev.sum()))


rows = []
for per, g0 in [('sep_all', sep), ('sep_full_price_days', sep[sep.period == 'sep_full_price_days']),
                ('sep_promo_days', sep[sep.period == 'sep_promo_days']), ('oct_1_11', v[v.period == 'oct_1_11'])]:
    for dev, g in list(g0.groupby('device')) + [('all', g0)]:
        rows.append(dict(period=per, device=dev, **funnel(g)))
f2 = pd.DataFrame(rows)
f2['conversion_rate'] = rate(f2.buyer_visits, f2.recorded_visits)
f2['atc_rate_of_pdp_visits'] = rate(f2.atc_visits, f2.pdp_visits)
f2['cart_to_checkout'] = rate(f2.checkout_started_visits, f2.atc_visits)
f2['checkout_completion'] = rate(f2.checkout_completed_visits, f2.checkout_started_visits)
f2['aov'] = rate(f2.revenue, f2.orders)
ndays = {'sep_all': 30, 'oct_1_11': 11,
         'sep_full_price_days': int(((f1.period == 'sep_full_price_days')).sum()),
         'sep_promo_days': int(((f1.period == 'sep_promo_days')).sum())}
f2['days'] = f2.period.map(ndays)
write(f2, 'F2_funnel_by_period_device')

# ---------------------------------------------------------------- F4 revenue exposure (all orders)
os_ = orders[(orders.d >= SEP0) & (orders.d <= SEP1)]
fp = orders[orders.d.map(period_of) == 'sep_full_price_days']
f4 = []
for dev, g in list(os_.groupby('order_device')) + [('all', os_)]:
    g_fp = fp if dev == 'all' else fp[fp.order_device == dev]
    nfp = ndays['sep_full_price_days']
    f4.append(dict(device=dev, sep_orders=len(g), sep_revenue=g.rev.sum(), sep_aov=g.rev.mean(),
                   full_price_days=nfp, full_price_orders=len(g_fp), full_price_revenue=g_fp.rev.sum(),
                   full_price_aov=g_fp.rev.mean(), full_price_revenue_per_30_days=g_fp.rev.sum() / nfp * 30))
f4 = pd.DataFrame(f4)
write(f4, 'F4_revenue_by_order_device')
KEY['revenue'] = f4.set_index('device').to_dict('index')
KEY['promo_days_sep'] = sorted(d for d in PROMO_DAYS if SEP0 <= d <= SEP1)

# ---------------------------------------------------------------- page facts (live HTML, 12 Oct 2026)
scrape = json.load(open(RAW / 'pdp_scrape.json'))
n_s = len(scrape)
facts = [
    ('PDP', 'Purchase buttons', f"'Add to Bag' plus 'Buy it Now' on {sum(o['has_buy_it_now'] for o in scrape)}/{n_s} top PDPs; a hidden 'Waitlist' button replaces Add to Bag for sold-out sizes", 'H8'),
    ('PDP', 'Quantity', f"No visible quantity selector; the form posts a hidden quantity=1 on {sum(o['qty_input_hidden'] for o in scrape)}/{n_s} top PDPs", 'H4, H8'),
    ('PDP', 'Reassurance line under buttons', f"'Free Shipping and Returns on All Orders' on {sum(o['free_ship_returns_line'] for o in scrape)}/{n_s} top PDPs", 'H1'),
    ('PDP', 'Model height and size', f"Stated on {sum(bool(o['size_fit_text'] and ' is ' in o['size_fit_text'] and 'size' in o['size_fit_text'].lower() and 'wearing' in o['size_fit_text']) for o in scrape)}/{n_s} top PDPs, always inside the collapsed 'Size & Fit' accordion (block 9), never on the images", 'H9'),
    ('PDP', 'Model size worn', "Every stated model wears size XS", 'H9, H10'),
    ('PDP', 'Fit recommendation', f"'If in between sizes we recommend sizing down' on {sum('recommend' in o['size_fit_text'].lower() for o in scrape)}/{n_s}; fit words ('fitted', 'relaxed fit', 'true to size') appear in the Description on {sum(o['fit_phrase_in'] == 'description' for o in scrape)}/{n_s}", 'H10'),
    ('PDP', 'Size guide', f"'Size guide' link beside the size selector opens a modal chart (chest, waist, hips, US/UK/EU) on {sum(o['size_guide_modal'] for o in scrape)}/{n_s}; the modal says 'please use this chart as a general guide. If you are between sizes or need assistance, please contact Client Services'", 'H10'),
    ('PDP', 'Block order', "Product form holder (size, colour, size guide) = 5, buttons = 6, reassurance line = 7, Description (open by default) = 8, Size & Fit = 9, Fabric & Care = 10, Reviews = 11, Shop the Print = 12; identical on all top PDPs scraped", 'H8, H9, H10'),
    ('Cart drawer', 'Line item', "Image, title, colour, size, price, then quantity counter (minus / input / plus) and a 'Remove' link under the price", 'H4'),
    ('Cart drawer', 'Header', "'Cart N items' with close button and 'Your order qualifies for free shipping' bar", 'H1, H4'),
    ('Cart drawer', 'Footer', "Subtotal, 'Shipping, taxes, and discount codes are calculated at checkout', 'Check Out' button", 'H1, H4'),
    ('Cart drawer', 'Recommendations', "Tabs 'Recently Viewed' and 'Frequently Bought Together' (Nosto) below the footer", 'H4'),
    ('Cart page', 'Layout', "Same line item; aside holds free-shipping bar, subtotal, gift note, 'Update Cart', 'Check Out', 'Pair with'", 'H4'),
    ('Checkout', 'Pay Now step', "Shopify checkout is not recorded by Heatmap on this site: no checkout URL in the tracked pages, so there are no clicks, scroll or time on the payment step", 'H1'),
    ('Homepage', 'Mobile header', "Hamburger menu and search icon on the left, cart on the right; category links live inside the menu drawer (rs-mobile-nav-columns)", 'H14'),
]
write(pd.DataFrame(facts, columns=['page', 'element', 'observed', 'hypotheses']), 'F5_page_facts')

model_inv = pd.DataFrame([dict(
    handle=o['handle'], sept_pdp_pageviews=o['sept_pdp_pageviews'], size_fit_text=o['size_fit_text'].replace(' Size Guide', '').strip(),
    model_statement_present=int('wearing' in o['size_fit_text']),
    model_size_worn=(o['size_fit_text'].split('size ')[-1].split()[0].strip('.') if 'wearing' in o['size_fit_text'] else ''),
    sizing_advice_present=int('recommend' in o['size_fit_text'].lower()),
    fit_phrase_in_description=o['fit_phrase'] if o['fit_phrase_in'] == 'description' else '',
    location='Size & Fit accordion (collapsed by default)') for o in scrape])
write(model_inv, 'H9_model_info_inventory')
KEY['model_inventory'] = dict(pages=n_s, with_model=int(model_inv.model_statement_present.sum()),
                              with_advice=int(model_inv.sizing_advice_present.sum()),
                              sizes_worn=model_inv.model_size_worn.value_counts().to_dict())

# ---------------------------------------------------------------- H1 checkout
co = v[v.e_co == 1].copy()
co['week'] = monday(co.d)
w = co.groupby(['week', 'device']).agg(checkout_started_visits=('idvisit', 'size'), buyer_visits=('buy', 'sum')).reset_index()
w_all = co.groupby('week').agg(checkout_started_visits=('idvisit', 'size'), buyer_visits=('buy', 'sum')).reset_index().assign(device='all')
w = pd.concat([w, w_all])
w['checkout_completion'] = rate(w.buyer_visits, w.checkout_started_visits)
w['scope'] = 'recorded_sample'
ew = f1[['d', 'co_visits', 'done_visits']].copy()
ew['week'] = monday(ew.d)
ew = ew.groupby('week')[['co_visits', 'done_visits']].sum().reset_index().rename(columns={'co_visits': 'checkout_started_visits', 'done_visits': 'buyer_visits'})
ew['device'] = 'all'
ew['checkout_completion'] = rate(ew.buyer_visits, ew.checkout_started_visits)
ew['scope'] = 'all_sessions_event_table'
pw = f1.assign(week=monday(f1.d)).groupby('week').promo_day.sum().rename('promo_days_in_week').reset_index()
h1w = pd.concat([ew, w]).merge(pw, on='week', how='left').sort_values(['scope', 'device', 'week'])
write(h1w[['scope', 'week', 'device', 'promo_days_in_week', 'checkout_started_visits', 'buyer_visits', 'checkout_completion']], 'H1_checkout_completion_weekly')

cs = co[(co.d >= SEP0) & (co.d <= SEP1)].copy()
cs['saw_help_page'] = np.where(cs.saw_help == 1, 'yes', 'no')
cs['size_guide_used'] = np.where((cs.saw_size_guide == 1) | (cs.c_size_guide == 1), 'yes', 'no')
cs['visitor'] = np.where(cs.ret == 1, 'returning', 'new')
cs['price_period'] = cs.period
segs = []
for fam in ['saw_help_page', 'size_guide_used', 'visitor', 'price_period']:
    for (dev, val), g in list(cs.groupby(['device', fam])) + [(('all', k), g) for k, g in cs.groupby(fam)]:
        segs.append(dict(segment=fam, value=val, device=dev, checkout_started_visits=len(g), buyer_visits=int(g.buy.sum()),
                         checkout_completion=g.buy.mean()))
write(pd.DataFrame(segs).sort_values(['segment', 'device', 'value']), 'H1_checkout_starters_by_segment')

hp = cs[cs.saw_help == 1].help_pages.str.split(',').explode().value_counts().rename_axis('help_page').reset_index(name='checkout_started_visits_that_viewed')
hp['share_of_checkout_started_visits'] = hp.checkout_started_visits_that_viewed / len(cs)
write(hp, 'H1_help_pages_viewed_by_checkout_starters')

# Checkout abandoners followed for 14 days on the same device id.
vv = v[~v.cid_blank.astype(bool)].copy()
vv['t0'] = pd.to_datetime(vv.t0)
ab = vv[(vv.e_co == 1) & (vv.buy == 0) & (vv.d >= SEP0) & (vv.d <= '2026-09-27')].sort_values('t0').drop_duplicates('cid')
later = vv[['cid', 't0', 'buy', 'rev']].rename(columns={'t0': 't_later', 'buy': 'buy_later', 'rev': 'rev_later'})
m = ab[['cid', 't0', 'device']].merge(later, on='cid')
m = m[(m.t_later > m.t0) & (m.t_later <= m.t0 + pd.Timedelta(days=14))]
agg = m.groupby('cid').agg(returned=('t_later', 'size'), bought=('buy_later', 'max'), later_rev=('rev_later', 'sum'),
                           first_buy=('t_later', lambda s: s[m.loc[s.index, 'buy_later'] == 1].min()))
ab = ab.merge(agg, left_on='cid', right_index=True, how='left')
ab['days_to_buy'] = (ab.first_buy - ab.t0).dt.total_seconds() / 86400
fu = []
for dev, g in list(ab.groupby('device')) + [('all', ab)]:
    fu.append(dict(device=dev, abandoning_visitors=len(g), returned_within_14d=int(g.returned.notna().sum()),
                   bought_within_14d=int((g.bought == 1).sum()), share_returned=g.returned.notna().mean(),
                   share_bought=(g.bought == 1).mean(), later_revenue=g.loc[g.bought == 1, 'later_rev'].sum(),
                   median_days_to_purchase=g.days_to_buy.median()))
write(pd.DataFrame(fu), 'H1_checkout_abandoner_followup')

# ---------------------------------------------------------------- H4 cart controls
cart = sep[(sep.e_atc == 1) & (sep.has_clicks == 1)].copy()
ctl = ['c_qty_plus', 'c_qty_minus', 'c_qty_input', 'c_qty_change', 'c_remove', 'c_drawer_close', 'c_drawer_checkout',
       'c_cartpage_checkout', 'c_cart_recs', 'c_header_cart']
rows = []
for dev, g in list(cart.groupby('device')) + [('all', cart)]:
    for c in ctl:
        rows.append(dict(device=dev, control=c[2:], atc_visits_with_click_recording=len(g), visits_clicking=int(g[c].sum()),
                         share_of_atc_visits=g[c].mean(),
                         checkout_start_rate_if_clicked=g.loc[g[c] == 1, 'e_co'].mean(),
                         purchase_rate_if_clicked=g.loc[g[c] == 1, 'buy'].mean()))
write(pd.DataFrame(rows), 'H4_cart_controls')

cart['qty_group'] = np.select([cart.c_qty_change == 1, cart.c_remove == 1], ['changed_quantity', 'removed_item_only'], 'no_quantity_control')
rows = []
for (dev, grp), g in list(cart.groupby(['device', 'qty_group'])) + [(('all', k), g) for k, g in cart.groupby('qty_group')]:
    rows.append(dict(device=dev, group=grp, atc_visits=len(g), share=len(g) / len(cart if dev == 'all' else cart[cart.device == dev]),
                     checkout_start_rate=g.e_co.mean(), purchase_rate=g.buy.mean(),
                     clicked_drawer_close=g.c_drawer_close.mean(), clicked_drawer_checkout=g.c_drawer_checkout.mean()))
write(pd.DataFrame(rows).sort_values(['device', 'group']), 'H4_quantity_interaction_outcomes')

u = os_.copy()
u['units_on_recorded_line'] = np.where(u.units >= 3, '3+', u.units.astype(str))
h4u = u.groupby(['order_device', 'units_on_recorded_line']).agg(orders=('oid', 'size'), revenue=('rev', 'sum')).reset_index()
h4u_all = u.groupby('units_on_recorded_line').agg(orders=('oid', 'size'), revenue=('rev', 'sum')).reset_index().assign(order_device='all')
h4u = pd.concat([h4u, h4u_all])
h4u['share_of_orders'] = h4u.orders / h4u.groupby('order_device').orders.transform('sum')
write(h4u.rename(columns={'order_device': 'device'}), 'H4_units_per_order')

# ---------------------------------------------------------------- PDP pageviews
pp = load('pdp_pageviews')
pp = pp[pp.idvisit.isin(set(v.idvisit))].copy()
pp['device'] = pp.dev.map(DEV)
pp['period'] = pp.d.map(period_of)
vk = v.set_index('idvisit')[['buy', 'e_atc', 'e_co', 'has_clicks']]
pp = pp.join(vk, on='idvisit')
for k, keys in {
    'add_to_bag': ('pdp_add_to_bag',), 'buy_now': ('pdp_buy_now',), 'waitlist': ('pdp_waitlist',),
    'size_option': ('pdp_size_option',), 'size_guide_open': ('pdp_size_guide_open',),
    'size_guide_table': ('pdp_size_guide_table',), 'size_fit_open': ('pdp_acc_9',), 'size_fit_guide_link': ('pdp_acc_link_9',),
    'fabric_care_open': ('pdp_acc_10',), 'description_toggle': ('pdp_acc_8',), 'reviews': ('pdp_reviews',),
    'gallery': ('pdp_gallery',), 'color_swatch': ('pdp_color_swatch',),
}.items():
    pp[k] = pp.cmap.map(lambda m, keys=keys: int(cmap_get(m, *keys) > 0))
pp['clicked_anything'] = pp.cmap.map(lambda m: int(isinstance(m, dict) and sum(m.values()) > 0))
pps = pp[pp.period.isin(['sep_full_price_days', 'sep_promo_days'])]
FLAGS = ['add_to_bag', 'buy_now', 'waitlist', 'size_option', 'size_guide_open', 'size_guide_table', 'size_fit_open',
         'size_fit_guide_link', 'fabric_care_open', 'reviews', 'gallery', 'color_swatch']


def pdp_visit_table(df, scope):
    g = df.groupby(['idvisit', 'device'])[FLAGS + ['clicked_anything']].max().reset_index()
    g = g.join(vk[['buy', 'e_atc']], on='idvisit')
    out = []
    for dev, x in list(g.groupby('device')) + [('all', g)]:
        for denom, y in [('all_pdp_visits', x), ('pdp_visits_with_any_click', x[x.clicked_anything == 1])]:
            r = dict(scope=scope, device=dev, denominator=denom, visits=len(y))
            for f in FLAGS:
                r[f'share_{f}'] = y[f].mean()
            r['share_atc_event'] = y.e_atc.mean()
            r['share_purchase'] = y.buy.mean()
            bn, ab_ = y.buy_now.sum(), y.add_to_bag.sum()
            r['buy_now_share_of_purchase_button_clickers'] = bn / max(bn + ab_, 1)
            out.append(r)
    return out


rows = pdp_visit_table(pps, 'all_pdps') + pdp_visit_table(pps[pps.handle == SANA], SANA)
write(pd.DataFrame(rows), 'PDP_engagement_by_device')

# H8: CTA outcomes by which purchase button the visit used
g = pps.groupby(['idvisit', 'device'])[['add_to_bag', 'buy_now', 'waitlist']].max().reset_index().join(vk[['buy', 'e_co']], on='idvisit').join(v.set_index('idvisit')[['rev']], on='idvisit')
g['cta_group'] = np.select([(g.buy_now == 1) & (g.add_to_bag == 1), g.buy_now == 1, g.add_to_bag == 1, g.waitlist == 1],
                           ['both', 'buy_it_now_only', 'add_to_bag_only', 'waitlist_only'], 'no_purchase_button')
rows = []
for (dev, grp), x in list(g.groupby(['device', 'cta_group'])) + [(('all', k), x) for k, x in g.groupby('cta_group')]:
    rows.append(dict(device=dev, cta_group=grp, pdp_visits=len(x), checkout_start_rate=x.e_co.mean(), purchase_rate=x.buy.mean(),
                     buyer_visits=int(x.buy.sum()), visit_revenue=x.rev.sum()))
h8 = pd.DataFrame(rows)
h8['share_of_pdp_visits'] = h8.pdp_visits / h8.groupby('device').pdp_visits.transform('sum')
write(h8.sort_values(['device', 'cta_group']), 'H8_purchase_button_outcomes')

clicks_pp = pps.cmap.map(lambda m: m if isinstance(m, dict) else {})
cta_clicks = pd.DataFrame({'device': pps.device, 'add_to_bag': clicks_pp.map(lambda m: int(m.get('pdp_add_to_bag', 0))),
                           'buy_now': clicks_pp.map(lambda m: int(m.get('pdp_buy_now', 0))),
                           'waitlist': clicks_pp.map(lambda m: int(m.get('pdp_waitlist', 0)))})
cc = with_all(cta_clicks).groupby('device')[['add_to_bag', 'buy_now', 'waitlist']].sum().reset_index()
cc['buy_now_share_of_add_to_bag_plus_buy_now_clicks'] = cc.buy_now / (cc.buy_now + cc.add_to_bag)
write(cc.rename(columns={'add_to_bag': 'add_to_bag_clicks', 'buy_now': 'buy_it_now_clicks', 'waitlist': 'waitlist_clicks'}), 'H8_purchase_button_clicks')

# Product table: top 30 products by September PDP visits
top = pps.groupby('handle').idvisit.nunique().sort_values(ascending=False).head(30).index
rows = []
for h in top:
    x = pps[pps.handle == h]
    for dev, y in [('mobile', x[x.device == 'mobile']), ('all', x)]:
        gv = y.groupby('idvisit')[FLAGS].max().join(vk[['buy', 'e_atc']])
        r = dict(handle=h, device=dev, pdp_visits=len(gv))
        for f in ['add_to_bag', 'buy_now', 'waitlist', 'size_option', 'size_guide_open', 'size_fit_open', 'gallery']:
            r[f'share_{f}'] = gv[f].mean()
        r['share_atc_event_in_visit'] = gv.e_atc.mean()
        r['share_purchase_in_visit'] = gv.buy.mean()
        rows.append(r)
write(pd.DataFrame(rows), 'PDP_top30_products')

# H9/H10: sizing behaviour on the pageview against Add to Bag on that pageview
pps = pps.copy()
pps['sizing_segment'] = np.select(
    [(pps.size_guide_open == 1) & (pps.size_fit_open == 1), pps.size_guide_open == 1, pps.size_fit_open == 1,
     pps.size_targets >= 3, pps.size_option == 1, pps.clicked_anything == 1],
    ['size_guide_and_size_fit', 'size_guide_only', 'size_fit_accordion_only', 'tapped_3plus_sizes_no_guide', 'tapped_1_2_sizes_no_guide',
     'clicked_but_no_sizing_control'], 'no_clicks_recorded')
rows = []
for (dev, seg), x in list(pps.groupby(['device', 'sizing_segment'])) + [(('all', k), x) for k, x in pps.groupby('sizing_segment')]:
    rows.append(dict(device=dev, sizing_segment=seg, pdp_pageviews=len(x), add_to_bag_on_pageview=x.add_to_bag.mean(),
                     waitlist_on_pageview=x.waitlist.mean(), purchase_in_visit=x.buy.mean(),
                     median_seconds_on_page=x.top_ms.median() / 1000, median_scroll_pct=x.scroll.median() / 10))
h9 = pd.DataFrame(rows)
h9['share_of_pageviews'] = h9.pdp_pageviews / h9.groupby('device').pdp_pageviews.transform('sum')
write(h9.sort_values(['device', 'sizing_segment']), 'H9_H10_sizing_behaviour_vs_add_to_bag')

sg = pps[pps.size_guide_open == 1].copy()
sg['added_after_guide'] = ((sg.add_to_bag == 1) & (sg.t_add_last > sg.t_sg)).astype(int)
sg['secs_guide_to_add'] = np.where(sg.added_after_guide == 1, (sg.t_add_last - sg.t_sg) / 1000, np.nan)
rows = []
for dev, x in list(sg.groupby('device')) + [('all', sg)]:
    rows.append(dict(device=dev, pageviews_with_size_guide_open=len(x), share_used_size_table=x.size_guide_table.mean(),
                     share_also_opened_size_fit=x.size_fit_open.mean(), share_added_to_bag_after_guide=x.added_after_guide.mean(),
                     share_waitlist=x.waitlist.mean(), median_seconds_guide_to_add=np.nanmedian(x.secs_guide_to_add) if x.added_after_guide.any() else np.nan,
                     share_left_page_without_adding=1 - x.add_to_bag.mean(), purchase_in_visit=x.buy.mean()))
write(pd.DataFrame(rows), 'H10_size_guide_sequence')


# ---------------------------------------------------------------- H14 homepage
hpv = load('home_pageviews')
hpv = hpv[hpv.idvisit.isin(set(v.idvisit))].copy()
hpv['device'] = hpv.dev.map(DEV)
hpv = hpv.sort_values('t').drop_duplicates('idvisit')
vs = v.set_index('idvisit')


def after_home(seq):
    pcs = [p for p, _ in seq]
    if 'home' not in pcs:
        return ('none', 0)
    i = pcs.index('home')
    nxt = pcs[i + 1] if i + 1 < len(pcs) else 'exit'
    later = int(any(p in ('collection', 'product') for p in pcs[i + 1:]))
    return (nxt, later)


ah = vs.seq_l.map(after_home)
vs['next_after_home'] = ah.map(lambda t: t[0])
vs['coll_or_pdp_after_home'] = ah.map(lambda t: t[1])
vs['home_entry'] = vs.pcs.map(lambda l: int(bool(l) and l[0] == 'home'))
hpv = hpv.join(vs[['next_after_home', 'coll_or_pdp_after_home', 'home_entry', 'buy', 'rev', 'period']], on='idvisit')
hpv['next_page'] = hpv.next_after_home.map(lambda x: {'collection': 'collection', 'product': 'product', 'exit': 'exit',
                                                       'home': 'home_again', 'search': 'search'}.get(x, 'other_page'))
for k, keys in {'menu_open': ('menu_open',), 'menu_link': ('menu_link',), 'search_open': ('search_open', 'search_use'),
                'content_tile': ('content_product_tile',), 'content_other': ('content_other',), 'popup_close': ('popup_close',),
                'popup_form': ('popup_form',), 'cookie': ('cookie',), 'search_close_artifact': ('search_close',)}.items():
    hpv[k] = hpv.cmap.map(lambda m, keys=keys: int(cmap_get(m, *keys) > 0))
hs = hpv[hpv.period.isin(['sep_full_price_days', 'sep_promo_days'])].copy()

rows = []
for per, x0 in [('sep_all', hs), ('sep_full_price_days', hs[hs.period == 'sep_full_price_days']), ('oct_1_11', hpv[hpv.period == 'oct_1_11'])]:
    for ent, x1 in [('all_home_visits', x0), ('home_entry_visits', x0[x0.home_entry == 1])]:
        for dev, x in list(x1.groupby('device')) + [('all', x1)]:
            r = dict(period=per, population=ent, device=dev, visits=len(x),
                     coll_or_pdp_next_page=x.next_page.isin(['collection', 'product']).mean(),
                     coll_or_pdp_later_in_visit=x.coll_or_pdp_after_home.mean(), purchase_rate=x.buy.mean(), revenue=x.rev.sum(),
                     median_seconds_on_home=x.top_ms.median() / 1000)
            for npg in ['collection', 'product', 'search', 'home_again', 'other_page', 'exit']:
                r[f'next_{npg}'] = (x.next_page == npg).mean()
            rows.append(r)
write(pd.DataFrame(rows), 'H14_homepage_progression')

hs['reach_pct'] = np.maximum(hs.scroll, hs.fold) / 10
hs['scroll_band'] = pd.cut(hs.reach_pct, [-1, 10, 25, 50, 75, 101], labels=['0-10%', '10-25%', '25-50%', '50-75%', '75-100%'])
rows = []
for (dev, b), x in list(hs.groupby(['device', 'scroll_band'], observed=True)) + [(('all', k), x) for k, x in hs.groupby('scroll_band', observed=True)]:
    rows.append(dict(device=dev, scroll_band=b, home_visits=len(x), coll_or_pdp_next_page=x.next_page.isin(['collection', 'product']).mean(),
                     menu_open=x.menu_open.mean(), purchase_rate=x.buy.mean(), median_seconds_on_home=x.top_ms.median() / 1000))
h14s = pd.DataFrame(rows)
h14s['share_of_home_visits'] = h14s.home_visits / h14s.groupby('device').home_visits.transform('sum')
write(h14s, 'H14_homepage_scroll_depth')

hs['first_click'] = hs.first_cls.replace('', 'no_click_recorded')
hs['first_nav_click'] = hs.first_nav_cls.replace('', 'no_navigation_click')
rows = []
for fam in ['first_click', 'first_nav_click']:
    for (dev, val), x in list(hs.groupby(['device', fam])) + [(('all', k), x) for k, x in hs.groupby(fam)]:
        tcol = 'first_tsl' if fam == 'first_click' else 'first_nav_tsl'
        rows.append(dict(measure=fam, device=dev, click_class=val, home_visits=len(x),
                         median_seconds_to_click=(x[tcol].median() / 1000) if not val.startswith('no_') else np.nan,
                         coll_or_pdp_next_page=x.next_page.isin(['collection', 'product']).mean(), purchase_rate=x.buy.mean()))
h14f = pd.DataFrame(rows)
h14f['share_of_home_visits'] = h14f.home_visits / h14f.groupby(['measure', 'device']).home_visits.transform('sum')
h14f = h14f[h14f.home_visits >= 30].sort_values(['measure', 'device', 'home_visits'], ascending=[True, True, False])
write(h14f, 'H14_homepage_first_interaction')

rows = []
for dev, x in list(hs.groupby('device')) + [('all', hs)]:
    for c in ['menu_open', 'menu_link', 'search_open', 'content_tile', 'content_other', 'popup_close', 'popup_form', 'cookie', 'search_close_artifact']:
        rows.append(dict(device=dev, control=c, home_visits=len(x), share_clicking=x[c].mean(),
                         coll_or_pdp_next_page_if_clicked=x.loc[x[c] == 1, 'next_page'].isin(['collection', 'product']).mean(),
                         coll_or_pdp_next_page_if_not=x.loc[x[c] == 0, 'next_page'].isin(['collection', 'product']).mean()))
write(pd.DataFrame(rows), 'H14_homepage_controls')

# ---------------------------------------------------------------- data quality flag
dq = []
for (dev, pcls), x in sep.assign(first_pc=sep.pcs.map(lambda l: l[0] if l else 'none')).groupby(['device', 'first_pc']):
    if len(x) >= 500:
        dq.append(dict(device=dev, entry_page_class=pcls, visits=len(x), share_with_search_close_click=x.c_search_close.mean()))
write(pd.DataFrame(dq), 'DQ_search_close_clicks')

# ---------------------------------------------------------------- financial scenarios
fin_rev = f4.set_index('device')
f2i = f2.set_index(['period', 'device'])
h14i = pd.read_csv(OUT / 'H14_homepage_progression.csv').set_index(['period', 'population', 'device'])
home_share = {dev: hs[hs.device == dev].rev.sum() / max(sep[sep.device == dev].rev.sum(), 1) for dev in ['mobile']}


def base(metric, dev, per):
    if metric == 'homepage_to_collection_or_pdp':
        return h14i.loc[(per if per != 'sep_all' else 'sep_all', 'all_home_visits', dev), 'coll_or_pdp_next_page']
    return f2i.loc[(per, dev), metric]


scen = [
    ('H1', 'Reassurance below Pay Now', 'checkout_completion', ['mobile', 'all'], 1.0,
     'Every order passes the payment step, so revenue moves one for one with checkout completion. Assumes AOV unchanged.'),
    ('H4', 'Quantity selector higher in cart', 'cart_to_checkout', ['mobile', 'all'], 1.0,
     'Every order passes cart to checkout. Assumes checkout completion and AOV unchanged.'),
    ('H8', 'One purchase button plus quantity selector', 'atc_rate_of_pdp_visits', ['mobile', 'all'], 1.0,
     'PDP template change seen by every PDP visitor. Assumes cart and checkout rates and AOV unchanged.'),
    ('H9', 'Model height and size on second image', 'atc_rate_of_pdp_visits', ['mobile', 'all'], 1.0, 'Same as H8.'),
    ('H10', 'Fit recommendation beside size guide', 'atc_rate_of_pdp_visits', ['mobile', 'all'], 1.0, 'Same as H8.'),
    ('H14', 'Mobile category quick links above hero', 'homepage_to_collection_or_pdp', ['mobile'], None,
     'Only mobile visits that load the homepage are exposed; exposure is their share of mobile visit revenue in the recorded sample. '
     'Assumes the extra progressing visits convert like current progressing visits, which overstates the gain.'),
]
rows = []
for hid, name, metric, devs, share0, note in scen:
    for dev in devs:
        share = share0 if share0 is not None else home_share[dev]
        exp_sep = fin_rev.loc[dev, 'sep_revenue'] * share
        exp_fp = fin_rev.loc[dev, 'full_price_revenue_per_30_days'] * share
        b_sep, b_fp = base(metric, dev, 'sep_all'), base(metric, dev, 'sep_full_price_days')
        r = dict(hypothesis=hid, change=name, device_scope=dev, metric=metric, baseline_rate_sep=b_sep, baseline_rate_full_price_days=b_fp,
                 exposure_share_of_device_revenue=share, exposed_revenue_sep=exp_sep, exposed_revenue_full_price_per_30d=exp_fp,
                 monthly_gain_per_1pp_absolute_sep=exp_sep * 0.01 / b_sep, monthly_gain_per_1pp_absolute_full_price=exp_fp * 0.01 / b_fp)
        for lift in [0.02, 0.05, 0.10]:
            r[f'monthly_gain_{int(lift * 100)}pct_relative_sep'] = exp_sep * lift
            r[f'annual_gain_{int(lift * 100)}pct_relative_full_price'] = exp_fp * lift * 365 / 30
        r['assumption'] = note
        rows.append(r)
write(pd.DataFrame(rows), 'FIN_impact_scenarios')
KEY['home_revenue_share'] = home_share

# ---------------------------------------------------------------- test sizing: 4-week 50/50 test, 80% power, two-sided 5%
h14m = h14i.loc[('sep_all', 'all_home_visits', 'mobile')]
pops = [
    ('H1', 'mobile', 'checkout started visits', f2i.loc[('sep_all', 'mobile'), 'checkout_started_visits'], f2i.loc[('sep_all', 'mobile'), 'checkout_completion']),
    ('H1', 'all', 'checkout started visits', f2i.loc[('sep_all', 'all'), 'checkout_started_visits'], f2i.loc[('sep_all', 'all'), 'checkout_completion']),
    ('H4', 'mobile', 'add-to-cart visits', f2i.loc[('sep_all', 'mobile'), 'atc_visits'], f2i.loc[('sep_all', 'mobile'), 'cart_to_checkout']),
    ('H4', 'all', 'add-to-cart visits', f2i.loc[('sep_all', 'all'), 'atc_visits'], f2i.loc[('sep_all', 'all'), 'cart_to_checkout']),
    ('H8 / H9 / H10', 'mobile', 'PDP visits', f2i.loc[('sep_all', 'mobile'), 'pdp_visits'], f2i.loc[('sep_all', 'mobile'), 'atc_rate_of_pdp_visits']),
    ('H8 / H9 / H10', 'all', 'PDP visits', f2i.loc[('sep_all', 'all'), 'pdp_visits'], f2i.loc[('sep_all', 'all'), 'atc_rate_of_pdp_visits']),
    ('H14', 'mobile', 'homepage visits', h14m.visits, h14m.coll_or_pdp_next_page),
]
rows = []
for hid, dev, unit, n_month, p in pops:
    n_arm = n_month * 28 / 30 / 2
    mde_abs = (1.96 + 0.8416) * np.sqrt(2 * p * (1 - p) / n_arm)
    rows.append(dict(hypothesis=hid, device_scope=dev, unit=unit, recorded_units_per_30d=n_month, baseline_rate=p,
                     units_per_arm_4_weeks=n_arm, mde_absolute_pp=mde_abs * 100, mde_relative=mde_abs / p,
                     note='Recorded sessions only; full traffic is roughly 20-25% larger, so the true MDE is slightly smaller.'))
write(pd.DataFrame(rows), 'TEST_minimum_detectable_effect')

json.dump(KEY, open(OUT / 'key_numbers.json', 'w'), indent=1, default=lambda o: o.item() if hasattr(o, 'item') else str(o))
print('done')
