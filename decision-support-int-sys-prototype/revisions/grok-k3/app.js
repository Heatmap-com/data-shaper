import { matches, measureColumns, resolvePickers, toObjects, ALL } from './query.js';
import { h, weekly, table, series, cards } from './views.js';
import { journey, journeySummary, funnel, minifunnels, trendlines } from './flows-views.js';
import { answerline, movers, decompose, verdictsummary, moverlists, annotations } from './home-views.js';
import { actions, unblock, landingScatter } from './verdict-views.js';
import { campaignchanges } from './changes-views.js';
import { homework } from './homework-views.js';
import { tileTables } from './tiles.js';
import { contraststrip, contrastgrid, funnelContrast, valueChips, strip as contrastStrip, scopeFromPickers } from './contrast-views.js';
import { weekCoverage, latestFull, coverageLabel } from './coverage.js';
import { makeNames } from './names.js';
import { log, facilitatorPanel } from './log.js';
import { mountMenu } from './tips.js';

const DATA = '../../data';
const VIEWS = { weekly, table, series, cards, journey, funnel, minifunnels, trendlines, answerline, movers, decompose, verdictsummary, moverlists, annotations, actions, unblock, contraststrip, contrastgrid, campaignchanges, homework };

const DERIVED = {
  journey_summary: { from: 'journeys', build: journeySummary },
};
// Context keys and the dataset fields that carry them.
const FIELD_MAP = {
  device: ['viewport_type', 'dim_device', 'dev_s', 'dev'],
  split: ['segment'],
  week: ['week', 'dim_week'],
};
const DEVICE_VALUE = { all: 'all', mobile: 'mobile', desktop: 'desktop', tablet: 'tablet' };
const SPLITS = [['traffic_source', 'Traffic source'], ['returning', 'New or returning'], ['buyer', 'Buyer'], ['rager', 'Rager'], ['none', 'None']];
const DEVICES = [['all', 'All devices (total)'], ['mobile', 'Mobile'], ['desktop', 'Desktop'], ['tablet', 'Tablet']];
const FAMILY_LABEL = Object.fromEntries(SPLITS);

const app = {
  views: null, sites: [], manifest: null, cache: new Map(), panelState: {}, names: makeNames({}),
  site: null, tab: null, ctx: null, weeks: [], cov: null, crumbs: [], showHidden: {},
};

const $ = (sel) => document.querySelector(sel);

async function getJson(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json();
}

function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  let ctx = null;
  try { ctx = p.get('ctx') ? JSON.parse(p.get('ctx')) : null; } catch { ctx = null; }
  return { site: p.get('site'), tab: p.get('tab'), state: p.get('s'), ctx };
}

function hashString() {
  const p = new URLSearchParams({ site: app.site, tab: app.tab });
  if (app.ctx) p.set('ctx', JSON.stringify(app.ctx));
  const tabState = Object.fromEntries(Object.entries(app.panelState)
    .filter(([k, v]) => Object.keys(v).length && allPanels(currentTab()).some((pn) => pn.id === k)));
  if (Object.keys(tabState).length) p.set('s', JSON.stringify(tabState));
  return `#${p}`;
}

function writeHash(push = false) {
  const url = hashString();
  const state = { crumbs: app.crumbs };
  if (push) history.pushState(state, '', url); else history.replaceState(state, '', url);
}

const currentTab = () => app.views.tabs.find((t) => t.id === app.tab) ?? app.views.tabs[0];
const allPanels = (tab) => tab.panels;

