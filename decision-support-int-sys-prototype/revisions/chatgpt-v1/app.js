import { answers, brief, changeBridge, comparison, eventReach, journeyFocus, mixRate, outcomes } from './answer-views.js';
import { compareWeek, contextPhrase, defaultWeek, hashFrom, readHash, renderContextBar, unsupportedScope, writeHash } from './context.js';
import { coverage } from './contracts.js';
import { buildAnalysis, labelOf } from './derive.js';
import { drawEvidence } from './evidence.js';
import { journey, funnel, minifunnels, trendlines } from './flows-views.js';
import { addPin, briefMarkdown, download, logEvent, readLog, readPins, removePin, writePins } from './pins.js';
import { matches, measureColumns, resolvePickers, toObjects, ALL } from './query.js';
import { cards, h, series, table, weekly } from './views.js';

const DATA = '../../data';
const VIEWS = {
  weekly, table, series, cards, journey, funnel, minifunnels, trendlines,
  comparison, eventReach, journeyFocus, answers, outcomes, changeBridge, mixRate, brief,
};
const CONCEPT = new Set(['comparison', 'eventReach', 'journeyFocus', 'answers', 'outcomes', 'changeBridge', 'mixRate', 'brief']);

const app = {
  views: null, sites: [], manifest: null, cache: new Map(), panelState: {},
  site: null, tab: null, context: { week: null, cmp: 'prev', seg: 'all', segv: 'all', dev: 'all' },
  focus: null, ev: null, linkSnap: null, families: [], values: {},
};

const $ = (sel) => document.querySelector(sel);
let silence = false;

async function getJson(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json();
}

function commit(mode) {
  const hash = hashFrom(app);
  if (location.hash === hash) return;
  silence = true;
  if (mode === 'push') history.pushState({ qt: 1 }, '', hash);
  else history.replaceState({ qt: 1 }, '', hash);
  silence = false;
}

const currentTab = () => app.views.tabs.find((t) => t.id === app.tab) ?? app.views.tabs[0];
function measure(id) {
  return app.views.measures[id] ?? { label: id, sum: id, format: 'num' };
}
const labels = () => ({ ...Object.fromEntries(app.families.filter(Boolean).map((f) => [f, labelOf(f)])), ...(app.views.valueLabels ?? {}) });

function contextId() {
  const c = app.context;
  return `${c.week}|${c.cmp}|${c.seg}:${c.segv}|${c.dev}`;
}

function weeksOf(rows) {
  return [...new Set(rows.map((r) => r.week))].sort();
}

