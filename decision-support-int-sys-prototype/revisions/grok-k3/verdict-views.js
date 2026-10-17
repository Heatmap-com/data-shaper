// Verdicts as actions, the unblock list, and the landing-page scatter.
import { format } from './query.js';
import { h, s } from './views.js';

const int = (v) => Math.round(Number(v) || 0).toLocaleString();
const pct = (v) => `${(Number(v) * 100).toFixed(1)}%`;
const splitSel = (text) => String(text ?? '').split(' | ').map((x) => x.trim()).filter(Boolean);

function selectorIndex(rows) {
  const by = new Map();
  for (const r of rows ?? []) {
    const e = by.get(r.selector) ?? { id: r.selector_id, row: r, clicking: 0, revenue: 0, clicks: 0 };
    e.clicking += Number(r.m_clicking_sessions) || 0;
    e.revenue += Number(r.m_revenue_udp) || 0;
    e.clicks += Number(r.m_clicks) || 0;
    by.set(r.selector, e);
  }
  return by;
}

function elementName(sel, idx, ctx) {
  const e = idx.get(sel);
  return ctx.names.resolve('selector', e?.id ?? sel, e?.row ?? { selector: sel }).label;
}

// One plain-language template per rule metric. `drill` names the evidence panel.
const METRICS = {
  clicks_with_zero_revenue: {
    finding: (r, x) => `${int(r.m_value)} clicks on ${x.sels.length} element${x.sels.length === 1 ? '' : 's'} with no order after them${x.names ? ` (${x.names})` : ''}.`,
    next: 'See these elements by week', drill: { tab: 'elements', panel: 'el-selectors' }, elements: true,
  },
  sister_page_rps: {
    finding: (r, x) => {
      const best = Math.max(...[...String(r.m_detail).matchAll(/rps ([\d.]+)/g)].map((m) => Number(m[1])), 0);
      return `This page makes ${format(r.m_value, 'money', x.ctx.currency)} per session; another landing page from the same source makes up to ${format(best, 'money', x.ctx.currency)}.`;
    },
    next: 'Compare with its sister pages', drill: { tab: 'pages', panel: 'pg-sisters', more: true },
  },
  same_class_gap: {
    finding: (r) => {
      const m = String(r.m_detail).match(/class (\w+) week ([\d-]+) click gap ([\d.]+)x/);
      return m ? `Elements of the same kind (${m[1].replace(/_/g, ' ')}) differ ${Math.round(Number(m[3]))}× in clicks in the week of ${m[2]}.` : 'Elements of the same kind perform very differently.';
    },
    next: 'Compare the elements', drill: { tab: 'elements', panel: 'el-selectors' },
  },
  product_tile_promotion: {
    finding: (r, x) => {
      const m = String(r.m_detail).match(/order rate ([\d.]+)/);
      return `"${elementName(r.m_value, x.idx, x.ctx)}" is a product tile with ${m ? `a ${pct(m[1])} order rate` : 'a low order rate'}, below a better tile on the same page.`;
    },
    next: 'See the element', drill: { tab: 'elements', panel: 'el-selectors' }, elements: true,
  },
  above_fold_promotion: {
    finding: (r, x) => `"${elementName(r.m_value, x.idx, x.ctx)}" holds the top of the page, while a lower element converts better.`,
    next: 'See the element', drill: { tab: 'elements', panel: 'el-selectors' }, elements: true,
  },
  rage_sessions: {
    finding: (r) => `${int(r.m_value)} sessions had rage clicks (3 or more clicks on one element within 2 seconds).`,
    next: 'See where people rage-click', drill: { tab: 'elements', panel: 'el-rage' },
  },
  nav_click_share: {
    finding: (r) => `${Number(r.m_value).toFixed(1)}% of entry sessions click the menu (the rule flags above 10%).`,
    next: 'See where the menu sends people', drill: { tab: 'elements', panel: 'el-nav' },
  },
  segment_rps_lag: {
    finding: (r, x) => {
      const m = String(r.m_detail).match(/campaign (\S+?)\/(\S+) rps ([\d.]+) vs median ([\d.]+)/);
      if (!m) return `${int(r.m_value)} traffic slices make far less per session than the rest.`;
      const name = x.ctx.names.resolve('campaign', m[2], { campaign: m[2] }).label;
      return `${int(r.m_value)} campaign slices make far less per session than the median — for example "${name}" at ${format(m[3], 'money', x.ctx.currency)} against ${format(m[4], 'money', x.ctx.currency)}.`;
    },
    next: 'See campaigns', drill: { tab: 'acquisition', panel: 'acq-campaigns' },
  },
  scroll_reach_25: {
    finding: (r) => `Only ${pct(r.m_value)} of visitors scroll a quarter of the way down (the rule wants 30%).`,
    next: 'See scroll depth', drill: { tab: 'elements', panel: 'el-scroll' },
  },
};

