"""Chart types. Each takes (bundle, spec, style) and returns a figure, or raises Skip when
the bundle has nothing to draw. A report stage declares which charts it wants, by type
and parameters, in its stage descriptor; adding a type is one function and one entry in
CHART_TYPES.

Every chart covers the report window unless its spec says otherwise. Gold marks the
thing the report points at; navy is the rest; grey is context such as a partial week.
"""
import pandas as pd

from .chart_style import day_span, is_partial, legend, money, short_day, week_label, whole_numbers, window_text

DEVICE_LABELS = {'mobile': 'Mobile', 'desktop': 'Desktop', 'tablet': 'Tablet'}
WINDOW_PERIODS = ('first', 'second')


class Skip(Exception):
    """The bundle cannot support this chart; the reason goes in the manifest."""


def title_of(spec, default, bundle, **extra):
    start, end = bundle.window
    text = spec.get('title', default)
    fills = {'window': window_text(start, end), 'page': bundle.page_label, **extra}
    for key, value in fills.items():
        text = text.replace('{' + key + '}', str(value))
    return text


def table(bundle, name):
    if not bundle.has(name):
        raise Skip(f'the bundle has no {name} table')
    return bundle.table(name)


def in_window(frame, column, bundle):
    start, end = bundle.window
    dates = pd.to_datetime(frame[column])
    return frame[(dates >= start) & (dates <= end)].assign(**{column: dates[(dates >= start) & (dates <= end)]})


def monday(dates):
    return dates - pd.to_timedelta(dates.dt.weekday, unit='D')


def daily_orders(bundle, spec, style):
    orders = bundle.window_orders()
    if orders.empty:
        raise Skip('no orders in the report window')
    start, end = bundle.window
    days = pd.date_range(start, end, freq='D')
    counts = orders.groupby('d').size().reindex(days, fill_value=0)
    peaks = bundle.peak_days or list(orders.groupby('d')['order_revenue'].sum().nlargest(3).index)
    colors = [style.highlight if day in peaks else style.primary for day in days]
    fig, ax = style.figure()
    ax.bar(days, counts.values, color=colors, width=0.8)
    legend(ax, [(style.highlight, spec.get('highlight_label', f'Peak-revenue days ({day_span(peaks)})')), (style.primary, 'Other days')])
    whole_numbers(ax.yaxis)
    ax.set_ylabel('Orders')
    ax.set_xticks(days[::7])
    ax.set_xticklabels([short_day(day) for day in days[::7]])
    ax.set_title(title_of(spec, 'Daily orders, {window}', bundle))
    return fig


def device_funnel(bundle, spec, style):
    frame = in_window(table(bundle, 'daily_channel_device'), 'd', bundle)
    if frame.empty:
        raise Skip('no visits in the report window')
    sums = frame.groupby('dev_s')[['visits', 'atc_visits', 'checkout_visits', 'buyer_visits']].sum()
    devices = [device for device in spec.get('devices', ['mobile', 'desktop', 'tablet']) if device in sums.index]
    focus = spec.get('focus', 'mobile')
    steps = [
        ('Added to cart', 'atc_visits', 'visits'),
        ('Checkout per cart', 'checkout_visits', 'atc_visits'),
        ('Order per checkout', 'buyer_visits', 'checkout_visits'),
    ]
    fig, axes = style.figure(1, len(steps))
    for ax, (label, top, bottom) in zip(axes, steps):
        shown, omitted = [], []
        for device in devices:
            num, den = sums.at[device, top], sums.at[device, bottom]
            if den <= 0 or num > den:
                omitted.append(DEVICE_LABELS.get(device, device))
            else:
                shown.append((device, 100 * num / den, den))
        names = [DEVICE_LABELS.get(device, device) for device, _, _ in shown]
        values = [value for _, value, _ in shown]
        colors = [style.highlight if device == focus else style.primary for device, _, _ in shown]
        bars = ax.bar(names, values, color=colors)
        for bar, (_, value, den) in zip(bars, shown):
            ax.annotate(f'{value:.1f}%\nof {den:,.0f}', (bar.get_x() + bar.get_width() / 2, value), ha='center', va='bottom', fontsize=8, xytext=(0, 2), textcoords='offset points')
        ax.set_title(label, fontsize=11)
        ax.set_ylim(0, max(values or [1]) * 1.3)
        if omitted:
            ax.set_xlabel(f'{", ".join(omitted)} omitted: the step count exceeds its base', fontsize=8)
    axes[0].set_ylabel('Share of the step before (%)')
    fig.suptitle(title_of(spec, 'Checkout funnel by device, {window}', bundle), x=0.01, ha='left', fontweight='bold', fontsize=13)
    return fig


