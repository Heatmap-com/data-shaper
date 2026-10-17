import { deviceName, refererName, returningName } from '../adapters/_lib/dims.js';
import { TIME_ON_PAGE_CAP_MS } from '../adapters/_lib/sql.js';
import { pageType } from '../page-type.js';
import { atStride, PROGRESS_STRIDE, progressEvery } from './progress.js';
import { parseVisitTime } from './time.js';

/**
 * Session facts the predicates read. Pageviews are distinct idsitehsr values.
 * Scroll arrives on the warehouse scale (0–1000) and is stored here as a
 * percent. Duration is the sum of per-page time, each page capped at
 * TIME_ON_PAGE_CAP_MS, in seconds.
 *
 * `fields` holds the registered segmentation fields a trigger session can
 * fill, typed as the trend column map types them, so a declared
 * segmentation's classifier gives the value its SQL gives.
 *
 * @param {object} args
 * @param {object[]} args.visits
 * @param {object[]} [args.pageviews] one row per pageview or per (visit, hsr)
 * @param {object[]} [args.clicks] `{idvisit, clicks}` or one row per click
 * @param {object[]} [args.events] `{idvisit, eventType}`
 * @param {object[]} [args.orders] `{idvisit, orders, revenue}`
 * @param {Map<string, string> | object[]} [args.tags] session_tags JSON by idvisit
 * @param {Map<string, string | {url: string}>} [args.urls] idsitehsr → url
 * @param {(fields: object) => void} [args.onProgress]
 */
export function assembleSessions({
  visits,
  pageviews = [],
  clicks = [],
  events = [],
  orders = [],
  tags = new Map(),
  urls = new Map(),
  onProgress,
}) {
  const tick = progressEvery(onProgress);
  const pages = new Map();
  let pageN = 0;
  tick({ phase: 'assemble-pageviews', done: 0, total: pageviews.length }, true);
  for (const row of pageviews) {
    pageN += 1;
    if (atStride(pageN, PROGRESS_STRIDE)) {
      tick({ phase: 'assemble-pageviews', done: pageN, total: pageviews.length });
    }
    const idvisit = String(row.idvisit);
    let perVisit = pages.get(idvisit);
    if (!perVisit) {
      perVisit = new Map();
      pages.set(idvisit, perVisit);
    }
    const hsr = String(row.hsr ?? '');
    let cell = perVisit.get(hsr);
    if (!cell) {
      cell = { scrollMax: 0, cappedMs: 0 };
      perVisit.set(hsr, cell);
    }
    cell.scrollMax = Math.max(cell.scrollMax, Number(row.scrollMax) || 0);
    const rawMs = Number(row.timeOnPageMs ?? row.cappedMs) || 0;
    cell.cappedMs += row.cappedMs != null && row.timeOnPageMs == null
      ? rawMs
      : Math.min(rawMs, TIME_ON_PAGE_CAP_MS);
  }
  tick({ phase: 'assemble-pageviews', done: pageviews.length, total: pageviews.length }, true);

  /** @type {Map<string, number>} */
  const clickCount = new Map();
  for (const row of clicks) {
    const idvisit = String(row.idvisit);
    const n = row.clicks == null ? 1 : Number(row.clicks) || 0;
    clickCount.set(idvisit, (clickCount.get(idvisit) ?? 0) + n);
  }

  /** @type {Map<string, Set<string>>} */
  const eventSets = new Map();
  for (const row of events) {
    const idvisit = String(row.idvisit);
    let set = eventSets.get(idvisit);
    if (!set) {
      set = new Set();
      eventSets.set(idvisit, set);
    }
    if (row.eventType) set.add(String(row.eventType));
  }

  /** @type {Map<string, {orders: number, revenue: number}>} */
  const orderByVisit = new Map();
  for (const row of orders) {
    orderByVisit.set(String(row.idvisit), {
      orders: Number(row.orders) || 0,
      revenue: Number(row.revenue) || 0,
    });
  }

  const tagMap = tags instanceof Map
    ? tags
    : new Map(tags.map((row) => [String(row.idvisit), String(row.tags ?? '')]));

  tick({ phase: 'assemble-sessions', done: 0, total: visits.length }, true);
  const assembled = visits.map((visit, index) => {
    if (atStride(index + 1, PROGRESS_STRIDE)) {
      tick({ phase: 'assemble-sessions', done: index + 1, total: visits.length });
    }
    const idvisit = String(visit.idvisit);
    const perPage = pages.get(idvisit) ?? new Map();
    let scrollMax = 0;
    let cappedMs = 0;
    /** @type {string[]} */
    const productPages = [];
    for (const [hsr, cell] of perPage) {
      scrollMax = Math.max(scrollMax, cell.scrollMax);
      cappedMs += cell.cappedMs;
      if (pageType(urlOf(urls, hsr)) === 'product') productPages.push(hsr);
    }
    const entryUrl = urlOf(urls, visit.entryHsr ?? visit.entry_hsr);
    const order = orderByVisit.get(idvisit);
    const started = visit.startedAt != null && typeof visit.startedAt === 'number'
      ? visit.startedAt
      : parseVisitTime(visit.startedAt ?? visit.started_at);
    const source = String(visit.utmSource ?? visit.utm_source ?? visit.source ?? '');
    const returning = visit.returning === 'new' || visit.returning === 'returning'
      ? visit.returning
      : returningName(Number(visit.returning));
    const orders = order?.orders ?? (Number(visit.orders) || 0);
    const referer = String(visit.refererName ?? visit.referer_name ?? '').toLowerCase();
    return {
      idsite: visit.idsite,
      idvisit,
      configId: String(visit.configId ?? visit.config_id ?? ''),
      serverDate: String(visit.serverDate ?? visit.server_date).slice(0, 10),
      startedAt: started,
      device: typeof visit.device === 'number' || /^\d+$/.test(String(visit.device ?? ''))
        ? deviceName(Number(visit.device))
        : String(visit.device ?? ''),
      channel: visit.referer != null
        ? refererName(Number(visit.referer))
        : String(visit.channel ?? ''),
      source,
      medium: mediumOf(tagMap.get(idvisit)),
      returning,
      country: String(visit.country ?? ''),
      landingPage: entryUrl,
      entryTemplate: pageType(entryUrl),
      events: [...(eventSets.get(idvisit) ?? [])],
      orders,
      revenue: order?.revenue ?? (Number(visit.revenue) || 0),
      pageviews: perPage.size,
      clicks: clickCount.get(idvisit) ?? 0,
      scrollPct: scrollMax / 10,
      durationSec: cappedMs / 1000,
      productPages,
      fields: {
        referer_type: Number(visit.referer) || 0,
        referer_name: referer,
        utm_source: source,
        source_or_referrer: source !== '' ? source : referer,
        utm_medium: String(visit.utmMedium ?? visit.utm_medium ?? ''),
        utm_campaign: String(visit.utmCampaign ?? visit.utm_campaign ?? ''),
        returning: returning === 'returning' ? 1 : 0,
        country: String(visit.country ?? ''),
        has_order: orders > 0 ? 1 : 0,
      },
    };
  });
  tick({ phase: 'assemble-sessions', done: visits.length, total: visits.length }, true);
  return assembled;
}

