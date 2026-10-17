// The team a card can be passed to: Heatmap's Revenue Success Team first, then the client's own people.
// The client team, and the cards already on everyone's stacks, are made up for the prototype; what you
// pass yourself is kept in this browser with the rest of the deck.
import { h } from './views.js';

export const ME = { id: 'me', name: 'You', role: 'Your own stack' };
export const RST_NAME = 'Revenue Success Team';
const RST = ['Olaf', 'Mimansa', 'Kinichi', 'Kanchan', 'Jofet'].map((name) => ({ id: `rst-${name.toLowerCase()}`, name, role: 'Heatmap.com', rst: true }));
const CLIENT = [
  { id: 'priya', name: 'Priya Shah', role: 'Growth lead' },
  { id: 'marcus', name: 'Marcus Lee', role: 'Front-end developer' },
  { id: 'ana', name: 'Ana Ortiz', role: 'Designer' },
  { id: 'sam', name: 'Sam Okafor', role: 'Analyst' },
  { id: 'jules', name: 'Jules Martin', role: 'Paid social, agency' },
  { id: 'dana', name: 'Dana Kim', role: 'Merchandising' },
  { id: 'theo', name: 'Theo Grant', role: 'Email and SMS' },
  { id: 'rina', name: 'Rina Patel', role: 'Back-end developer' },
  { id: 'owen', name: 'Owen Brooks', role: 'Customer support' },
  { id: 'lena', name: 'Lena Novak', role: 'Content and SEO' },
  { id: 'kofi', name: 'Kofi Mensah', role: 'CRO specialist' },
];
export const TEAM = [...RST, ...CLIENT];
// Green belongs to Heatmap, so the client's colours leave it out.
const COLORS = ['#2c5f8a', '#c2410c', '#7c3aed', '#0e7490', '#b45309', '#be185d', '#1d4ed8', '#9f1239', '#475569', '#6d28d9', '#a16207'];
export const URGENT = [['low', 'Low'], ['normal', 'Normal'], ['high', 'High'], ['urgent', 'Urgent']];
const URGENT_OF = { now: 'urgent', week: 'high', good: 'normal', fyi: 'low' };
const LEAD_DAYS = { urgent: 1, high: 3, normal: 7, low: 14 };
const ASKS = {
  check: 'Can you confirm this before we act on it?',
  experiment: 'Can you check this test is set up right?',
  campaign: 'Is this campaign worth keeping as it is?',
  opportunity: 'Could we try this on the site?',
};

export const member = (id) => (id === 'me' ? ME : TEAM.find((m) => m.id === id));
export const firstName = (id) => (id === 'me' ? 'you' : member(id)?.name.split(' ')[0] ?? id);
const initials = (m) => {
  if (m.id === 'me') return 'Me';
  const parts = m.name.split(/\s+/);
  return parts.length > 1 ? parts.map((p) => p[0]).slice(0, 2).join('').toUpperCase() : m.name.slice(0, 2);
};
export const urgencyFor = (c) => URGENT_OF[c.urgency] ?? 'normal';
export const roleOf = (m) => (m.rst ? `${RST_NAME}, ${m.role}` : m.role);
export const rstBadge = (m) => (m?.rst ? h('span', { class: 'hw-rst-badge' }, RST_NAME) : null);

