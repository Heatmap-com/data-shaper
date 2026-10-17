#!/usr/bin/env python3
"""Render the charts the report stages declare, from the full bundle.

usage: python3 py/chart-render.py --bundle <dir> --specs <charts.json> --out <media dir> --tokens <tokens.json>

The specs file is {"charts": [{"file": "sor-fig1-daily-orders.png", "stage": "...", "type": "daily-orders", ...}]},
written by the orchestrator's chart-render handler from the stage descriptors. Each chart is
drawn or skipped with a reason, and <out>/charts.json records which, with each chart's title,
so the report agent cites only charts that exist. An unknown type or a drawing error exits 1.
"""
import argparse
import datetime
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from lib.bundle_io import Bundle  # noqa: E402
from lib.chart_style import Style  # noqa: E402
from lib.chart_types import CHART_TYPES, Skip  # noqa: E402


def figure_title(fig):
    if fig._suptitle is not None:
        return fig._suptitle.get_text()
    return fig.axes[0].get_title(loc='left') if fig.axes else ''


def render(bundle, specs, out, style):
    unknown = sorted({spec.get('type') for spec in specs if spec.get('type') not in CHART_TYPES}, key=str)
    if unknown:
        raise ValueError(f'unknown chart type {", ".join(map(str, unknown))}; known: {", ".join(sorted(CHART_TYPES))}')
    entries = []
    for spec in specs:
        entry = {'file': spec['file'], 'stage': spec.get('stage', ''), 'type': spec['type']}
        try:
            fig = CHART_TYPES[spec['type']](bundle, spec, style)
        except Skip as skip:
            entry.update(status='skipped', reason=str(skip))
        else:
            entry.update(status='rendered', title=figure_title(fig))
            style.save(fig, os.path.join(out, spec['file']))
        entries.append(entry)
    return entries


def main(argv):
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[1])
    parser.add_argument('--bundle', required=True)
    parser.add_argument('--specs', required=True)
    parser.add_argument('--out', required=True)
    parser.add_argument('--tokens', required=True)
    args = parser.parse_args(argv)

    with open(args.specs, encoding='utf-8') as handle:
        specs = json.load(handle)['charts']
    bundle = Bundle(args.bundle)
    os.makedirs(args.out, exist_ok=True)
    entries = render(bundle, specs, args.out, Style(args.tokens))
    start, end = bundle.window
    manifest = {
        'bundle': os.path.abspath(args.bundle),
        'report_window': {'start': start.date().isoformat(), 'end': end.date().isoformat()},
        'generated_at': datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds'),
        'charts': entries,
    }
    with open(os.path.join(args.out, 'charts.json'), 'w', encoding='utf-8') as handle:
        json.dump(manifest, handle, indent=2, ensure_ascii=False)
        handle.write('\n')
    for entry in entries:
        note = entry.get('title') or entry.get('reason')
        print(f'{entry["status"]:8} {entry["file"]}  {note}')
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main(sys.argv[1:]))
    except (ValueError, KeyError, FileNotFoundError) as err:
        print(f'chart-render: {err}', file=sys.stderr)
        sys.exit(1)