def cohort_rpv(bundle, spec, family):
    frame = table(bundle, 'visit_cohorts')
    periods = spec.get('periods', list(WINDOW_PERIODS))
    frame = frame[(frame['family'] == family) & (frame['period'].isin(periods))]
    if frame.empty:
        raise Skip(f'visit_cohorts has no {family} rows for {"/".join(periods)}')
    sums = frame.groupby('value')[['visits', 'revenue']].sum()
    overall = sums['revenue'].sum() / sums['visits'].sum() if sums['visits'].sum() else 0
    sums = sums[sums['visits'] >= spec.get('min_visits', 30)]
    if sums.empty:
        raise Skip(f'no {family} value reaches {spec.get("min_visits", 30)} visits')
    sums['rpv'] = sums['revenue'] / sums['visits']
    return sums.sort_values('rpv', ascending=False).head(spec.get('top', 8)), overall


def horizontal_rpv(bundle, spec, style, sums, labels, highlight, default_title, unit=''):
    fig, ax = style.figure()
    rows = sums.iloc[::-1]
    names = [labels(value) for value in rows.index]
    colors = [style.highlight if highlight(value, row) else style.primary for value, row in rows.iterrows()]
    bars = ax.barh(names, rows['rpv'], color=colors)
    for bar, (_, row) in zip(bars, rows.iterrows()):
        ax.annotate(f'{money(row["rpv"], bundle.currency)}  ·  {row["visits"]:,.0f}{unit}', (bar.get_width(), bar.get_y() + bar.get_height() / 2), va='center', fontsize=9, xytext=(6, 0), textcoords='offset points')
    ax.set_xlim(0, rows['rpv'].max() * 1.3)
    ax.set_xlabel('Revenue per human visit')
    ax.grid(axis='y', visible=False)
    ax.set_title(title_of(spec, default_title, bundle))
    return fig


def channel_rpv(bundle, spec, style):
    sums, _overall = cohort_rpv(bundle, {'min_visits': 100, **spec}, spec.get('family', 'ch'))
    names = spec.get('labels', {})
    best = sums['rpv'].idxmax()
    return horizontal_rpv(bundle, spec, style, sums, lambda value: names.get(value, value.replace('_', ' ')), lambda value, _row: value == best, 'Revenue per visit by channel, {window}')


def journey_rpv(bundle, spec, style):
    sums, overall = cohort_rpv(bundle, spec, spec.get('family', 'journey3'))

    def label(value):
        steps = value.split('>')
        return f'{steps[0]} only' if len(steps) == 1 else ' → '.join(steps)

    return horizontal_rpv(bundle, spec, style, sums, label, lambda _value, row: row['rpv'] > overall, 'Revenue per visit by journey, {window}', unit=' visits')


def scroll_depth(bundle, spec, style):
    frame = table(bundle, 'scroll-decile')
    device = spec.get('device', 'mobile')
    frame = frame[frame['dim_device'] == device]
    if frame.empty or frame['m_entry_sessions'].sum() == 0:
        raise Skip(f'scroll-decile has no {device} entry sessions')
    frame = frame[frame['x_depth_bin'] >= spec.get('min_depth', 10)]
    sums = frame.groupby('x_depth_bin')[['m_sessions_reached', 'm_entry_sessions']].sum().sort_index()
    share = 100 * sums['m_sessions_reached'] / sums['m_entry_sessions']
    fig, ax = style.figure()
    ax.plot(share.index, share.values, color=style.primary, marker='o', linewidth=2)
    ax.set_ylim(0, max(60, share.max() * 1.15))
    ax.set_xticks(list(share.index))
    ax.set_xlabel(f'Scroll depth on {bundle.page_label} (%)')
    ax.set_ylabel(f'{DEVICE_LABELS.get(device, device)} entry sessions that reach it (%)')
    ax.set_title(title_of(spec, '{device} scroll on {page}, entry sessions summed across weeks', bundle, device=DEVICE_LABELS.get(device, device)))
    return fig


def cart_recovery(bundle, spec, style):
    frame = table(bundle, 'trigger-chains')
    trigger = spec.get('trigger', 'abandoned_cart')
    follow = spec.get('follow_days', 14)
    _start, end = bundle.window
    dates = pd.to_datetime(frame['server_date'])
    frame = frame[(frame['trigger_key'] == trigger) & (frame['final'] == 1) & (dates + pd.Timedelta(days=follow) <= end)]
    if frame.empty:
        raise Skip(f'no {trigger} chains with a closed {follow}-day follow-up')
    sums = frame.groupby('dim_device')[['chains', 'purchased']].sum()
    devices = [device for device in spec.get('devices', ['mobile', 'tablet', 'desktop']) if device in sums.index and sums.at[device, 'chains'] > 0]
    palette = [style.primary, style.highlight, style.context, style.secondary]
    fig, ax = style.figure()
    values = [100 * sums.at[device, 'purchased'] / sums.at[device, 'chains'] for device in devices]
    names = [f'{DEVICE_LABELS.get(device, device)}\n{sums.at[device, "chains"]:,.0f} chains' for device in devices]
    bars = ax.bar(names, values, color=palette[: len(devices)])
    for bar, value in zip(bars, values):
        ax.annotate(f'{value:.1f}%', (bar.get_x() + bar.get_width() / 2, value), ha='center', va='bottom', xytext=(0, 2), textcoords='offset points')
    ax.set_ylim(0, max(values) * 1.4)
    ax.set_ylabel('Purchased (%)')
    ax.set_title(title_of(spec, 'Abandoned-cart chains that purchased, closed {follow}-day window', bundle, follow=follow))
    return fig


