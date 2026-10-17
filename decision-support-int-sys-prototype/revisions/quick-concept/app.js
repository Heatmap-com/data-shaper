import { matches, measureColumns, resolvePickers, toObjects, ALL } from './query.js';
import { h, weekly, table, series, cards } from './views.js';
import { journey, journeySummary, funnel, minifunnels, trendlines } from './flows-views.js';

const DATA = '../../data';
const VIEWS = { weekly, table, series, cards, journey, funnel, minifunnels, trendlines };

// Datasets built in the browser from a snapshot dataset.
const DERIVED = {
  journey_summary: { from: 'journeys', build: journeySummary },
};
const app = {
  views: null, sites: [], manifest: null, cache: new Map(), panelState: {},
  site: null, tab: null,
};

const $ = (sel) => document.querySelector(sel);

async function getJson(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json();
}

function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  return { site: p.get('site'), tab: p.get('tab'), state: p.get('s') };
}

function writeHash() {
  const p = new URLSearchParams({ site: app.site, tab: app.tab });
  const tabState = Object.fromEntries(Object.entries(app.panelState)
    .filter(([k, v]) => Object.keys(v).length && currentTab().panels.some((pn) => pn.id === k)));
  if (Object.keys(tabState).length) p.set('s', JSON.stringify(tabState));
  history.replaceState(null, '', `#${p}`);
}

const currentTab = () => app.views.tabs.find((t) => t.id === app.tab) ?? app.views.tabs[0];

