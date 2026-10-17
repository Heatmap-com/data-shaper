#!/usr/bin/env node
// Writes names/<slug>.json: readable placeholder names for every campaign, creative, selector, experiment and arm.
// Deterministic: the same snapshot gives the same file. Reads ../../../data, never writes there.
//
//   node prototype/query-tool/revisions/grok-k3/names/seed.mjs [--site mellow]
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const data = join(here, '..', '..', '..', 'data');

const SITES = {
  mellow: {
    products: ['MarshMellow Comforter', 'Ploof Pillow', 'Puff Pillow', 'CloudAlign Pillow', 'Body Pillow', 'Comforter + CloudAlign Bundle', 'Cloud Cold Comforter', 'Cloud Throw Blanket'],
    angles: ['Like sleeping on a cloud', 'Cool all night', '100-night trial', 'Side-sleeper approved', 'Fluffy without the heat', 'Hotel-bed feel', 'Wake up without neck pain', 'Gift-ready'],
    swatches: ['White', 'Cloud Grey', 'Sage', 'Blush', 'Navy', 'Sand', 'Lavender', 'Charcoal', 'Ivory', 'Mist'],
    sizes: ['Twin', 'Full/Queen', 'King', 'Cal King'],
    cards: {},
    arms: [
      [/SB-046DM/, ['Badge with anchor link', 'Badge with CTA button']],
      [/SB-069DM|SB-062DM/, ['Price −10%', 'Price +10%', 'Price +20%']],
      [/SB-031DM/, ['10-minute timer', 'Static urgency text', 'Timer + static text']],
      [/SB-065DM/, ['Title: Cervical contour', 'Title: Cervical contour + benefit']],
      [/SB-063DM/, ['Title: Side sleepers', 'Title: Side sleepers + pain relief', 'Title: Side sleepers, short']],
      [/SB-061DM/, ['Social proof', 'Value props', 'Social proof + value props']],
      [/SB-059DM/, ['Price −$5', 'Price +$5']],
      [/SB-045DM/, ['Reviews carousel']],
      [/SB-051DM/, ['Objection accordion, open', 'Objection accordion, closed']],
      [/SB-064DM/, ['Title: Shoulder & neck pain', 'Title: Shoulder & neck pain + benefit', 'Title: Shoulder & neck pain, short']],
      [/SB-050DM/, ['Carousel + trust badges', 'Carousel + guarantee']],
      [/SB-060DM/, ['Queen +$10', 'Queen +$20']],
      [/Variant ATC Text V2/, ['Add-to-cart text V2']],
      [/Variant ATC Text/, ['Add-to-cart text with variant']],
      [/SB-058DM/, ['Price +$5', 'Price +$10']],
      [/SB-070DM/, ['Price −10%', 'Price +10%']],
      [/CPAP LP Headline/, ['CPAP headline']],
      [/SB-049DM/, ['Protected-checkout badge', 'Double CTA']],
      [/Control vs Control/, ['Control — copy B']],
      [/SB-072DM/, ['Bounce animation', 'Pulse animation']],
      [/SB-075DM/, ['Price +$4']],
      [/SB-071DM/, ['Shipping $1.99']],
      [/SB-073DM/, ['+5% all sizes', '+10% all sizes', '+10% Queen and King']],
      [/SB-053DM/, ['Badges on colour swatches']],
    ],
    experiments: [],
  },
  'loop-earplugs': {
    products: ['Loop Dream', 'Loop Quiet 2', 'Loop Experience 2', 'Loop Switch 2', 'Loop Engage 2', 'Loop Engage Kids 2', 'Loop Experience Plus', 'Loop Eclipse'],
    angles: ['Sleep through snoring', 'Concert-safe sound', 'Focus mode', 'Kids hearing protection', 'Quiet on the commute', 'Comfortable all night', 'Now in teal', 'Find your Loop'],
    swatches: [],
    sizes: [],
    cards: { 1: 'Loop Dream', 2: 'Loop Switch 2', 3: 'Loop Experience 2', 4: 'Loop Quiet 2', 5: 'Loop Engage 2', 6: 'Loop Engage Kids 2' },
    arms: [],
    experiments: [
      ['Homepage hero: range vs single product', ['Range hero']],
      ['PDP bundle picker layout', ['Stacked bundles']],
      ['Free-shipping progress bar', ['Progress bar']],
      ['Sticky add to cart on mobile', ['Sticky button']],
      ['Size guide placement', ['Size guide by the CTA']],
      ['Reviews above the fold', ['Reviews first']],
      ['Quiz CTA on the homepage', ['Quiz CTA']],
      ['Price anchoring on Experience', ['Anchored price']],
      ['Cart drawer upsell', ['Upsell in drawer']],
      ['Navigation: shop by use case', ['Use-case menu']],
      ['Product video on PDP', ['Video first', 'Video second']],
      ['Trust badges near the CTA', ['Badges under CTA', 'Badges above CTA']],
      ['Exit-intent offer', ['10% exit offer']],
      ['Collection grid density', ['Three per row']],
    ],
  },
};