function measure(id) {
  return app.views.measures[id] ?? { label: id, sum: id, format: 'num' };
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const shortDate = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
function fieldLabel(name, valueOf) {
  if (valueOf !== undefined) {
    if (DATE.test(String(name))) return shortDate(name);
    const text = String(name);
    if (text.includes(' > ')) return text.split(' > ').map((part) => app.views.valueLabels?.[part] ?? part).join(' → ');
    if (valueOf === 'segment') return FAMILY_LABEL[text] ?? app.views.valueLabels?.[text] ?? text;
    if (FIELD_MAP.device.includes(valueOf) && text === 'all') return 'All devices (total)';
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
    app.cache.set(key, getJson(`${DATA}/sites/${app.site}/${meta.file}`).then((j) => ({ name, meta, columns: j.columns, rows: toObjects(j) })));
  } else if (derived && app.manifest.datasets[derived.from]) {
    app.cache.set(key, loadDataset(derived.from).then((src) => {
      const rows = derived.build(src.rows);
      return { name, meta: { ...src.meta, rows: rows.length, note: `derived in the browser from ${derived.from}` }, columns: Object.keys(rows[0] ?? {}), rows };
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

function sourceInfo(meta) {
  const bits = [meta.source === 'warehouse' ? 'Warehouse' : 'Bundle', `${meta.rows.toLocaleString()} rows`];
  if (meta.capped) bits.push(`capped from ${meta.cappedFrom.toLocaleString()}`);
  if (meta.note) bits.push(meta.note);
  return h('span', { class: 'info', title: bits.join(' · ') }, 'ⓘ');
}

// ---------- context ----------

function defaultCtx() {
  const d = app.views.contextBar?.defaults ?? {};
  return { week: app.weeks.length ? latestFull(app.cov, app.weeks) : null, compare: d.compare ?? 'prev', split: d.split ?? 'traffic_source', device: d.device ?? 'all' };
}

function setCtx(patch, { push = false } = {}) {
  const before = app.ctx;
  app.ctx = { ...app.ctx, ...patch };
  log('ctx_change', { from: before, to: app.ctx });
  renderContextBar();
  renderTab({ push });
}

function select(label, options, value, onchange, cls = '') {
  return h('label', { class: `picker ${cls}` }, h('span', {}, label),
    h('select', { onchange: (e) => onchange(e.target.value) },
      options.map(([v, l]) => h('option', { value: v, selected: String(v) === String(value) ? 'selected' : null }, l))));
}

function weekLabel(w) {
  const c = app.cov?.get(w);
  return `Week of ${shortDate(w)}${c && !c.full ? ` (${coverageLabel(c)})` : ''}`;
}

function renderContextBar() {
  const c = app.ctx;
  const host = $('#context-bar');
  if (!c || !app.weeks.length) { host.replaceChildren(); return; }
  const compareOpts = [['prev', 'Previous week'], ['firstFull', 'First full week'], ...app.weeks.filter((w) => w !== c.week).map((w) => [w, weekLabel(w)]), ['none', 'None']];
  host.replaceChildren(
    select('Week', app.weeks.map((w) => [w, weekLabel(w)]), c.week, (v) => setCtx({ week: v })),
    select('Compare with', compareOpts, c.compare, (v) => setCtx({ compare: v })),
    select('Split', SPLITS, c.split, (v) => setCtx({ split: v })),
    select('Device', DEVICES, c.device, (v) => setCtx({ device: v })),
    h('span', { class: 'ctx-note' }, 'Every panel follows these unless it says otherwise.'));
}

function renderCrumbs() {
  const host = $('#crumbs');
  if (!app.crumbs.length) { host.replaceChildren(); host.hidden = true; return; }
  host.hidden = false;
  host.replaceChildren(h('span', { class: 'muted' }, 'You came here by: '),
    app.crumbs.map((cr, i) => [i ? h('span', { class: 'sep' }, ' › ') : null,
      i === app.crumbs.length - 1 ? h('strong', {}, cr.label) : h('a', { href: cr.hash, onclick: (e) => { e.preventDefault(); goCrumb(i); } }, cr.label)]),
    h('button', { type: 'button', class: 'link', onclick: () => { app.crumbs = []; writeHash(); renderCrumbs(); } }, 'clear'));
}

function goCrumb(i) {
  const cr = app.crumbs[i];
  app.crumbs = app.crumbs.slice(0, i + 1);
  location.hash = cr.hash;
}

// Drill: open a panel with the context, optionally setting its pickers. Back returns.
function drill({ tab, panel, pickers, ctx, label, highlight, state }) {
  log('drill', { tab, panel, pickers, label });
  if (!app.crumbs.length) app.crumbs.push({ label: currentTab().label.split(':')[0], hash: hashString() });
  if (panel) {
    const st = app.panelState[panel] ?? (app.panelState[panel] = {});
    if (pickers) {
      st.pickers = { ...(st.pickers ?? {}), ...pickers };
      st.override = true;
    }
    if (highlight !== undefined) st.highlight = highlight;
    if (state) Object.assign(st, state);
  }
  if (ctx) { app.ctx = { ...app.ctx, ...ctx }; renderContextBar(); }
  const target = app.views.tabs.find((t) => t.id === tab)?.panels.find((p) => p.id === panel);
  if (target?.demoted) app.panelState.__openMore = tab;
  if (target?.hidden) app.showHidden[tab] = true;
  app.tab = tab;
  app.crumbs.push({ label, hash: '' });
  app.crumbs = app.crumbs.slice(-6);
  renderTab({ push: true, scrollTo: panel });
  app.crumbs[app.crumbs.length - 1].hash = hashString();
  history.replaceState({ crumbs: app.crumbs }, '', hashString());
  renderCrumbs();
}

// Which context keys drive which of a panel's pickers.
function inheritedPickers(panel) {
  const keys = panel.inherit ?? ['week', 'device'];
  const out = [];
  for (const p of panel.pickers ?? []) {
    const key = keys.find((k) => FIELD_MAP[k]?.includes(p.field));
    if (key) out.push({ field: p.field, key });
  }
  return out;
}

function ctxValueFor(key, picker) {
  const c = app.ctx;
  if (key === 'device') return c.device === 'all' && picker.allowAll && !['viewport_type'].includes(picker.field) ? ALL : DEVICE_VALUE[c.device];
  if (key === 'split') return c.split === 'none' ? 'all' : c.split;
  if (key === 'week') return c.week;
  return undefined;
}

const CTX_KEY_LABEL = { device: 'Device', split: 'Split', week: 'Week' };

// ---------- panels ----------

function effectivePanel(panel, state) {
  if (!panel.modes) return panel;
  const m = panel.modes;
  const id = m.options[state.mode] ? state.mode : m.default;
  return { ...panel, ...m.options[id], modeId: id };
}

// Panels under a closed "More cuts" render at zero width; size them by the nearest box that has one.
function contentWidth(el) {
  const inner = (x) => { const cs = getComputedStyle(x); return x.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight); };
  let w = el.clientWidth;
  for (let p = el.parentElement; !w && p; p = p.parentElement) w = p.clientWidth && inner(p);
  if (!w) return null;
  const cs = getComputedStyle(el);
  return w - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) || null;
}

async function renderPanel(panelDef, host) {
  const state = app.panelState[panelDef.id] ?? (app.panelState[panelDef.id] = {});
  const panel = effectivePanel(panelDef, state);
  const ds = await loadDataset(panel.dataset);
  host.replaceChildren();
  const header = h('header', {},
    h('div', {}, h('h3', {}, panel.title, ds ? [' ', sourceInfo(ds.meta)] : null), h('p', { class: 'question' }, panel.question)));
  host.append(header);
  if (panel.lead) host.append(h('p', { class: 'lead' }, panel.lead));
  if (panel.chainsLead && ds) host.append(chainsSentence(ds.rows));
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
  const set = (patch, opts = {}) => {
    Object.assign(state, patch);
    if (opts.log !== false) log('panel_change', { panel: panel.id, patch });
    writeHash();
    renderPanel(panelDef, host);
  };

  if (panel.modes) {
    host.append(h('div', { class: 'view-controls' }, select(panel.modes.label, Object.entries(panel.modes.options).map(([k, o]) => [k, o.modeLabel]), panel.modeId,
      (v) => set({ mode: v, pickers: {}, sort: undefined }))));
    if (panel.modeNote) host.append(h('p', { class: 'foot mode-note' }, panel.modeNote));
  }

  const base = ds.rows.filter((r) => matches(r, panel.filter));
  const inherited = inheritedPickers(panel);
  const chosen = { ...(state.pickers ?? {}) };
  const chips = [];
  const notApplied = [];
  for (const { field, key } of inherited) {
    if (state.override && chosen[field] !== undefined) continue;
    const pdef = panel.pickers.find((p) => p.field === field);
    const want = ctxValueFor(key, pdef);
    const present = new Set(base.map((r) => String(r[field])));
    if (want === ALL || present.has(String(want))) chosen[field] = want;
    else notApplied.push(key);
  }
  for (const p of panel.pickers ?? []) {
    if (p.default === 'latestReal' && chosen[p.field] === undefined) chosen[p.field] = await latestRealExperiment(base);
    if (p.default === 'latestFull' && chosen[p.field] === undefined) {
      const ws = [...new Set(base.map((r) => r[p.field]).filter(Boolean))].sort();
      if (ws.length) chosen[p.field] = latestFull(weekCoverage(app.manifest, panel.dataset, ws), ws);
    }
  }
  const { rows, pickers } = resolvePickers(base, panel.pickers, chosen);
  const hiddenFields = new Set(state.override ? [] : inherited.filter((i) => !notApplied.includes(i.key)).map((i) => i.field));
  const visible = pickers.filter((p) => !hiddenFields.has(p.field));
  const pickerLabel = (p, o) => {
    if (o === ALL) return p.field && FIELD_MAP.device.includes(p.field) ? 'All devices (total)' : 'All';
    if (p.field === 'experiment') return app.names.resolve('experiment', o).label;
    return p.labels?.[o] ?? fieldLabel(o, p.field);
  };
  if (visible.length) {
    host.append(h('div', { class: 'pickers' }, visible.map((p) => h('label', { class: 'picker' }, h('span', {}, p.label ?? fieldLabel(p.field)),
      h('select', { onchange: (e) => set({ pickers: { ...(state.pickers ?? {}), [p.field]: e.target.value }, sort: state.sort }) },
        p.options.map((o) => h('option', { value: o, selected: o === p.value ? 'selected' : null }, pickerLabel(p, o))))))));
  }
  if (inherited.length) {
    if (!state.override) {
      const keys = [...new Set(inherited.filter((i) => !notApplied.includes(i.key)).map((i) => CTX_KEY_LABEL[i.key].toLowerCase()))];
      if (keys.length) {
        chips.push(h('span', { class: 'inherits' }, `Follows the context bar: ${keys.join(', ')} · `,
          h('a', { href: '#', onclick: (e) => { e.preventDefault(); log('override', { panel: panel.id }); set({ override: true, pickers: Object.fromEntries(pickers.map((p) => [p.field, p.value])) }); } }, 'override')));
      }
    } else {
      for (const { field, key } of inherited) {
        const p = pickers.find((x) => x.field === field);
        const want = ctxValueFor(key, panel.pickers.find((x) => x.field === field));
        if (p && String(p.value) !== String(want)) {
          chips.push(h('span', { class: 'chip override' }, `This panel: ${CTX_KEY_LABEL[key]} = ${pickerLabel(p, p.value)} `,
            h('button', { type: 'button', title: 'Follow the context bar again', onclick: () => {
              const next = { ...(state.pickers ?? {}) };
              for (const i of inherited) delete next[i.field];
              set({ override: false, pickers: next });
            } }, '✕')));
        }
      }
      if (!chips.length) chips.push(h('span', { class: 'inherits' }, h('a', { href: '#', onclick: (e) => { e.preventDefault(); const next = { ...(state.pickers ?? {}) }; for (const i of inherited) delete next[i.field]; set({ override: false, pickers: next }); } }, 'follow the context bar again')));
    }
    for (const key of [...new Set(notApplied)]) {
      const why = key === 'week' ? `Week of ${shortDate(app.ctx.week)} isn't in this table` : key === 'split' ? 'Split doesn\'t apply to this table' : 'This device isn\'t in this table';
      chips.push(h('span', { class: 'chip na' }, why));
    }
  }
  const weekPicker = pickers.find((p) => FIELD_MAP.week.includes(p.field) && p.value && p.value !== ALL);
  if (weekPicker) {
    const c = weekCoverage(app.manifest, panel.dataset, [weekPicker.value]).get(weekPicker.value);
    if (c && !c.full) chips.push(h('span', { class: 'chip partial', title: 'Counts and money for a part week are not comparable with whole weeks.' }, `Week of ${shortDate(weekPicker.value)}: ${coverageLabel(c)}`));
  }
  const seg = pickers.find((p) => p.field === 'segment')?.value;
  if (seg === 'buyer') chips.push(h('span', { class: 'chip trap' }, 'Buyer split: the buying rate is 100% by construction. Order rate here describes buyers, not performance.'));
  if (seg === 'returning') chips.push(h('span', { class: 'chip trap' }, 'Returning means something different from 7 Sep. Don\'t compare across that week.'));
  if (chips.length) host.append(h('div', { class: 'chips' }, chips));

  const label = (name, valueOf) => (valueOf === undefined && panel.labels?.[name]) || fieldLabel(name, valueOf);
  let join = null;
  if (panel.join) {
    const other = await loadDataset(panel.join.dataset);
    if (other) {
      const fixed = Object.fromEntries(pickers.filter((p) => panel.join.on.includes(p.field) && p.value !== ALL).map((p) => [p.field, p.value]));
      join = other.rows.filter((r) => matches(r, { ...(panel.join.filter ?? {}), ...fixed }));
    }
  }
  const also = {};
  for (const name of panel.also ?? []) also[name] = (await loadDataset(name))?.rows ?? null;
  const flowWeeks = app.weeks;
  const ctx = {
    state, set, measure, fieldLabel: label, join, also, currency: app.manifest.site.currency ?? 'USD',
    panel, manifest: app.manifest, global: app.ctx, wobble: app.views.wobble, floors: app.views.measureFloors,
    names: app.names, drill, log, pickers, width: contentWidth(host),
    inheritWeek: !state.override || state.week === undefined,
    cov: (weeks, dataset = panel.dataset) => weekCoverage(app.manifest, dataset, weeks),
    full: (w) => app.cov?.get(w)?.full ?? false,
    flowWeeks,
    entity: (field, value, row) => entityLabel(panel, field, value, row),
    segmentFamily: seg,
    baseRows: panel.filter ? base : ds.rows,
  };
  const ctrRows = panel.contrast === 'funnel' ? also.funnel : panel.contrast ? ctx.baseRows : null;
  ctx.contrast = ctrRows?.length ? {
    funnel: (wk) => funnelContrast(ctrRows, ctx, wk),
    strip: (wk, opts) => contrastStrip(ctrRows, { ...scopeFromPickers(ctx), ...wk }, ctx, opts),
    valueChips: ({ week, compare, ...opts } = {}) => valueChips(ctrRows, { ...scopeFromPickers(ctx), week, compare }, ctx, opts),
  } : null;
  const body = h('div', { class: 'panel-body' });
  if (!rows.length) body.append(h('div', { class: 'blocked' }, 'No rows for this selection.'));
  else {
    if (panel.scatter) body.append(landingScatter(panel, rows, ctx));
    body.append(...[VIEWS[panel.view](panel, rows, ctx)].flat().filter(Boolean));
    tileTables(body, { layout: state.layout, narrow: (ctx.width ?? Infinity) < 560, set });
  }
  host.append(body);
  if (panel.caveats?.length || panel.drillHint) {
    host.append(h('footer', {},
      panel.caveats?.length ? h('ul', { class: 'caveats' }, panel.caveats.map((c) => h('li', {}, c))) : null,
      panel.drillHint ? h('a', { class: 'next', href: '#', onclick: (e) => { e.preventDefault(); drill({ ...panel.drillHint, label: panel.drillHint.text }); } }, `${panel.drillHint.text} →`) : null));
  }
}

function chainsSentence(rows) {
  const ab = rows.filter((r) => r.trigger_key === 'abandoned_cart' && Number(r.final) === 1);
  const sum = (k) => ab.reduce((a, r) => a + (Number(r[k]) || 0), 0);
  const chains = sum('chains');
  if (!chains) return null;
  const cur = app.manifest.site.currency ?? 'USD';
  const money = new Intl.NumberFormat(undefined, { style: 'currency', currency: cur, notation: 'compact', maximumFractionDigits: 2 }).format(sum('revenue'));
  return h('p', { class: 'lead strong' }, `Abandoned-cart chains: ${Math.round(chains / 1000)}K chains, ${(sum('returned') / chains * 100).toFixed(1)}% came back, ${(sum('purchased') / chains * 100).toFixed(1)}% bought, ${money} revenue.`);
}

// Map display fields to entity types for names.
function entityLabel(panel, field, value, row) {
  const type = panel.entities?.[field];
  if (!type) return null;
  let key = value;
  if (type === 'experiment_arm') key = `${row?.experiment_key}|${value}`;
  if (type === 'selector') key = row?.selector_id ?? value;
  const r = app.names.resolve(type, key, row);
  return { label: r.label, title: app.names.title(type, key, row) };
}

async function latestRealExperiment(rows) {
  const ex = (await loadDataset('experiments'))?.rows ?? [];
  const started = new Map(ex.map((e) => [e.name, e.observed_start ?? '']));
  const by = new Map();
  for (const r of rows) {
    const e = by.get(r.experiment) ?? { arms: new Set(), visits: 0 };
    e.arms.add(r.arm);
    if (r.basis === 'assigned' && (r.viewport_type === 'all' || !r.viewport_type)) e.visits += Number(r.sessions) || 0;
    by.set(r.experiment, e);
  }
  const ok = [...by.entries()].filter(([name, e]) => e.arms.size >= 2 && e.visits >= 1000 && !/control vs control|a\/a/i.test(name));
  ok.sort((a, b) => String(started.get(b[0]) ?? '').localeCompare(String(started.get(a[0]) ?? '')) || b[1].visits - a[1].visits);
  return ok[0]?.[0];
}

async function renderVerdicts(tab) {
  const host = $('#verdicts');
  host.replaceChildren();
  if (!tab.verdictMetrics) { host.hidden = true; return; }
  host.hidden = false;
  const ds = await loadDataset('strategy-triggers');
  const page = app.manifest.bundle?.analysedPage?.path;
  host.append(h('h3', {}, 'What the rules say'), page ? h('p', { class: 'muted small' }, `Analysed page: ${page}`) : null);
  if (!ds) { host.append(h('p', { class: 'muted' }, 'No rule results in this snapshot.')); return; }
  if (!tab.verdictMetrics.length) { host.append(h('p', {}, 'No rules read this tab\'s numbers yet.')); return; }
  const rows = ds.rows.filter((r) => tab.verdictMetrics.includes(r.m_metric));
  const fired = rows.filter((r) => r.m_state === 'triggered').length;
  host.append(h('p', {}, fired ? `${rows.length} rules watched, ${fired} triggered. ` : `Nothing fired this week — ${rows.length} rules watched. `,
    h('a', { class: 'next', href: '#', onclick: (e) => { e.preventDefault(); drill({ tab: 'verdicts', panel: 'vd-actions', label: 'Verdicts' }); } }, 'Open →')));
}

function renderMeta() {
  const m = app.manifest;
  const parts = [`${m.site.name} (${m.site.idsite})`];
  if (m.flows?.window) parts.push(`whole weeks ${shortDate(m.flows.window.start)} to ${shortDate(m.flows.window.end)}`);
  if (m.bundle?.window) parts.push(`bundle ${m.bundle.window.start} to ${m.bundle.window.end}`);
  parts.push(`snapshot ${new Date(m.generatedAt).toLocaleString()}`);
  $('#meta').replaceChildren(parts.join(' · '));
}

function setFiltersOpen(open) {
  document.body.classList.toggle('filters-open', open);
  $('#filters-toggle').setAttribute('aria-expanded', String(open));
}

function renderFilterSummary(tab) {
  const site = app.manifest?.site?.name ?? '';
  const week = app.ctx?.week ? `Week of ${shortDate(app.ctx.week)}` : '';
  $('#filters-summary').textContent = [site, tab.label.split(':')[0], week].filter(Boolean).join(' · ');
}

function renderTab({ push = false, scrollTo } = {}) {
  const tab = currentTab();
  document.body.dataset.tab = tab.id;
  renderFilterSummary(tab);
  $('#tab-select').value = tab.id;
  const [label, question] = tab.label.split(/:\s*/);
  $('#tab-title').replaceChildren(h('span', {}, label), h('em', {}, question ?? ''));
  $('#tab-intro').textContent = tab.intro ?? '';
  const host = $('#panels');
  host.replaceChildren();
  const showHidden = app.showHidden[tab.id];
  const main = tab.panels.filter((p) => !p.demoted && (!p.hidden || showHidden));
  const demoted = tab.panels.filter((p) => p.demoted && (!p.hidden || showHidden));
  const hidden = tab.panels.filter((p) => p.hidden);
  const mount = (panel, parent) => {
    const el = h('section', { class: `panel view-${panel.view}${panel.hidden ? ' was-hidden' : ''}`, id: `panel-${panel.id}` }, h('p', { class: 'muted' }, 'Loading…'));
    parent.append(el);
    return renderPanel(panel, el).catch((err) => el.replaceChildren(h('div', { class: 'blocked' }, `Error: ${err.message}`)));
  };
  const jobs = main.map((p) => mount(p, host));
  if (demoted.length) {
    const box = h('details', { class: 'more-cuts' }, h('summary', {}, `More cuts (${demoted.length}): ${demoted.map((p) => p.title).join(', ')}`));
    host.append(box);
    let done = false;
    box.addEventListener('toggle', () => { if (box.open && !done) { done = true; for (const p of demoted) mount(p, box); } });
    if (app.panelState.__openMore === tab.id) box.open = true;
  }
  if (hidden.length) {
    host.append(h('p', { class: 'hidden-line' }, `Hidden in this concept: ${hidden.map((p) => p.title).join(', ')}. `,
      h('a', { href: '#', onclick: (e) => { e.preventDefault(); app.showHidden[tab.id] = !showHidden; renderTab(); } }, showHidden ? 'hide them' : 'show')));
  }
  renderVerdicts(tab);
  writeHash(push);
  if (scrollTo) Promise.all(jobs).then(() => setTimeout(() => document.getElementById(`panel-${scrollTo}`)?.scrollIntoView({ block: 'start' }), 150));
  log('load', { tab: tab.id });
}

function selectTab(id) {
  app.tab = id;
  app.crumbs = [];
  renderCrumbs();
  renderTab();
  window.scrollTo({ top: 0 });
}

async function selectSite(slug, ctx) {
  app.site = slug;
  app.manifest = await getJson(`${DATA}/sites/${slug}/manifest.json`);
  app.names = makeNames(await getJson(`names/${slug}.json`).catch(() => ({})));
  const funnelDs = await loadDataset('funnel');
  app.weeks = funnelDs ? [...new Set(funnelDs.rows.map((r) => r.week))].sort() : [];
  app.cov = weekCoverage(app.manifest, 'funnel', app.weeks);
  const d = defaultCtx();
  app.ctx = { ...d, ...(ctx ?? {}) };
  if (!app.weeks.includes(app.ctx.week)) app.ctx.week = d.week;
  $('#site-select').value = slug;
  renderMeta();
  renderContextBar();
  renderTab();
}

function renderGlossary() {
  $('#glossary-body').replaceChildren(
    h('dl', {}, app.views.glossary.map((g) => [h('dt', {}, g.term), h('dd', {}, g.text)])),
    h('h4', {}, 'Measures'),
    h('dl', { class: 'measures' }, Object.values(app.views.measures).filter((m) => m.help).map((m) => [h('dt', {}, m.label), h('dd', {}, m.help)])));
}

async function applyHash() {
  const hash = readHash();
  try { app.panelState = hash.state ? JSON.parse(hash.state) : {}; } catch { app.panelState = {}; }
  app.tab = app.views.tabs.some((t) => t.id === hash.tab) ? hash.tab : app.views.tabs[0].id;
  const slug = app.sites.some((s) => s.slug === hash.site) ? hash.site : app.sites.find((s) => s.slug === 'mellow')?.slug ?? app.sites[0].slug;
  if (slug !== app.site) { app.cache.clear(); await selectSite(slug, hash.ctx); return; }
  if (hash.ctx) app.ctx = { ...app.ctx, ...hash.ctx };
  renderContextBar();
  renderTab();
}

async function init() {
  [app.views, app.sites] = await Promise.all([getJson('views.json'), getJson(`${DATA}/sites.json`).catch(() => [])]);
  document.title = `${app.views.title} — ${app.views.revision}`;
  $('#title').textContent = app.views.title;
  if (!app.sites.length) {
    $('#panels').replaceChildren(h('div', { class: 'blocked' }, `No snapshots yet. Expected ${DATA}/sites.json.`));
    return;
  }
  $('#site-select').replaceChildren(...app.sites.map((s) => h('option', { value: s.slug }, s.name)));
  $('#tab-select').replaceChildren(...app.views.tabs.map((t) => h('option', { value: t.id }, t.label)));
  $('#site-select').addEventListener('change', (e) => { setFiltersOpen(false); app.panelState = {}; app.crumbs = []; app.cache.clear(); renderCrumbs(); selectSite(e.target.value); });
  $('#tab-select').addEventListener('change', (e) => { setFiltersOpen(false); selectTab(e.target.value); });
  $('#glossary-open').addEventListener('click', () => { $('#glossary').hidden = false; });
  $('#filters-toggle').addEventListener('click', () => setFiltersOpen(!document.body.classList.contains('filters-open')));
  document.addEventListener('click', (e) => { if (document.body.classList.contains('filters-open') && !e.target.closest('.top')) { e.preventDefault(); e.stopPropagation(); setFiltersOpen(false); } }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && document.body.classList.contains('filters-open')) setFiltersOpen(false); });
  $('#glossary-open').addEventListener('click', () => setFiltersOpen(false));
  $('#glossary-close').addEventListener('click', () => { $('#glossary').hidden = true; });
  window.addEventListener('popstate', (e) => {
    app.crumbs = e.state?.crumbs ?? [];
    renderCrumbs();
    applyHash();
  });
  renderGlossary();
  facilitatorPanel();
  mountMenu($('#menu-open'), { log });
  const hash = readHash();
  try { app.panelState = hash.state ? JSON.parse(hash.state) : {}; } catch { app.panelState = {}; }
  app.crumbs = history.state?.crumbs ?? [];
  renderCrumbs();
  app.tab = app.views.tabs.some((t) => t.id === hash.tab) ? hash.tab : app.views.tabs[0].id;
  const site = app.sites.some((s) => s.slug === hash.site) ? hash.site : app.sites.find((s) => s.slug === 'mellow')?.slug ?? app.sites[0].slug;
  await selectSite(site, hash.ctx);
}

init().catch((err) => {
  document.body.append(h('pre', { class: 'blocked' }, String(err.stack ?? err)));
});