def weekly_revenue(bundle, spec, style):
    orders = bundle.window_orders()
    if orders.empty:
        raise Skip('no orders in the report window')
    start, end = bundle.window
    weekly = orders.assign(week=monday(orders['d'])).groupby('week')['order_revenue'].sum()
    weeks = list(weekly.index)
    colors = [style.context if is_partial(week, start, end) else style.primary for week in weeks]
    fig, ax = style.figure()
    bars = ax.bar(range(len(weeks)), weekly.values / 1000, color=colors, width=0.7)
    symbol = money(0, bundle.currency, 0).replace('0', '').strip()
    for bar, value in zip(bars, weekly.values):
        ax.annotate(f'{symbol}{value / 1000:.1f}k', (bar.get_x() + bar.get_width() / 2, value / 1000), ha='center', va='bottom', fontsize=9, xytext=(0, 2), textcoords='offset points')
    entries = [(style.primary, 'Full Monday–Sunday week')]
    if any(is_partial(week, start, end) for week in weeks):
        entries.append((style.context, 'Partial week'))
    legend(ax, entries)
    ax.set_xticks(range(len(weeks)))
    ax.set_xticklabels([week_label(week, start, end) for week in weeks])
    ax.set_ylabel(f'Order revenue ({symbol}k)')
    ax.set_title(title_of(spec, 'Order-file revenue by week, {window}', bundle))
    return fig


def channel_weekly_rpv(bundle, spec, style):
    frame = in_window(table(bundle, 'daily_channel_device'), 'd', bundle)
    column = spec.get('column', 'ch')
    channel = spec.get('channel', 'meta_paid')
    frame = frame.assign(week=monday(frame['d']))
    site = frame.groupby('week')[['revenue', 'visits']].sum()
    mine = frame[frame[column] == channel].groupby('week')[['revenue', 'visits']].sum()
    if mine.empty or mine['visits'].sum() == 0:
        raise Skip(f'daily_channel_device has no {column}={channel} visits in the report window')
    start, end = bundle.window
    weeks = list(site.index)
    fig, ax = style.figure()
    ax.plot(range(len(weeks)), (site['revenue'] / site['visits']).values, color=style.primary, marker='o', linewidth=2, label='All human visits')
    mine = mine.reindex(weeks)
    ax.plot(range(len(weeks)), (mine['revenue'] / mine['visits']).values, color=style.highlight, marker='o', linewidth=2, label=spec.get('label', channel.replace('_', ' ')))
    ax.legend(frameon=False)
    ax.set_xticks(range(len(weeks)))
    ax.set_xticklabels([week_label(week, start, end) for week in weeks])
    ax.set_ylabel('Revenue per human visit')
    ax.set_ylim(bottom=0)
    ax.set_title(title_of(spec, '{label} against the site, by week', bundle, label=spec.get('label', channel)))
    return fig


def order_value_histogram(bundle, spec, style):
    orders = bundle.window_orders()
    if orders.empty:
        raise Skip('no orders in the report window')
    width = spec.get('bucket', 10)
    cap = spec.get('cap', float(orders['order_revenue'].quantile(0.98)))
    values = orders['order_revenue'].clip(upper=cap)
    fig, ax = style.figure()
    ax.hist(values, bins=range(0, int(cap) + width, width), color=style.primary, edgecolor='white')
    for line in spec.get('thresholds', []):
        ax.axvline(line['value'], color=style.highlight, linewidth=2)
        ax.annotate(line.get('label', money(line['value'], bundle.currency, 0)), (line['value'], ax.get_ylim()[1] * 0.92), xytext=(4, 0), textcoords='offset points', color=style.highlight, fontsize=9)
    ax.set_xlabel(f'Order value ({bundle.currency}; the last bar includes everything above {money(cap, bundle.currency, 0)})')
    ax.set_ylabel('Orders')
    ax.set_title(title_of(spec, 'Order values, {window}', bundle))
    return fig


CHART_TYPES = {
    'daily-orders': daily_orders,
    'device-funnel': device_funnel,
    'channel-rpv': channel_rpv,
    'journey-rpv': journey_rpv,
    'scroll-depth': scroll_depth,
    'cart-recovery': cart_recovery,
    'weekly-revenue': weekly_revenue,
    'channel-weekly-rpv': channel_weekly_rpv,
    'order-value-histogram': order_value_histogram,
}