const PLATFORM = [
  [/^(facebook|fb|meta)$/i, 'Meta'], [/^(ig|instagram)$/i, 'Instagram'], [/^google/i, 'Google'], [/^bing/i, 'Bing'],
  [/^snapchat/i, 'Snapchat'], [/^tiktok/i, 'TikTok'], [/^pinterest/i, 'Pinterest'], [/^(axon|applovin)$/i, 'AppLovin'],
  [/^klaviyo$/i, 'Email'], [/^(email|attentive|postscript)/i, 'Email'], [/^sms/i, 'SMS'], [/^(cj|impact)$/i, 'Affiliate'],
  [/^chatgpt/i, 'ChatGPT'], [/^packaging$/i, 'Packaging insert'], [/^rokt/i, 'Rokt'], [/^shop_campaigns$/i, 'Shop app'],
];
const platformOf = (src) => PLATFORM.find(([re]) => re.test(String(src ?? '')))?.[1]
  ?? String(src ?? "Other").split(/[|=]/)[0].replace(/[_+-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

const AD_PLATFORMS = new Set(['Meta', 'Instagram', 'Snapchat', 'TikTok', 'Pinterest', 'AppLovin', 'Rokt', 'Shop app', 'ChatGPT']);
const SEARCH_PLATFORMS = new Set(['Google', 'Bing']);
const SEARCH_TYPES = ['Search — brand', 'Search — generic', 'Shopping', 'Performance Max'];
const PUBLISHERS = ['Wirecutter', 'Sleep Foundation', 'Rakuten', 'RetailMeNot', 'Honey', 'Slickdeals', 'Forbes Vetted', 'Mattress Clarity', 'Sleepopolis', 'Business Insider', 'Good Housekeeping', 'Capital One Shopping'];
const PARTNER_THEMES = ['Spring promo', 'Partner feature', 'Newsletter mention', 'Gift guide', 'Launch push', 'Bundle offer'];
const KNOWN_TEXT = { linkinbio: 'Link in bio', link_in_bio: 'Link in bio', 'product-guide': 'Product guide', quiz: 'Quiz' };
const GOALS = ['Prospecting', 'Retargeting', 'Sale', 'Evergreen'];
const AUDIENCES = ['Broad', 'Lookalike 1%', 'Interest: Sleep', 'Past purchasers', 'Site visitors 30d'];
const RETARGET = ['Past purchasers', 'Site visitors 30d'];
const EMAIL_THEMES = ['Welcome series', 'Back in stock', 'Abandoned cart', 'New arrival', 'Sale'];
const FORMATS = ['UGC video', 'Studio video', 'Static', 'Carousel'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function hash(s) {
  let h = 2166136261;
  for (const ch of String(s)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
const pick = (list, key, salt = '') => list[hash(`${salt}${key}`) % list.length];

function load(slug, file) {
  const path = join(data, 'sites', slug, file);
  if (!existsSync(path)) return [];
  const j = JSON.parse(readFileSync(path, 'utf8'));
  return j.rows.map((r) => Object.fromEntries(j.columns.map((c, i) => [c, r[i]])));
}

const idLike = (s) => /\d{8,}|^[0-9a-f]{8}-[0-9a-f]{4}-|[0-9a-f]{16,}/i.test(String(s));
const tidy = (s) => String(s).replace(/[_+]+/g, ' ').replace(/\s+/g, ' ').trim();

function unique(entries) {
  const seen = new Map();
  for (const e of entries) {
    const n = seen.get(e.name) ?? 0;
    seen.set(e.name, n + 1);
    if (n) e.name = `${e.name} ${String(n + 1).padStart(2, '0')}`;
  }
}

// ---------- campaigns ----------

function codedCampaign(text, platform) {
  if (/^AUTO_/i.test(text)) {
    const words = text.replace(/^AUTO_/i, '').split('_').filter((t) => !/^(EU|US|UK|email\d*|v\d+)$/i.test(t));
    const region = text.match(/_(EU|US|UK)_/i)?.[1];
    return `Email flow · ${tidy(words.slice(0, 3).join(' ')).toLowerCase().replace(/^\w/, (c) => c.toUpperCase())}${region ? ` · ${region.toUpperCase()}` : ''}`;
  }
  const t = text.split('_');
  const bits = [platform];
  if (/^[A-Z]{2}$/.test(t[0])) bits.push(t[0]);
  const stage = text.match(/(?:^|_)(TOF|MOF|BOF)(?:_|$)/)?.[1];
  if (stage) bits.push({ TOF: 'Prospecting', MOF: 'Consideration', BOF: 'Retargeting' }[stage]);
  const theme = text.match(/Consolidated([A-Za-z]+?)(?:BOF)?(?:Marketing)?Campaign/)?.[1];
  if (theme && !/^Marketing$/i.test(theme)) bits.push(theme.length <= 5 ? theme.toUpperCase() : theme);
  if (/Sale/.test(text)) bits.push('Sale');
  const product = t[t.length - 1];
  if (product && /^[A-Za-z]+$/.test(product) && !bits.includes(product) && !/^(None|Sale)$/i.test(product)) bits.push(product);
  return bits.length > 2 ? bits.join(' · ') : `${platform} · ${tidy(text).slice(0, 36)}`;
}

function nameCampaigns(slug, cfg) {
  const rows = load(slug, 'weekly_source_campaign.json').filter((r) => r.camp !== null && r.camp !== undefined && r.camp !== '');
  const by = new Map();
  for (const r of rows) {
    const k = String(r.camp);
    const e = by.get(k) ?? { key: k, src: r.src, visits: 0, first: r.week };
    e.visits += Number(r.visits) || 0;
    if (r.week < e.first) e.first = r.week;
    by.set(k, e);
  }
  const list = [...by.values()].sort((a, b) => b.visits - a.visits || a.key.localeCompare(b.key));
  let rank = 0;
  for (const e of list) {
    const platform = platformOf(e.src);
    if (!idLike(e.key)) {
      const text = e.key;
      const coded = /(^|_)(TOF|MOF|BOF)(_|$)|^AUTO_|_CBO|Consolidated/.test(text) || (text.includes('_') && text.length > 28);
      const plain = KNOWN_TEXT[text] ?? cap(tidy(text));
      e.name = coded ? codedCampaign(text, platform) : (plain.toLowerCase().includes(platform.toLowerCase()) ? plain : `${platform} · ${plain}`);
      continue;
    }
    if (platform === 'Email' || platform === 'SMS') {
      e.name = `${platform} · ${pick(EMAIL_THEMES, e.key)} · ${MONTHS[Number(e.first.slice(5, 7)) - 1]}`;
      continue;
    }
    if (platform === 'Affiliate' || /affiliate|rakuten|awin|partnerize/i.test(String(e.src))) {
      e.name = `Affiliate · ${pick(PUBLISHERS, e.key, 'p')}`;
      continue;
    }
    const product = cfg.products[rank % cfg.products.length];
    if (SEARCH_PLATFORMS.has(platform)) {
      rank += 1;
      e.name = `${platform} · ${pick(SEARCH_TYPES, e.key, 's')} · ${product}`;
      continue;
    }
    if (!AD_PLATFORMS.has(platform)) {
      e.name = `${platform} · ${pick(PARTNER_THEMES, e.key, 't')}`;
      continue;
    }
    rank += 1;
    const goal = pick(GOALS, e.key, 'g');
    const audience = goal === 'Retargeting' ? pick(RETARGET, e.key, 'a') : pick(AUDIENCES.filter((a) => !RETARGET.includes(a)), e.key, 'a');
    e.name = `${platform} · ${goal} · ${product} · ${audience}`;
  }
  unique(list);
  return Object.fromEntries(list.map((e) => [e.key, { name: e.name, placeholder: true }]));
}

// ---------- creatives ----------

function codedCreative(text) {
  const format = text.match(/_(static|video|carousel|ugc)_/i)?.[1];
  const copy = text.match(/SingleCopy-([A-Za-z]+)/)?.[1] ?? text.match(/Copy-([A-Za-z]+)/)?.[1];
  const lp = text.match(/LP-([A-Za-z]+(?:-[A-Za-z]+)?)/)?.[1];
  const version = text.match(/-v(\d+)_/)?.[1];
  if (!format && !copy && !lp) return null;
  const f = format ? format[0].toUpperCase() + format.slice(1).toLowerCase() : 'Ad';
  const parts = [copy ? tidy(copy.replace(/([a-z])([A-Z])/g, '$1 $2')) : null, lp ? `${tidy(lp.replace(/-/g, ' '))} page` : null].filter(Boolean);
  return `${f} — ${parts.join(' · ') || 'creative'}${version ? ` v${version}` : ''}`;
}

function nameCreatives(slug, cfg) {
  const rows = load(slug, 'meta_creative_period.json').filter((r) => r.utm_content !== null && r.utm_content !== undefined && r.utm_content !== '');
  const by = new Map();
  for (const r of rows) {
    const k = String(r.utm_content);
    const e = by.get(k) ?? { key: k, visits: 0 };
    e.visits += Number(r.visits) || 0;
    by.set(k, e);
  }
  const list = [...by.values()].sort((a, b) => b.visits - a.visits || a.key.localeCompare(b.key));
  list.forEach((e, i) => {
    const coded = idLike(e.key) ? null : codedCreative(e.key);
    if (coded) { e.name = coded; return; }
    if (!idLike(e.key) && e.key.length <= 40) { e.name = KNOWN_TEXT[e.key] ?? cap(tidy(e.key)); return; }
    const product = cfg.products[i % cfg.products.length];
    e.name = `${pick(FORMATS, e.key, 'f')} — ${pick(cfg.angles, e.key, 'an')} · ${product}`;
  });
  unique(list);
  return Object.fromEntries(list.map((e) => [e.key, { name: e.name, placeholder: true }]));
}

// ---------- selectors ----------

const nth = (seg) => Number(seg?.match(/:nth-child\((\d+)\)/)?.[1] ?? 1);
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function readableLabel(row) {
  let label = row.name ?? row.x_am_label;
  if (!label) return null;
  label = String(label).replace(/\s+/g, ' ').trim();
  const half = label.length / 2;
  if (Number.isInteger(half) && label.slice(0, half).trim() === label.slice(half).trim()) label = label.slice(0, half).trim();
  const words = label.split(' ');
  if (words.length % 2 === 0 && words.slice(0, words.length / 2).join(' ') === words.slice(words.length / 2).join(' ')) label = words.slice(0, words.length / 2).join(' ');
  if (/^cta_\d+$/i.test(label) || /^Button - Color/.test(label)) return null;
  return label.replace(/\s*(product_tile|nav_toggle)$/, '').replace(/ Product Tile /, ' product tile — ').trim();
}

function nameSelector(row, cfg) {
  const sel = String(row.selector ?? '');
  const low = sel.toLowerCase();
  const segs = sel.split(' > ');
  const last = segs[segs.length - 1] ?? '';
  const tag = last.match(/^[a-z]+/i)?.[0]?.toLowerCase() ?? '';
  const seg = (re) => segs.find((s) => re.test(s));

  if (/alia-/.test(low)) {
    const el = tag === 'svg' || /> svg/.test(low) ? 'Close (×)' : tag === 'button' ? 'Button' : tag === 'input' ? 'Email field' : 'Answer option';
    return `Alia popup — ${el}`;
  }
  if (/kaching-bundle/.test(low)) {
    const upsell = /upsell/.test(low);
    const el = tag === 'select' ? (upsell ? 'add-on dropdown' : 'variant dropdown') : tag === 'svg' ? 'add-on checkbox' : upsell ? 'add-on label' : 'option label';
    const barSeg = seg(/kaching-bundles__bar[.:]/);
    const bar = /bar--selected/.test(low) ? 'selected bundle' : barSeg && /nth-child/.test(barSeg) ? `bundle ${nth(barSeg)}` : null;
    return `Bundle picker — ${el}${bar ? ` (${bar})` : ''}`;
  }
  if (/variant-selects|product_variants/.test(low)) {
    const second = /variant-selects:nth-child/.test(sel) ? ' (second item)' : '';
    const opt = seg(/^(input|label)/);
    const shown = opt?.startsWith('label') ? ' (label)' : '';
    if (/--swatch/.test(low)) {
      if (!opt) return `Variant picker — colour row${second}`;
      const idx = Math.floor(nth(opt) / 2) - 1;
      return `Variant picker — colour: ${cfg.swatches[idx] ?? `swatch ${idx + 1}`}${shown}${second}`;
    }
    if (/--pill/.test(low)) {
      if (!opt) return `Variant picker — size row${second}`;
      const idx = Math.floor(nth(opt) / 2) - 1;
      return `Variant picker — size: ${cfg.sizes[idx] ?? `option ${idx + 1}`}${shown}${second}`;
    }
    return `Variant picker — option${second}`;
  }
  if (/variant-swatches|card__content|slider-component/.test(low)) {
    const cardSeg = segs.find((s, i) => /^div:nth-child/.test(s) && segs[i - 1]?.startsWith('div:nth-child(1)') && /slider-component/.test(segs[i - 2] ?? ''));
    const card = cardSeg ? nth(cardSeg) : null;
    const product = card ? cfg.cards[card] ?? `card ${card}` : null;
    if (/slider-button--next/.test(low)) return 'Product carousel — next arrow';
    if (/slider-button--prev/.test(low)) return 'Product carousel — previous arrow';
    if (/variant-swatches/.test(low)) {
      const sw = segs.find((s) => /^div:nth-child/.test(s) && segs[segs.indexOf(s) - 1]?.startsWith('fieldset'));
      return `Product carousel — ${product ?? 'card'}, swatch ${sw ? nth(sw) - 1 : 1}`;
    }
    return `Product carousel — ${product ?? 'card'} tile`;
  }
  if (/main-media|thumb-media|product__media|gallery/.test(low)) {
    if (/swiper-button-next/.test(low)) return 'Product gallery — next arrow';
    if (/swiper-button-prev/.test(low)) return 'Product gallery — previous arrow';
    if (/thumb/.test(low)) return 'Product gallery — thumbnail';
    return 'Product gallery — main image';
  }
  if (/product_buy_buttons|product-form__submit|add-to-cart|addtocart/.test(low)) return 'Buy box — add to cart button';
  if (/hamburger|details-menu-drawer|summary/.test(low) && /menu/.test(low)) return 'Header — open menu';
  if (/main-drawer|menu-drawer/.test(low)) {
    if (/back/.test(low)) return 'Mobile menu — back';
    const li = seg(/^li/);
    const kind = { svg: ' arrow', span: ' label', a: ' link', button: '' }[tag] ?? '';
    return `Mobile menu — item ${li ? nth(li) : 1}${kind}`;
  }
  if (/cart-dialog|cart-drawer|cart-notification/.test(low)) {
    if (/header/.test(low) && /button|svg/.test(tag)) return 'Cart drawer — close';
    const words = contextWords(segs);
    return `Cart drawer — ${words ?? 'item'}`;
  }
  if (/md-modal|md-form|md-btn/.test(low)) {
    if (/language/.test(low)) return 'Market selector — language';
    if (/onsubmit/.test(low)) return 'Market selector — shop now';
    if (/header|button/.test(low)) return 'Market selector — close';
    return 'Market selector — field';
  }
  if (/country-selector|localization/.test(low)) return 'Header — country selector';
  if (/pandectes|cookie|cc-btn|consent/.test(low)) return /allow|accept/.test(low) ? 'Cookie banner — accept' : 'Cookie banner — button';
  if (/engagement-toast|toast/.test(low)) return 'Toast — close';
  if (/card-cover/.test(low)) return 'Scratch card — cover';
  const region = /header/.test(low) ? 'Header' : /footer/.test(low) ? 'Footer' : /swiper|carousel|slideshow/.test(low) ? 'Carousel' : /dialog|modal/.test(low) ? 'Popup' : null;
  const el = { button: 'button', a: 'link', img: 'image', input: 'input', svg: 'icon', select: 'dropdown', label: 'label', p: 'text', span: 'text', h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading', li: 'list item', iframe: 'embed', video: 'video' }[tag] ?? 'element';
  const words = contextWords(segs);
  if (words) return `${region ? `${region} — ` : ''}${words} ${el}`.replace(/^(\w)/, (c) => c.toUpperCase());
  return `${region ?? 'Page'} — ${el}`;
}

const GENERIC = new Set(['div', 'wrapper', 'inner', 'container', 'block', 'js', 'shopify', 'section', 'main', 'content', 'mainc', 'grid', 'row', 'col', 'column', 'flex', 'item', 'items', 'el', 'element', 'box', 'holder', 'outer', 'page', 'width', 'template', 'app', 'no', 'hidden', 'default', 'is', 'active', 'visible', 'fully', 'swiper', 'slide', 'component', 'icon', 'svg', 'btn', 'button', 'link', 'text', 'title', 'label', 'img', 'image', 'media', 'wfe', 'gp', 'pf', 'tw', 'md', 'lg', 'sm', 'xs']);
function contextWords(segs) {
  for (let i = segs.length - 1; i >= 0; i -= 1) {
    const tokens = [...segs[i].matchAll(/[.#]([A-Za-z][\w-]*)/g)].map((m) => m[1]).filter((t) => !/\d{3,}|[A-Za-z]*\d+[A-Za-z]+\d/.test(t) && t.length <= 40 && !/^shopify-block|^shopify-section-template/i.test(t));
    for (const t of tokens.reverse()) {
      const words = t.replace(/([a-z])([A-Z])/g, '$1 $2').split(/[-_\s]+/).map((w) => w.toLowerCase()).filter((w) => w && !GENERIC.has(w) && w.length > 1);
      if (words.length) return [...new Set(words)].slice(0, 3).join(' ');
    }
  }
  return null;
}

function nameSelectors(slug, cfg, hand) {
  const rows = load(slug, 'selector-weekly.json');
  const by = new Map();
  for (const r of rows) {
    const k = String(r.selector_id);
    const e = by.get(k) ?? { key: k, row: r, clicks: 0, mobile: 0 };
    e.clicks += Number(r.m_clicks) || 0;
    if (r.dim_device === 'mobile') e.mobile += Number(r.m_clicks) || 0;
    if (!e.row.name && r.name) e.row = { ...e.row, name: r.name };
    if (!e.row.x_am_label && r.x_am_label) e.row = { ...e.row, x_am_label: r.x_am_label };
    by.set(k, e);
  }
  const list = [...by.values()].sort((a, b) => b.clicks - a.clicks || a.key.localeCompare(b.key));
  for (const e of list) {
    if (hand[e.key]) { e.name = hand[e.key]; e.placeholder = true; continue; }
    const real = readableLabel(e.row);
    if (real) { e.name = real; e.placeholder = false; continue; }
    e.name = nameSelector(e.row, cfg);
    e.placeholder = true;
  }
  unique(list);
  return Object.fromEntries(list.map((e) => [e.key, { name: e.name, placeholder: e.placeholder }]));
}

// ---------- experiments and arms ----------

const UUIDISH = /^[0-9a-f]{8}-[0-9a-f]{4}-/i;

function nameExperiments(slug, cfg) {
  const rows = load(slug, 'experiment_rows.json');
  const exps = new Map();
  for (const r of rows) {
    const e = exps.get(r.experiment_key) ?? { key: r.experiment_key, name: r.experiment, sessions: 0, arms: new Map() };
    if (r.basis === 'assigned' && r.viewport_type === 'all') e.sessions += Number(r.sessions) || 0;
    e.arms.set(r.arm, Boolean(r.is_control));
    exps.set(r.experiment_key, e);
  }
  const list = [...exps.values()].sort((a, b) => b.sessions - a.sessions || a.key.localeCompare(b.key));
  const experiment = {};
  const arm = {};
  let invented = 0;
  for (const e of list) {
    let display = e.name;
    let variants = cfg.arms.find(([re]) => re.test(e.name))?.[1] ?? null;
    if (UUIDISH.test(e.name) || /^Variation \d+$/i.test(e.name)) {
      const [name, vs] = cfg.experiments[invented % Math.max(1, cfg.experiments.length)] ?? [`Test ${invented + 1}`, []];
      invented += 1;
      display = name;
      variants = vs;
      experiment[e.name] = { name, placeholder: true };
    }
    const keys = [...e.arms.keys()].sort();
    let v = 0;
    for (const k of keys) {
      const label = e.arms.get(k) ? 'Control — current' : variants?.[v] ?? `Variant ${String.fromCharCode(66 + v)}`;
      if (!e.arms.get(k)) v += 1;
      arm[`${e.key}|${k}`] = { name: label, placeholder: true };
    }
    e.display = display;
  }
  return { experiment, arm };
}

// ---------- main ----------

function seed(slug) {
  const cfg = SITES[slug] ?? { ...SITES.mellow, cards: {}, arms: [], experiments: [] };
  const handFile = join(here, 'hand', `${slug}.json`);
  const hand = existsSync(handFile) ? JSON.parse(readFileSync(handFile, 'utf8')) : {};
  const { experiment, arm } = nameExperiments(slug, cfg);
  const out = {
    _note: 'Prototype placeholder names. Real names will come from the naming feature.',
    campaign: nameCampaigns(slug, cfg),
    creative: nameCreatives(slug, cfg),
    selector: nameSelectors(slug, cfg, hand.selector ?? {}),
    experiment,
    experiment_arm: arm,
    page: {},
    changes: [],
  };
  writeFileSync(join(here, `${slug}.json`), `${JSON.stringify(out, null, 1)}\n`);
  const counts = Object.fromEntries(Object.entries(out).filter(([, v]) => v && typeof v === 'object' && !Array.isArray(v)).map(([k, v]) => [k, Object.keys(v).length]));
  console.log(`${slug}: ${JSON.stringify(counts)}`);
}

const argv = process.argv.slice(2);
const only = argv[argv.indexOf('--site') + 1];
const sites = JSON.parse(readFileSync(join(data, 'sites.json'), 'utf8')).map((s) => s.slug);
for (const slug of argv.includes('--site') ? [only] : sites) seed(slug);
