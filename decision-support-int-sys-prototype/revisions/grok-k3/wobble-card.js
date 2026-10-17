// The hover card for "moved beyond its wobble": what moved, the usual weekly change, the changes the band
// was learned from, and whether the other lines in the same chart moved too.
import { h, s } from './views.js';
import { format } from './query.js';
import { changeOf, fmtBand, fmtDelta } from './wobble.js';
import { hoverCard, pinCard } from './hovercard.js';

// m: { id, name, color, chart, measure, fmt, unit, weeks, values, idx, cIdx, full[], delta, band, median, n,
//      volume?: { label, values[] }, others: [{ name, color, values, delta, badge }], weekLabel(w), currency, log? }
export function wobbleChart(m) {
  const W = 300; const H = 104; const L = 20; const R = 20; const T = 10; const B = 22;
  const n = m.weeks.length;
  const all = m.values.filter((v) => v !== null && Number.isFinite(v));
  const prev = m.values[m.cIdx];
  const lowBand = m.unit === 'pp' ? prev - m.band / 100 : prev * (1 - m.band / 100);
  const highBand = m.unit === 'pp' ? prev + m.band / 100 : prev * (1 + m.band / 100);
  if (n < 2 || !all.length) return null;
  let lo = Math.min(...all, lowBand); let hi = Math.max(...all, highBand);
  if (hi === lo) { hi += Math.abs(hi) * 0.1 || 1; lo -= Math.abs(lo) * 0.1 || 1; }
  const pad = (hi - lo) * 0.15; lo -= pad; hi += pad;
  const x = (i) => L + (i / (n - 1)) * (W - L - R);
  const y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  const svg = s('svg', { width: W, height: H, class: 'ctr-chart', viewBox: `0 0 ${W} ${H}` });
  m.weeks.forEach((w, i) => {
    if (!m.full[i]) svg.append(s('rect', { x: x(i) - 9, y: T - 4, width: 18, height: H - T - B + 8, class: 'ctr-unusable' }));
    if (i === m.idx) svg.append(s('rect', { x: x(i) - 9, y: T - 4, width: 18, height: H - T - B + 8, class: 'ctr-judged' }));
    svg.append(s('text', { x: x(i), y: H - 6, class: `ctr-wk${i === m.idx ? ' on' : ''}`, 'text-anchor': 'middle' }, m.weekLabel(w)));
  });
  const band = s('rect', { x: x(m.idx) - 7, y: y(highBand), width: 14, height: Math.max(1, y(lowBand) - y(highBand)), class: 'wb-band' });
  band.append(s('title', {}, `Where it would sit after a usual week: ${format(lowBand, m.fmt, m.currency)} to ${format(highBand, m.fmt, m.currency)}`));
  svg.append(band);
  const path = (vals, cls, color) => {
    const pts = vals.map((v, i) => [i, v]).filter(([, v]) => v !== null && Number.isFinite(v));
    if (pts.length > 1) svg.append(s('path', { d: pts.map(([i, v], k) => `${k ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' '), class: `ctr-line ${cls}`, ...(color ? { style: `stroke:${color}` } : {}) }));
    return pts;
  };
  for (const [i, v] of path(m.values, 'seg', m.color)) {
    const dot = s('circle', { cx: x(i), cy: y(v), r: i === m.idx || i === m.cIdx ? 3.4 : 2.2, class: `ctr-dot seg${m.full[i] ? '' : ' hollow'}`, style: m.full[i] ? `fill:${m.color}` : `stroke:${m.color}` });
    dot.append(s('title', {}, `${m.weekLabel(m.weeks[i])}: ${format(v, m.fmt, m.currency)}`));
    svg.append(dot);
  }
  return svg;
}

const BADGE = { moved: 'Moved beyond its wobble', within: 'Within its wobble', cantsay: "Can't say" };
const CANTSAY = {
  'partial week': 'One of the two weeks is a part week, so a total can\'t be compared fairly with a whole week.',
  'no comparison': 'There is no value to compare with in one of the two weeks.',
};

function body(m, { floating = false, pinned = false, onUnpin } = {}) {
  const status = m.status ?? 'moved';
  const wkJ = m.weekLabel(m.weeks[m.idx]); const wkC = m.cIdx >= 0 ? m.weekLabel(m.weeks[m.cIdx]) : null;
  const hasBand = m.band !== null && m.band !== undefined;
  const hasDelta = m.delta !== null && m.delta !== undefined && Number.isFinite(m.delta);
  const times = hasBand && hasDelta && m.band ? Math.abs(m.delta) / m.band : null;
  const who = m.scope === 'site' ? 'across every row on this site' : 'for this row';
  const changes = [];
  for (let i = 1; i < m.idx; i += 1) {
    if (!m.full[i] || !m.full[i - 1]) continue;
    const c = changeOf(m.values[i], m.values[i - 1], m.unit);
    if (c !== null && Number.isFinite(c)) changes.push({ w: m.weeks[i], c });
  }
  let explain;
  if (status === 'cantsay') {
    explain = CANTSAY[m.reason] ?? `There are only ${m.n} whole-week change${m.n === 1 ? '' : 's'} before ${wkJ}, and the band needs at least 3 to learn what a usual week looks like.`;
    if (hasDelta) explain = `${m.name} moved ${fmtDelta(m.delta, m.unit)}${wkC ? ` against ${wkC}` : ''}, but it can't be judged. ${explain}`;
  } else {
    const usual = `It usually moves about ${fmtBand(m.median, m.unit)} a week ${m.scope === 'site' ? who : ''}(the median of ${m.scope === 'site' ? 'the' : 'its'} ${m.n} whole-week changes before ${wkJ}). The wobble band is twice that, ${fmtBand(m.band, m.unit)}`;
    explain = status === 'moved'
      ? `${m.name} moved ${fmtDelta(m.delta, m.unit)} against ${wkC}. ${usual}, so this move is ${times ? `${times.toFixed(1)}×` : 'beyond'} the band.`
      : `${m.name} moved ${fmtDelta(m.delta, m.unit)} against ${wkC}. ${usual}, so this is inside it: an ordinary week.`;
  }
  const others = m.others ?? [];
  const judgedOthers = others.filter((o) => o.badge !== 'cantsay');
  const movedOthers = others.filter((o) => o.badge === 'moved');
  const sameWay = movedOthers.filter((o) => hasDelta && Math.sign(o.delta) === Math.sign(m.delta));
  const noun = m.othersNoun ?? 'lines';
  const whole = m.wholeLabel ?? (m.chart.toLowerCase().startsWith('#') ? 'the journey' : 'this chart as a whole');
  let verdict = '';
  if (status === 'moved' && judgedOthers.length) {
    verdict = sameWay.length * 2 >= judgedOthers.length
      ? `Most other ${noun} moved the same way, so this looks like a change to ${whole}, not just ${m.name}.`
      : `The other ${noun} ${sameWay.length ? 'mostly ' : ''}stayed within their usual wobble, so this is about ${m.name}.`;
  }
  const othersLine = !others.length ? null
    : others.length <= 5
      ? h('p', { class: 'ctr-gap' }, h('strong', {}, 'Others here: '),
        others.map((o, i) => [i ? ', ' : '', `${o.name} ${o.delta === null || o.delta === undefined ? '–' : fmtDelta(o.delta, m.unit)}`, o.badge === 'moved' ? ' (moved)' : o.badge === 'cantsay' ? " (can't say)" : '']), '. ', verdict)
      : h('p', { class: 'ctr-gap' }, h('strong', {}, 'Others here: '),
        `${movedOthers.length} of the other ${others.length} ${noun} moved beyond their wobble`,
        movedOthers.length ? [': ', movedOthers.slice(0, 4).map((o, i) => [i ? ', ' : '', `${o.name} ${fmtDelta(o.delta, m.unit)}`]), movedOthers.length > 4 ? `, and ${movedOthers.length - 4} more` : ''] : '', '. ', verdict);
  const vol = (i) => (m.volume && i >= 0 ? h('td', { class: 'muted' }, `${format(m.volume.values[i], 'int')} ${m.volume.label.toLowerCase()}`) : m.volume ? h('td', {}) : null);
  const chartOk = hasBand && m.cIdx >= 0 && m.values[m.cIdx] !== null && m.values[m.cIdx] !== undefined;
  return [
    h('div', { class: 'ctr-card-head' },
      h('div', {}, h('div', { class: 'ctr-title' }, m.chart ? `${m.name} · ${m.chart}` : m.name), h('div', { class: 'ctr-sub' }, `${m.measure} · week of ${wkJ}${wkC ? ` vs ${wkC}` : ''}`)),
      h('span', { class: `ctr-kind ${status === 'moved' ? `kind-pulled ${m.delta > 0 ? 'up' : 'down'}` : status === 'within' ? 'kind-inline' : 'kind-cantsay'}` }, BADGE[status], m.thin ? ' · thin' : ''),
      pinned ? h('button', { type: 'button', class: 'ctr-x', title: 'Unpin', onclick: onUnpin }, '✕') : null),
    pinned ? null : h('p', { class: 'ctr-explain' }, explain),
    chartOk ? h('div', { class: 'ctr-legend' }, h('span', { class: 'seg', style: `--c:${m.color}` }, m.name),
      pinned ? null : h('span', { class: 'muted' }, 'orange bar: where a usual week would land')) : null,
    chartOk ? wobbleChart(m) : null,
    h('table', { class: 'ctr-tbl' }, h('tbody', {},
      h('tr', {}, h('td', {}, `Week of ${wkJ}`), h('td', {}, format(m.values[m.idx], m.fmt, m.currency)), vol(m.idx)),
      wkC ? h('tr', {}, h('td', {}, `Week of ${wkC}`), h('td', {}, format(m.values[m.cIdx], m.fmt, m.currency)), vol(m.cIdx)) : null,
      h('tr', { class: 'chg' }, h('td', {}, 'Change'), h('td', {}, hasDelta ? fmtDelta(m.delta, m.unit) : '–'), m.volume ? h('td', {}) : null),
      h('tr', { class: 'usual' }, h('td', {}, 'Wobble band'), h('td', {}, hasBand ? fmtBand(m.band, m.unit) : '–'), m.volume ? h('td', {}) : null))),
    changes.length && m.scope !== 'site' ? h('p', { class: 'ctr-note wb-changes' }, `Learned from: ${changes.map((c) => `${m.weekLabel(c.w)} ${fmtDelta(c.c, m.unit)}`).join(', ')}.`) : null,
    m.thin ? h('p', { class: 'ctr-note' }, `Thin: ${m.floorText ?? 'below the volume floor'} in one of the two weeks, so read it as directional.`) : null,
    othersLine,
    floating ? h('div', { class: 'ctr-actions' }, h('button', { type: 'button', class: 'ctr-btn', onclick: () => pinCard(spec(m)) }, 'Pin to compare')) : null,
  ];
}

function spec(m) {
  return {
    id: `wb|${m.id}`,
    build: (o) => body(m, o),
    onHover: () => m.log?.('wobble_hover', { id: m.id }),
    onPin: () => m.log?.('wobble_pin', { id: m.id }),
  };
}

// Attach the card to an existing element, such as a wobble pill.
export function wobbleHover(el, m) {
  el.setAttribute('tabindex', '0');
  el.classList.add('wb-hov');
  return hoverCard(el, spec(m));
}

// A button that explains one "moved beyond its wobble" on hover and pins on click.
export function wobbleButton(m, ...children) {
  return hoverCard(h('button', { type: 'button', class: `wb-trigger ${m.delta > 0 ? 'up' : 'down'}` }, ...children), spec(m));
}