async function loadDataset(name) {
  const key = `${app.site}/${name}`;
  if (app.cache.has(key)) return app.cache.get(key);
  const meta = app.manifest.datasets[name];
  if (!meta) return null;
  app.cache.set(key, getJson(`${DATA}/sites/${app.site}/${meta.file}`).then((j) => ({ meta, columns: j.columns, rows: toObjects(j) })));
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

function coverageOf(dataset) {
  const map = coverage(app.manifest, dataset);
  return (week) => map.get(String(week));
}

function applyHash(hash) {
  app.panelState = hash.state ?? {};
  app.focus = hash.focus;
  app.ev = hash.ev;
  app.context = { ...app.context, ...hash.context };
  if (!app.switchingSite && hash.snap && hash.snap !== app.manifest?.generatedAt) app.linkSnap = hash.snap;
}

function go(patch) {
  if (patch.tab) app.tab = patch.tab;
  if (patch.focus !== undefined) app.focus = patch.focus;
  if (patch.seg) { app.context.seg = patch.seg; app.context.segv = patch.segv; }
  if (patch.ev === null) app.ev = null;
  commit('push');
  renderAll();
  window.scrollTo({ top: 0 });
}

function openEvidence(ref) {
  app.ev = ref;
  commit('push');
  paintEvidence();
  logEvent('evidence_opened', { tab: app.tab, context: contextId(), ev: ref.measure });
  if (ref.filter?.segment && ref.filter.segment !== 'all' && ref.filter.segment !== 'traffic_source') {
    logEvent('unsupported_cut_requested', { tab: app.tab, context: contextId(), ev: ref.measure });
  }
}

function closeEvidence() {
  if (location.hash.includes('ev=')) history.back();
  else { app.ev = null; paintEvidence(); commit('replace'); }
}

function paintEvidence() {
  const host = $('#evidence');
  drawEvidence(host, app.ev, {
    manifest: app.manifest,
    funnelRows: app.funnelRows ?? [],
    journeyRows: app.journeyRows ?? [],
    context: resolvedContext(),
    closeEvidence,
    go,
  });
}

function resolvedContext() {
  const weeks = app.weekList ?? [];
  const week = weeks.includes(app.context.week) ? app.context.week : (defaultWeek(app.manifest) ?? weeks.at(-1));
  const cmp = app.context.cmp === 'none' ? 'none' : 'prev';
  return {
    week,
    compareWeek: compareWeek(weeks, week, cmp),
    cmp,
    segment: app.context.seg || 'all',
    segmentValue: app.context.seg === 'all' ? 'all' : (app.context.segv || 'all'),
    device: app.context.dev || 'all',
  };
}

async function ensureFlows() {
  const [funnelDs, journeyDs, tagDs] = await Promise.all([loadDataset('funnel'), loadDataset('journeys'), loadDataset('tag_trend')]);
  app.funnelRows = funnelDs?.rows ?? [];
  app.journeyRows = journeyDs?.rows ?? [];
  app.tagRows = tagDs?.rows ?? [];
  app.weekList = weeksOf(app.funnelRows);
  const segs = app.manifest.flows?.segmentations ?? [];
  app.families = ['all', ...segs.filter((f) => f && f !== 'null')];
  app.values = { all: ['all'] };
  for (const f of segs) {
    app.values[f] = [...new Set(app.funnelRows.filter((r) => r.segment === f).map((r) => r.segment_value))].sort();
  }
}

function analysisFor(ctx) {
  const rowsOf = (name) => (name === 'tag_trend' ? app.tagRows : app.funnelRows);
  return buildAnalysis({
    funnelRows: app.funnelRows,
    journeyRows: app.journeyRows,
    manifest: app.manifest,
    context: { ...ctx, rowsOf },
    screening: app.views.screening,
    rules: app.views.answerRules,
    emptyState: app.views.emptyState,
  });
}

function conceptCtx(panel, base) {
  const state = app.panelState[panel.id] ?? (app.panelState[panel.id] = {});
  const set = (patch) => {
    Object.assign(state, patch);
    commit('replace');
    renderAll();
  };
  const ctx = resolvedContext();
  const override = state.override === 'all';
  const used = override ? { ...ctx, segment: 'all', segmentValue: 'all' } : ctx;
  return {
    ...base,
    state, set, panel,
    context: used,
    manifest: app.manifest,
    views: app.views,
    currency: app.manifest.site.currency ?? 'USD',
    funnelRows: app.funnelRows,
    journeyRows: app.journeyRows,
    analysis: analysisFor(used),
    focus: app.focus,
    fieldLabel: (name, valueOf) => (valueOf !== undefined ? (labels()[name] ?? labelOf(name)) : (app.views.fields[name] ?? name)),
    openEvidence, go, log: (event, extra) => logEvent(event, { tab: app.tab, context: contextId(), ...extra }),
    pin(finding) {
      const ref = {
        snap: app.manifest.generatedAt, measure: finding.evidence?.metric, filter: {
          segment: used.segment, segment_value: used.segmentValue, viewport_type: used.device,
        },
      };
      addPin(app.site, app.manifest.generatedAt, {
        id: `${finding.ruleId}:${finding.evidence?.subject}`,
        claim: finding.claim,
        caveats: finding.caveats,
        evidenceRef: ref,
        pinnedAt: new Date().toISOString(),
      });
      logEvent('answer_pinned', { tab: app.tab, context: contextId(), ev: finding.ruleId });
    },
    pins: () => readPins(app.site, app.manifest.generatedAt),
    unpin(id) { removePin(app.site, app.manifest.generatedAt, id); renderAll(); },
    setAction(action) {
      const data = readPins(app.site, app.manifest.generatedAt);
      data.action = action;
      writePins(app.site, app.manifest.generatedAt, data);
    },
    copyBrief(scope) {
      const text = briefMarkdown(readPins(app.site, app.manifest.generatedAt), scope);
      navigator.clipboard?.writeText(text);
      logEvent('brief_exported', { tab: app.tab, context: contextId(), ev: 'markdown' });
    },
    downloadBrief(scope) {
      const data = readPins(app.site, app.manifest.generatedAt);
      download('client-brief.json', JSON.stringify({ scope, ...data }, null, 2), 'application/json');
      logEvent('brief_exported', { tab: app.tab, context: contextId(), ev: 'json' });
    },
  };
}

async function renderConcept(panel, host) {
  const ctx = resolvedContext();
  const block = unsupportedScope(panel, { seg: ctx.segment, breakdown: panel.breakdown });
  const state = app.panelState[panel.id] ?? {};
  host.replaceChildren(h('header', {}, h('div', {}, h('h3', {}, panel.title), h('p', { class: 'question' }, panel.question))));
  if (block && state.override !== 'all') {
    const field = labels()[block.field] ?? block.field;
    host.append(h('div', { class: 'blocked choice' },
      h('p', {}, `This view can't be filtered by ${field} (${block.reason}).`),
      h('div', { class: 'finding-actions' },
        h('button', { type: 'button', onclick: () => { state.override = 'all'; app.panelState[panel.id] = state; logEvent('scope_change_accepted', { tab: app.tab, context: contextId(), ev: panel.id }); commit('replace'); renderAll(); } }, 'Show it for all visitors'),
        h('button', { type: 'button', onclick: () => go({ tab: block.alternative.tab, focus: block.alternative.panel }) }, `Keep my filter and go to ${block.alternative.panel}`)),
      h('p', { class: 'small muted' }, block.alternative.note)));
    return;
  }
  if (state.override === 'all') {
    host.append(h('p', { class: 'chip' }, 'Showing all visitors ', h('button', { type: 'button', class: 'texty', onclick: () => { delete state.override; commit('replace'); renderAll(); } }, 'remove ✕')));
  }
  const viewCtx = conceptCtx(panel);
  const body = h('div', { class: 'panel-body' });
  body.append(...[VIEWS[panel.view](panel, viewCtx)].flat().filter(Boolean));
  host.append(body);
}

async function renderPanel(panel, host) {
  if (CONCEPT.has(panel.view)) { await renderConcept(panel, host); return; }
  const state = app.panelState[panel.id] ?? (app.panelState[panel.id] = {});
  const ds = await loadDataset(panel.dataset);
  host.replaceChildren();
  const header = h('header', {},
    h('div', {}, h('h3', {}, panel.title), h('p', { class: 'question' }, panel.question)),
    ds ? sourceBadge(ds.meta) : null);
  host.append(header);
  if (ds?.meta?.capped) {
    host.append(h('p', { class: 'chip warn' }, `Incomplete source: ${ds.meta.rows.toLocaleString()} of ${ds.meta.cappedFrom.toLocaleString()} rows exported. Totals and week-to-week rankings are not shown.`));
  }
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
    commit('replace');
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
  const ctx = {
    state, set, measure, fieldLabel: label, join, currency: app.manifest.site.currency ?? 'USD',
    capped: Boolean(ds.meta.capped), coverageOf: coverageOf(panel.dataset),
  };
  const body = h('div', { class: 'panel-body' });
  if (!rows.length) body.append(h('div', { class: 'blocked' }, 'No rows for this selection.'));
  else body.append(...[VIEWS[panel.view](panel, rows, ctx)].flat().filter(Boolean));
  host.append(body);
  if (panel.caveats?.length || panel.next) {
    host.append(h('footer', {},
      panel.caveats?.length ? h('ul', { class: 'caveats' }, panel.caveats.map((c) => h('li', {}, c))) : null,
      panel.next ? h('a', { class: 'next', href: '#', onclick: (e) => { e.preventDefault(); selectTab(panel.next.tab, 'push'); } }, `${panel.next.text} →`) : null));
  }
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

async function renderVerdicts(tab) {
  const host = $('#verdicts');
  host.replaceChildren();
  if (tab.group === 'Reference' && !tab.verdictMetrics?.length) { host.hidden = true; return; }
  if (tab.group !== 'Reference') { host.hidden = true; return; }
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
  host.append(h('a', { class: 'next', href: '#', onclick: (e) => { e.preventDefault(); selectTab('ref-verdicts', 'push'); } }, 'All verdicts →'));
}

function renderMeta() {
  const m = app.manifest;
  const w = m.bundle?.window;
  const parts = [`${m.site.name} (${m.site.idsite})`];
  const weeks = m.warehouse?.trendWeeks ?? [];
  if (weeks.length) parts.push(`warehouse weeks ${weeks[0]} to ${weeks[weeks.length - 1]}`);
  if (w) parts.push(`bundle ${w.start ?? w[0]} to ${w.end ?? w[1]}`);
  parts.push(`snapshot ${new Date(m.generatedAt).toLocaleString()}`);
  const misses = (Array.isArray(m.checks) ? m.checks : Object.values(m.checks ?? {})).reduce((s, c) => s + (c.misses ?? 0), 0);
  $('#meta').replaceChildren(parts.join(' · '), h('span', { class: `check ${misses ? 'bad' : 'ok'}` }, misses ? `${misses} partition misses` : 'partition check passed'));
  const banner = $('#snap-banner');
  if (app.linkSnap && app.linkSnap !== m.generatedAt) {
    banner.hidden = false;
    banner.textContent = `This link was made on snapshot ${app.linkSnap}. You're seeing snapshot ${m.generatedAt}; numbers may differ.`;
  } else banner.hidden = true;
}

function renderContext() {
  const ctx = resolvedContext();
  app.context.week = ctx.week;
  app.context.cmp = ctx.cmp;
  renderContextBar($('#context-bar'), {
    manifest: app.manifest,
    context: { ...app.context, week: ctx.week },
    weeks: app.weekList,
    families: app.families,
    values: app.values,
    labels: labels(),
    onChange(patch) {
      const before = contextId();
      Object.assign(app.context, patch);
      if (patch.seg && patch.seg !== 'all' && !patch.segv) app.context.segv = app.values[patch.seg]?.[0] ?? 'all';
      commit('replace');
      if (contextId() !== before) logEvent('context_changed', { tab: app.tab, context: contextId() });
      renderAll();
    },
  });
}

async function renderAll() {
  const tab = currentTab();
  $('#tab-select').value = tab.id;
  $('#tab-title').replaceChildren(h('span', {}, tab.short || tab.label), tab.question ? h('em', {}, tab.question) : null);
  const intro = $('#tab-intro');
  intro.replaceChildren(tab.intro ?? '');
  if (tab.group === 'Reference') intro.append(h('span', { class: 'ref-banner' }, ' Reference views keep their own filters and don\'t follow the context bar.'));
  if (tab.inherit) await ensureFlows();
  renderContext();
  const host = $('#panels');
  host.replaceChildren();
  for (const panel of tab.panels) {
    const el = h('section', { class: `panel view-${panel.view}`, id: `panel-${panel.id}` }, h('p', { class: 'muted' }, 'Loading…'));
    host.append(el);
    renderPanel(panel, el).catch((err) => el.replaceChildren(h('div', { class: 'blocked' }, `Error: ${err.message}`)));
  }
  renderVerdicts(tab);
  paintEvidence();
  document.body.dataset.snap = app.manifest.generatedAt;
}

function selectTab(id, mode = 'push') {
  app.tab = id;
  app.ev = null;
  commit(mode);
  renderAll();
  window.scrollTo({ top: 0 });
}

async function selectSite(slug, mode = 'replace') {
  const siteChanged = app.site && app.site !== slug;
  if (siteChanged) { app.switchingSite = true; app.linkSnap = null; }
  app.site = slug;
  app.manifest = await getJson(`${DATA}/sites/${slug}/manifest.json`);
  app.cache.clear();
  $('#site-select').value = slug;
  await ensureFlows();
  if (!app.context.week) app.context.week = defaultWeek(app.manifest);
  if (siteChanged) app.linkSnap = null;
  app.switchingSite = false;
  renderMeta();
  commit(mode);
  await renderAll();
}

function renderGlossary() {
  $('#glossary-body').replaceChildren(
    h('dl', {}, app.views.glossary.map((g) => [h('dt', {}, g.term), h('dd', {}, g.text)])),
    h('h4', {}, 'Measures'),
    h('dl', { class: 'measures' }, Object.values(app.views.measures).filter((m) => m.help).map((m) => [h('dt', {}, m.label), h('dd', {}, m.help)])));
}

function fillTabs() {
  const groups = [];
  for (const tab of app.views.tabs) {
    let g = groups.find((x) => x.label === tab.group);
    if (!g) { g = { label: tab.group || 'More', options: [] }; groups.push(g); }
    g.options.push(tab);
  }
  $('#tab-select').replaceChildren(...groups.map((g) => h('optgroup', { label: g.label },
    g.options.map((t) => h('option', { value: t.id }, t.short || t.label)))));
}

function facilitator() {
  const on = new URLSearchParams(location.search).get('facilitator') === '1';
  const host = $('#facilitator');
  if (!on) { host.hidden = true; return; }
  host.hidden = false;
  let task = '1';
  host.replaceChildren(
    h('span', {}, 'Facilitator'),
    h('label', {}, 'Task ', h('input', { value: task, onchange: (e) => { task = e.target.value; } })),
    h('button', { type: 'button', onclick: () => logEvent('task_started', { tab: app.tab, context: contextId(), ev: task }) }, 'Start'),
    h('button', { type: 'button', onclick: () => logEvent('task_completed', { tab: app.tab, context: contextId(), ev: task }) }, 'Stop'),
    h('button', { type: 'button', onclick: () => download('task-log.json', JSON.stringify(readLog(), null, 2), 'application/json') }, 'Download log'));
}

function restore() {
  const hash = readHash();
  applyHash(hash);
  const tabOk = app.views.tabs.some((t) => t.id === hash.tab);
  app.tab = tabOk ? hash.tab : app.views.tabs[0].id;
  const siteOk = app.sites.some((s) => s.slug === hash.site);
  return selectSite(siteOk ? hash.site : app.sites[0].slug, 'replace');
}

window.__qtRefresh = () => renderAll();

async function init() {
  [app.views, app.sites] = await Promise.all([getJson('views.json'), getJson(`${DATA}/sites.json`).catch(() => [])]);
  document.title = `${app.views.title} · ${app.views.revision ?? 'ChatGPT - V1'}`;
  $('#title').textContent = app.views.title;
  const tag = document.querySelector('.tag');
  if (tag) tag.textContent = app.views.revision ?? 'ChatGPT - V1';
  if (!app.sites.length) {
    $('#panels').replaceChildren(h('div', { class: 'blocked' }, `No snapshots yet. Expected ${DATA}/sites.json. Run node prototype/query-tool/snapshot.mjs --site <slug>.`));
    return;
  }
  $('#site-select').replaceChildren(...app.sites.map((s) => h('option', { value: s.slug }, s.name)));
  fillTabs();
  $('#site-select').addEventListener('change', (e) => { app.panelState = {}; app.ev = null; selectSite(e.target.value); });
  $('#tab-select').addEventListener('change', (e) => selectTab(e.target.value, 'push'));
  $('#glossary-open').addEventListener('click', () => { $('#glossary').hidden = false; });
  $('#glossary-close').addEventListener('click', () => { $('#glossary').hidden = true; });
  window.addEventListener('popstate', () => { if (!silence) restore(); });
  window.addEventListener('hashchange', () => { if (!silence) restore(); });
  renderGlossary();
  facilitator();
  await restore();
}

init().catch((err) => {
  document.body.append(h('pre', { class: 'blocked' }, String(err.stack ?? err)));
});
