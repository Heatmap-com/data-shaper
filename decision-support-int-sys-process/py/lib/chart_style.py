"""Chart palette, figure defaults, and the date and money labels the style guide sets."""
import json

import matplotlib
import pandas as pd

matplotlib.use('Agg')
import matplotlib.pyplot as plt  # noqa: E402
from matplotlib.patches import Patch  # noqa: E402
from matplotlib.ticker import MaxNLocator  # noqa: E402

SYMBOLS = {'USD': '$', 'CAD': '$', 'AUD': '$', 'EUR': '€', 'GBP': '£', 'COP': '$', 'MXN': '$'}


class Style:
    """The `chart` block of scripts/report-style/tokens.json."""

    def __init__(self, tokens_path):
        with open(tokens_path, encoding='utf-8') as handle:
            chart = json.load(handle)['chart']
        self.primary = chart['primary']
        self.highlight = chart['highlight']
        self.context = chart['context']
        self.secondary = chart['secondary']
        self.grid = chart['grid']
        self.ink = chart['ink']
        self.size = (chart['width'], chart['height'])
        self.dpi = chart['dpi']
        plt.rcParams.update({
            'font.family': chart['font'],
            'axes.spines.top': False,
            'axes.spines.right': False,
            'axes.grid': True,
            'grid.color': self.grid,
            'axes.axisbelow': True,
            'axes.titleweight': 'bold',
            'axes.titlesize': 13,
            'axes.titlelocation': 'left',
            'text.color': self.ink,
            'axes.labelcolor': self.ink,
            'text.parse_math': False,
        })

    def figure(self, rows=1, cols=1):
        return plt.subplots(rows, cols, figsize=self.size, dpi=self.dpi)

    def save(self, fig, path):
        fig.tight_layout()
        fig.savefig(path, dpi=self.dpi)
        plt.close(fig)


def legend(ax, entries):
    """A legend of colour swatches, [(colour, label)], for charts whose bars carry no label."""
    ax.legend(handles=[Patch(color=color, label=label) for color, label in entries], frameon=False)


def whole_numbers(axis):
    axis.set_major_locator(MaxNLocator(integer=True))


def day_month(ts):
    return f'{ts.day} {ts.strftime("%B")}'


def window_text(start, end):
    """13 September – 12 October 2026; 1 – 30 September 2026 inside one month."""
    if start.year != end.year:
        return f'{day_month(start)} {start.year} – {day_month(end)} {end.year}'
    if start.month == end.month:
        return f'{start.day} – {day_month(end)} {end.year}'
    return f'{day_month(start)} – {day_month(end)} {end.year}'


def short_day(ts):
    return f'{ts.day} {ts.strftime("%b")}'


def day_span(days):
    """14–16 Sep, or 30 Sep – 2 Oct across a month."""
    first, last = min(days), max(days)
    if first == last:
        return short_day(first)
    if first.month == last.month:
        return f'{first.day}–{short_day(last)}'
    return f'{short_day(first)} – {short_day(last)}'


def ordinal(n):
    suffix = 'th' if 11 <= n % 100 <= 13 else {1: 'st', 2: 'nd', 3: 'rd'}.get(n % 10, 'th')
    return f'{n}{suffix}'


def week_label(week_start, start, end):
    """A Monday week, labelled by its Monday; a week the window cuts says which days it covers."""
    week_end = week_start + pd.Timedelta(days=6)
    first = max(week_start, start)
    last = min(week_end, end)
    label = short_day(week_start)
    if first == last:
        return f'{label}\n({ordinal(first.day)} only)'
    if first > week_start:
        return f'{label}\n(from {ordinal(first.day)})'
    if last < week_end:
        return f'{label}\n(through {ordinal(last.day)})'
    return label


def is_partial(week_start, start, end):
    week_end = week_start + pd.Timedelta(days=6)
    return week_start < start or week_end > end


def money(value, currency, decimals=2):
    symbol = SYMBOLS.get(currency, '')
    text = f'{value:,.{decimals}f}'
    return f'{symbol}{text}' if symbol else f'{text} {currency}'
