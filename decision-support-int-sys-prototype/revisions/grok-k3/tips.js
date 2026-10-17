// Welcome tips for the ideas deck, the header menu and the settings modal. Which tips you have
// hidden is kept in this browser for every site.
import { h } from './views.js';
import { shell } from './team.js';

const STORE = 'qt:grok-k3:tips';
const phone = () => window.matchMedia('(max-width: 720px)').matches;

const swipeMap = () => h('div', { class: 'tip-swipes', 'aria-label': 'Swipe directions' },
  h('span', { class: 'tip-sw up' }, h('b', {}, '↑'), ' Send to the bottom'),
  h('span', { class: 'tip-sw left' }, h('b', {}, '←'), ' Set aside'),
  h('span', { class: 'tip-sw card', 'aria-hidden': 'true' }, 'Card'),
  h('span', { class: 'tip-sw right' }, 'Act on it ', h('b', {}, '→')),
  h('span', { class: 'tip-sw down' }, h('b', {}, '↓'), ' Bring the bottom card back'));

export const TIPS = [
  {
    id: 'welcome',
    title: 'Welcome to your ideas deck',
    body: () => [
      h('p', { class: 'tip-lead' }, 'Each card is one thing worth a decision this week.'),
      h('ol', { class: 'tip-steps' },
        h('li', {}, h('b', {}, 'Read the card. '), 'The top line says what it asks: what changed, what you can change, or is it true. The headline and big numbers say what moved and by how much.'),
        h('li', {}, h('b', {}, `${phone() ? 'Tap' : 'Click'} to flip it `), 'for the chart, the reasons and what to do next.'),
        h('li', {}, h('b', {}, 'Swipe to decide.'), phone() ? null : ' Drag the card, or use the arrow keys.')),
      swipeMap(),
      h('p', { class: 'tip-note' }, 'On an “Is it true?” card, right means you agree and left means you don’t.'),
    ],
  },
  {
    id: 'team',
    title: 'Pass a card to a teammate',
    body: () => [
      h('p', { class: 'tip-lead' }, `Drag a card onto someone’s picture at the top, or ${phone() ? 'tap' : 'click'} 👤 Assign on the card.`),
      h('p', {}, `${phone() ? 'Tap' : 'Click'} the pictures to see the whole team and look through anyone’s stack.`),
    ],
  },
  {
    id: 'tags',
    title: 'Tag it, comment on it',
    body: () => [
      h('p', { class: 'tip-lead' }, 'Use 🏷 Tag and 💬 Comment at the bottom of any card.'),
      h('p', {}, `${phone() ? 'Tap' : 'Click'} a tag on a card to go through every card with that tag.`),
    ],
  },
];

function load() {
  try { const v = JSON.parse(localStorage.getItem(STORE) ?? '{}'); return { hidden: v.hidden ?? {}, off: v.off ?? null }; } catch { return { hidden: {}, off: null }; }
}
const save = (v) => { try { localStorage.setItem(STORE, JSON.stringify(v)); } catch { /* storage full or blocked */ } };
const pending = () => { const v = load(); return v.off ? [] : TIPS.filter((t) => !v.hidden[t.id]); };

let shown = false;
let open = null;

// Keys go to the open dialog, not the deck underneath it.
function trapKeys(close) {
  const onKey = (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); close(); }
  };
  window.addEventListener('keydown', onKey, true);
  return () => window.removeEventListener('keydown', onKey, true);
}

function mount(wrap, onGone) {
  open?.close();
  const release = trapKeys(() => api.close());
  const api = { close: () => { release(); wrap.remove(); if (open === api) open = null; onGone?.(); } };
  open = api;
  document.body.append(wrap);
  return api;
}