const PLAIN_BLOCK = {
  'drawer/checkout selectors not classed': 'Cart drawer and checkout buttons are not labelled yet.',
  'no hero_cta classed selectors': 'The hero button is not labelled yet.',
  'fewer than two faq_item selectors are classed': 'FAQ items are not labelled yet.',
  'fewer than two nav_link selectors are classed': 'Menu links are not labelled yet.',
};

export function actions(panel, rows, ctx) {
  const idx = selectorIndex(ctx.also['selector-weekly']);
  const path = ctx.manifest.bundle?.analysedPage?.path ?? '';
  const pageRows = (ctx.also['entry-by-channel'] ?? []).filter((r) => path && String(r.m_url).replace(/[?#].*$/, '').endsWith(path));
  const page = pageRows.reduce((a, r) => ({ sessions: a.sessions + (Number(r.m_sessions) || 0), revenue: a.revenue + (Number(r.m_revenue_udp) || 0) }), { sessions: 0, revenue: 0 });
  const cards = ctx.also.cards ?? [];
  const groups = new Map();
  for (const r of rows.filter((x) => x.m_state === 'triggered')) {
    const g = groups.get(r.m_metric) ?? { metric: r.m_metric, rules: [], row: r };
    g.rules.push(r.x_strategy_id);
    groups.set(r.m_metric, g);
  }
  const list = [...groups.values()].map((g) => {
    const cfg = METRICS[g.metric] ?? { finding: (r) => `${g.metric.replace(/_/g, ' ')}: ${r.m_value} (${r.m_threshold ?? 'no threshold'}).`, next: 'See the rule', drill: { tab: 'verdicts', panel: 'vd-triggers', more: true } };
    const sels = cfg.elements ? splitSel(g.metric === 'clicks_with_zero_revenue' ? g.row.m_detail : g.row.m_value) : [];
    const attached = sels.length
      ? sels.reduce((a, sel) => { const e = idx.get(sel); return { sessions: a.sessions + (e?.clicking ?? 0), revenue: a.revenue + (e?.revenue ?? 0), kind: 'element' }; }, { sessions: 0, revenue: 0, kind: 'element' })
      : { ...page, kind: 'page' };
    const names = sels.length ? sels.slice(0, 3).map((x) => `"${elementName(x, idx, ctx)}"`).join(', ') + (sels.length > 3 ? ` and ${sels.length - 3} more` : '') : '';
    const ideas = cards.filter((c) => g.rules.includes(c.strategy_id) && c.trigger_state === 'triggered').length;
    return { ...g, cfg, sels, attached, finding: cfg.finding(g.row, { sels, names, idx, ctx }), ideas };
  }).sort((a, b) => b.attached.revenue - a.attached.revenue);
  ctx.log('actions_rendered', { groups: list.length });
  const soWhat = (a) => (a.attached.kind === 'element'
    ? (a.attached.sessions ? `${int(a.attached.sessions)} sessions clicked ${a.sels.length === 1 ? 'it' : 'them'}, with ${format(a.attached.revenue, 'money', ctx.currency)} in orders after.` : 'No clicking sessions recorded for these elements in the snapshot.')
    : `The analysed page had ${int(a.attached.sessions)} entry sessions and ${format(a.attached.revenue, 'money', ctx.currency)} in orders in the report window.`);
  const blocked = rows.filter((r) => r.m_state === 'blocked');
  const below = rows.filter((r) => r.m_state === 'below_floor');
  return [
    list.length ? h('div', { class: 'action-cards' }, list.map((a) => h('article', { class: 'action' },
      h('p', { class: 'finding' }, a.finding),
      h('p', { class: 'sowhat' }, h('span', { class: 'muted small' }, 'So what: '), soWhat(a)),
      h('p', { class: 'nextmove' }, h('a', { class: 'next', href: '#', onclick: (e) => { e.preventDefault(); ctx.log('action_click', { metric: a.metric }); ctx.drill({ ...a.cfg.drill, label: a.cfg.next }); } }, `${a.cfg.next} →`)),
      h('p', { class: 'rules muted small' }, `Rules ${a.rules.join(', ')}${a.ideas ? ` · ${a.ideas} test ideas` : ''}`))))
      : h('p', { class: 'answer ok' }, `Nothing fired this week — ${rows.length} rules watched.`),
    blocked.length ? h('details', { class: 'queue' }, h('summary', {}, `${blocked.length} rules can't run yet`),
      h('ul', {}, blocked.map((r) => h('li', {}, h('strong', {}, r.x_strategy_id), ' ', PLAIN_BLOCK[r.m_detail] ?? r.m_detail ?? 'Missing input.'))),
      h('a', { class: 'next', href: '#', onclick: (e) => { e.preventDefault(); ctx.drill({ tab: 'verdicts', panel: 'vd-unblock', label: 'Unblock' }); } }, 'What would unblock them →')) : null,
    below.length ? h('details', { class: 'queue' }, h('summary', {}, `${below.length} below the volume floor`),
      h('ul', {}, below.map((r) => h('li', {}, h('strong', {}, r.x_strategy_id), ` ${r.m_metric.replace(/_/g, ' ')}: ${r.m_detail ?? 'not enough traffic'}.`)))) : null,
  ];
}

const WHO = {
  operator: 'You (operator form)', tracker: 'Tracking change', commerce: 'Store connector', vendor: 'App/vendor connector',
  ads_external: 'Ad platform connector', heatmap: 'Heatmap capture', render: 'Page render capture',
};
const TYPE_LABEL = { campaign: 'campaigns', creative: 'creatives', selector: 'elements', experiment: 'experiments', experiment_arm: 'experiment arms' };

export function unblock(panel, rows, ctx) {
  const counts = new Map();
  for (const c of ctx.also.cards ?? []) for (const k of String(c.missing ?? '').split(/[,\s]+/).filter(Boolean)) counts.set(k, (counts.get(k) ?? 0) + 1);
  const reqs = new Map(rows.map((r) => [r.requirement_key, r]));
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const limit = ctx.state.all ? ranked.length : 10;
  const nc = ctx.names.counts();
  const pending = Object.entries(nc).filter(([, n]) => n > 0);
  const body = ranked.slice(0, limit).map(([k, n]) => {
    const r = reqs.get(k);
    return h('tr', {},
      h('td', { class: 'label' }, h('div', {}, r?.title ? r.title.split(/[:.]/)[0] : k), h('div', { class: 'muted small' }, k)),
      h('td', {}, WHO[r?.domain] ?? (r?.domain ?? '—')),
      h('td', { class: 'num strong' }, int(n)),
      h('td', { class: 'muted small' }, r?.detail ?? ''));
  });
  if (pending.length) {
    body.unshift(h('tr', { class: 'names-row' },
      h('td', { class: 'label' }, h('div', {}, 'Confirm names'), h('div', { class: 'muted small' }, 'naming')),
      h('td', {}, 'You (naming feature)'),
      h('td', { class: 'num' }, '—'),
      h('td', { class: 'small' }, `Placeholder names are showing for ${pending.map(([t, n]) => `${int(n)} ${TYPE_LABEL[t] ?? t}`).join(', ')}. Confirmed names replace them everywhere.`)));
  }
  return [
    h('p', { class: 'answer' }, `${ranked.length} missing inputs hold back test ideas. The top one, ${ranked[0] ? `${reqs.get(ranked[0][0])?.title?.split(/[:.]/)[0] ?? ranked[0][0]}` : '—'}, would unlock ${ranked[0]?.[1] ?? 0}.`),
    h('div', { class: 'scroll' }, h('table', { class: 'grid' },
      h('thead', {}, h('tr', {}, h('th', { class: 'label' }, 'Missing input'), h('th', {}, 'Who can supply it'), h('th', { class: 'num' }, 'Test ideas waiting'), h('th', {}, 'Why it is missing'))),
      h('tbody', {}, body))),
    ranked.length > 10 ? h('p', { class: 'foot' }, h('a', { href: '#', onclick: (e) => { e.preventDefault(); ctx.set({ all: !ctx.state.all }); } }, ctx.state.all ? 'Show top 10' : `Show all ${ranked.length}`)) : null,
  ];
}

export function landingScatter(panel, rows, ctx) {
  const by = new Map();
  for (const r of rows) {
    const url = String(r.m_url ?? r.url ?? '').replace(/^https?:\/\/[^/]+/, '').replace(/[?#].*$/, '') || '/';
    const e = by.get(url) ?? { url, sessions: 0, orders: 0, single: 0, revenue: 0 };
    e.sessions += Number(r.m_sessions) || 0;
    e.orders += Number(r.m_orders_udp) || 0;
    e.single += Number(r.m_single_pageview_sessions) || 0;
    e.revenue += Number(r.m_revenue_udp) || 0;
    by.set(url, e);
  }
  const pts = [...by.values()].filter((p) => p.sessions >= 100).map((p) => ({ ...p, x: p.single / p.sessions, y: p.orders / p.sessions }));
  if (pts.length < 3) return h('p', { class: 'muted small' }, 'Too few landing pages with 100+ sessions to plot.');
  const tot = pts.reduce((a, p) => ({ s: a.s + p.sessions, o: a.o + p.orders, x: a.x + p.single }), { s: 0, o: 0, x: 0 });
  const mx = tot.x / tot.s; const my = tot.o / tot.s;
  const W = Math.round(Math.max(300, Math.min(900, ctx.width ?? 900))); const narrow = W < 560;
  const H = narrow ? 300 : 320; const L = narrow ? 40 : 56; const R = narrow ? 8 : 16; const T = 14; const B = 34;
  const ymax = Math.max(...pts.map((p) => p.y)) * 1.08 || 0.01;
  const sx = (v) => L + v * (W - L - R);
  const sy = (v) => T + (1 - v / ymax) * (H - T - B);
  const rmax = Math.sqrt(Math.max(...pts.map((p) => p.sessions)));
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'scatter' });
  svg.append(s('line', { x1: sx(mx), x2: sx(mx), y1: T, y2: H - B, class: 'q-line' }), s('line', { x1: L, x2: W - R, y1: sy(my), y2: sy(my), class: 'q-line' }));
  svg.append(s('text', { x: W - R - 4, y: T + 12, 'text-anchor': 'end', class: 'q-label' }, narrow ? 'Leave, but buy' : 'Many leave at once, but buyers buy'));
  svg.append(s('text', { x: W - R - 4, y: H - B - 6, 'text-anchor': 'end', class: 'q-label warn' }, narrow ? 'Leave and rarely buy: fix first' : 'Leave at once and rarely buy — fix first'));
  svg.append(s('text', { x: L + 4, y: T + 12, class: 'q-label' }, 'Healthy'));
  svg.append(s('text', { x: L + 4, y: H - B - 6, class: 'q-label' }, narrow ? 'Browse, rarely buy' : 'Browse but rarely buy'));
  for (const t of [0, 0.25, 0.5, 0.75, 1]) svg.append(s('text', { x: sx(t), y: H - 14, 'text-anchor': 'middle', class: 'tl-axis' }, `${t * 100}%`));
  svg.append(s('text', { x: (L + W) / 2, y: H - 2, 'text-anchor': 'middle', class: 'tl-axis' }, narrow ? 'Share that viewed only this page' : 'Share of entries that viewed only this page'));
  svg.append(s('text', { x: L - 6, y: sy(ymax / 1.08) + 4, 'text-anchor': 'end', class: 'tl-axis' }, pct(ymax / 1.08)));
  svg.append(s('text', { x: L - 6, y: sy(0) + 4, 'text-anchor': 'end', class: 'tl-axis' }, '0%'));
  const top = new Set([...pts].sort((a, b) => b.sessions - a.sessions).slice(0, narrow ? 3 : 7).map((p) => p.url));
  const cut = narrow ? 22 : 34;
  for (const p of [...pts].sort((a, b) => b.sessions - a.sessions)) {
    const c = s('circle', { cx: sx(p.x), cy: sy(p.y), r: 3 + 18 * Math.sqrt(p.sessions) / rmax, class: `dot${p.x > mx && p.y < my ? ' warn' : ''}` });
    c.append(s('title', {}, `${p.url}\n${int(p.sessions)} entry sessions · order rate ${pct(p.y)} · single-page ${pct(p.x)}`));
    svg.append(c);
    if (top.has(p.url)) svg.append(s('text', { x: sx(p.x) + 6, y: sy(p.y) - 6, class: 'dot-label' }, p.url.length > cut ? `${p.url.slice(0, cut - 1)}…` : p.url));
  }
  return h('div', { class: 'chart' }, svg,
    h('p', { class: 'foot' }, `Each bubble is a landing page with 100+ entry sessions (bubble area = sessions). Lines are the site's averages: ${pct(mx)} single-page, ${pct(my)} order rate. Report window, not one week.`));
}