export function dayFrom(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export const dueFor = (u) => dayFrom(LEAD_DAYS[u] ?? 7);
export function dueText(due) {
  if (!due) return 'no date';
  const days = Math.round((Date.parse(due) - Date.parse(dayFrom(0))) / 864e5);
  const date = new Date(`${due}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
  return days < 0 ? `${date}, overdue` : days === 0 ? `${date}, today` : days === 1 ? `${date}, tomorrow` : `${date}, in ${days} days`;
}

export function avatar(m, { badge } = {}) {
  const i = CLIENT.indexOf(m);
  return h('span', { class: `hw-av${m.id === 'me' ? ' me' : ''}${m.rst ? ' rst' : ''}`, 'data-member': m.id, style: i >= 0 ? `--av:${COLORS[i % COLORS.length]}` : null, title: m.id === 'me' ? null : `${m.name}, ${roleOf(m)}` },
    initials(m), badge ? h('em', { class: 'hw-av-n' }, String(badge)) : null);
}

// Cards that teammates passed to each other before you opened the deck, so their stacks are not empty.
export function seedStacks(cards) {
  const out = {};
  cards.forEach((c, i) => {
    const hash = [...c.key].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) >>> 0, 7);
    const [toTeam, fromTeam] = i % 2 ? [CLIENT, RST] : [RST, CLIENT];
    const to = toTeam[(hash + i * 3) % toTeam.length];
    const from = fromTeam[(hash >>> 5) % fromTeam.length];
    const urgency = urgencyFor(c);
    out[c.key] = { to: to.id, from: from.id, task: ASKS[c.type] ?? 'Can you dig into this and tell me what changed?', due: dueFor(urgency), urgency, at: Date.now() - (i + 1) * 36e5, demo: true };
  });
  return out;
}

// A list of people that narrows as you type: name or role, any part of it, word starts first.
// Heatmap's Revenue Success Team and the client's people are listed under their own headings.
export function peoplePicker({ people, count, selected = null, onPick, action = '', client = 'Client' }) {
  let q = ''; let active = 0; let shown = []; let opts = [];
  const groupOf = (m) => (m.id === 'me' ? 0 : m.rst ? 1 : 2);
  const heads = { 1: h('span', {}, h('i', { class: 'hw-rst-dot' }), `${RST_NAME} · Heatmap.com`), 2: `${client} team` };
  const input = h('input', { type: 'search', class: 'hw-people-q', placeholder: 'Search by name or role', 'aria-label': 'Search the team', autocomplete: 'off', spellcheck: 'false' });
  const list = h('ul', { class: 'hw-people', role: 'listbox', 'aria-label': 'Team' });
  const none = h('p', { class: 'hw-people-none', 'aria-live': 'polite' });
  const mark = (text) => {
    const i = q ? text.toLowerCase().indexOf(q) : -1;
    return i < 0 ? [text] : [text.slice(0, i), h('mark', {}, text.slice(i, i + q.length)), text.slice(i + q.length)];
  };
  const rank = (m) => {
    const hay = `${m.name} ${m.role}${m.rst ? ` ${RST_NAME} rst` : ''}`.toLowerCase();
    if (!q) return 0;
    if (hay.startsWith(q)) return 1;
    if (hay.split(/[\s,]+/).some((w) => w.startsWith(q))) return 2;
    if (initials(m).toLowerCase() === q) return 2;
    return hay.includes(q) ? 3 : -1;
  };
  function draw() {
    shown = people.map((m, i) => [m, rank(m), i]).filter(([, r]) => r >= 0).sort((a, b) => groupOf(a[0]) - groupOf(b[0]) || a[1] - b[1] || a[2] - b[2]).map(([m]) => m);
    active = Math.min(active, Math.max(0, shown.length - 1));
    opts = shown.map((m, i) => {
      const n = count(m.id);
      return h('li', { role: 'option', 'aria-selected': String(m.id === selected), class: `${i === active ? 'active' : ''}${m.id === selected ? ' picked' : ''}${m.rst ? ' rst' : ''}`,
        onclick: () => onPick(m), onpointermove: () => { if (active !== i) { active = i; paint(); } } },
        avatar(m),
        h('span', { class: 'hw-people-who' }, h('b', {}, ...mark(m.name), rstBadge(m)), h('span', {}, ...mark(m.role))),
        h('span', { class: 'hw-people-n' }, h('b', {}, String(n.total)), n.total === 1 ? ' card' : ' cards', n.mine ? h('em', {}, `${n.mine} from you`) : null),
        action ? h('span', { class: 'hw-people-go' }, typeof action === 'function' ? action(m) : action) : null);
    });
    list.replaceChildren(...shown.flatMap((m, i) => {
      const g = groupOf(m);
      const head = heads[g] && (i === 0 || groupOf(shown[i - 1]) !== g) ? h('li', { role: 'presentation', class: `hw-people-group g${g}` }, heads[g]) : null;
      return [head, opts[i]].filter(Boolean);
    }));
    none.textContent = shown.length ? '' : `No one on the team matches “${input.value.trim()}”.`;
  }
  const paint = () => opts.forEach((li, i) => li.classList.toggle('active', i === active));
  input.addEventListener('input', () => { q = input.value.trim().toLowerCase(); active = 0; draw(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      active = Math.max(0, Math.min(shown.length - 1, active + (e.key === 'ArrowDown' ? 1 : -1)));
      paint();
      opts[active]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter' && shown[active]) { e.preventDefault(); onPick(shown[active]); }
  });
  draw();
  return { el: h('div', { class: 'hw-people-pick' }, input, list, none), input };
}

export function shell({ title, cls, body, onClose }) {
  const box = h('div', { class: `hw-modal ${cls}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title, tabindex: -1 },
    h('div', { class: 'hw-modal-head' }, h('h4', {}, title), h('button', { type: 'button', class: 'hw-modal-x', 'aria-label': 'Close', onclick: onClose }, '×')),
    ...body);
  return h('div', { class: 'hw-modal-wrap' }, h('div', { class: 'hw-modal-back', onclick: onClose }), box);
}