// Opening the deck shows the tips you haven't hidden, once per visit. `all` (from the menu) shows every tip.
export function showTips({ all = false, log } = {}) {
  const list = all ? [...TIPS] : pending();
  if (!list.length) return;
  let at = 0;
  let api = null;
  const draw = () => {
    const tip = list[at];
    const last = at === list.length - 1;
    const hideOne = () => {
      const v = load(); v.hidden[tip.id] = Date.now(); save(v);
      log?.('tip_hide', { tip: tip.id });
      list.splice(at, 1);
      if (at >= list.length) return api.close();
      redraw();
    };
    const hideAll = () => {
      const v = load(); v.off = Date.now(); save(v);
      log?.('tips_off', { tip: tip.id });
      api.close();
    };
    const next = () => { if (last) { api.close(); return; } at++; redraw(); };
    const wrap = shell({ title: tip.title, cls: 'tip', onClose: () => api.close(), body: [
      h('div', { class: 'tip-body' }, ...tip.body()),
      h('div', { class: 'tip-foot' },
        h('div', { class: 'tip-skip' },
          h('button', { type: 'button', class: 'hw-link', onclick: hideOne }, 'Don’t show me this tip again'),
          h('button', { type: 'button', class: 'hw-link', onclick: hideAll }, 'Don’t show me tips again')),
        h('div', { class: 'tip-go' },
          list.length > 1 ? h('span', { class: 'tip-count' }, `${at + 1} of ${list.length}`) : null,
          h('button', { type: 'button', class: 'hw-btn primary', onclick: next }, last ? 'Got it' : 'Next tip'))),
    ] });
    return wrap;
  };
  const redraw = () => {
    const box = api.wrap.querySelector('.hw-modal');
    const fresh = draw();
    box.replaceWith(fresh.querySelector('.hw-modal'));
    api.wrap.querySelector('.tip .hw-btn.primary')?.focus({ preventScroll: true });
  };
  const wrap = draw();
  api = mount(wrap);
  api.wrap = wrap;
  wrap.querySelector('.tip .hw-btn.primary')?.focus({ preventScroll: true });
  log?.('tips_show', { tips: list.map((t) => t.id), all });
}

export function welcomeTips(log) {
  if (shown || navigator.webdriver || /HeadlessChrome/.test(navigator.userAgent)) return;
  shown = true;
  setTimeout(() => showTips({ log }), 300);
}

export function settingsModal({ log } = {}) {
  const status = h('p', { class: 'set-status' });
  const reset = h('button', { type: 'button', class: 'hw-btn', onclick: () => {
    save({ hidden: {}, off: null });
    log?.('tips_reset', {});
    draw('Done. Every tip shows again the next time you open the ideas deck.');
  } }, 'Reset Don’t Show');
  const draw = (msg) => {
    const v = load();
    const n = Object.keys(v.hidden).filter((id) => TIPS.some((t) => t.id === id)).length;
    reset.disabled = !v.off && !n;
    status.textContent = msg ?? (v.off ? 'You turned tips off.' : n ? `You hid ${n} of ${TIPS.length} tips.` : 'Every tip is on.');
  };
  draw();
  let api = null;
  const wrap = shell({ title: 'Settings', cls: 'settings', onClose: () => api.close(), body: [
    h('section', { class: 'set-row' },
      h('div', { class: 'set-text' }, h('b', {}, 'Tips'), status),
      reset),
    h('p', { class: 'hw-modal-note' }, 'Settings are kept in this browser.'),
  ] });
  api = mount(wrap);
  reset.focus({ preventScroll: true });
}

// The ☰ button in the header opens a small menu.
export function mountMenu(button, { log } = {}) {
  let menu = null;
  const close = () => {
    menu?.remove(); menu = null;
    button.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', outside, true);
    window.removeEventListener('keydown', onKey, true);
  };
  const outside = (e) => { if (!menu?.contains(e.target) && !button.contains(e.target)) close(); };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); button.focus(); } };
  const item = (label, run) => h('button', { type: 'button', role: 'menuitem', class: 'qt-menu-item', onclick: () => { close(); run(); } }, label);
  button.addEventListener('click', () => {
    if (menu) { close(); return; }
    document.body.classList.remove('filters-open');
    const r = button.getBoundingClientRect();
    menu = h('div', { class: 'qt-menu', role: 'menu', style: `top:${Math.round(r.bottom + 6)}px;left:${Math.round(r.left)}px` },
      item('⚙ Settings', () => settingsModal({ log })),
      item('💡 Show the tips', () => showTips({ all: true, log })));
    document.body.append(menu);
    button.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('keydown', onKey, true);
    menu.querySelector('button').focus({ preventScroll: true });
  });
}
