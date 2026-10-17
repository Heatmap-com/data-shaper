// Tiles or table, for every data table a panel draws. A tile is the same row, laid out as a card by CSS:
// the first cell is the title, the others keep their column header as a label, and links, hover pills and
// sortable headers keep working because nothing is rebuilt. Matrices stay tables.
import { h } from './views.js';

const MATRIX = '.ctr-grid, .heat-grid';

export function tileTables(body, { layout, narrow, set }) {
  const tables = [...body.querySelectorAll('table.grid')].filter((t) => !t.matches(MATRIX));
  if (!tables.length) return;
  const mode = layout ?? (narrow ? 'tiles' : 'table');
  const anchor = tables[0].closest('.scroll') ?? tables[0];
  anchor.before(h('div', { class: 'layout-toggle seg-toggle', role: 'group', 'aria-label': 'Show as' },
    ...[['tiles', '▦ Tiles'], ['table', '☰ Table']].map(([id, label]) => h('button', {
      type: 'button', class: mode === id ? 'on' : null, 'aria-pressed': String(mode === id), onclick: () => { if (mode !== id) set({ layout: id }); },
    }, label))));
  if (mode === 'tiles') tables.forEach(tile);
}

function tile(t) {
  const heads = [...(t.tHead?.rows[0]?.cells ?? [])].map((th) => (th.childNodes[0]?.textContent ?? '').replace(/\s*[▲▼]$/, '').trim());
  t.classList.add('tiles');
  t.closest('.scroll')?.classList.add('tiled');
  const hero = !!t.querySelector('td.judged, td.now');
  if (hero) t.classList.add('hero');
  for (const tr of t.tBodies[0]?.rows ?? []) {
    [...tr.cells].forEach((td, i) => {
      if (td.colSpan > 1) { td.classList.add('t-wide'); return; }
      if (heads[i]) td.dataset.label = heads[i];
      if (td.matches('.judged, .now')) td.classList.add('t-hero');
      if (i === 0) td.classList.add('t-head');
      else if (td.classList.contains('label') || (hero && !td.matches('.num, .ctr-td') && !td.querySelector('svg, .wb'))) td.classList.add('t-sub');
      if (td.querySelector('.wb')) td.classList.add('t-wob');
      const svg = td.querySelector('svg');
      if (svg) {
        td.classList.add('t-trend');
        if (!svg.hasAttribute('viewBox')) svg.setAttribute('viewBox', `0 0 ${svg.getAttribute('width')} ${svg.getAttribute('height')}`);
      }
      if (!td.textContent.trim() && !td.children.length) td.classList.add('t-empty');
    });
  }
}
