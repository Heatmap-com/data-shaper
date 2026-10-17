// One shared floating card and one pin tray for every view.
// spec: { id, build({ floating, pinned, onUnpin }) → nodes, onHover?, onPin? }
// Cards are built from numbers the view already holds, so showing one costs no computation.
import { h } from './views.js';

let cardEl = null;
let hideTimer = null;
let dwellTimer = null;
let current = null;
let byTouch = false;
let lastPointer = 'mouse';

function ensureCard() {
  if (cardEl) return cardEl;
  cardEl = h('div', { id: 'ctr-card', class: 'ctr-card floating', role: 'dialog', hidden: true });
  cardEl.addEventListener('mouseenter', () => clearTimeout(hideTimer));
  cardEl.addEventListener('mouseleave', () => scheduleHide());
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideCard(); });
  document.addEventListener('click', (e) => { if (byTouch && !cardEl.hidden && !cardEl.contains(e.target)) hideCard(); });
  document.body.append(cardEl);
  return cardEl;
}
document.addEventListener('pointerdown', (e) => { lastPointer = e.pointerType || 'mouse'; }, true);
function scheduleHide() { if (byTouch) return; clearTimeout(hideTimer); hideTimer = setTimeout(hideCard, 160); }
export function hideCard() { clearTimeout(dwellTimer); if (cardEl) cardEl.hidden = true; current = null; byTouch = false; }

function showCard(anchor, spec, touch = false) {
  clearTimeout(hideTimer);
  const el = ensureCard();
  byTouch = touch;
  el.classList.toggle('by-touch', touch);
  if (current !== spec.id) {
    el.replaceChildren(h('button', { type: 'button', class: 'ctr-close', 'aria-label': 'Close', onclick: (e) => { e.stopPropagation(); hideCard(); } }, '×'),
      ...spec.build({ floating: true }).filter(Boolean));
    current = spec.id;
    clearTimeout(dwellTimer);
    if (spec.onHover) dwellTimer = setTimeout(spec.onHover, 500);
  }
  el.hidden = false;
  if (touch) { el.style.left = ''; el.style.top = ''; return; }
  const a = anchor.getBoundingClientRect();
  const w = el.offsetWidth; const ht = el.offsetHeight;
  const left = Math.max(8, Math.min(a.left, window.innerWidth - w - 8));
  const below = a.bottom + 6 + ht < window.innerHeight;
  el.style.left = `${left}px`;
  el.style.top = `${below ? a.bottom + 6 : Math.max(8, a.top - ht - 6)}px`;
}

// Hover or focus shows the card; click pins it. A tap shows it instead, and the card's own button pins.
export function hoverCard(el, spec) {
  el.setAttribute('aria-haspopup', 'dialog');
  el.addEventListener('mouseenter', () => { if (lastPointer !== 'touch') showCard(el, spec); });
  el.addEventListener('focus', () => { if (lastPointer !== 'touch') showCard(el, spec); });
  el.addEventListener('mouseleave', scheduleHide);
  el.addEventListener('blur', scheduleHide);
  el.addEventListener('click', (e) => {
    e.stopPropagation();
    if (lastPointer === 'touch') { if (byTouch && current === spec.id) hideCard(); else showCard(el, spec, true); return; }
    pinCard(spec);
  });
  return el;
}

const pins = [];
let trayEl = null;
export function pinCard(spec) {
  if (!pins.some((p) => p.id === spec.id)) pins.push(spec);
  while (pins.length > 4) pins.shift();
  spec.onPin?.();
  hideCard();
  renderTray();
}
function renderTray() {
  if (!trayEl) { trayEl = h('div', { id: 'ctr-pins', class: 'ctr-pins' }); document.body.append(trayEl); }
  trayEl.hidden = !pins.length;
  trayEl.replaceChildren(
    pins.length ? h('div', { class: 'ctr-pins-head' }, h('strong', {}, `Pinned (${pins.length} of 4)`),
      h('button', { type: 'button', class: 'linklike', onclick: () => { pins.length = 0; renderTray(); } }, 'clear all')) : null,
    h('div', { class: 'ctr-pins-row' }, pins.map((p, n) => h('div', { class: 'ctr-card pinned' },
      ...p.build({ pinned: true, onUnpin: () => { pins.splice(n, 1); renderTray(); } }).filter(Boolean)))));
}