/**
 * Sessions from loadTriggerFacts output: the fact window's rows plus the
 * prior purchase sessions.
 * @param {Awaited<ReturnType<typeof import('./load.js').loadTriggerFacts>>} loaded
 * @param {(fields: object) => void} [onProgress]
 */
export function assembleLoaded(loaded, onProgress) {
  return assembleSessions({
    visits: [...loaded.visits, ...loaded.prior.visits],
    pageviews: loaded.pageviews.map((row) => ({
      idvisit: row.idvisit,
      hsr: row.hsr,
      scrollMax: Number(row.scroll_max),
      cappedMs: Number(row.capped_ms),
    })),
    clicks: loaded.clicks.map((row) => ({ idvisit: row.idvisit, clicks: Number(row.clicks) })),
    events: [...loaded.events, ...loaded.prior.events].map((row) => ({
      idvisit: row.idvisit,
      eventType: row.event_type,
    })),
    orders: [...loaded.orders, ...loaded.prior.orders].map((row) => ({
      idvisit: row.idvisit,
      orders: Number(row.orders),
      revenue: Number(row.revenue),
    })),
    tags: new Map(loaded.tags.map((row) => [String(row.idvisit), String(row.session_tags ?? '')])),
    urls: loaded.urls,
    onProgress,
  });
}

/**
 * @param {Map<string, string | {url: string}>} urls
 * @param {unknown} hsr
 */
function urlOf(urls, hsr) {
  if (hsr == null || hsr === '') return '';
  const found = urls.get(String(hsr));
  if (!found) return '';
  return typeof found === 'string' ? found : String(found.url ?? '');
}

/** @param {string | undefined} raw */
function mediumOf(raw) {
  if (!raw) return '';
  try {
    const json = JSON.parse(raw);
    for (const [key, value] of Object.entries(json)) {
      if (/medium/i.test(key) && value != null && String(value) !== '') return String(value);
    }
  } catch {
    return '';
  }
  return '';
}
