"""
Live PDP facts for the DVF P0 hypothesis brief.

    python3 py/hypothesis-scrape.py /tmp/hyp/raw

Takes the 40 most-viewed product handles in September from pdp_pageviews.json, fetches each
product page with a mobile user agent, and writes pdp_scrape.json: block order, Size & Fit text,
model statement, fit wording, and whether the size guide, reassurance line, Buy it Now and the
hidden quantity field are present. Needs beautifulsoup4.
"""
import collections
import json
import re
import subprocess
import sys
import time
from pathlib import Path

from bs4 import BeautifulSoup

RAW = Path(sys.argv[1])
HTML = RAW / 'pdp_html'
HTML.mkdir(exist_ok=True)
UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148'
FIT = re.compile(r'(true to size|runs (small|large)|size (up|down)|fits (small|large|true)[^.]*|relaxed fit|fitted[^.,]*|oversized)', re.I)

rows = json.load(open(RAW / 'pdp_pageviews.json'))
views = collections.Counter(r['handle'] for r in rows if r['d'] <= '2026-09-30')

out = []
for handle, n in views.most_common(40):
    f = HTML / f'{handle}.html'
    code = subprocess.run(['curl', '-sL', '-A', UA, '-o', str(f), '-w', '%{http_code}', f'https://www.dvf.com/products/{handle}'],
                          capture_output=True, text=True).stdout
    s = BeautifulSoup(f.read_text(encoding='utf-8', errors='ignore'), 'html.parser')
    blocks = {}
    pf = s.find('product-form')
    if pf:
        node = pf
        for _ in range(10):
            node = node.parent
            if len([k for k in node.find_all(recursive=False) if k.name]) > 5:
                break
        for i, k in enumerate([k for k in node.find_all(recursive=False) if k.name], 1):
            summ = k.select_one('details > summary')
            cls = ' '.join(k.get('class') or [])
            if 'product__block--buttons' in cls:
                blocks[i] = 'buttons'
            elif summ:
                blocks[i] = 'acc:' + re.sub(r'\s+', ' ', summ.get_text(' ', strip=True))
            elif k.name == 'modal-content':
                blocks[i] = 'reviews'
            elif 'product__custom-code' in cls:
                blocks[i] = 'custom:' + k.get_text(' ', strip=True)[:40]
    secs = {}
    for d in s.select('div.product__block--accordion details'):
        title = re.sub(r'\s+', ' ', d.select_one('summary').get_text(' ', strip=True))
        secs.setdefault(title, re.sub(r'\s+', ' ', d.get_text(' ', strip=True))[len(title):].strip())
    size_fit, desc = secs.get('Size & Fit', ''), secs.get('Description', '')[:400]
    fm = FIT.search(size_fit + ' || ' + desc)
    mm = re.search(r"[A-Z][a-z]+ is \d+'\d+\"? and (?:is )?wearing a size \w+", size_fit)
    out.append(dict(
        handle=handle, sept_pdp_pageviews=n, http=code, blocks=blocks, model_statement=mm.group(0) if mm else '',
        size_fit_text=size_fit, description_text=desc,
        fit_phrase=fm.group(0) if fm else '',
        fit_phrase_in=('size_fit' if fm and fm.group(0).lower() in size_fit.lower() else 'description') if fm else '',
        size_guide_modal=bool(s.select_one('div.selector-wrapper--size product-modal')),
        free_ship_returns_line=bool(re.search(r'Free Shipping and Returns', s.get_text(' '))),
        has_buy_it_now=bool(s.select_one('button.fake-buy-now-button')),
        qty_input_hidden=bool(s.select_one('product-form input[type=hidden][name=quantity]')),
    ))
    time.sleep(0.3)

json.dump(out, open(RAW / 'pdp_scrape.json', 'w'), indent=1)
print('pdp_scrape.json', len(out))
