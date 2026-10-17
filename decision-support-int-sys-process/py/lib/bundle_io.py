"""Read a full analyst bundle: the site profile, the anchors, the order file, and the
named tables inside the numbered text files.

A table is a block of the form

    === TABLE: name ===
    key: value lines
    --- BEGIN CSV ---
    header
    rows, with `@@` lines that repeat the header for readers that page
    --- END CSV ---
"""
import csv
import io
import json
import os
import re

TABLE_RE = re.compile(r"^=== TABLE: (\S+) ===\n(.*?)^--- BEGIN CSV ---\n(.*?)^--- END CSV ---$", re.S | re.M)


def read_body(body):
    """A table's CSV body as (header, rows), without the `@@` header repeats."""
    rows = list(csv.reader(line for line in body.splitlines() if not line.startswith('@@')))
    return (rows[0] if rows else []), rows[1:]


def write_body(name, header, rows, repeat=100):
    """A table's CSV body, repeating the header as an `@@` line every `repeat` rows."""
    buf = io.StringIO()
    writer = csv.writer(buf, lineterminator='\n')
    writer.writerow(header)
    for i, row in enumerate(rows):
        if i and i % repeat == 0:
            buf.write(f"@@ {name} | columns: {','.join(header)}\n")
        writer.writerow(row)
    return buf.getvalue()


def parse_tables(text):
    """Every table in one bundle file, as {name: (meta, header, rows)}."""
    tables = {}
    for match in TABLE_RE.finditer(text):
        name, meta_text, body = match.groups()
        meta = {}
        for line in meta_text.splitlines():
            key, sep, value = line.partition(':')
            if sep:
                meta[key.strip()] = value.strip()
        header, rows = read_body(body)
        tables[name] = (meta, header, rows)
    return tables


class Bundle:
    """One site's full bundle directory. Tables load on first use. Needs pandas."""

    def __init__(self, root):
        self.root = root
        profile = os.path.join(root, '00_site_profile.json')
        if not os.path.exists(profile):
            raise FileNotFoundError(f'{root} has no 00_site_profile.json; charts are drawn from the full bundle')
        with open(profile, encoding='utf-8') as handle:
            self.profile = json.load(handle)
        anchors = os.path.join(root, '.anchors.json')
        self.anchors = {}
        if os.path.exists(anchors):
            with open(anchors, encoding='utf-8') as handle:
                self.anchors = json.load(handle)
        self._tables = None
        self._frames = {}

    @property
    def window(self):
        import pandas as pd
        window = self.profile['report_window']
        return pd.Timestamp(window['start']), pd.Timestamp(window['end'])

    @property
    def peak_days(self):
        import pandas as pd
        return [pd.Timestamp(day) for day in self.anchors.get('peak_days', [])]

    @property
    def currency(self):
        return self.profile.get('currency', 'USD')

    @property
    def page_label(self):
        return (self.profile.get('analysed_page') or {}).get('label', 'the analysed page')

    def _index(self):
        if self._tables is None:
            self._tables = {}
            for name in sorted(os.listdir(self.root)):
                if name.endswith('.txt'):
                    with open(os.path.join(self.root, name), encoding='utf-8') as handle:
                        self._tables.update(parse_tables(handle.read()))
        return self._tables

    def has(self, name):
        return name in self._index()

    def table(self, name):
        """The named table as a DataFrame, numeric columns converted. Missing tables raise KeyError."""
        import pandas as pd
        if name not in self._frames:
            tables = self._index()
            if name not in tables:
                raise KeyError(name)
            _meta, header, rows = tables[name]
            frame = pd.DataFrame(rows, columns=header)
            self._frames[name] = numeric(frame)
        return self._frames[name].copy()

    def orders(self):
        import pandas as pd
        if 'orders' not in self._frames:
            path = os.path.join(self.root, '01_orders.csv')
            if not os.path.exists(path):
                raise KeyError('01_orders.csv')
            frame = pd.read_csv(path, dtype=str, keep_default_na=False)
            frame = numeric(frame)
            frame['d'] = pd.to_datetime(frame['d'])
            self._frames['orders'] = frame
        return self._frames['orders'].copy()

    def window_orders(self):
        start, end = self.window
        orders = self.orders()
        return orders[(orders['d'] >= start) & (orders['d'] <= end)]


def numeric(frame):
    """Convert each column that is entirely numbers (blanks allowed) to floats."""
    import pandas as pd
    for column in frame.columns:
        values = frame[column].replace('', pd.NA)
        converted = pd.to_numeric(values, errors='coerce')
        if converted.notna().sum() == values.notna().sum() and values.notna().any():
            frame[column] = converted.fillna(0) if values.isna().any() else converted
    return frame
