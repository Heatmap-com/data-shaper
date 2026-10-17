// Tags and comments on a card. Tags are free text; every tag you have used stays in a list, most recent
// first, so reusing one is a single click. Everything is kept in this browser with the rest of the deck.
import { h } from './views.js';
import { shell, avatar, member } from './team.js';

export const STARTERS = ['Quick win', 'Needs dev', 'Test idea', 'Follow up', 'Checkout', 'Paid social'];
const PALETTE = [
  ['#eef4ff', '#3538cd', '#c7d7fe'], ['#fdf2fa', '#c11574', '#fcceee'], ['#fef6ee', '#b93815', '#f9dbaf'], ['#f0f9ff', '#026aa2', '#b9e6fe'],
  ['#f4f3ff', '#5925dc', '#d9d6fe'], ['#fefbe8', '#a15c07', '#fde272'], ['#f0fdf9', '#107569', '#99f6e0'], ['#fff1f3', '#c01048', '#fecdd6'],
];

export const cleanTag = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, 32);
const same = (a, b) => a.toLowerCase() === b.toLowerCase();
const hash = (s) => [...s.toLowerCase()].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) >>> 0, 7);
export const tagStyle = (name) => { const [bg, fg, bd] = PALETTE[hash(name) % PALETTE.length]; return `--tg-bg:${bg};--tg-fg:${fg};--tg-bd:${bd}`; };

export function tagChip(name, { onClick, n = null, cls = '' } = {}) {
  const kids = [h('span', { class: 'hw-tag-t' }, name), n !== null ? h('em', {}, String(n)) : null];
  if (!onClick) return h('span', { class: `hw-tag ${cls}`, style: tagStyle(name) }, ...kids);
  return h('button', { type: 'button', class: `hw-tag ${cls}`, style: tagStyle(name), title: `See every card tagged “${name}”`, onclick: (e) => { e.stopPropagation(); onClick(name); } }, ...kids);
}

