// The weekly ideas deck: one card per thing worth a decision, swiped right to act or left to set aside,
// up to the bottom of the stack, down to bring the bottom card back. Either pile can be brought into
// focus and swiped through the same way, and a card can be passed to a teammate, whose stack you can
// look through. Decisions, notes, mutes, passes and the board stay in this browser.
import { h, s } from './views.js';
import { format } from './query.js';
import { fmtDelta } from './wobble.js';
import { buildDeck, TYPES, URGENCY } from './homework.js';
import { wobbleChart } from './wobble-card.js';
import { TEAM, RST_NAME, URGENT, member, firstName, avatar, rstBadge, seedStacks, teamModal, assignModal, dueText } from './team.js';
import { tagChip, metaMark, notesModal, tagsModal, when } from './tags.js';
import { welcomeTips } from './tips.js';

const STORE = 'qt:grok-k3:homework';
const RETURN = 'qt:grok-k3:ideas:return';
const LEVELS = [
  { id: 'easy', label: 'Easy', n: 5, hint: 'The 5 cards that matter most, plus the four numbers' },
  { id: 'standard', label: 'Standard', n: 12, hint: 'The top 12 cards' },
  { id: 'expert', label: 'Expert', n: Infinity, hint: 'Every card, the full queue and the method on each' },
];
const POINTS = { swipe: 10, note: 5, done: 25 };
const COMMIT = 110;
const REASONS = {
  act: ["I'll fix it", "I'll dig in", 'Send to my team', 'Already on it'],
  skip: ['Expected, I know why', 'Too small to matter', 'Data looks wrong', 'Not my area'],
  agree: ['Matches what I see', 'Good to rule it out'],
  disagree: ['I still think it is', 'Missing context', 'Data looks wrong'],
};
const WHO = ['Me', 'My team', 'Agency', 'Developer'];
const STATUS = [['todo', 'To do'], ['dev', 'Sent to development'], ['live', 'Live'], ['no', 'Not doing']];
const ASK = { changed: 'What changed?', opportunity: 'What can I change?', check: 'Is it true?' };
const TONE = { good: '#10893e', bad: '#c2410c', neutral: '#2c5f8a' };
const GLYPH = { moved: (c) => (c.tone === 'good' ? '📈' : '📉'), segment: '👥', journey: '🧭', campaign: '📣', opportunity: '💡', check: '🔍', experiment: '🧪' };
const PILE = { skip: 'Set aside', act: 'Acting on', deck: 'To review' };
const SHAPES = new WeakMap();
let keyHandler = null;
let resizeHandler = null;

const shortDate = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
const isCheck = (c) => c.type === 'check';
const verbs = (c) => (isCheck(c) ? { act: 'Agree', skip: 'Disagree', actStamp: 'AGREE', skipStamp: 'NOPE' } : { act: 'Act on it', skip: 'Not now', actStamp: 'ACT', skipStamp: 'NOT NOW' });
const mobile = () => window.matchMedia('(max-width: 720px)').matches;
const buzz = () => { try { navigator.vibrate?.(8); } catch { /* not supported */ } };

const EMPTY = () => ({ decisions: {}, mutes: {}, notes: {}, done: {}, started: {}, board: {}, passed: {}, recent: {}, tags: {}, comments: {}, tagLib: {}, back: {}, points: 0 });
// Cards past the Standard level are the ones teammates are already passing around.
const SEED_FROM = 12;
const SEED_VERSION = 3;
function loadMem(site) {
  try { return { ...EMPTY(), ...JSON.parse(localStorage.getItem(`${STORE}:${site}`) ?? '{}') }; } catch { return EMPTY(); }
}
const saveMem = (site, mem) => { try { localStorage.setItem(`${STORE}:${site}`, JSON.stringify(mem)); } catch { /* storage full or blocked */ } };

function streakOf(mem, weeks, week) {
  let n = 0;
  const at = weeks.indexOf(week);
  for (let i = mem.done[week] ? at : at - 1; i >= 0 && mem.done[weeks[i]]; i--) n++;
  return n;
}

function deckFor(rows, ctx) {
  const k = `${ctx.global?.week}|${ctx.global?.compare}`;
  const seen = SHAPES.get(rows);
  if (seen?.k === k) return seen.v;
  const v = buildDeck({ funnel: rows, journeys: ctx.also.journeys ?? [], journeySummary: ctx.also.journey_summary ?? [], campaigns: ctx.also.weekly_source_campaign ?? [], experiments: ctx.also.experiment_rows ?? [], ctx });
  SHAPES.set(rows, { k, v });
  return v;
}