const desk = () => !window.matchMedia('(max-width: 720px)').matches;

export function teamModal({ count, viewing, onView, onClose, client }) {
  const pick = peoplePicker({ people: [ME, ...TEAM], count, client, selected: viewing ?? 'me', onPick: (m) => onView(m.id),
    action: (m) => (m.id === (viewing ?? 'me') ? 'Showing' : m.id === 'me' ? 'Back to mine' : 'View stack') });
  const wrap = shell({ title: `Your team · ${TEAM.length} people`, cls: 'team', onClose, body: [
    pick.el,
    h('p', { class: 'hw-modal-note' }, `The ${RST_NAME} works at Heatmap.com. The ${client} team and everyone's stacks are made up for the prototype; cards you pass are kept in this browser.`),
  ] });
  if (desk()) setTimeout(() => pick.input.focus(), 0);
  return wrap;
}

// Pass a card: who, what you need from them, by when, and how urgent. A card on someone else's stack
// (`holder`) can also be assigned back to you.
export function assignModal({ card, thumb, to, count, onSave, onClose, client, holder = null, verb = 'Pass' }) {
  const urgency = urgencyFor(card);
  const st = { to, task: card.lead?.short ? `${card.lead.short}.` : '', due: dueFor(urgency), urgency, dueTouched: false, picking: !to };
  const toBox = h('div', { class: 'hw-assign-to' });
  const save = h('button', { type: 'button', class: 'hw-btn primary', onclick: () => submit() });
  const label = () => { save.textContent = st.to === 'me' ? 'Assign to me' : st.to ? `${verb} to ${member(st.to).name.split(' ')[0]}` : 'Pick someone'; save.disabled = !st.to; };
  const toMe = () => (holder && st.to !== 'me'
    ? h('button', { type: 'button', class: 'hw-btn small hw-to-me', title: `Take it from ${member(holder)?.name ?? 'them'} onto your own stack`, onclick: () => { st.to = 'me'; st.picking = false; drawTo(); label(); } }, avatar(ME), 'Assign to me')
    : null);
  function drawTo() {
    const m = st.to ? member(st.to) : null;
    if (st.picking) {
      const pick = peoplePicker({ people: holder ? [ME, ...TEAM] : TEAM, count, client, selected: st.to, onPick: (p) => { st.to = p.id; st.picking = false; drawTo(); label(); if (desk()) task.focus(); } });
      toBox.replaceChildren(h('div', { class: 'hw-field-k' }, 'To', h('span', { class: 'hw-field-acts' }, toMe(), m ? h('button', { type: 'button', class: 'hw-link', onclick: () => { st.picking = false; drawTo(); } }, `Keep ${m.name.split(' ')[0]}`) : null)), pick.el);
      if (desk()) setTimeout(() => pick.input.focus(), 0);
    } else {
      const n = count(m.id);
      toBox.replaceChildren(h('div', { class: 'hw-field-k' }, 'To', toMe()),
        h('div', { class: `hw-assign-who${m.rst ? ' rst' : ''}` }, avatar(m),
          h('span', { class: 'hw-people-who' }, h('b', {}, m.name, rstBadge(m)), h('span', {}, m.id === 'me' ? `Goes on top of your deck · ${n.total} card${n.total === 1 ? '' : 's'} left` : `${m.role} · ${n.total} card${n.total === 1 ? '' : 's'} on their stack`)),
          h('button', { type: 'button', class: 'hw-btn ghost small', onclick: () => { st.picking = true; drawTo(); } }, 'Change')));
    }
  }
  const task = h('textarea', { rows: 3, placeholder: 'What do you need? e.g. "Check the Meta landing page on mobile and tell me what changed"' });
  task.value = st.task;
  task.addEventListener('input', () => { st.task = task.value; });
  const due = h('input', { type: 'date', value: st.due, min: dayFrom(0) });
  const dueNote = h('span', { class: 'hw-due-note' }, dueText(st.due));
  const setDue = (d, touched) => { st.due = d; due.value = d; dueNote.textContent = dueText(d); if (touched) st.dueTouched = true; };
  due.addEventListener('change', () => setDue(due.value, true));
  const quick = [[1, 'Tomorrow'], [3, 'In 3 days'], [7, 'Next week']].map(([n, t]) => h('button', { type: 'button', class: 'hw-chip', onclick: () => setDue(dayFrom(n), true) }, t));
  const urg = h('div', { class: 'seg-toggle hw-urgency', role: 'group', 'aria-label': 'Urgency' }, ...URGENT.map(([id, t]) => h('button', { type: 'button', class: `u-${id}${id === st.urgency ? ' on' : ''}`, 'aria-pressed': String(id === st.urgency),
    onclick: (e) => { st.urgency = id; [...urg.children].forEach((b) => { b.classList.toggle('on', b === e.currentTarget); b.setAttribute('aria-pressed', String(b === e.currentTarget)); }); if (!st.dueTouched) setDue(dueFor(id), false); } }, t)));
  function submit() {
    if (!st.to) { st.picking = true; drawTo(); return; }
    onSave({ to: st.to, task: st.task.trim(), due: st.due, urgency: st.urgency });
  }
  drawTo(); label();
  const wrap = shell({ title: holder ? `Assign this card · now with ${member(holder)?.name ?? 'someone else'}` : verb === 'Pass' ? 'Pass this card' : 'Pass it on', cls: 'assign', onClose, body: [
    h('div', { class: 'hw-assign-card' }, h('span', { class: 'hw-assign-thumb' }, thumb), h('span', {}, h('em', {}, card.eyebrow ?? ''), h('b', {}, card.title))),
    toBox,
    h('label', { class: 'hw-field' }, h('span', { class: 'hw-field-k' }, 'What do you need?'), task),
    h('div', { class: 'hw-assign-row' },
      h('label', { class: 'hw-field' }, h('span', { class: 'hw-field-k' }, 'Needed by'), h('span', { class: 'hw-due' }, due, dueNote), h('span', { class: 'hw-chiprow' }, ...quick)),
      h('div', { class: 'hw-field' }, h('span', { class: 'hw-field-k' }, 'Urgency'), urg)),
    h('div', { class: 'hw-sheet-actions' }, h('button', { type: 'button', class: 'hw-btn ghost', onclick: onClose }, 'Cancel'), save),
  ] });
  wrap.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); } });
  if (!st.picking && desk()) setTimeout(() => task.focus(), 0);
  return wrap;
}