export function when(at) {
  const mins = Math.round((Date.now() - at) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  if (mins < 24 * 60) return `${Math.round(mins / 60)} h ago`;
  return new Date(at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// Small marks for a card that has tags or comments; a thumbnail shows them as one dark pill.
export function metaMark(nTags, nNotes, cls = 'hw-thumb-meta') {
  if (!nTags && !nNotes) return null;
  return h('span', { class: cls, title: [nTags ? `${nTags} tag${nTags === 1 ? '' : 's'}` : null, nNotes ? `${nNotes} comment${nNotes === 1 ? '' : 's'}` : null].filter(Boolean).join(', ') },
    nTags ? h('span', {}, '🏷', h('b', {}, String(nTags))) : null,
    nNotes ? h('span', {}, '💬', h('b', {}, String(nNotes))) : null);
}

// Tag a card and talk about it. Changes are saved as you make them; Done just closes.
export function notesModal({ card, thumb, tags, comments, library, counts, start = 'tags', onTags, onComments, onView, onClose }) {
  const st = { tags: [...tags], comments: [...comments], q: '', active: 0 };
  let opts = [];
  const has = (n) => st.tags.some((t) => same(t, n));
  const known = () => [...library, ...STARTERS.filter((s) => !library.some((l) => same(l, s)))];

  const set = h('div', { class: 'hw-tagset' });
  const input = h('input', { type: 'text', class: 'hw-tag-input', maxlength: 32, autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Add a tag',
    placeholder: 'Find a tag or type a new one', role: 'combobox', 'aria-expanded': 'false' });
  const list = h('ul', { class: 'hw-tag-opts', role: 'listbox', hidden: true });
  const quick = h('div', { class: 'hw-tag-quick' });

  const add = (raw) => {
    const typed = cleanTag(raw);
    if (!typed) return;
    const name = known().find((n) => same(n, typed)) ?? typed;
    if (!has(name)) { st.tags.push(name); onTags([...st.tags], name); }
    input.value = ''; st.q = ''; st.active = 0;
    draw();
    input.focus();
  };
  const remove = (name) => { st.tags = st.tags.filter((t) => t !== name); onTags([...st.tags]); draw(); };
  const uses = (n) => { const k = counts(n); return k ? `${k} card${k === 1 ? '' : 's'}` : library.some((l) => same(l, n)) ? 'none this week' : 'suggested'; };

  function draw() {
    set.replaceChildren(...(st.tags.length
      ? st.tags.map((t) => h('span', { class: 'hw-tag lg', style: tagStyle(t) },
        h('button', { type: 'button', class: 'hw-tag-t', title: `See every card tagged “${t}”`, onclick: () => onView(t) }, t),
        h('button', { type: 'button', class: 'hw-tag-x', title: 'Remove this tag', 'aria-label': `Remove the tag ${t}`, onclick: () => remove(t) }, '×')))
      : [h('span', { class: 'hw-quiet' }, 'No tags on this card yet.')]));
    const q = st.q.toLowerCase();
    const pool = known().filter((n) => !has(n));
    if (q) {
      const hits = pool.filter((n) => n.toLowerCase().includes(q)).sort((a, b) => b.toLowerCase().startsWith(q) - a.toLowerCase().startsWith(q));
      const typed = cleanTag(st.q);
      opts = [...hits.slice(0, 6).map((name) => ({ name })), ...(typed && !known().some((n) => same(n, typed)) && !has(typed) ? [{ name: typed, fresh: true }] : [])];
      st.active = Math.min(st.active, Math.max(0, opts.length - 1));
      list.replaceChildren(...opts.map((o, i) => h('li', { role: 'option', class: i === st.active ? 'active' : '', 'aria-selected': String(i === st.active),
        onmousedown: (e) => { e.preventDefault(); add(o.name); }, onmousemove: () => { if (st.active !== i) { st.active = i; draw(); } } },
        o.fresh ? h('span', { class: 'hw-tag-new' }, 'Create') : null, tagChip(o.name), h('span', { class: 'hw-tag-uses' }, o.fresh ? 'a new tag' : uses(o.name)))));
      list.hidden = !opts.length; quick.hidden = true;
    } else {
      opts = []; list.hidden = true;
      const recent = pool.slice(0, 10);
      quick.replaceChildren(h('span', { class: 'hw-field-k' }, library.length ? 'Reuse a tag' : 'Suggestions'),
        h('div', { class: 'hw-tag-row' }, ...recent.map((n) => h('button', { type: 'button', class: 'hw-tag add', style: tagStyle(n), title: `Add “${n}”`, onclick: () => add(n) }, h('span', { class: 'hw-tag-plus' }, '+'), h('span', { class: 'hw-tag-t' }, n)))));
      quick.hidden = !recent.length;
    }
    input.setAttribute('aria-expanded', String(!list.hidden));
  }

  input.addEventListener('input', () => { st.q = input.value; st.active = 0; draw(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' && opts.length) { e.preventDefault(); st.active = (st.active + 1) % opts.length; draw(); }
    else if (e.key === 'ArrowUp' && opts.length) { e.preventDefault(); st.active = (st.active - 1 + opts.length) % opts.length; draw(); }
    else if (e.key === 'Enter') { e.preventDefault(); add(opts[st.active]?.name ?? st.q); }
    else if (e.key === 'Escape' && st.q) { e.preventDefault(); e.stopPropagation(); input.value = ''; st.q = ''; draw(); }
    else if (e.key === 'Backspace' && !input.value && st.tags.length) remove(st.tags[st.tags.length - 1]);
  });

  const thread = h('ol', { class: 'hw-comments' });
  const box = h('textarea', { rows: 2, class: 'hw-comment-input', maxlength: 1000, placeholder: 'Add a comment for the team', 'aria-label': 'Add a comment' });
  const post = h('button', { type: 'button', class: 'hw-btn primary small', disabled: true, onclick: () => send() }, 'Comment');
  const head = h('h5', { class: 'hw-notes-k' });
  const send = () => {
    const text = box.value.trim();
    if (!text) return;
    st.comments.push({ id: Date.now().toString(36), from: 'me', text, at: Date.now() });
    onComments([...st.comments]);
    box.value = ''; post.disabled = true;
    drawThread();
    thread.scrollTop = thread.scrollHeight;
    box.focus();
  };
  function drawThread() {
    head.textContent = st.comments.length ? `Comments (${st.comments.length})` : 'Comments';
    thread.replaceChildren(...st.comments.map((c) => {
      const m = member(c.from) ?? { id: c.from, name: c.from, role: '' };
      return h('li', { class: 'hw-comment' }, avatar(m),
        h('div', { class: 'hw-comment-body' },
          h('div', { class: 'hw-comment-head' }, h('b', {}, m.name), h('span', {}, when(c.at)),
            c.from === 'me' ? h('button', { type: 'button', class: 'hw-link', onclick: () => { st.comments = st.comments.filter((x) => x.id !== c.id); onComments([...st.comments]); drawThread(); } }, 'Delete') : null),
          h('p', {}, c.text)));
    }));
    thread.hidden = !st.comments.length;
  }
  box.addEventListener('input', () => { post.disabled = !box.value.trim(); });
  box.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); e.stopPropagation(); send(); } });

  draw(); drawThread();
  const wrap = shell({ title: 'Tags and comments', cls: 'notes', onClose, body: [
    h('div', { class: 'hw-assign-card' }, h('span', { class: 'hw-assign-thumb' }, thumb), h('span', {}, h('em', {}, card.eyebrow ?? ''), h('b', {}, card.title))),
    h('section', { class: 'hw-notes-sec' }, h('h5', { class: 'hw-notes-k' }, 'Tags'), set,
      h('div', { class: 'hw-tag-find' }, input, list), quick),
    h('section', { class: 'hw-notes-sec' }, head, thread,
      h('div', { class: 'hw-comment-new' }, box, h('div', { class: 'hw-comment-go' }, h('span', { class: 'hw-modal-note' }, '⌘ Enter to post'), post))),
    h('div', { class: 'hw-sheet-actions hw-notes-go' }, h('button', { type: 'button', class: 'hw-btn primary', onclick: onClose }, 'Done')),
  ] });
  setTimeout(() => { thread.scrollTop = thread.scrollHeight; (start === 'comments' ? box : input).focus({ preventScroll: start !== 'comments' }); }, 0);
  return wrap;
}

