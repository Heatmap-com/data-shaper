// Hover cards for the closed journey summaries. Every card ends with a button that opens the journey,
// so the diagram is reachable from the explanation as well as from the chevron.
import { h } from './views.js';
import { format } from './query.js';
import { fmtBand, fmtDelta } from './wobble.js';
import { hoverCard, hideCard, pinCard } from './hovercard.js';
import { wobbleChart } from './wobble-card.js';

const pct = (v) => (v === null || v === undefined || !Number.isFinite(v) ? '–' : format(v, 'pct'));
const int = (v) => format(v ?? 0, 'int');
const SHORT = { moved: 'moved', within: 'within', thin: 'thin', cantsay: "can't say" };
const STATUS = { moved: 'moved', within: 'within its wobble', thin: 'too few sessions', cantsay: "can't say" };

// jc: { panelId, weeks, wc, label(node), pretty(path), laneSets, siteWide, floor, ctx }
// x:  { p, lane, prev, byWeek, fd, open, toggle(open), reveal() }
function head(title, sub, badge, badgeCls, { pinned, onUnpin }) {
  return h('div', { class: 'ctr-card-head' },
    h('div', {}, h('div', { class: 'ctr-title' }, title), h('div', { class: 'ctr-sub' }, sub)),
    badge ? h('span', { class: `ctr-kind ${badgeCls}` }, badge) : null,
    pinned ? h('button', { type: 'button', class: 'ctr-x', title: 'Unpin', onclick: onUnpin }, '✕') : null);
}

function actions(spec, x, { floating, pinned }) {
  if (!floating && !pinned) return null;
  const openBtn = pinned || !x.open
    ? h('button', { type: 'button', class: 'ctr-btn primary', onclick: () => { hideCard(); x.reveal(); } }, pinned ? 'Show this journey ↓' : 'Open this journey ↓')
    : h('button', { type: 'button', class: 'ctr-btn', onclick: () => { hideCard(); x.toggle(false); } }, 'Close this journey');
  return h('div', { class: 'ctr-actions' },
    floating ? h('button', { type: 'button', class: 'ctr-btn', onclick: () => pinCard(spec) }, 'Pin to compare') : null,
    openBtn);
}

const laneName = (x, jc) => `#${x.lane.rank} ${jc.pretty(x.p)}`;
const weekSub = (jc) => `week of ${jc.wc.label(jc.wc.week)}${jc.wc.compare ? ` vs ${jc.wc.label(jc.wc.compare)}` : ''}`;

// One step's rate (share of the node before that went on to this node) against its own weekly wobble.
function stepBody(st, x, jc, o) {
  const from = jc.label(x.lane.nodes[st.i - 1]); const to = jc.label(x.lane.nodes[st.i]);
  const shared = jc.siteWide.get(`${st.key}|${Math.sign(st.d)}`);
  const cIdx = jc.weeks.indexOf(jc.wc.compare);
  const prevFrom = x.prev?.nodes[st.i - 1]?.reached; const prevTo = x.prev?.nodes[st.i]?.reached;
  const times = st.band ? Math.abs(st.d) / st.band : null;
  const elsewhere = jc.laneSets.filter((y) => y.p !== x.p)
    .map((y) => ({ y, s: y.fd.steps.find((t) => t.key === st.key) }))
    .filter((e) => e.s && e.s.d !== null);
  const badge = st.status !== 'moved' ? STATUS[st.status] : shared ? 'Site-wide shift' : 'Moved beyond its wobble';
  return [
    head(`${from} → ${to}`, `${laneName(x, jc)} · ${weekSub(jc)}`, badge, st.status === 'moved' ? `kind-pulled ${st.d > 0 ? 'up' : 'down'}` : 'kind-inline', o),
    o.pinned ? null : h('p', { class: 'ctr-explain' },
      `Of the ${int(x.lane.nodes[st.i - 1].reached)} sessions that reached ${from}, ${pct(st.cur)} went on to ${to}, ${st.d > 0 ? 'up' : 'down'} from ${pct(st.prev)}. `,
      st.band !== null
        ? `This step usually moves about ${fmtBand(st.median, 'pp')} a week (the median of its ${st.n} whole-week changes), so its wobble band is ${fmtBand(st.band, 'pp')} and this move of ${fmtDelta(st.d, 'pp')} is ${times.toFixed(1)}× the band.`
        : 'There are too few whole weeks to learn its usual weekly change.'),
    st.band !== null && cIdx >= 0 ? h('div', { class: 'ctr-legend' }, h('span', { class: 'seg', style: '--c:#079455' }, `${from} → ${to}`), o.pinned ? null : h('span', { class: 'muted' }, 'orange bar: where a usual week would land')) : null,
    st.band !== null && cIdx >= 0 ? wobbleChart({ weeks: jc.weeks, values: st.series, idx: jc.weeks.indexOf(jc.wc.week), cIdx, full: jc.weeks.map(jc.wc.full), unit: 'pp', band: st.band, fmt: 'pct', color: '#079455', weekLabel: jc.wc.label, currency: jc.ctx.currency }) : null,
    h('table', { class: 'ctr-tbl' }, h('tbody', {},
      h('tr', {}, h('td', {}, `Week of ${jc.wc.label(jc.wc.week)}`), h('td', {}, pct(st.cur)), h('td', { class: 'muted' }, `${int(x.lane.nodes[st.i].reached)} of ${int(x.lane.nodes[st.i - 1].reached)}`)),
      jc.wc.compare ? h('tr', {}, h('td', {}, `Week of ${jc.wc.label(jc.wc.compare)}`), h('td', {}, pct(st.prev)), h('td', { class: 'muted' }, prevFrom ? `${int(prevTo)} of ${int(prevFrom)}` : '')) : null,
      h('tr', { class: 'chg' }, h('td', {}, 'Change'), h('td', {}, st.d === null ? '–' : fmtDelta(st.d, 'pp')), h('td', {})),
      h('tr', { class: 'usual' }, h('td', {}, 'Wobble band'), h('td', {}, st.band === null ? '–' : fmtBand(st.band, 'pp')), h('td', {})))),
    elsewhere.length ? h('p', { class: 'ctr-gap' }, h('strong', {}, 'Same step in other journeys: '),
      elsewhere.map((e, i) => [i ? ', ' : '', `#${e.y.lane.rank} ${fmtDelta(e.s.d, 'pp')}`, e.s.status === 'moved' ? ' (moved)' : '']), '. ',
      shared ? `It moved the same way in ${shared.length} of ${jc.laneSets.length} journeys, so it is counted once as a site-wide shift rather than as standing out here.`
        : st.status === 'moved' ? 'Not enough other journeys moved the same way to call it site-wide, so it stands out in this journey.' : '')
      : h('p', { class: 'ctr-gap muted' }, 'No other top journey has this step.'),
  ];
}