// A floating way back after "Open the full view", since the drill lands on another tab.
function backButton() {
  document.getElementById('hw-back')?.remove();
  let saved = null;
  try { saved = JSON.parse(sessionStorage.getItem(RETURN) ?? 'null'); } catch { saved = null; }
  if (!saved?.hash) return;
  const b = h('button', { id: 'hw-back', type: 'button', onclick: () => { b.remove(); location.hash = saved.hash.replace(/^#/, ''); } }, '← Back to Ideas');
  document.body.append(b);
}

export function homework(panel, rows, ctx) {
  document.getElementById('hw-back')?.remove();
  const built = deckFor(rows, ctx);
  const site = ctx.manifest?.site?.slug ?? ctx.manifest?.site?.name ?? 'site';
  const client = ctx.manifest?.site?.name ?? 'Client';
  const level = LEVELS.find((l) => l.id === ctx.state.level) ?? LEVELS[1];
  const phone = !!ctx.state.phone;
  const { week, compare, weeks } = built;
  const mem = loadMem(site);
  mem.decisions[week] ??= {};
  if (!mem.passed[week] || mem.seeded !== SEED_VERSION) {
    const kept = Object.fromEntries(Object.entries(mem.passed[week] ?? {}).filter(([, p]) => !p.demo));
    mem.passed[week] = { ...seedStacks(built.deck.slice(SEED_FROM)), ...kept };
    mem.seeded = SEED_VERSION;
    saveMem(site, mem);
  }
  const ui = { flipped: false, sheet: null, modal: null, order: [], later: [], history: [], view: ctx.state.view === 'board' ? 'board' : 'deck', focus: 'deck', viewing: null, tag: null, dirty: false, rot: { skip: [], act: [], member: [], tag: [] }, pulled: null, wheelLock: 0 };
  const root = h('div', { class: `hw${phone ? ' phone' : ''} lvl-${level.id}` });

  const decided = () => mem.decisions[week];
  const passed = () => mem.passed[week];
  // Passed by me: still counts as handled in my level. Passed between others: not mine at all. Passed to me: always in my deck.
  const away = (c) => { const p = passed()[c.key]; return !!p && p.to !== 'me'; };
  const theirs = (c) => { const p = passed()[c.key]; return !!p && p.from !== 'me' && p.to !== 'me'; };
  const incoming = () => built.deck.filter((c) => passed()[c.key]?.to === 'me');
  const pool = () => built.deck.filter((c) => !theirs(c) && (decided()[c.key] || !mem.mutes[c.muteKey]));
  // Cards passed to me and cards I put back are in my deck whatever the level.
  const kept = () => { const inc = incoming(); return [...inc, ...Object.keys(mem.back[week] ?? {}).map(cardOf).filter((c) => c && !inc.includes(c))]; };
  const inLevel = () => { const k = kept(); return [...k, ...pool().filter((c) => !k.includes(c)).slice(0, level.n)]; };
  const queue = () => {
    const left = inLevel().filter((c) => !decided()[c.key] && !away(c));
    const pick = (keys) => keys.map((k) => left.find((c) => c.key === k)).filter(Boolean);
    const front = pick(ui.order);
    const back = pick(ui.later).filter((c) => !front.includes(c));
    return [...front, ...left.filter((c) => !front.includes(c) && !back.includes(c)), ...back];
  };
  const cardOf = (key) => built.deck.find((c) => c.key === key);
  // A pile reads newest first; cards sent to its bottom keep that order until something new lands on top.
  const rotate = (base, f) => { const rot = ui.rot[f].filter((k) => base.includes(k)); return [...base.filter((k) => !rot.includes(k)), ...rot]; };
  const pileKeys = (dir) => rotate(Object.entries(decided()).filter(([, r]) => r.dir === dir).sort((a, b) => b[1].at - a[1].at).map(([k]) => k), dir);
  const memberKeys = (id) => rotate(Object.entries(passed()).filter(([, p]) => p.to === id).sort((a, b) => b[1].at - a[1].at).map(([k]) => k), 'member');
  const count = (id) => {
    if (id === 'me') return { total: queue().length, mine: 0 };
    const list = Object.values(passed()).filter((p) => p.to === id);
    return { total: list.length, mine: list.filter((p) => p.from === 'me').length };
  };
  const tagsOf = (c) => mem.tags[c.key] ?? [];
  const notesOf = (c) => mem.comments[c.key] ?? [];
  const tagKeys = (name) => rotate(built.deck.filter((c) => tagsOf(c).includes(name)).map((c) => c.key), 'tag');
  const tagLib = () => Object.entries(mem.tagLib).sort((a, b) => b[1].at - a[1].at).map(([n]) => n);
  // Someone else's stack and a tag's cards are for looking through: no swiping left or right.
  const browsing = () => ui.focus === 'member' || ui.focus === 'tag';
  const stackOf = (f) => (f === 'deck' ? queue() : (f === 'member' ? memberKeys(ui.viewing) : f === 'tag' ? tagKeys(ui.tag) : pileKeys(f)).map(cardOf).filter(Boolean));
  const stack = () => stackOf(ui.focus);
  const top = () => stack()[0];
  try {
    const ret = JSON.parse(sessionStorage.getItem(RETURN) ?? 'null');
    sessionStorage.removeItem(RETURN);
    if (ret?.key && ret.site === site && inLevel().some((c) => c.key === ret.key && !decided()[c.key])) { ui.order = [ret.key]; ui.flipped = true; }
  } catch { /* ignore */ }
  const persist = () => saveMem(site, mem);
  const boardItems = () => Object.entries(mem.board ?? {});
  const fit = () => {
    const top = document.querySelector('.top');
    document.documentElement.style.setProperty('--hw-top', `${top ? top.offsetHeight : 0}px`);
  };

  function render() {
    const q = queue();
    const total = inLevel().length;
    if (!mem.started[week] && !Object.keys(decided()).length) { mem.started[week] = Date.now(); persist(); }
    if (!q.length && total && !mem.done[week]) { mem.done[week] = Date.now(); mem.points += POINTS.done; persist(); ctx.log?.('homework_done', { week, cards: total }); }
    const board = ui.view === 'board';
    if (ui.focus !== 'deck' && ui.focus !== 'member' && !ui.sheet && !stackOf(ui.focus).length) ui.focus = 'deck';
    const deckOn = ui.focus === 'deck';
    const theirStack = browsing();
    const st = stack();
    root.classList.toggle('on-board', board);
    root.replaceChildren(...[
      header(q.length, total),
      board ? null : teamRow(),
      controls(),
      !board && level.id === 'easy' && !theirStack ? kpis() : null,
      board ? boardView() : theirStack ? h('div', { class: `hw-main focus-${ui.focus}` },
        h('div', { class: 'hw-col' }, focusBar(st), st.length ? stage(st) : memberEmpty(), st.length ? actions(st[0]) : null))
        : h('div', { class: `hw-main focus-${ui.focus}${deckOn && level.id === 'expert' && q.length > 1 ? ' with-queue' : ''}` },
          pileEl('skip'),
          h('div', { class: 'hw-col' }, focusBar(st), st.length ? stage(st) : total ? done() : empty(), st.length ? actions(st[0]) : null),
          pileEl('act'),
          deckOn && level.id === 'expert' && q.length > 1 ? queueList(q) : null),
      !board && st.length ? h('p', { class: 'hw-hint' }, hint()) : null,
      mutedLine(),
      ui.modal,
    ].filter(Boolean));
    ui.pulled = null;
    requestAnimationFrame(fit);
  }

  function hint() {
    if (ui.focus === 'member') return `${member(ui.viewing).name}'s stack: up for the next card, down for the bottom one. Drag a card onto someone else to pass it on, or take it into your deck.`;
    if (ui.focus === 'tag') return `Cards tagged “${ui.tag}”: up for the next card, down for the bottom one. Click another tag on a card to switch. Keys: ↑ ↓, T for tags, C to comment.`;
    if (ui.focus !== 'deck') {
      const other = ui.focus === 'act' ? 'left to set it aside instead, right to keep it' : 'right to act on it instead, left to keep it set aside';
      return `${PILE[ui.focus]}: swipe ${other}, up for the next card, down for the bottom one.`;
    }
    return mobile() ? 'Swipe right to act, left to set aside, up to send it to the bottom, down to bring the bottom card back. Tap for details.'
      : 'Drag or two-finger swipe: right to act, left to set aside, up to the bottom of the stack, down to bring the bottom card back. Drop a card on a teammate to pass it. Keys: ← → ↑ ↓, Space for details, A to assign, T to tag, C to comment, Z to undo.';
  }

  function focus(f) {
    if (ui.sheet || f === ui.focus) { if (f === ui.focus && f !== 'deck') focus('deck'); return; }
    ui.focus = f; ui.flipped = false; ui.viewing = null; ui.tag = null;
    ctx.log?.('homework_focus', { stack: f });
    render();
  }

  // ---------- Tags and comments ----------

  function viewTag(name) {
    closeModal();
    if (!built.deck.some((c) => tagsOf(c).includes(name))) return;
    Object.assign(ui, { focus: 'tag', tag: name, viewing: null, flipped: false, view: 'deck' });
    ui.rot.tag = [];
    ctx.log?.('homework_tag_view', { tag: name });
    render();
  }

  function openNotes(c, start = 'tags') {
    if (!c || ui.sheet) return;
    closeModal();
    ui.modal = notesModal({ card: c, thumb: thumb(c), tags: tagsOf(c), comments: notesOf(c), library: tagLib(), start,
      counts: (name) => built.deck.filter((x) => tagsOf(x).includes(name)).length,
      onTags: (list, added) => {
        if (list.length) mem.tags[c.key] = list; else delete mem.tags[c.key];
        if (added) mem.tagLib[added] = { at: Date.now() };
        ui.dirty = true; persist();
        ctx.log?.(added ? 'homework_tag_add' : 'homework_tag_remove', { key: c.key, tag: added ?? null, tags: list.length });
      },
      onComments: (list) => {
        if (list.length) mem.comments[c.key] = list; else delete mem.comments[c.key];
        ui.dirty = true; persist();
        ctx.log?.('homework_comment', { key: c.key, comments: list.length });
      },
      onView: (name) => viewTag(name),
      onClose: closeModal });
    root.append(ui.modal);
    ctx.log?.('homework_notes_open', { key: c.key, start });
  }

  function openTags() {
    if (ui.sheet) return;
    closeModal();
    const rows = tagLib().map((name) => ({ name, n: built.deck.filter((c) => tagsOf(c).includes(name)).length }));
    ui.modal = tagsModal({ rows, onView: (name) => viewTag(name), onClose: closeModal });
    root.append(ui.modal);
  }

  // ---------- The team: pass a card, look through someone else's stack ----------

  function viewStack(id) {
    closeModal();
    if (id === 'me') { if (ui.focus === 'member') focus('deck'); else render(); return; }
    Object.assign(ui, { focus: 'member', viewing: id, flipped: false, view: 'deck' });
    ui.rot.member = [];
    ctx.log?.('homework_team_view', { member: id });
    render();
  }

  // Heatmap's Revenue Success Team on the left in Heatmap green, the client's people after a divider.
  // Whoever you assigned to most recently comes first in their group, so they stay in reach for the next pass.
  function teamRow() {
    const last = (id) => Math.max(mem.recent[id] ?? 0, ...Object.values(passed()).filter((p) => p.to === id && p.from === 'me').map((p) => p.at));
    const group = (list, n, cls, label) => {
      const shown = [...list].sort((a, b) => (b.id === ui.viewing) - (a.id === ui.viewing) || last(b.id) - last(a.id)).slice(0, n);
      const more = list.length - shown.length;
      return h('span', { class: `hw-avs ${cls}`, title: label },
        h('span', { class: 'hw-avs-k' }, label),
        ...shown.map((m) => { const a = avatar(m, { badge: count(m.id).total }); if (m.id === ui.viewing) a.classList.add('on'); return a; }),
        more > 0 ? h('span', { class: 'hw-av more', 'data-member': '*', title: `${more} more. Drop a card here to pick someone.` }, `+${more}`) : null);
    };
    const rst = TEAM.filter((m) => m.rst);
    const theirs = TEAM.filter((m) => !m.rst);
    return h('div', { class: 'hw-team' },
      h('button', { type: 'button', class: 'hw-team-open', title: 'See the team and their stacks', 'aria-label': `Your team: ${rst.length} from the ${RST_NAME} and ${theirs.length} from ${client}. Open the list.`, onclick: () => openTeam() },
        group(rst, mobile() ? 2 : rst.length, 'rst', RST_NAME),
        h('i', { class: 'hw-avs-sep', 'aria-hidden': 'true' }),
        group(theirs, mobile() ? 3 : 5, 'client', `${client} team`),
        h('span', { class: 'hw-team-n' }, h('b', {}, String(TEAM.length)), ' people')),
      ui.focus === 'member'
        ? h('button', { type: 'button', class: 'hw-link hw-team-back', onclick: () => viewStack('me') }, '← Back to my stack')
        : h('span', { class: 'hw-team-hint' }, 'Drag a card onto someone to pass it'));
  }

  function openTeam() {
    if (ui.sheet) return;
    closeModal();
    ui.modal = teamModal({ count, client, viewing: ui.viewing, onView: (id) => viewStack(id), onClose: closeModal });
    root.append(ui.modal);
    ctx.log?.('homework_team_open', {});
  }

  function openAssign(c, to = null) {
    if (!c || ui.sheet) return;
    closeModal();
    const holder = away(c) ? passed()[c.key].to : null;
    ui.modal = assignModal({ card: c, thumb: thumb(c), to, count, client, holder, onSave: (a) => assign(c, a), onClose: closeModal });
    root.append(ui.modal);
    ctx.log?.('homework_assign_open', { key: c.key, to, via: to ? 'drop' : 'button' });
  }

  // A modal that changed the card (tags, comments) redraws the deck when it closes, not while you type.
  function closeModal() {
    if (ui.modal?.classList.contains('hw-open-wrap')) ui.flipped = false;
    ui.modal?.remove();
    ui.modal = null;
    if (ui.dirty) { ui.dirty = false; render(); }
  }

  function restore(snap) {
    for (const k of Object.keys(mem)) delete mem[k];
    Object.assign(mem, snap);
    persist();
  }

  function assign(c, a) {
    const before = structuredClone(mem);
    const prev = passed()[c.key];
    if (a.to === 'me') {
      passed()[c.key] = { ...a, from: prev?.to ?? 'me', at: Date.now() };
      ui.order = [c.key, ...ui.order.filter((k) => k !== c.key)];
      ui.later = ui.later.filter((k) => k !== c.key);
      persist();
      closeModal();
      ui.flipped = false;
      ctx.log?.('homework_pass', { key: c.key, to: 'me', urgency: a.urgency, due: a.due, from: prev?.to ?? null });
      render();
      toast(`On your stack · needed by ${dueText(a.due)}`, { label: 'Undo', run: () => { restore(before); render(); } });
      return;
    }
    if (decided()[c.key]) undecide(c.key);
    passed()[c.key] = { ...a, from: 'me', at: Date.now() };
    mem.recent[a.to] = Date.now();
    ui.order = ui.order.filter((k) => k !== c.key);
    ui.later = ui.later.filter((k) => k !== c.key);
    persist();
    closeModal();
    ui.flipped = false;
    ctx.log?.('homework_pass', { key: c.key, to: a.to, urgency: a.urgency, due: a.due, reassigned: !!prev });
    const go = () => {
      render();
      toast(`Passed to ${firstName(a.to)} · needed by ${dueText(a.due)}`, { label: 'Undo', run: () => { restore(before); render(); } });
    };
    const el = root.querySelector('.hw-card.d0');
    const av = root.querySelector(`.hw-team [data-member="${a.to}"]`) ?? root.querySelector('.hw-team .hw-av.more');
    if (!el || el.dataset.key !== c.key || !av) return go();
    const r = el.getBoundingClientRect(); const t = av.getBoundingClientRect();
    el.classList.add('flying', 'passing-out');
    el.style.transform = `translate(${Math.round(t.left + t.width / 2 - (r.left + r.width / 2))}px, ${Math.round(t.top + t.height / 2 - (r.top + r.height / 2))}px) scale(.06)`;
    av.classList.add('catch');
    setTimeout(go, 300);
  }

  const onStack = (c) => queue().some((x) => x.key === c.key);

  // Any card of this week back on top of my stack, undecided: out of a pile (and off the board), back from
  // a teammate, unmuted, and kept in my deck even past my level. Someone else's card arrives marked as
  // passed to me; one I passed comes back as it was.
  function putBack(c) {
    if (!c || ui.sheet || onStack(c)) return;
    const before = structuredClone(mem);
    const p = away(c) ? passed()[c.key] : null;
    const rec = undecide(c.key);
    if (p?.from === 'me') delete passed()[c.key];
    else if (p) passed()[c.key] = { ...p, to: 'me', from: p.to, at: Date.now() };
    delete mem.mutes[c.muteKey];
    (mem.back[week] ??= {})[c.key] = Date.now();
    ui.order = [c.key, ...ui.order.filter((k) => k !== c.key)];
    ui.later = ui.later.filter((k) => k !== c.key);
    persist();
    closeModal();
    ui.flipped = false;
    ctx.log?.('homework_put_back', { key: c.key, from: p ? p.to : rec ? rec.dir : 'level', stack: ui.focus, view: ui.view });
    render();
    const msg = p ? `${p.from === 'me' ? 'Taken back' : 'Taken'} from ${firstName(p.to)}` : rec ? `Out of ${PILE[rec.dir]}${rec.dir === 'act' && !isCheck(c) ? ' and off your board' : ''}` : 'Back in your deck';
    toast(`${msg} · top of your stack`, { label: 'Undo', run: () => { restore(before); render(); } });
  }

  const putBackBtn = (c, cls = 'hw-btn small hw-putback') => h('button', { type: 'button', class: cls, title: 'Put it back on top of my stack, undecided', onclick: (e) => { e.stopPropagation(); putBack(c); } }, '↩ Put back on my stack');

  function memberEmpty() {
    const m = member(ui.viewing);
    return h('div', { class: 'hw-done empty' },
      h('div', { class: 'hw-done-badge quiet' }, avatar(m)),
      h('h3', {}, `${m.name.split(' ')[0]}'s stack is empty`),
      h('p', { class: 'hw-done-sub' }, 'Pass them a card: drag one onto their face, or use Assign on the card.'),
      h('button', { type: 'button', class: 'hw-btn primary', onclick: () => viewStack('me') }, 'Back to my stack'));
  }

  // In a pile, a coloured bar says which pile you are going through and how to get back.
  function focusBar(st) {
    if (ui.focus === 'deck') return null;
    if (ui.focus === 'member') {
      const m = member(ui.viewing);
      return h('div', { class: `hw-focusbar member${m.rst ? ' rst' : ''}` },
        avatar(m),
        h('span', { class: 'hw-focus-k' }, `${m.name}'s stack`),
        rstBadge(m),
        h('span', { class: 'hw-focus-n' }, `${st.length} card${st.length === 1 ? '' : 's'}${m.rst ? '' : ` · ${m.role}`}`),
        h('button', { type: 'button', class: 'hw-focus-done', onclick: () => viewStack('me') }, 'Back to my stack'));
    }
    if (ui.focus === 'tag') {
      return h('div', { class: 'hw-focusbar tagged' },
        h('span', { class: 'hw-focus-k' }, '🏷'), tagChip(ui.tag),
        h('span', { class: 'hw-focus-n' }, `${st.length} card${st.length === 1 ? '' : 's'} this week`),
        tagLib().length > 1 ? h('button', { type: 'button', class: 'hw-link hw-focus-more', onclick: () => openTags() }, 'Other tags') : null,
        h('button', { type: 'button', class: 'hw-focus-done', onclick: () => focus('deck') }, 'Back to the deck'));
    }
    const act = ui.focus === 'act';
    return h('div', { class: `hw-focusbar ${ui.focus}` },
      h('span', { class: 'hw-focus-k' }, `${act ? '✓' : '✕'} ${PILE[ui.focus]}`),
      h('span', { class: 'hw-focus-n' }, `${st.length} card${st.length === 1 ? '' : 's'} · swipe ${act ? 'left' : 'right'} to change your mind`),
      h('button', { type: 'button', class: 'hw-focus-done', onclick: () => focus('deck') }, 'Back to the deck'));
  }

  // A miniature of a card, built from the card's own numbers: what kind it is, its headline, its weekly line
  // (or its comparison bars) and its biggest number. Sized by --s from a 120 by 160 design.
  function thumb(c) {
    const g = GLYPH[c.type];
    const color = TONE[c.tone] ?? TONE.neutral;
    const pts = (c.detail?.chart?.values ?? []).map((v, i) => [i, v]).filter(([, v]) => Number.isFinite(v));
    let pic = null;
    if (pts.length >= 3) {
      const xs = pts.map(([i]) => i); const ys = pts.map(([, v]) => v);
      const x0 = Math.min(...xs); const x1 = Math.max(...xs); const y0 = Math.min(...ys); const y1 = Math.max(...ys);
      const X = (i) => 3 + ((i - x0) / (x1 - x0 || 1)) * 98; const Y = (v) => 31 - ((v - y0) / (y1 - y0 || 1)) * 27;
      const now = pts.find(([i]) => i === c.detail.chart.idx) ?? pts[pts.length - 1];
      pic = s('svg', { class: 'hw-thumb-pic', viewBox: '0 0 104 34', preserveAspectRatio: 'none' },
        s('polyline', { points: pts.map(([i, v]) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(' '), fill: 'none', stroke: '#98a2b3', 'stroke-width': 2, 'stroke-linejoin': 'round', 'vector-effect': 'non-scaling-stroke' }),
        s('circle', { cx: X(now[0]).toFixed(1), cy: Y(now[1]).toFixed(1), r: 4.5, fill: color }));
    } else if (c.compare?.items?.length) {
      const items = c.compare.items.slice(0, 4);
      const max = Math.max(...items.map((i) => Math.abs(i.value ?? 0)), 1e-9);
      pic = h('div', { class: 'hw-thumb-pic bars' }, ...items.map((i) => h('i', { style: `width:${Math.max(6, (Math.abs(i.value ?? 0) / max) * 100)}%;${i.mine ? `background:${color}` : ''}` })));
    }
    const num = c.big?.[0]?.value ?? c.impact?.text ?? null;
    return h('div', { class: `hw-thumb tone-${c.tone}${c.alarm ? ` al-${c.alarm.level}` : ''}`, 'aria-hidden': 'true' },
      h('div', { class: 'hw-thumb-head' }, h('span', { class: 'hw-thumb-glyph' }, typeof g === 'function' ? g(c) : g ?? '•'),
        metaMark(tagsOf(c).length, notesOf(c).length), c.alarm?.level === 'stop' ? h('span', { class: 'hw-thumb-stop' }, 'STOP') : null),
      h('b', { class: 'hw-thumb-title' }, c.title),
      pic,
      num ? h('span', { class: 'hw-thumb-num' }, num) : null);
  }

  // Phones: three very small stacks in the controls row. Tap one to go through it.
  function minis() {
    const one = (f, glyph) => {
      const cards = stackOf(f);
      const pending = f !== 'deck' && ui.sheet?.dir === f ? ui.sheet.card : null;
      const n = cards.length + (pending ? 1 : 0);
      const t = pending ?? cards[0];
      const on = ui.focus === f;
      return h('button', { type: 'button', class: `hw-mini ${f}${on ? ' focus' : ''}${n ? '' : ' empty'}${pending ? ' landing' : ''}`, 'aria-pressed': String(on),
        'aria-label': `${PILE[f]}: ${n} card${n === 1 ? '' : 's'}${on ? ', in focus' : ''}`, title: PILE[f], disabled: !n && !on, onclick: () => focus(f) },
        h('span', { class: 'hw-mini-stack' }, n > 1 ? h('i', { class: 'hw-mini-layer' }) : null, t ? thumb(t) : h('span', { class: 'hw-mini-blank' }, glyph || '·')),
        h('em', { class: 'hw-mini-n' }, `${glyph}${n}`));
    };
    return h('div', { class: 'hw-minis', role: 'group', 'aria-label': 'Stacks' }, one('skip', '✕'), one('deck', ''), one('act', '✓'));
  }

  function header(left, total) {
    const streak = streakOf(mem, weeks, week);
    const pct = total ? (total - left) / total : 0;
    const open = boardItems().filter(([, b]) => b.status !== 'no').length;
    return h('div', { class: 'hw-top' },
      h('div', { class: 'hw-title' },
        h('p', {}, `Week of ${shortDate(week)}${compare ? `, compared with ${shortDate(compare)}` : ''}. ${built.deck.length} ideas built in ${Math.max(1, Math.round(built.ms))} ms from the weekly snapshot.`)),
      h('div', { class: 'hw-stats' },
        h('div', { class: 'hw-ring', style: `--p:${pct}`, title: `${left} of ${total} left` }, h('b', {}, String(left)), h('span', {}, 'left')),
        h('div', { class: 'hw-stat', title: 'Weeks in a row you finished' }, h('b', {}, streak ? `🔥 ${streak}` : '0'), h('span', {}, 'week streak')),
        h('div', { class: 'hw-stat' }, h('b', {}, String(mem.points)), h('span', {}, 'points')),
        h('button', { type: 'button', class: `hw-board-btn${ui.view === 'board' ? ' on' : ''}`, onclick: () => { ui.view = ui.view === 'board' ? 'deck' : 'board'; ctx.log?.('homework_board', { open: ui.view === 'board' }); render(); } },
          h('b', {}, String(open)), h('span', {}, ui.view === 'board' ? 'Back to ideas' : 'On your board'))));
  }

  function controls() {
    const seg = h('div', { class: 'seg-toggle hw-levels', role: 'group', 'aria-label': 'Level' },
      ...LEVELS.map((l) => h('button', { type: 'button', class: l.id === level.id ? 'on' : '', title: l.hint, onclick: () => { ctx.log?.('homework_level', { level: l.id }); ctx.set({ level: l.id }); } }, l.label)));
    return h('div', { class: 'hw-controls' },
      seg,
      h('span', { class: 'hw-level-hint' }, level.hint),
      h('label', { class: 'hw-phone-toggle' }, h('input', { type: 'checkbox', checked: phone, onchange: (e) => ctx.set({ phone: e.target.checked }) }), ' Phone frame'),
      ui.view === 'board' ? null : minis(),
      ui.view !== 'board' && tagLib().length ? h('button', { type: 'button', class: `hw-link hw-tags-btn${ui.focus === 'tag' ? ' on' : ''}`, title: 'See your tags and the cards that carry them', 'aria-label': `Your tags: ${tagLib().length}`, onclick: () => openTags() }, '🏷', h('span', { class: 'hw-more-l' }, ' Tags'), h('b', { class: 'hw-tags-n' }, String(tagLib().length))) : null,
      Object.keys(decided()).length || Object.values(passed()).some((p) => p.from === 'me' || p.to === 'me') ? h('button', { type: 'button', class: 'hw-link hw-reset', title: 'Start this week over', onclick: () => resetWeek() }, h('span', { class: 'hw-more-l' }, 'Start over'), h('span', { class: 'hw-short' }, 'Reset')) : null);
  }

  function kpis() {
    return h('div', { class: 'hw-kpis' }, ...built.kpi.measures.map((m) => {
      const tone = m.delta === null || m.delta === undefined ? '' : m.delta > 0 ? 'up' : m.delta < 0 ? 'down' : '';
      return h('div', { class: `hw-kpi ${tone}` },
        h('span', { class: 'hw-kpi-label' }, m.label),
        h('b', {}, format(m.cur, m.fmt, ctx.currency)),
        h('span', { class: 'hw-kpi-delta' }, m.delta === null || m.delta === undefined ? '–' : `${m.delta > 0 ? '▲' : m.delta < 0 ? '▼' : ''} ${fmtDelta(m.delta, m.unit)}`),
        h('span', { class: `hw-kpi-badge ${m.badge ?? ''}` }, m.badge === 'moved' ? 'Unusual week' : m.badge === 'within' ? 'A normal week' : "Can't say yet"));
    }));
  }

  // ---------- The stack and its two piles ----------

  function stage(q) {
    const el = h('div', { class: `hw-stage${ui.sheet ? ' asking' : ''} focus-${ui.focus}` });
    const shown = q.filter((c) => c !== ui.sheet?.card).slice(0, 3);
    const bottom = !ui.sheet && q.length > 1 ? q[q.length - 1] : null;
    if (bottom) el.append(h('div', { class: 'hw-peek' }, thumb(bottom), h('span', {}, 'Bottom card')));
    shown.reverse().forEach((c, i, arr) => el.append(cardEl(c, arr.length - 1 - i)));
    if (ui.sheet) el.append(sheet(ui.sheet));
    if (!ui.sheet) wheel(el);
    return el;
  }

  // Desk and tablet piles. Click one to go through it; click it again, or the bar, to go back to the deck.
  function pileEl(dir) {
    const keys = pileKeys(dir);
    const pending = ui.sheet?.dir === dir ? ui.sheet.card : null;
    const n = keys.length + (pending ? 1 : 0);
    const t = pending ?? cardOf(keys[0]);
    const on = ui.focus === dir;
    const btn = h('button', { type: 'button', class: `hw-pile ${dir}${n ? '' : ' empty'}${pending ? ' landing' : ''}${on ? ' focus' : ''}`, 'aria-pressed': String(on),
      title: !n ? '' : on ? 'Back to the deck' : `Go through what you ${dir === 'act' ? 'are acting on' : 'set aside'}`, onclick: () => { if (n) focus(dir); } },
      h('div', { class: 'hw-pile-stack' },
        ...Array.from({ length: Math.min(Math.max(n - 1, 0), 2) }, (_, i) => h('i', { class: `hw-pile-layer l${i + 1}` })),
        t ? h('div', { class: 'hw-pile-top' }, thumb(t)) : h('div', { class: 'hw-pile-top blank' }, h('span', {}, dir === 'act' ? 'Swipe right to act' : 'Swipe left to set aside'))),
      h('div', { class: 'hw-pile-label' }, h('b', {}, dir === 'act' ? '✓' : '✕'), ` ${PILE[dir]} `, h('em', {}, String(n)), on ? h('span', { class: 'hw-pile-on' }, 'In focus') : null));
    return h('div', { class: `hw-pile-wrap ${dir}` }, btn);
  }

  // ---------- A card ----------

  function chips(c) {
    const t = TYPES[c.type]; const u = URGENCY[c.urgency];
    return h('div', { class: 'hw-chips' },
      h('span', { class: `hw-type t-${c.type}` }, t.label),
      h('span', { class: `hw-urg u-${c.urgency}` }, u.label));
  }

  // The client's own names (campaign tags, test names) are marked, and say where they came from.
  function named(text, c) {
    const names = (c.names ?? []).filter((n) => n.text && text.includes(n.text)).sort((a, b) => b.text.length - a.text.length);
    if (!names.length) return [text];
    let parts = [text];
    for (const n of names) {
      parts = parts.flatMap((p) => {
        if (typeof p !== 'string' || !p.includes(n.text)) return [p];
        const out = [];
        p.split(n.text).forEach((piece, i) => { if (i) out.push(nameChip(n)); if (piece) out.push(piece); });
        return out;
      });
    }
    return parts;
  }

  function nameChip(n) {
    const b = h('button', { type: 'button', class: 'hw-name', title: 'Your name for this. Click to see where it came from.' }, n.text);
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      const face = b.closest('.hw-face') ?? root;
      const was = face.querySelector('.hw-name-pop');
      was?.remove();
      if (was?.dataset.for === n.text) return;
      const pop = h('div', { class: 'hw-name-pop', 'data-for': n.text, role: 'dialog' },
        h('div', { class: 'hw-name-pop-head' }, h('b', {}, n.kind === 'campaign' ? 'Your campaign' : n.kind === 'arm' ? 'Your test variant' : 'Your test'),
          h('button', { type: 'button', class: 'hw-link', onclick: (ev) => { ev.stopPropagation(); pop.remove(); } }, 'Close')),
        h('code', {}, n.text),
        h('dl', {}, ...n.source.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])));
      const fr = face.getBoundingClientRect(); const br = b.getBoundingClientRect();
      pop.style.top = `${br.bottom - fr.top + face.scrollTop + 6}px`;
      face.append(pop);
      ctx.log?.('homework_name', { kind: n.kind });
    });
    return b;
  }

  function versus(c) {
    const cmp = c.compare;
    if (!cmp) return null;
    const max = Math.max(...cmp.items.map((i) => Math.abs(i.value ?? 0)), 1e-9);
    return h('div', { class: 'hw-vs' },
      ...cmp.items.map((i) => h('div', { class: `hw-vs-row${i.mine ? ' mine' : ''}` },
        h('span', { class: 'hw-vs-label' }, named(i.label, c)),
        h('span', { class: 'hw-vs-track' }, h('i', { style: `width:${Math.max(1.5, (Math.abs(i.value ?? 0) / max) * 100)}%;${i.mine ? `background:${TONE[c.tone] ?? TONE.neutral}` : ''}` })),
        h('b', { class: 'hw-vs-val' }, i.text))),
      cmp.note ? h('span', { class: 'hw-vs-note' }, cmp.note) : null);
  }

  function stake(c) {
    if (!c.impact) return null;
    return h('div', { class: `hw-stake tier-${c.impact.tier.toLowerCase()} tone-${c.tone}` },
      h('div', { class: 'hw-stake-main' }, h('span', { class: 'hw-stake-k' }, 'At stake'), h('b', {}, c.impact.text), h('em', {}, c.impact.tier)),
      c.forecast ? h('span', { class: 'hw-stake-f' }, c.forecast) : null);
  }

  function alarm(c) {
    if (!c.alarm) return null;
    const stop = c.alarm.level === 'stop';
    return h('div', { class: `hw-alarm ${stop ? 'stop' : 'star'}` },
      stop ? h('span', { class: 'hw-octagon', 'aria-hidden': 'true' }, 'STOP') : h('span', { class: 'hw-starburst', 'aria-hidden': 'true' }, '★'),
      h('span', {}, c.alarm.text));
  }

  function front(c) {
    const v = verbs(c);
    const prior = mem.notes[c.muteKey];
    const was = ui.focus !== 'deck' && ui.focus !== 'member' ? decided()[c.key] : null;
    const pass = passed()[c.key];
    const showPass = pass && (browsing() || pass.to === 'me');
    const tg = tagsOf(c); const nn = notesOf(c).length;
    return h('div', { class: 'hw-face front' },
      alarm(c),
      h('div', { class: 'hw-face-body' },
        was ? h('div', { class: `hw-ribbon ${was.dir}` }, `${was.dir === 'act' ? `✓ You chose: ${v.act}` : `✕ You chose: ${v.skip}`}`,
          was.note || was.reasons?.length ? h('em', {}, ` · “${was.note || was.reasons.join(', ')}”`) : null) : null,
        showPass ? h('div', { class: `hw-ribbon pass u-${pass.urgency}` },
          h('span', { class: 'hw-pass-line' }, avatar(member(pass.from)), h('b', {}, pass.from === 'me' ? 'From you' : `From ${member(pass.from).name}`),
            ` · needed by ${dueText(pass.due)} · `, h('span', { class: `hw-urg-tag u-${pass.urgency}` }, URGENT.find(([id]) => id === pass.urgency)?.[1] ?? pass.urgency)),
          pass.task ? h('em', {}, `“${pass.task}”`) : null) : null,
        chips(c),
        tg.length || nn ? h('div', { class: 'hw-tagline' },
          ...tg.map((t) => tagChip(t, { onClick: viewTag, cls: ui.focus === 'tag' && t === ui.tag ? 'on' : '' })),
          nn ? h('button', { type: 'button', class: 'hw-note-count', title: `${nn} comment${nn === 1 ? '' : 's'}. Click to read.`, onclick: (e) => { e.stopPropagation(); openNotes(c, 'comments'); } }, '💬 ', h('b', {}, String(nn))) : null) : null,
        h('div', { class: 'hw-eyebrow' }, `${ASK[TYPES[c.type].ask]} · `, named(c.eyebrow, c)),
        h('h3', { class: 'hw-card-title' }, named(c.title, c)),
        c.verdict ? h('div', { class: `hw-verdict ${c.verdictTone ?? ''}` }, c.verdict) : null,
        prior && prior.week < week ? h('p', { class: 'hw-memory' }, `Week of ${shortDate(prior.week)} you ${prior.dir === 'act' ? 'planned' : 'set this aside'}: “${prior.note || prior.reasons.join(', ')}”`) : null,
        versus(c),
        c.big?.length ? h('div', { class: 'hw-big' }, ...c.big.map((b) => h('div', { class: `hw-num ${b.tone ?? ''}` }, h('b', {}, b.value), h('span', {}, b.label), b.delta ? h('em', {}, b.delta) : null))) : null,
        stake(c),
        c.lead ? h('p', { class: 'hw-lead' }, h('b', {}, '💡 '), c.lead.short) : null,
        level.id !== 'easy' && !c.compare ? h('p', { class: 'hw-why' }, c.why) : null,
        level.id === 'expert' && c.detail?.method ? h('p', { class: 'hw-method' }, c.detail.method) : null),
      h('div', { class: 'hw-foot' },
        h('button', { type: 'button', class: 'hw-more', onclick: (e) => { e.stopPropagation(); flip(); } }, mobile() ? 'Tap for details' : 'Details'),
        h('button', { type: 'button', class: 'hw-more hw-assign-btn', title: 'Pass this card to a teammate (A)', onclick: (e) => { e.stopPropagation(); openAssign(c); } }, ui.focus === 'member' ? '⇄ Reassign' : '👤 Assign'),
        h('button', { type: 'button', class: `hw-more hw-tag-btn${tg.length ? ' has' : ''}`, title: tg.length ? `${tg.length} tag${tg.length === 1 ? '' : 's'}: ${tg.join(', ')} (T)` : 'Tag this card (T)',
          'aria-label': tg.length ? `Tags: ${tg.length}` : 'Tag this card', onclick: (e) => { e.stopPropagation(); openNotes(c, 'tags'); } },
          '🏷', h('span', { class: 'hw-more-l' }, tg.length ? ' Tags' : ' Tag'), tg.length ? h('b', { class: 'hw-foot-n' }, String(tg.length)) : null),
        h('button', { type: 'button', class: `hw-more hw-tag-btn${nn ? ' has' : ''}`, title: nn ? `${nn} comment${nn === 1 ? '' : 's'} (C)` : 'Comment on this card (C)',
          'aria-label': nn ? `Comments: ${nn}` : 'Comment on this card', onclick: (e) => { e.stopPropagation(); openNotes(c, 'comments'); } },
          '💬', h('span', { class: 'hw-more-l' }, nn ? ' Comments' : ' Comment'), nn ? h('b', { class: 'hw-foot-n' }, String(nn)) : null)),
      h('div', { class: 'hw-stamp act' }, v.actStamp),
      h('div', { class: 'hw-stamp skip' }, v.skipStamp),
      h('div', { class: 'hw-stamp later' }, 'LATER'));
  }

  function back(c) {
    const d = c.detail ?? {};
    let chart = null;
    if (d.chart?.band && d.chart.cIdx >= 0 && d.chart.values?.[d.chart.cIdx] !== null) {
      chart = wobbleChart({ ...d.chart, full: d.chart.weeks.map((w) => ctx.full(w)), weekLabel: shortDate, currency: ctx.currency, color: TONE[c.tone] ?? TONE.neutral });
    }
    const L = c.lead;
    const tapBack = (e) => {
      if (!ui.flipped || e.target.closest('button, a, input, select, textarea, summary, .hw-name-pop') || String(window.getSelection?.() ?? '')) return;
      flip();
    };
    return h('div', { class: 'hw-face back', onclick: tapBack },
      h('div', { class: 'hw-back-head' }, h('button', { type: 'button', class: 'hw-link', onclick: (e) => { e.stopPropagation(); flip(); } }, '← Back to the card'), chips(c)),
      h('h4', {}, named(c.title, c)),
      c.why ? h('p', { class: 'hw-why' }, c.why) : null,
      L ? h('section', { class: 'hw-lead-box' },
        h('h5', {}, `💡 ${L.short}`),
        h('p', {}, L.text),
        ...L.extra.map((x) => h('p', {}, named(x.text, c))),
        L.rows?.length ? h('table', { class: 'hw-table rows' }, h('thead', {}, h('tr', {}, ...L.rowHead.map((x) => h('th', {}, x)))), h('tbody', {}, ...L.rows.map((r) => h('tr', {}, ...r.map((x) => h('td', {}, x)))))) : null) : null,
      d.explain ? h('p', {}, d.explain) : null,
      chart ? h('div', { class: 'hw-chart' }, chart, h('span', { class: 'hw-chart-note' }, 'Orange bar: where it would sit after a usual week.')) : null,
      d.table ? h('table', { class: 'hw-table' }, h('tbody', {}, ...d.table.map(([k, val]) => h('tr', {}, h('th', {}, k), h('td', {}, val))))) : null,
      d.rows?.length ? h('table', { class: 'hw-table rows' }, d.rowHead ? h('thead', {}, h('tr', {}, ...d.rowHead.map((x) => h('th', {}, x)))) : null, h('tbody', {}, ...d.rows.map((r) => h('tr', {}, ...r.map((x) => h('td', {}, x)))))) : null,
      d.method ? h('p', { class: 'hw-method' }, d.method) : null,
      d.drill ? h('button', { type: 'button', class: 'hw-drill', onclick: (e) => { e.stopPropagation(); openFull(c); } }, `Open ${d.drill.label ?? 'the full view'} →`) : null,
      backNotes(c));
  }

  function backNotes(c) {
    const tg = tagsOf(c); const list = notesOf(c);
    return h('section', { class: 'hw-back-notes' },
      h('div', { class: 'hw-back-notes-head' }, h('h5', {}, list.length ? `Comments (${list.length})` : 'Tags and comments'),
        h('button', { type: 'button', class: 'hw-link', onclick: (e) => { e.stopPropagation(); openNotes(c, list.length ? 'comments' : 'tags'); } }, tg.length || list.length ? 'Edit' : 'Add')),
      tg.length ? h('div', { class: 'hw-tagline' }, ...tg.map((t) => tagChip(t, { onClick: viewTag }))) : null,
      list.length ? h('div', { class: 'hw-back-thread' }, ...list.map((n) => h('div', { class: 'hw-comment' }, avatar(member(n.from) ?? { id: n.from, name: n.from, role: '' }),
        h('div', { class: 'hw-comment-body' }, h('div', { class: 'hw-comment-head' }, h('b', {}, member(n.from)?.name ?? n.from), h('span', {}, when(n.at))), h('p', {}, n.text))))) : null,
      !tg.length && !list.length ? h('p', { class: 'hw-quiet' }, 'Tag this card to find it again, or leave a comment for the team.') : null);
  }

  function openFull(c) {
    try { sessionStorage.setItem(RETURN, JSON.stringify({ key: c.key, site, hash: location.hash })); } catch { /* ignore */ }
    ctx.log?.('homework_drill', { key: c.key, tab: c.detail.drill.tab });
    ctx.drill(c.detail.drill);
    setTimeout(backButton, 0);
  }

  function cardEl(c, depth) {
    const el = h('article', { class: `hw-card tone-${c.tone} d${depth}${depth === 0 && ui.flipped ? ' flipped' : ''}${depth === 0 && ui.pulled === c.key ? ' pulled' : ''}${c.alarm ? ` al-${c.alarm.level}` : ''}`, 'data-key': c.key, 'data-type': c.type, tabindex: depth === 0 ? 0 : -1 },
      h('div', { class: 'hw-inner' }, front(c), depth === 0 ? back(c) : null));
    if (depth === 0 && !ui.sheet) drag(el, c);
    return el;
  }

  // ---------- Gestures ----------

  const stamps = (el, dx, dy, overTeam = false) => {
    const t = Math.min(COMMIT, el.offsetWidth * 0.28);
    const sides = !browsing() && !overTeam;
    el.querySelector('.hw-stamp.act').style.opacity = String(sides ? Math.max(0, Math.min(1, dx / t)) : 0);
    el.querySelector('.hw-stamp.skip').style.opacity = String(sides ? Math.max(0, Math.min(1, -dx / t)) : 0);
    el.querySelector('.hw-stamp.later').style.opacity = String(Math.abs(dx) < 30 && !overTeam ? Math.max(0, Math.min(1, -dy / t)) : 0);
    const peek = el.parentElement?.querySelector('.hw-peek');
    if (peek) {
      const p = Math.abs(dx) < 30 ? Math.max(0, Math.min(1, dy / t)) : 0;
      peek.style.opacity = String(p);
      peek.style.transform = `translate(-50%, ${Math.round((p - 1) * 30)}px) scale(${0.8 + p * 0.2})`;
    }
  };

  // With a mouse or pen, a card dragged over a teammate's face is passed to them on release.
  function drag(el, c) {
    let x0 = 0; let y0 = 0; let dx = 0; let dy = 0; let on = false; let trail = []; let canPass = false; let target = null;
    const aim = (next) => {
      if (next === target) return;
      target?.classList.remove('drop');
      next?.classList.add('drop');
      target = next;
      el.classList.toggle('to-team', !!next);
    };
    el.addEventListener('pointerdown', (e) => {
      if (ui.flipped || e.button !== 0 || e.target.closest('button, a, input, textarea, table, .hw-name-pop')) return;
      on = true; x0 = e.clientX; y0 = e.clientY; dx = 0; dy = 0; trail = [{ t: e.timeStamp, x: 0, y: 0 }];
      canPass = e.pointerType !== 'touch' && !!root.querySelector('.hw-team');
      el.setPointerCapture(e.pointerId); el.classList.add('dragging');
    });
    el.addEventListener('pointermove', (e) => {
      if (!on) return;
      dx = e.clientX - x0; dy = e.clientY - y0;
      trail.push({ t: e.timeStamp, x: dx, y: dy }); if (trail.length > 6) trail.shift();
      if (canPass && Math.hypot(dx, dy) > 12) root.classList.add('passing');
      if (canPass) aim(document.elementsFromPoint(e.clientX, e.clientY).map((n) => n.closest?.('.hw-team [data-member]')).find(Boolean) ?? null);
      el.style.transform = `translate(${dx}px, ${dy < 0 || target ? dy : Math.min(dy, 170) * 0.6}px) rotate(${target ? 0 : dx / 16}deg)`;
      stamps(el, dx, dy, !!target);
    });
    const end = () => {
      if (!on) return;
      on = false; el.classList.remove('dragging');
      root.classList.remove('passing');
      if (target) {
        const id = target.dataset.member;
        aim(null);
        el.style.transform = ''; stamps(el, 0, 0);
        return openAssign(c, id === '*' ? null : id);
      }
      const first = trail[0]; const last = trail[trail.length - 1];
      const dt = Math.max(1, last.t - first.t);
      const vx = (last.x - first.x) / dt; const vy = (last.y - first.y) / dt;
      const t = Math.min(COMMIT, el.offsetWidth * 0.28);
      const sides = !browsing();
      if (sides && (dx > t || (vx > 0.6 && dx > 30))) return swipe(c, 'act', el);
      if (sides && (dx < -t || (vx < -0.6 && dx < -30))) return swipe(c, 'skip', el);
      if (Math.abs(dx) < 50 && (dy < -t || (vy < -0.6 && dy < -30))) return later(c, el);
      if (Math.abs(dx) < 50 && (dy > t || (vy > 0.6 && dy > 30)) && stack().length > 1) return pull();
      const tap = Math.abs(dx) < 5 && Math.abs(dy) < 5;
      el.style.transform = ''; stamps(el, 0, 0);
      if (tap) flip();
    };
    el.addEventListener('pointerup', end);
    // A phone browser that still claims the gesture cancels the pointer; finish the swipe as if the finger lifted.
    el.addEventListener('pointercancel', () => { aim(null); end(); });
    // iOS Safari ignores touch-action inside a scrolling box; stopping touchmove keeps the page from taking the gesture.
    el.addEventListener('touchmove', (e) => { if (on && e.cancelable) e.preventDefault(); }, { passive: false });
  }

  // Two-finger trackpad swipes move the card instead of the browser's back and forward.
  function wheel(stageEl) {
    let acc = 0; let timer = null;
    stageEl.addEventListener('wheel', (e) => {
      if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
      e.preventDefault();
      if (ui.flipped || ui.sheet || ui.modal || browsing()) return;
      if (e.timeStamp < ui.wheelLock) { ui.wheelLock = e.timeStamp + 250; return; }
      const el = stageEl.querySelector('.hw-card.d0');
      const c = top();
      if (!el || !c) return;
      acc -= e.deltaX;
      el.classList.add('dragging');
      el.style.transform = `translate(${acc}px, 0) rotate(${acc / 16}deg)`;
      stamps(el, acc, 0);
      clearTimeout(timer);
      const t = Math.min(COMMIT, el.offsetWidth * 0.28) * 1.3;
      if (Math.abs(acc) > t) {
        const dir = acc > 0 ? 'act' : 'skip';
        acc = 0; ui.wheelLock = e.timeStamp + 400; el.classList.remove('dragging');
        swipe(c, dir, el);
        return;
      }
      timer = setTimeout(() => { acc = 0; el.classList.remove('dragging'); el.style.transform = ''; stamps(el, 0, 0); }, 160);
    }, { passive: false });
  }

  function flip() {
    if (ui.sheet) return;
    ui.flipped = !ui.flipped;
    const el = root.querySelector('.hw-card.d0');
    el?.classList.toggle('flipped', ui.flipped);
    el?.querySelector('.hw-name-pop')?.remove();
    if (ui.flipped) ctx.log?.('homework_details', { key: el?.dataset.key ?? top()?.key });
  }

  function toBottom(key) {
    if (ui.focus === 'deck') {
      ui.order = ui.order.filter((k) => k !== key);
      ui.later = [...ui.later.filter((k) => k !== key), key];
    } else {
      ui.rot[ui.focus] = [...pileKeys(ui.focus).filter((k) => k !== key), key];
    }
  }

  function later(c, el = root.querySelector('.hw-card.d0')) {
    if (!c || ui.sheet) return;
    ui.flipped = false;
    toBottom(c.key);
    ctx.log?.('homework_later', { key: c.key, stack: ui.focus });
    buzz();
    const go = () => { render(); toast(ui.focus === 'deck' ? 'Sent to the bottom of the stack' : ui.focus === 'member' ? `Sent to the bottom of ${firstName(ui.viewing)}'s stack` : ui.focus === 'tag' ? `Sent to the bottom of “${ui.tag}”` : `Sent to the bottom of ${PILE[ui.focus]}`); };
    if (!el) return go();
    el.classList.add('flying', 'later');
    el.style.transform = 'translate(0, -120%) scale(.9)';
    el.querySelector('.hw-stamp.later').style.opacity = '1';
    setTimeout(go, 220);
  }

  // Swipe down: the bottom card of the stack in focus comes back to the top.
  function pull() {
    const st = stack();
    if (ui.sheet || st.length < 2) return;
    const b = st[st.length - 1];
    ui.flipped = false;
    if (ui.focus === 'deck') {
      ui.later = ui.later.filter((k) => k !== b.key);
      ui.order = [b.key, ...ui.order.filter((k) => k !== b.key)];
    } else {
      ui.rot[ui.focus] = [b.key, ...st.filter((c) => c !== b).map((c) => c.key)];
    }
    ui.pulled = b.key;
    ctx.log?.('homework_pull', { key: b.key, stack: ui.focus });
    buzz();
    render();
  }

  function swipe(c, dir, el = root.querySelector('.hw-card.d0')) {
    if (!c || ui.sheet || browsing()) return;
    ui.flipped = false;
    const fly = (go) => {
      if (!el) return go();
      el.classList.add('flying', dir);
      el.style.transform = `translate(${dir === 'act' ? 140 : -140}%, 30px) rotate(${dir === 'act' ? 24 : -24}deg)`;
      el.querySelector(`.hw-stamp.${dir}`).style.opacity = '1';
      setTimeout(go, 220);
    };
    // Going through a pile: the pile's own direction keeps the card there, the other direction changes your mind.
    if (ui.focus !== 'deck' && dir === ui.focus) {
      toBottom(c.key);
      ctx.log?.('homework_keep', { key: c.key, stack: ui.focus });
      buzz();
      return fly(() => { render(); toast(dir === 'act' ? 'Still acting on it' : 'Still set aside'); });
    }
    let before = null;
    if (ui.focus !== 'deck') { before = structuredClone(mem); undecide(c.key); }
    ctx.log?.('homework_swipe', { key: c.key, type: c.type, dir, changed: !!before });
    buzz();
    const go = () => { ui.sheet = { card: c, dir, reasons: [], who: [], note: '', mute: false, before }; render(); };
    if (!el) return go();
    el.classList.add('flying', dir);
    el.style.transform = `translate(${dir === 'act' ? 140 : -140}%, 30px) rotate(${dir === 'act' ? 24 : -24}deg)`;
    el.querySelector(`.hw-stamp.${dir}`).style.opacity = '1';
    setTimeout(go, 220);
  }

  // ---------- Why, after a swipe ----------

  function sheet(sh) {
    const c = sh.card; const v = verbs(c); const act = sh.dir === 'act';
    const reasons = REASONS[isCheck(c) ? (act ? 'agree' : 'disagree') : sh.dir];
    const chip = (list, x) => h('button', { type: 'button', class: `hw-chip${list.includes(x) ? ' on' : ''}`, onclick: (e) => { const i = list.indexOf(x); if (i >= 0) list.splice(i, 1); else list.push(x); e.currentTarget.classList.toggle('on'); } }, x);
    const note = h('textarea', { rows: 2, placeholder: act ? (isCheck(c) ? 'Anything to add? (optional)' : 'Next step, e.g. "Compare the two landing pages"') : "Why? Next week's ideas will take it into account (optional)" });
    note.value = sh.note;
    note.addEventListener('input', () => { sh.note = note.value; });
    const mute = h('input', { type: 'checkbox', checked: sh.mute, onchange: (e) => { sh.mute = e.target.checked; } });
    setTimeout(() => root.querySelector('.hw-sheet')?.focus({ preventScroll: true }), 0);
    return h('div', { class: 'hw-sheet-wrap' },
      h('div', { class: 'hw-sheet-backdrop' }),
      h('div', { class: `hw-sheet ${act ? 'act' : 'skip'}`, tabindex: -1, role: 'dialog', 'aria-label': 'Tell us why' },
        h('div', { class: 'hw-sheet-head' },
          h('span', { class: `hw-sheet-verdict ${act ? 'act' : 'skip'}` }, act ? `✓ ${v.act}` : `✕ ${v.skip}`),
          h('span', { class: 'hw-sheet-title' }, c.title)),
        h('h4', {}, act ? (isCheck(c) ? 'Why do you agree?' : "Nice. What's the next step?") : (isCheck(c) ? "What's missing?" : 'Got it. Why not now?')),
        h('div', { class: 'hw-chiprow' }, ...reasons.map((x) => chip(sh.reasons, x))),
        act && !isCheck(c) ? h('div', { class: 'hw-who' }, h('span', {}, "Who's on it?"), ...WHO.map((x) => chip(sh.who, x))) : null,
        note,
        h('label', { class: 'hw-mute' }, mute, " Don't show me this again"),
        h('div', { class: 'hw-sheet-actions' },
          h('button', { type: 'button', class: 'hw-btn ghost', onclick: () => undo() }, 'Undo swipe'),
          h('button', { type: 'button', class: 'hw-btn ghost', onclick: () => commit(sh, true) }, 'Skip'),
          h('button', { type: 'button', class: 'hw-btn primary', onclick: () => commit(sh, false) }, act && !isCheck(c) ? 'Save to my board' : 'Save'))));
  }

  function commit(sh, bare) {
    const c = sh.card;
    const rec = { dir: sh.dir, reasons: bare ? [] : sh.reasons, who: bare ? [] : sh.who, note: bare ? '' : sh.note.trim(), mute: !bare && sh.mute, at: Date.now(), title: c.title, type: c.type, tone: c.tone, muteKey: c.muteKey, impact: c.impact?.text ?? null, urgency: c.urgency };
    const gain = POINTS.swipe + (rec.note || rec.reasons.length ? POINTS.note : 0);
    rec.points = gain;
    decided()[c.key] = rec;
    if (rec.mute) mem.mutes[c.muteKey] = { title: c.title, week, note: rec.note, at: rec.at };
    if (rec.note || rec.reasons.length) mem.notes[c.muteKey] = { week, note: rec.note, reasons: rec.reasons, dir: rec.dir };
    if (rec.dir === 'act' && !isCheck(c)) mem.board[c.key] = { status: 'todo', title: c.title, week, note: rec.note, who: rec.who, type: c.type, tone: c.tone, impact: c.impact?.text ?? null, forecast: c.forecast ?? null, at: rec.at };
    mem.points += gain;
    persist();
    ui.history.push(c.key);
    ui.sheet = null;
    ctx.log?.('homework_feedback', { key: c.key, dir: rec.dir, reasons: rec.reasons, mute: rec.mute, noted: !!rec.note });
    render();
    toast(sh.before ? `+${gain} points · moved to ${PILE[rec.dir]}` : `+${gain} points · ${queue().length ? `${queue().length} left` : 'all done'}`);
  }

  function undecide(key) {
    const rec = decided()[key];
    if (!rec) return null;
    delete decided()[key];
    if (rec.mute && mem.mutes[rec.muteKey]?.week === week) delete mem.mutes[rec.muteKey];
    if (mem.board[key]?.week === week) delete mem.board[key];
    if (mem.done[week]) { delete mem.done[week]; mem.points -= POINTS.done; }
    mem.points = Math.max(0, mem.points - (rec.points ?? 0));
    persist();
    ui.history = ui.history.filter((k) => k !== key);
    return rec;
  }

  function reopen(key) {
    if (!undecide(key)) return;
    ui.order = [key, ...ui.order.filter((k) => k !== key)];
    ctx.log?.('homework_undo', { key });
    render();
    if (ui.focus !== 'deck') toast('Back in the deck, undecided');
  }

  function undo() {
    if (ui.sheet?.before) {
      restore(ui.sheet.before);
      ui.sheet = null;
      render();
      return;
    }
    if (ui.sheet) { ui.order = [ui.sheet.card.key, ...ui.order]; ui.sheet = null; render(); return; }
    const key = ui.history[ui.history.length - 1] ?? Object.entries(decided()).sort((a, b) => b[1].at - a[1].at)[0]?.[0];
    if (key) reopen(key);
  }

  function resetWeek() {
    let back = 0;
    for (const [key, rec] of Object.entries(decided())) {
      back += rec.points ?? 0;
      if (rec.mute && mem.mutes[rec.muteKey]?.week === week) delete mem.mutes[rec.muteKey];
      if (mem.board[key]?.week === week) delete mem.board[key];
    }
    if (mem.done[week]) { back += POINTS.done; delete mem.done[week]; }
    mem.points = Math.max(0, mem.points - back);
    mem.decisions[week] = {}; delete mem.started[week]; delete mem.back[week];
    mem.passed[week] = seedStacks(built.deck.slice(SEED_FROM));
    closeModal();
    Object.assign(ui, { history: [], order: [], later: [], sheet: null, flipped: false, focus: 'deck', viewing: null, tag: null, rot: { skip: [], act: [], member: [], tag: [] } });
    persist();
    ctx.log?.('homework_reset', { week });
    render();
  }

  function actions(c) {
    const v = verbs(c); const off = !!ui.sheet;
    const f = ui.focus;
    if (f === 'member') {
      const mine = passed()[c.key]?.from === 'me';
      return h('div', { class: 'hw-actions in-pile member' },
        h('button', { type: 'button', class: 'hw-round later', title: 'Next card (↑)', onclick: () => later(c) }, h('span', { class: 'ico' }, '↑'), h('span', {}, 'Next')),
        h('button', { type: 'button', class: 'hw-round pass', title: 'Pass it to someone else (A)', onclick: () => openAssign(c) }, h('span', { class: 'ico' }, '⇄'), h('span', {}, 'Reassign')),
        h('button', { type: 'button', class: 'hw-round take', title: mine ? 'Take it back: on top of my stack' : 'Take it: on top of my stack', onclick: () => putBack(c) }, h('span', { class: 'ico' }, '↩'), h('span', {}, 'To my stack')));
    }
    if (f === 'tag') {
      return h('div', { class: 'hw-actions in-pile member tagged' },
        h('button', { type: 'button', class: 'hw-round later', title: 'Next card (↑)', onclick: () => later(c) }, h('span', { class: 'ico' }, '↑'), h('span', {}, 'Next')),
        h('button', { type: 'button', class: 'hw-round tags', title: 'Tags (T)', onclick: () => openNotes(c, 'tags') }, h('span', { class: 'ico' }, '🏷'), h('span', {}, 'Tags')),
        h('button', { type: 'button', class: 'hw-round notes', title: 'Comment (C)', onclick: () => openNotes(c, 'comments') }, h('span', { class: 'ico' }, '💬'), h('span', {}, 'Comment')),
        h('button', { type: 'button', class: 'hw-round pass', title: 'Pass it to a teammate (A)', onclick: () => openAssign(c) }, h('span', { class: 'ico' }, '👤'), h('span', {}, 'Assign')),
        onStack(c) ? null : h('button', { type: 'button', class: 'hw-round take', title: 'Put it back on top of my stack, undecided', onclick: () => putBack(c) }, h('span', { class: 'ico' }, '↩'), h('span', {}, 'To my stack')));
    }
    if (f !== 'deck') {
      return h('div', { class: `hw-actions in-pile ${f}` },
        h('button', { type: 'button', class: 'hw-round skip', disabled: off, title: f === 'skip' ? 'Keep it set aside (←)' : `${v.skip} instead (←)`, onclick: () => swipe(c, 'skip') }, h('span', { class: 'ico' }, '✕'), h('span', {}, f === 'skip' ? 'Keep' : v.skip)),
        h('button', { type: 'button', class: 'hw-round take', disabled: off, title: 'Put it back on top of my stack, undecided', onclick: () => putBack(c) }, h('span', { class: 'ico' }, '↩'), h('span', {}, 'To my stack')),
        h('button', { type: 'button', class: 'hw-round act', disabled: off, title: f === 'act' ? 'Keep acting on it (→)' : `${v.act} instead (→)`, onclick: () => swipe(c, 'act') }, h('span', { class: 'ico' }, '✓'), h('span', {}, f === 'act' ? 'Keep' : v.act)),
        h('button', { type: 'button', class: 'hw-round undo', title: 'Undo (Z)', onclick: () => undo() }, h('span', { class: 'ico' }, '↺'), h('span', {}, 'Undo')));
    }
    return h('div', { class: 'hw-actions' },
      h('button', { type: 'button', class: 'hw-round skip', disabled: off, title: `${v.skip} (←)`, onclick: () => swipe(c, 'skip') }, h('span', { class: 'ico' }, '✕'), h('span', {}, v.skip)),
      h('button', { type: 'button', class: 'hw-round later', disabled: off, title: 'Later: to the back of the deck (↑)', onclick: () => later(c) }, h('span', { class: 'ico' }, '↑'), h('span', {}, 'Later')),
      h('button', { type: 'button', class: 'hw-round act', disabled: off, title: `${v.act} (→)`, onclick: () => swipe(c, 'act') }, h('span', { class: 'ico' }, '✓'), h('span', {}, v.act)),
      ui.history.length || Object.keys(decided()).length ? h('button', { type: 'button', class: 'hw-round undo', title: 'Undo (Z)', onclick: () => undo() }, h('span', { class: 'ico' }, '↺'), h('span', {}, 'Undo')) : null);
  }

  function queueList(q) {
    return h('aside', { class: 'hw-queue' },
      h('h4', {}, `Up next (${q.length - 1})`),
      h('ol', {}, ...q.slice(1).map((c) => h('li', {},
        h('button', { type: 'button', title: 'Bring this card to the top', onclick: () => { ui.order = [c.key, ...ui.order.filter((k) => k !== c.key)]; ui.flipped = false; render(); } },
          h('i', { class: `hw-dot u-${c.urgency}` }),
          h('span', { class: 'hw-q-title' }, c.alarm?.level === 'stop' ? '⛔ ' : '', c.title),
          h('span', { class: 'hw-q-meta' }, [TYPES[c.type].label, c.impact ? c.impact.tier : null].filter(Boolean).join(' · '), metaMark(tagsOf(c).length, notesOf(c).length, 'hw-q-marks')))))));
  }

  // ---------- The board: kept cards, across weeks, with where each one stands ----------

  function statusPick(key) {
    const b = mem.board[key];
    return h('select', { class: `hw-status s-${b.status}`, 'aria-label': 'Status', onchange: (e) => { b.status = e.target.value; b.moved = Date.now(); persist(); ctx.log?.('homework_status', { key, status: b.status }); render(); } },
      ...STATUS.map(([id, label]) => h('option', { value: id, selected: b.status === id }, label)));
  }

  function boardView() {
    const items = boardItems();
    if (!items.length) {
      return h('div', { class: 'hw-done empty' }, h('div', { class: 'hw-done-badge quiet' }, '📋'), h('h3', {}, 'Your board is empty'),
        h('p', { class: 'hw-done-sub' }, 'Swipe an idea right and save it. It lands here with your note, and you can track it to live.'),
        h('button', { type: 'button', class: 'hw-btn primary', onclick: () => { ui.view = 'deck'; render(); } }, "Go to this week's ideas"));
    }
    return h('div', { class: 'hw-board' },
      ...STATUS.map(([id, label]) => {
        const col = items.filter(([, b]) => b.status === id).sort((a, b) => (b[1].moved ?? b[1].at) - (a[1].moved ?? a[1].at));
        return h('section', { class: `hw-col-board s-${id}` },
          h('h4', {}, label, h('em', {}, String(col.length))),
          id === 'live' ? h('p', { class: 'hw-quiet' }, "We'll watch these for a change in the data and bring wins back as cards.") : null,
          ...col.map(([key, b]) => h('article', { class: `hw-bcard tone-${b.tone ?? 'neutral'}`, role: 'button', tabindex: 0, title: 'Open this card',
            onclick: (e) => { if (!e.target.closest('select')) openBoard(key); },
            onkeydown: (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) { e.preventDefault(); openBoard(key); } } },
            h('b', {}, b.title),
            h('span', { class: 'hw-bmeta' }, boardMeta(b)),
            b.note ? h('span', { class: 'hw-note' }, b.note) : null,
            statusPick(key))));
      }));
  }

  const boardMeta = (b) => [`Week of ${shortDate(b.week)}`, b.who?.length ? b.who.join(', ') : null, b.impact].filter(Boolean).join(' · ');

  // A board tile opens as the full card, flipped the same way as in the deck. Cards from an earlier
  // week only have what was saved with them.
  function openBoard(key) {
    const b = mem.board[key];
    if (!b || ui.sheet) return;
    closeModal();
    const c = b.week === week ? cardOf(key) : null;
    ui.flipped = false;
    let body;
    if (c) {
      const card = h('article', { class: `hw-card d0 hw-open-card tone-${c.tone}${c.alarm ? ` al-${c.alarm.level}` : ''}`, 'data-key': c.key, tabindex: 0,
        onclick: (e) => { if (!ui.flipped && !e.target.closest('button, a, input, select, textarea, .hw-name-pop')) flip(); } },
        h('div', { class: 'hw-inner' }, front(c), back(c)));
      body = h('div', { class: 'hw-stage hw-open-stage' }, card);
    } else {
      body = h('div', { class: `hw-open-old tone-${b.tone ?? 'neutral'}` },
        h('h3', {}, b.title),
        h('span', { class: 'hw-bmeta' }, boardMeta(b)),
        b.note ? h('p', { class: 'hw-note' }, b.note) : null,
        h('p', { class: 'hw-quiet' }, `This card is from the week of ${shortDate(b.week)}. Pick that week in Filters to see the whole card.`));
    }
    ui.modal = h('div', { class: 'hw-modal-wrap hw-open-wrap' },
      h('div', { class: 'hw-modal-back', onclick: closeModal }),
      h('div', { class: 'hw-open', role: 'dialog', 'aria-modal': 'true', 'aria-label': b.title },
        h('div', { class: 'hw-open-bar' },
          h('span', { class: 'hw-open-k' }, 'On your board'),
          statusPick(key),
          h('button', { type: 'button', class: 'hw-modal-x', 'aria-label': 'Close', onclick: closeModal }, '×')),
        body,
        c && !onStack(c) ? h('div', { class: 'hw-open-foot' }, putBackBtn(c, 'hw-btn hw-putback'), h('span', {}, 'Takes it off your board and puts it on top of your stack, undecided.')) : null));
    root.append(ui.modal);
    ui.modal.querySelector('.hw-open-card, .hw-open')?.focus({ preventScroll: true });
    ctx.log?.('homework_board_open', { key, full: !!c });
  }

  function done() {
    const recs = Object.entries(decided());
    const acts = recs.filter(([, r]) => r.dir === 'act' && r.type !== 'check');
    const checks = recs.filter(([, r]) => r.type === 'check').map(([, r]) => r);
    const skips = recs.filter(([, r]) => r.dir === 'skip' && r.type !== 'check');
    const muted = recs.filter(([, r]) => r.mute);
    const outs = Object.entries(passed()).filter(([, p]) => p.from === 'me' && p.to !== 'me').map(([k, p]) => [cardOf(k), p]).filter(([c]) => c);
    const mins = mem.started[week] && mem.done[week] ? Math.max(1, Math.round((mem.done[week] - mem.started[week]) / 60000)) : null;
    const more = pool().length - inLevel().length;
    const nextLevel = LEVELS[LEVELS.indexOf(level) + 1];
    const streak = streakOf(mem, weeks, week);
    const plan = () => [
      `Heatmap ideas, week of ${shortDate(week)} (${ctx.manifest?.site?.name ?? site})`,
      '', 'Acting on:', ...(acts.length ? acts.map(([, r]) => `- ${r.title}${r.who.length ? ` [${r.who.join(', ')}]` : ''}${r.note ? `: ${r.note}` : ''}`) : ['- nothing this week']),
      '', 'Set aside:', ...(skips.length ? skips.map(([, r]) => `- ${r.title}${r.reasons.length ? ` (${r.reasons.join(', ')})` : ''}`) : ['- nothing']),
      ...(outs.length ? ['', 'Passed on:', ...outs.map(([c, p]) => `- ${c.title} → ${member(p.to).name}, needed by ${dueText(p.due)}${p.task ? `: ${p.task}` : ''}`)] : []),
    ].join('\n');
    const copy = h('button', { type: 'button', class: 'hw-btn primary', onclick: async () => { try { await navigator.clipboard.writeText(plan()); copy.textContent = 'Copied ✓'; } catch { copy.textContent = 'Copy failed'; } ctx.log?.('homework_copy', { week }); } }, 'Copy my plan');
    const item = ([key, r]) => h('li', {}, h('b', {}, r.title), r.who?.length ? h('span', { class: 'hw-who-tag' }, r.who.join(', ')) : null,
      r.note ? h('span', { class: 'hw-note' }, r.note) : r.reasons?.length ? h('span', { class: 'hw-note' }, r.reasons.join(', ')) : null,
      mem.board[key] ? statusPick(key) : null,
      cardOf(key) ? putBackBtn(cardOf(key), 'hw-link hw-putback') : null);
    const list = (rs) => (rs.length > 4 ? [h('ul', {}, ...rs.slice(0, 4).map(item)), h('details', { class: 'hw-more-list' }, h('summary', {}, `${rs.length - 4} more`), h('ul', {}, ...rs.slice(4).map(item)))] : h('ul', {}, ...rs.map(item)));
    return h('div', { class: 'hw-done' },
      h('div', { class: 'hw-done-badge' }, '✓'),
      h('h3', {}, 'All ideas reviewed'),
      h('p', { class: 'hw-done-sub' }, `${recs.length} cards for the week of ${shortDate(week)}${mins ? ` in about ${mins} minute${mins === 1 ? '' : 's'}` : ''}. +${POINTS.done} bonus points. ${streak > 1 ? `That's ${streak} weeks in a row.` : 'Your streak starts here. Come back next week to keep it going.'}`),
      h('div', { class: 'hw-done-cols' },
        h('section', {}, h('h4', {}, `Your plan (${acts.length})`), acts.length ? list(acts) : h('p', { class: 'hw-quiet' }, 'Nothing to act on this week.')),
        h('section', {}, h('h4', {}, `Set aside (${skips.length})`), skips.length ? list(skips) : h('p', { class: 'hw-quiet' }, 'Nothing set aside.')),
        outs.length ? h('section', {}, h('h4', {}, `Passed on (${outs.length})`), h('ul', {}, ...outs.map(([c, p]) => h('li', {}, h('b', {}, c.title),
          h('span', { class: 'hw-who-tag' }, member(p.to).name), h('span', { class: 'hw-note' }, `Needed by ${dueText(p.due)}${p.task ? `: ${p.task}` : ''}`), putBackBtn(c, 'hw-link hw-putback'))))) : null,
        checks.length ? h('section', {}, h('h4', {}, 'Checks'), h('ul', {}, ...checks.map((r) => h('li', {}, h('b', {}, r.title), h('span', { class: 'hw-note' }, r.dir === 'act' ? 'You agreed' : `You disagreed${r.note ? `: ${r.note}` : ''}`))))) : null),
      h('p', { class: 'hw-next' }, `Next week we'll ${[muted.length ? `leave out ${muted.length} topic${muted.length === 1 ? '' : 's'} you muted` : null, recs.some(([, r]) => r.note || r.reasons.length) ? 'show your notes again on any card about the same thing, so you can see whether your plan worked' : null].filter(Boolean).join(', ') || 'build a fresh deck from the new week'}.`),
      h('div', { class: 'hw-done-actions' },
        copy,
        acts.length ? h('button', { type: 'button', class: 'hw-btn ghost', onclick: () => { ui.view = 'board'; render(); } }, 'Open my board →') : null,
        more > 0 && nextLevel ? h('button', { type: 'button', class: 'hw-btn ghost', onclick: () => ctx.set({ level: nextLevel.id }) }, `${more} more at ${nextLevel.label} →`) : null,
        h('button', { type: 'button', class: 'hw-btn ghost', onclick: () => resetWeek() }, 'Start over')));
  }

  function empty() {
    return h('div', { class: 'hw-done empty' },
      h('div', { class: 'hw-done-badge quiet' }, '☕'),
      h('h3', {}, 'Nothing needs you this week'),
      h('p', { class: 'hw-done-sub' }, built.deck.length ? 'Every card this week is about a topic you muted.' : 'No movement beyond the usual wobble, no broken experiments and no dead campaigns.'));
  }

  function mutedLine() {
    const list = Object.entries(mem.mutes);
    if (!list.length || ui.view === 'board') return null;
    return h('details', { class: 'hw-muted' },
      h('summary', {}, `${list.length} topic${list.length === 1 ? '' : 's'} muted by your feedback`),
      h('ul', {}, ...list.map(([k, m]) => h('li', {}, h('span', {}, m.title), m.note ? h('em', {}, ` “${m.note}”`) : null,
        h('button', { type: 'button', class: 'hw-link', onclick: () => { delete mem.mutes[k]; persist(); ctx.log?.('homework_unmute', { key: k }); render(); } }, 'Unmute')))));
  }

  function toast(text, act = null) {
    root.querySelector('.hw-toast')?.remove();
    const t = h('div', { class: `hw-toast${act ? ' with-act' : ''}` }, text, act ? h('button', { type: 'button', onclick: () => { t.remove(); act.run(); } }, act.label) : null);
    root.append(t);
    const life = act ? 4500 : 1400;
    setTimeout(() => t.classList.add('out'), life);
    setTimeout(() => t.remove(), life + 400);
  }

  if (keyHandler) document.removeEventListener('keydown', keyHandler);
  keyHandler = (e) => {
    if (!root.isConnected) { document.removeEventListener('keydown', keyHandler); keyHandler = null; return; }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const typing = e.target.closest?.('input, textarea, select');
    if (ui.modal) {
      if (e.key === 'Escape') { e.preventDefault(); closeModal(); }
      else if (e.key === ' ' && !typing && ui.modal.querySelector('.hw-open-card') && !e.target.closest?.('button')) { e.preventDefault(); flip(); }
      return;
    }
    if (ui.view === 'board') return;
    if (ui.sheet) {
      if (e.key === 'Escape') { e.preventDefault(); commit(ui.sheet, true); }
      else if (e.key === 'Enter' && !e.shiftKey && (!typing || e.target.tagName === 'TEXTAREA')) { e.preventDefault(); commit(ui.sheet, false); }
      return;
    }
    if (typing) return;
    const c = top();
    if (e.key === 'ArrowRight' && c) { e.preventDefault(); swipe(c, 'act'); }
    else if (e.key === 'ArrowLeft' && c) { e.preventDefault(); swipe(c, 'skip'); }
    else if (e.key === 'ArrowUp' && c) { e.preventDefault(); later(c); }
    else if (e.key === 'ArrowDown' && c) { e.preventDefault(); pull(); }
    else if (e.key === ' ' && c) { e.preventDefault(); flip(); }
    else if ((e.key === 'a' || e.key === 'A') && c) { e.preventDefault(); openAssign(c); }
    else if ((e.key === 't' || e.key === 'T') && c) { e.preventDefault(); openNotes(c, 'tags'); }
    else if ((e.key === 'c' || e.key === 'C') && c) { e.preventDefault(); openNotes(c, 'comments'); }
    else if ((e.key === 'z' || e.key === 'Z') && !browsing()) { e.preventDefault(); undo(); }
    else if (e.key === 'Escape') { if (root.querySelector('.hw-name-pop')) root.querySelector('.hw-name-pop').remove(); else if (ui.focus !== 'deck') focus('deck'); }
  };
  document.addEventListener('keydown', keyHandler);
  if (resizeHandler) window.removeEventListener('resize', resizeHandler);
  resizeHandler = fit;
  window.addEventListener('resize', resizeHandler, { passive: true });

  render();
  welcomeTips(ctx.log);
  return root;
}