// Every tag you have used, with how many of this week's cards carry it. Pick one to go through those cards.
export function tagsModal({ rows, onView, onClose }) {
  let q = '';
  const list = h('ul', { class: 'hw-people hw-tag-list' });
  const input = h('input', { type: 'search', class: 'hw-people-q', placeholder: 'Search your tags', 'aria-label': 'Search your tags', autocomplete: 'off' });
  const draw = () => {
    const shown = rows.filter((r) => r.name.toLowerCase().includes(q.toLowerCase()));
    list.replaceChildren(...(shown.length ? shown.map((r) => h('li', { class: r.n ? '' : 'none' },
      h('button', { type: 'button', class: 'hw-tag-row-btn', disabled: !r.n, onclick: () => onView(r.name) },
        tagChip(r.name),
        h('span', { class: 'hw-tag-uses' }, r.n ? `${r.n} card${r.n === 1 ? '' : 's'} this week` : 'None this week'),
        r.n ? h('span', { class: 'hw-people-go' }, 'See cards') : null)))
      : [h('li', { class: 'hw-quiet' }, 'No tag matches.')]));
  };
  input.addEventListener('input', () => { q = input.value; draw(); });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { const r = rows.find((x) => x.n && x.name.toLowerCase().includes(q.toLowerCase())); if (r) onView(r.name); } });
  draw();
  const wrap = shell({ title: `Your tags · ${rows.length}`, cls: 'tags', onClose, body: [
    input, list,
    h('p', { class: 'hw-modal-note' }, 'Add tags from the 🏷 button on any card.'),
  ] });
  setTimeout(() => input.focus({ preventScroll: true }), 0);
  return wrap;
}
