// Important week-over-week changes, in sections that open and close. Closed, each section still says
// how many changes it holds, which way the money went, and the biggest one.
import { h, s } from './views.js';
import { ALL, format } from './query.js';
import { fmtBand, fmtDelta } from './wobble.js';
import { compareWeek } from './derive.js';
import { coverageLabel } from './coverage.js';
import { findChanges, SECTIONS } from './changes.js';

const TITLES = {
  traffic: 'Traffic grew or shrank',
  value: 'Sales or value per visit moved',
  started: 'Started',
  stopped: 'Stopped',
};
const HELP = {
  traffic: 'Visits moved beyond the campaign\'s own usual weekly wobble, by a material amount.',
  value: 'Orders, revenue, visit conversion or revenue per visit moved beyond the usual wobble, by a material amount, while visits did not.',
  started: 'Material visits this week and none in any earlier week of this data.',
  stopped: 'Material visits in the compared week, and at most a tenth of that now.',
};

function spark(values, idx, cIdx) {
  const W = 120; const H = 28;
  const n = values.length;
  if (n < 2) return null;
  const hi = Math.max(...values, 1);
  const x = (i) => 3 + (i / (n - 1)) * (W - 6);
  const y = (v) => H - 3 - (v / hi) * (H - 6);
  const svg = s('svg', { width: W, height: H, class: 'chg-spark' });
  svg.append(s('path', { d: values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' '), class: 'chg-line' }));
  for (const i of [cIdx, idx]) if (i >= 0) svg.append(s('circle', { cx: x(i), cy: y(values[i]), r: i === idx ? 3 : 2.2, class: i === idx ? 'chg-dot on' : 'chg-dot' }));
  return svg;
}

