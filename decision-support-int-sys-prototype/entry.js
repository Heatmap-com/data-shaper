const $ = (sel) => document.querySelector(sel);

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

function readSite() {
  return new URLSearchParams(location.hash.slice(1)).get('site');
}

function render(registry, sites, slug) {
  const site = sites.find((s) => s.slug === slug) ?? sites[0];
  $('#title').textContent = registry.title;
  document.title = registry.title;
  $('#intro').textContent = registry.intro;
  $('#site-select').replaceChildren(...sites.map((s) => h('option', { value: s.slug, selected: s.slug === site.slug ? 'selected' : null }, s.name)));
  $('#cards').replaceChildren(...registry.revisions.map((rev) => h('article', { class: 'rev-card' },
    h('div', { class: 'rev-head' },
      h('div', {},
        h('h2', { class: 'rev-name' }, rev.name),
        h('div', { class: 'rev-date' }, rev.date)),
      h('span', { class: `pill ${rev.status}` }, rev.status)),
    h('p', { class: 'summary' }, rev.summary),
    rev.changes?.length ? h('ul', { class: 'changes' }, rev.changes.map((c) => h('li', {}, c))) : null,
    h('p', { class: 'basis' }, `Based on: ${rev.basis}`),
    h('a', { class: 'open', href: `revisions/${rev.id}/#site=${site.slug}` }, 'Open'))));
  const stamps = sites.map((s) => `${s.name} snapshot ${new Date(s.generatedAt).toLocaleString()}`);
  $('#footer').textContent = stamps.join(' · ');
}

async function init() {
  if (location.hash.includes('tab=')) {
    location.replace(`revisions/quick-concept/${location.hash}`);
    return;
  }
  const [registry, sites] = await Promise.all([
    fetch('revisions.json', { cache: 'no-store' }).then((r) => r.json()),
    fetch('data/sites.json', { cache: 'no-store' }).then((r) => r.json()),
  ]);
  const pick = () => {
    const wanted = readSite();
    return sites.some((s) => s.slug === wanted) ? wanted : sites[0].slug;
  };
  render(registry, sites, pick());
  $('#site-select').addEventListener('change', (e) => {
    history.replaceState(null, '', `#site=${e.target.value}`);
    render(registry, sites, e.target.value);
  });
}

init().catch((err) => {
  document.body.append(h('pre', { class: 'blocked' }, String(err.stack ?? err)));
});