// Every step in the lane against its own wobble: the overview behind the badge and the calm sentences.
function overviewBody(x, jc, o) {
  const { fd } = x;
  const flags = fd.moves.filter((m) => !jc.siteWide.has(`${m.key}|${Math.sign(m.d)}`)).length + fd.contrasts.length;
  return [
    head(laneName(x, jc), weekSub(jc), flags ? `${flags} stand${flags === 1 ? 's' : ''} out` : 'Nothing unusual', flags ? 'kind-pulled down' : 'kind-inline', o),
    o.pinned ? null : h('p', { class: 'ctr-explain' },
      `${int(x.lane.start)} sessions started this journey and ${int(x.lane.end)} reached the end. `,
      fd.canJudge
        ? 'Each step\'s rate is the share of the node before that went on. A step stands out when it moved beyond its own wobble band and the same step did not move the same way in most other journeys.'
        : 'Pick a comparison week to judge the steps.'),
    fd.steps.length ? h('table', { class: 'ctr-tbl jc-steps' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Step'), h('th', {}, 'Rate'), h('th', {}, 'Change'), h('th', {}, 'Band'), h('th', {}))),
      h('tbody', {}, fd.steps.map((st) => {
        const shared = jc.siteWide.has(`${st.key}|${Math.sign(st.d)}`);
        return h('tr', { class: st.status === 'moved' ? (shared ? 'jc-shared' : `jc-moved ${st.d > 0 ? 'up' : 'down'}`) : '' },
          h('td', {}, `${jc.label(x.lane.nodes[st.i - 1])} → ${jc.label(x.lane.nodes[st.i])}`),
          h('td', {}, pct(st.cur)),
          h('td', {}, st.d === null ? '–' : fmtDelta(st.d, 'pp')),
          h('td', {}, st.band === null ? '–' : fmtBand(st.band, 'pp')),
          h('td', { class: 'muted' }, st.status === 'moved' && shared ? 'site-wide' : SHORT[st.status]));
      }))) : null,
    x.lane.start < jc.floor ? h('p', { class: 'ctr-note' }, `Under ${jc.floor} starters, so read it as directional.`) : null,
  ];
}

// The lane against the other top journeys on the same measure.
function peerBody(c, x, jc, o) {
  const rows = jc.laneSets.map((y) => ({ y, v: c.m.of(y.lane), thin: y.lane.start < jc.floor })).filter((r) => r.v !== null);
  const max = Math.max(...rows.map((r) => r.v), c.med) || 1;
  return [
    head('Bought, of those at the end', `${laneName(x, jc)} · week of ${jc.wc.label(jc.wc.week)}`, `${c.r.toFixed(1)}× typical`, c.r > 1 ? 'kind-pulled up' : 'kind-pulled down', o),
    o.pinned ? null : h('p', { class: 'ctr-explain' },
      `Of the ${int(x.lane.end)} sessions that reached the end of this journey, ${pct(c.mine)} bought. The median across the other top journeys is ${pct(c.med)}, so this one is ${c.r.toFixed(1)}× that. A journey is called out at 1.5× above or below the median. Completion isn't compared this way because it falls with every extra step.`),
    h('div', { class: 'jc-bars' }, rows.map((r) => h('div', { class: `jc-bar${r.y.p === x.p ? ' on' : ''}${r.thin ? ' thin' : ''}` },
      h('span', { class: 'jc-bar-name', title: r.y.p }, `#${r.y.lane.rank} ${jc.pretty(r.y.p)}`),
      h('span', { class: 'jc-bar-track' }, h('i', { style: `width:${((r.v / max) * 100).toFixed(1)}%` }), h('b', { style: `left:${((c.med / max) * 100).toFixed(1)}%`, title: `Median of the others: ${pct(c.med)}` })),
      h('span', { class: 'jc-bar-val' }, pct(r.v))))),
    h('p', { class: 'ctr-note' }, `The dark tick is the median of the other journeys.${rows.some((r) => r.thin) ? ` Faded journeys have under ${jc.floor} starters and aren't in the median.` : ''}`),
  ];
}

// Where sessions leave the lane, node by node.
function leakBody(x, jc, o) {
  const { leak } = x.fd;
  const nodes = x.lane.nodes.filter((n) => n.kind !== 'bought' && n.continued !== null && n.reached);
  const shareOf = (n) => (n && n.reached ? 1 - Math.min(n.continued ?? 0, n.reached) / n.reached : null);
  const prevShare = shareOf(x.prev?.nodes[leak.node.index]);
  const isCheckout = leak.node.kind === 'checkout';
  return [
    head(isCheckout ? 'Checkouts that don\'t end in a purchase' : `Leaving at ${jc.label(leak.node)}`, `${laneName(x, jc)} · week of ${jc.wc.label(jc.wc.week)}`, `${pct(leak.share)} leave`, 'kind-inline', o),
    o.pinned ? null : h('p', { class: 'ctr-explain' },
      isCheckout
        ? `${int(leak.node.reached)} sessions on this journey started checkout and ${int(leak.node.continued)} bought, so ${pct(leak.share)} didn't finish. `
        : `${int(leak.node.reached)} sessions reached ${jc.label(leak.node)} on this journey and ${int(leak.node.continued)} went on to the next step, so ${pct(leak.share)} left the site or went somewhere off the journey. `,
      prevShare !== null ? `The week of ${jc.wc.label(jc.wc.compare)} it was ${pct(prevShare)}. ` : '',
      'This is the biggest share lost at any node in the journey, not a change, so it is shown as context rather than as standing out.'),
    h('table', { class: 'ctr-tbl jc-steps' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Node'), h('th', {}, 'Reached'), h('th', {}, 'Went on'), h('th', {}, 'Left'))),
      h('tbody', {}, nodes.map((n) => h('tr', { class: n === leak.node ? 'jc-moved down' : '' },
        h('td', {}, jc.label(n)), h('td', {}, int(n.reached)), h('td', {}, int(Math.min(n.continued, n.reached))), h('td', {}, pct(shareOf(n))))))),
  ];
}

const BODIES = {
  step: (d, x, jc, o) => stepBody(d, x, jc, o),
  overview: (d, x, jc, o) => overviewBody(x, jc, o),
  peer: (d, x, jc, o) => peerBody(d, x, jc, o),
  leak: (d, x, jc, o) => leakBody(x, jc, o),
};

// card: { type: step|overview|peer|leak, data }
export function journeyHover(el, card, x, jc) {
  const id = `jr|${jc.panelId}|${x.p}|${jc.wc.week}|${jc.wc.compare}|${card.type}|${card.data?.key ?? card.data?.m?.id ?? ''}`;
  const spec = {
    id,
    build: (o) => [...BODIES[card.type](card.data, x, jc, o), actions(spec, x, o)],
    onHover: () => jc.ctx.log?.('journey_card_hover', { panel: jc.panelId, path: x.p, card: card.type }),
    onPin: () => jc.ctx.log?.('journey_card_pin', { panel: jc.panelId, path: x.p, card: card.type }),
  };
  el.setAttribute('tabindex', '0');
  return hoverCard(el, spec);
}