function measure(id) {
  return app.views.measures[id] ?? { label: id, sum: id, format: 'num' };
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
function fieldLabel(name, valueOf) {
  if (valueOf !== undefined) {
    if (DATE.test(String(name))) return new Date(`${name}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
    const text = String(name);
    if (text.includes(' > ')) return text.split(' > ').map((part) => app.views.valueLabels?.[part] ?? part).join(' → ');
    return app.views.valueLabels?.[text] ?? text;
  }
  return app.views.fields[name] ?? name.replace(/^(m|x|dim)_/, '').replace(/_/g, ' ');
}

async function loadDataset(name) {
  const key = `${app.site}/${name}`;
  if (app.cache.has(key)) return app.cache.get(key);
  const meta = app.manifest.datasets[name];
  const derived = DERIVED[name];
  if (meta) {
    app.cache.set(key, getJson(`${DATA}/sites/${app.site}/${meta.file}`).then((j) => ({ meta, columns: j.columns, rows: toObjects(j) })));
  } else if (derived && app.manifest.datasets[derived.from]) {
    app.cache.set(key, loadDataset(derived.from).then((src) => {
      const rows = derived.build(src.rows);
      return { meta: { ...src.meta, rows: rows.length, note: `derived in the browser from ${derived.from}` }, columns: Object.keys(rows[0] ?? {}), rows };
    }));
  } else {
    return null;
  }
  return app.cache.get(key);
}

function referencedColumns(panel) {
  const cols = new Set([
    ...Object.keys(panel.filter ?? {}), ...(panel.pickers ?? []).map((p) => p.field),
    ...(panel.groupBy && Array.isArray(panel.groupBy) ? panel.groupBy : panel.groupBy ? [panel.groupBy] : []),
    ...(panel.groupByOptions ?? []).filter((o) => o !== '(none)'),
    ...(panel.show ?? []), panel.rows, panel.rowLabel, panel.columns, panel.x,
    panel.cardTitle, panel.cardSubtitle, ...(panel.cardFields ?? []),
    panel.series, panel.facet, ...(panel.steps ?? []).map((st) => st.col),
    ...(panel.view === 'journey' ? ['path', 'row_key', 'step_index', 'step', 'rank', 'week', 'sessions', 'progressed', 'buyers', 'orders', 'revenue'] : []),
  ]);
  for (const id of panel.facetMeasures ?? []) for (const c of measureColumns(measure(id))) cols.add(c);
  if (panel.floor) for (const c of measureColumns(measure(panel.floor.measure))) cols.add(c);
  for (const id of panel.measures ?? []) for (const c of measureColumns(measure(id))) cols.add(c);
  cols.delete(undefined);
  return [...cols];
}

function sourceBadge(meta) {
  const bits = [meta.source === 'warehouse' ? 'Warehouse' : 'Bundle', `${meta.rows.toLocaleString()} rows`];
  if (meta.capped) bits.push(`capped from ${meta.cappedFrom.toLocaleString()}`);
  return h('span', { class: `source ${meta.source}`, title: meta.note ?? '' }, bits.join(' · '));
}

async function renderPanel(panel, host) {
  const state = app.panelState[panel.id] ?? (app.panelState[panel.id] = {});
  const ds = await loadDataset(panel.dataset);
  host.replaceChildren();
  const header = h('header', {},
    h('div', {}, h('h3', {}, panel.title), h('p', { class: 'question' }, panel.question)),
    ds ? sourceBadge(ds.meta) : null);
  host.append(header);
  if (!ds) {
    host.append(h('div', { class: 'blocked' }, h('strong', {}, 'Not in this snapshot. '),
      panel.blockedNote ?? `The dataset ${panel.dataset} was not exported for ${app.manifest.site.name}.`));
    return;
  }
  const missing = ds.rows.length ? referencedColumns(panel).filter((c) => !ds.columns.includes(c)) : [];
  if (missing.length) {
    host.append(h('div', { class: 'blocked' }, h('strong', {}, 'Columns not in this snapshot: '), missing.join(', ')));
    return;
  }
  const base = ds.rows.filter((r) => matches(r, panel.filter));
  const { rows, pickers } = resolvePickers(base, panel.pickers, state.pickers ?? {});
  const set = (patch) => {
    Object.assign(state, patch);
    writeHash();
    renderPanel(panel, host);
  };
  if (pickers.length) {
    host.append(h('div', { class: 'pickers' }, pickers.map((p) => h('label', { class: 'picker' }, h('span', {}, p.label ?? fieldLabel(p.field)),
      h('select', { onchange: (e) => set({ pickers: { ...(state.pickers ?? {}), [p.field]: e.target.value }, sort: state.sort }) },
        p.options.map((o) => h('option', { value: o, selected: o === p.value ? 'selected' : null },
          o === ALL ? 'All' : p.labels?.[o] ?? fieldLabel(o, p.field))))))));
  }
  const label = (name, valueOf) => (valueOf === undefined && panel.labels?.[name]) || fieldLabel(name, valueOf);
  let join = null;
  if (panel.join) {
    const other = await loadDataset(panel.join.dataset);
    if (other) {
      const fixed = Object.fromEntries(pickers.filter((p) => panel.join.on.includes(p.field) && p.value !== ALL).map((p) => [p.field, p.value]));
      join = other.rows.filter((r) => matches(r, { ...(panel.join.filter ?? {}), ...fixed }));
    }
  }
  const ctx = { state, set, measure, fieldLabel: label, join, currency: app.manifest.site.currency ?? 'USD' };
  const body = h('div', { class: 'panel-body' });
  if (!rows.length) body.append(h('div', { class: 'blocked' }, 'No rows for this selection.'));
  else body.append(...[VIEWS[panel.view](panel, rows, ctx)].flat().filter(Boolean));
  host.append(body);
  if (panel.caveats?.length || panel.next) {
    host.append(h('footer', {},
      panel.caveats?.length ? h('ul', { class: 'caveats' }, panel.caveats.map((c) => h('li', {}, c))) : null,
      panel.next ? h('a', { class: 'next', href: '#', onclick: (e) => { e.preventDefault(); selectTab(panel.next.tab); } }, `${panel.next.text} →`) : null));
  }
}

async function renderVerdicts(tab) {
  const host = $('#verdicts');
  host.replaceChildren();
  if (!tab.verdictMetrics?.length) { host.hidden = true; return; }
  host.hidden = false;
  const ds = await loadDataset('strategy-triggers');
  host.append(h('h3', {}, 'What the rules say'));
  if (!ds) { host.append(h('p', { class: 'muted' }, 'No rule results in this snapshot.')); return; }
  const rows = ds.rows.filter((r) => tab.verdictMetrics.includes(r.m_metric));
  const rank = { triggered: 0, below_floor: 1, silent: 2, blocked: 3 };
  rows.sort((a, b) => (rank[a.m_state] ?? 9) - (rank[b.m_state] ?? 9));
  host.append(h('p', { class: 'muted small' }, `Rules on the analysed page that read this tab's numbers. ${rows.filter((r) => r.m_state === 'triggered').length} of ${rows.length} fired.`));
  host.append(h('ul', { class: 'verdict-list' }, rows.map((r) => h('li', { class: `state-${r.m_state}` },
    h('span', { class: 'pill' }, r.m_state.replace('_', ' ')),
    h('strong', {}, r.x_strategy_id), ' ', h('span', { class: 'muted' }, r.m_metric),
    r.m_detail ? h('div', { class: 'small' }, r.m_detail) : null))));
  host.append(h('a', { class: 'next', href: '#', onclick: (e) => { e.preventDefault(); selectTab('verdicts'); } }, 'All verdicts →'));
}

function renderMeta() {
  const m = app.manifest;
  const w = m.bundle?.window;
  const parts = [`${m.site.name} (${m.site.idsite})`];
  const weeks = m.warehouse?.trendWeeks ?? [];
  if (weeks.length) parts.push(`warehouse weeks ${weeks[0]} to ${weeks[weeks.length - 1]}`);
  if (w) parts.push(`bundle ${w.start ?? w[0]} to ${w.end ?? w[1]}`);
  parts.push(`snapshot ${new Date(m.generatedAt).toLocaleString()}`);
  const misses = Object.values(m.checks ?? {}).reduce((s, c) => s + (c.misses ?? 0), 0);
  $('#meta').replaceChildren(parts.join(' · '), h('span', { class: `check ${misses ? 'bad' : 'ok'}` }, misses ? `${misses} partition misses` : 'partition check passed'));
}

function renderTab() {
  const tab = currentTab();
  $('#tab-select').value = tab.id;
  const [label, question] = tab.label.split(/:\s*/);
  $('#tab-title').replaceChildren(h('span', {}, label), h('em', {}, question ?? ''));
  $('#tab-intro').textContent = tab.intro ?? '';
  const host = $('#panels');
  host.replaceChildren();
  for (const panel of tab.panels) {
    const el = h('section', { class: `panel view-${panel.view}`, id: `panel-${panel.id}` }, h('p', { class: 'muted' }, 'Loading…'));
    host.append(el);
    renderPanel(panel, el).catch((err) => el.replaceChildren(h('div', { class: 'blocked' }, `Error: ${err.message}`)));
  }
  renderVerdicts(tab);
  writeHash();
}

function selectTab(id) {
  app.tab = id;
  renderTab();
  window.scrollTo({ top: 0 });
}

async function selectSite(slug) {
  app.site = slug;
  app.manifest = await getJson(`${DATA}/sites/${slug}/manifest.json`);
  $('#site-select').value = slug;
  renderMeta();
  renderTab();
}

function renderGlossary() {
  $('#glossary-body').replaceChildren(
    h('dl', {}, app.views.glossary.map((g) => [h('dt', {}, g.term), h('dd', {}, g.text)])),
    h('h4', {}, 'Measures'),
    h('dl', { class: 'measures' }, Object.values(app.views.measures).filter((m) => m.help).map((m) => [h('dt', {}, m.label), h('dd', {}, m.help)])));
}

async function init() {
  [app.views, app.sites] = await Promise.all([getJson('views.json'), getJson(`${DATA}/sites.json`).catch(() => [])]);
  document.title = app.views.title;
  $('#title').textContent = app.views.title;
  if (!app.sites.length) {
    $('#panels').replaceChildren(h('div', { class: 'blocked' }, `No snapshots yet. Expected ${DATA}/sites.json. Run node prototype/query-tool/snapshot.mjs --site <slug>.`));
    return;
  }
  $('#site-select').replaceChildren(...app.sites.map((s) => h('option', { value: s.slug }, s.name)));
  $('#tab-select').replaceChildren(...app.views.tabs.map((t) => h('option', { value: t.id }, t.label)));
  $('#site-select').addEventListener('change', (e) => { app.panelState = {}; selectSite(e.target.value); });
  $('#tab-select').addEventListener('change', (e) => selectTab(e.target.value));
  $('#glossary-open').addEventListener('click', () => { $('#glossary').hidden = false; });
  $('#glossary-close').addEventListener('click', () => { $('#glossary').hidden = true; });
  renderGlossary();
  const hash = readHash();
  try { app.panelState = hash.state ? JSON.parse(hash.state) : {}; } catch { app.panelState = {}; }
  app.tab = app.views.tabs.some((t) => t.id === hash.tab) ? hash.tab : app.views.tabs[0].id;
  await selectSite(app.sites.some((s) => s.slug === hash.site) ? hash.site : app.sites[0].slug);
}

init().catch((err) => {
  document.body.append(h('pre', { class: 'blocked' }, String(err.stack ?? err)));
});