export function campaignchanges(panel, rows, ctx) {
  const cfg = panel.changes;
  const keys = panel.groupBy;
  const weekField = cfg.week ?? 'week';
  const weekP = ctx.pickers?.find((p) => p.field === weekField);
  const others = (ctx.pickers ?? []).filter((p) => p !== weekP && p.value !== undefined && p.value !== ALL);
  const hist = (ctx.baseRows ?? rows).filter((r) => others.every((p) => String(r[p.field]) === String(p.value)));
  const weeks = [...new Set(hist.map((r) => r[weekField]))].filter(Boolean).sort();
  const cov = ctx.cov(weeks.map(String));
  const full = (w) => cov.get(String(w))?.full ?? false;
  const fullWeeks = weeks.filter(full);
  const week = weekP && weekP.value !== ALL && weeks.includes(weekP.value) ? weekP.value : fullWeeks[fullWeeks.length - 1] ?? weeks[weeks.length - 1];
  const compare = compareWeek(weeks, week, ctx.global?.compare ?? 'prev', full);
  const floorMin = panel.floor?.min ?? 0;
  const res = findChanges({ rows: hist, keys, weekField, week, compare, full, cfg, measure: ctx.measure, floorMin });

  const wk = (w) => ctx.fieldLabel(w, 'week');
  const vol = ctx.measure(cfg.volume); const money = ctx.measure(cfg.money);
  const cash = (v) => new Intl.NumberFormat(undefined, { style: 'currency', currency: ctx.currency ?? 'USD', notation: 'compact', maximumFractionDigits: 1 }).format(v);
  const signed = (v) => (v === null || v === undefined ? '–' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${cash(Math.abs(v))}`);
  const nameOf = (t) => {
    const lastKey = keys[keys.length - 1];
    const raw = t.key[lastKey];
    const ent = ctx.entity?.(lastKey, raw, t.first);
    const name = raw === null || raw === undefined || raw === '' ? '(no campaign)' : ent?.label ?? ctx.fieldLabel(raw, lastKey);
    const rest = keys.slice(0, -1).map((k) => (t.key[k] === null || t.key[k] === undefined || t.key[k] === '' ? '(blank)' : ctx.fieldLabel(t.key[k], k)));
    return { name, sub: rest.join(' · '), title: ent?.title ?? String(raw ?? '') };
  };
  const open = ctx.state.open ?? {};

  const tile = (t) => {
    const n = nameOf(t);
    const dir = res.partial ? 'flat' : (t.moneyDelta ?? 0) > 0 ? 'up' : (t.moneyDelta ?? 0) < 0 ? 'down' : 'flat';
    const head = h('div', { class: 'chg-head' },
      h('div', {}, h('div', { class: 'chg-name', title: n.title }, n.name), n.sub ? h('div', { class: 'muted small' }, n.sub) : null),
      res.partial
        ? h('div', { class: 'chg-money muted small', title: `${money.label} in a part week isn't comparable with a whole week.` }, 'part week')
        : h('div', { class: `chg-money ${dir}`, title: `${money.label}: ${format(t.moneyPrev, money.format, ctx.currency)} → ${format(t.moneyCur, money.format, ctx.currency)}` }, signed(t.moneyDelta), h('span', { class: 'muted small' }, ` ${money.label.toLowerCase()}`)));
    let body;
    if (t.kind === 'started') {
      body = h('p', { class: 'chg-line-text' }, `${format(t.cur, 'int')} ${vol.label.toLowerCase()} and ${format(t.moneyCur, money.format, ctx.currency)} ${money.label.toLowerCase()} this week; nothing in the ${t.earlierWeeks} earlier week${t.earlierWeeks === 1 ? '' : 's'} of this data.`);
    } else if (t.kind === 'stopped') {
      body = h('p', { class: 'chg-line-text' }, `${vol.label} ${format(t.prev, 'int')} → ${format(t.cur, 'int')} (${fmtDelta(t.prev ? (t.cur / t.prev - 1) * 100 : null, '%', 0)}); ${money.label.toLowerCase()} ${format(t.moneyPrev, money.format, ctx.currency)} → ${format(t.moneyCur, money.format, ctx.currency)}.`);
    } else {
      body = h('table', { class: 'chg-metrics' }, h('tbody', {}, t.metrics.map((m) => h('tr', { class: `st-${m.status}` },
        h('td', {}, m.label),
        h('td', { class: 'num' }, `${format(m.prev, m.format, ctx.currency)} → ${format(m.cur, m.format, ctx.currency)}`),
        h('td', { class: `num ${m.delta > 0 ? 'up' : m.delta < 0 ? 'down' : ''}` }, fmtDelta(m.delta, m.unit, m.unit === 'pp' ? 2 : 0)),
        h('td', { class: 'num muted', title: m.band ? `Usual weekly change: twice the median of ${m.n} whole-week changes` : null }, m.band ? `usual ${fmtBand(m.band, m.unit)}` : ''),
        h('td', {}, m.status === 'important' ? h('span', { class: 'ob bad imp' }, 'important')
          : m.status === 'small' ? h('span', { class: 'ob soft', title: 'Beyond its usual wobble, but too small a share of the table to matter' }, 'unusual, small')
            : m.status === 'cantsay' ? h('span', { class: 'ob soft', title: m.reason }, "can't say") : '')))));
    }
    return h('div', { class: `chg-tile ${t.kind} ${dir}` }, head, body,
      h('div', { class: 'chg-foot' }, spark(t.vols, res.idx, res.cIdx), h('span', { class: 'muted small' }, `${vol.label.toLowerCase()} by week`)));
  };

  const section = (id) => {
    const list = res.sections[id];
    const gained = list.filter((t) => (t.moneyDelta ?? 0) > 0).length;
    const lost = list.filter((t) => (t.moneyDelta ?? 0) < 0).length;
    const top = list[0];
    const blocked = id === 'traffic' && res.partial;
    const summaryBits = blocked
      ? [h('span', { class: 'chg-count none' }, '–'), h('span', { class: 'muted' }, ' Can\'t judge traffic in a part week')]
      : list.length
        ? [h('span', { class: 'chg-count' }, list.length), ' ', h('span', { class: 'muted' }, res.partial ? `${money.label.toLowerCase()} not comparable in a part week` : `${lost} lost ${money.label.toLowerCase()}, ${gained} gained`),
          !res.partial && top && top.moneyDelta ? [h('span', { class: 'muted' }, ' · biggest: '), h('strong', {}, nameOf(top).name), ` ${signed(top.moneyDelta)}`] : null]
        : [h('span', { class: 'chg-count none' }, '0'), h('span', { class: 'muted' }, ' No important changes')];
    const isOpen = Boolean(open[id]);
    const d = h('details', { class: `chg-section ${id}${list.length ? '' : ' empty'}`, open: isOpen ? 'open' : null },
      h('summary', {}, h('span', { class: 'chg-title' }, TITLES[id]), ' ', summaryBits),
      h('p', { class: 'foot chg-help' }, HELP[id]),
      blocked ? h('p', { class: 'chg-empty' }, `The week of ${wk(res.week)} covers ${coverageLabel(cov.get(String(res.week)))}${res.compare && !full(res.compare) ? ` and the week of ${wk(res.compare)} is also partial` : ''}, so visits, orders and revenue aren't comparable with whole weeks. Rate changes still show under "${TITLES.value}".`)
        : list.length ? h('div', { class: 'chg-grid' }, list.map(tile)) : h('p', { class: 'chg-empty' }, 'Nothing here this week.'));
    d.addEventListener('toggle', () => {
      if (d.open === isOpen) return;
      ctx.log?.('changes_toggle', { panel: panel.id, section: id, open: d.open, count: list.length });
      ctx.set({ open: { ...(ctx.state.open ?? {}), [id]: d.open } }, { log: false });
    });
    return d;
  };

  const total = SECTIONS.reduce((a, id) => a + (id === 'traffic' && res.partial ? 0 : res.sections[id].length), 0);
  const lead = h('p', { class: 'lead-block' },
    h('strong', {}, `${total} important change${total === 1 ? '' : 's'}`),
    res.compare ? ` in the week of ${wk(res.week)} against ${wk(res.compare)}` : ` in the week of ${wk(res.week)} (no comparison week)`,
    res.partial ? h('span', { class: 'chip partial' }, `part week: ${coverageLabel(cov.get(String(res.week)))}`) : null,
    h('span', { class: 'muted' }, ` · ${res.judged} campaigns with ${floorMin}+ ${vol.label.toLowerCase()} in both weeks judged${res.tooShort ? `, ${res.tooShort} more too new to have a usual wobble` : ''}.`),
    ' ',
    h('button', { type: 'button', class: 'linklike', onclick: () => ctx.set({ open: Object.fromEntries(SECTIONS.map((id) => [id, !SECTIONS.every((x) => open[x])])) }) }, SECTIONS.every((x) => open[x]) ? 'close all' : 'open all'));
  return [lead, ...SECTIONS.map(section),
    h('p', { class: 'foot' }, `Important means beyond the campaign's own usual weekly change (twice the median of its earlier whole-week changes) and at least ${((cfg.material ?? 0.005) * 100).toLocaleString()}% of the table's total for that metric. One tile per campaign; the money figure is the change in ${money.label.toLowerCase()}.`)];
}
