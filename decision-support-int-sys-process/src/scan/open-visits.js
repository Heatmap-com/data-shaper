import { dayDiff } from '../triggers/time.js';

/**
 * @typedef {object} ScanVisit one visit merged across the days read so far
 * @property {string} idvisit
 * @property {string} firstDate the first day with a visit row (min server_date of the visit rows)
 * @property {string} lastDay the last day with any fact
 * @property {boolean} hasVisit
 * @property {string} startedAt
 * @property {string} configId
 * @property {number} device
 * @property {number} referer
 * @property {number} returning
 * @property {string} country
 * @property {string} browser
 * @property {string} entryHsr
 * @property {string} utmSource
 * @property {string} refererName
 * @property {string} utmMedium
 * @property {string} utmCampaign
 * @property {string} tagUtmSource the first utm_source session tag, by day
 * @property {string} tagUtmMedium
 * @property {string} tagUtmCampaign
 * @property {Record<string, string>} tagUtmDays the day each tag UTM came from
 * @property {string} fpHash
 * @property {number} pageviewRows
 * @property {Set<string>} hsrs
 * @property {number} cappedMs
 * @property {number} scrollMax
 * @property {Array<[string, string, string]>} firstPages the visit's first two pageviews by (server time, idloghsr)
 * @property {Map<string, {scrollMax: number, landingPageviews: number, pageCappedMs: number}>} pageFacts per chosen page
 * @property {Set<string>} events
 * @property {Map<string, number>} orders idorder → revenue, first day seen wins
 * @property {number} clicks
 * @property {string} tags the first non-empty tag JSON
 * @property {Set<string>} arms A/B arm keys (see armKey in day-record.js)
 */

const VISIT_FIELDS = ['startedAt', 'configId', 'device', 'referer', 'returning', 'country', 'browser', 'entryHsr', 'utmSource', 'refererName', 'utmMedium', 'utmCampaign', 'fpHash'];
const TAG_UTM_FIELDS = ['tagUtmSource', 'tagUtmMedium', 'tagUtmCampaign'];

/**
 * Visits that have rows on the days read so far and have not closed. Days
 * arrive oldest first. Sums add, maxima take the max, sets union, and orders
 * dedupe by idorder. The visit fields come from the day whose earliest row
 * started first, matching argMin over the window.
 *
 * A visit closes once `hold` days pass with no row for it. Visit ids closed
 * in the last `lateDays` days are kept so a later row for one is dropped
 * and counted rather than opening a second visit.
 *
 * `ahead` holds the spread visits, whose days are further apart than
 * `hold`, with every row and page fact they have on this lane's days. The
 * first row of one opens it from all of them, so it closes whole on the
 * usual hold; its rows on later days are counted and skipped.
 *
 * @param {{hold?: number, lateDays?: number, ahead?: Map<string, {rows: import('./day-record.js').DayRow[], facts: object[]}>}} [opts]
 */
export function createOpenVisits({ hold = 1, lateDays = 3, ahead = new Map() } = {}) {
  /** @type {Map<string, ScanVisit>} */
  const open = new Map();
  /** @type {Map<string, Set<string>>} close day → ids closed that day */
  const recent = new Map();
  /** @type {Set<string>} spread visits already opened from their rows ahead */
  const merged = new Set();
  const stats = { rows: 0, lateRows: 0, closed: 0, orphans: 0, peakOpen: 0, spread: 0, spreadRows: 0 };

  /** @param {string} idvisit @param {string} day */
  function openAhead(idvisit, day) {
    const { rows, facts } = ahead.get(idvisit);
    const visit = fresh(rows[0]);
    for (const row of rows.slice(1)) merge(visit, row);
    for (const fact of facts) addFact(visit, fact);
    visit.lastDay = day;
    open.set(idvisit, visit);
    merged.add(idvisit);
    stats.spread += 1;
  }

  const recentlyClosed = (idvisit) => {
    for (const ids of recent.values()) if (ids.has(idvisit)) return true;
    return false;
  };

  /** @param {Iterable<import('./day-record.js').DayRow>} rows */
  function add(rows) {
    for (const row of rows) {
      stats.rows += 1;
      if (merged.has(row.idvisit)) {
        stats.spreadRows += 1;
        continue;
      }
      if (ahead.has(row.idvisit)) {
        openAhead(row.idvisit, row.day);
        continue;
      }
      const current = open.get(row.idvisit);
      if (!current) {
        if (recentlyClosed(row.idvisit)) {
          stats.lateRows += 1;
          continue;
        }
        open.set(row.idvisit, fresh(row));
        continue;
      }
      merge(current, row);
    }
    stats.peakOpen = Math.max(stats.peakOpen, open.size);
  }

  /**
   * Merges a day's per-page facts into the open visits they belong to. The
   * day's visit rows were added first, so every pageview's visit is open.
   * @param {Iterable<ReturnType<typeof import('./day-record.js').parsePageFact>>} facts
   */
  function addPageFacts(facts) {
    for (const fact of facts) {
      const visit = open.get(fact.idvisit);
      if (!visit || merged.has(fact.idvisit)) continue;
      addFact(visit, fact);
    }
  }

  /**
   * Closes the visits quiet for `hold` days as of `day`, the last day read.
   * @param {string} day
   * @returns {ScanVisit[]}
   */
  function closeQuiet(day) {
    const closed = [];
    for (const visit of open.values()) {
      if (dayDiff(day, visit.lastDay) >= hold) closed.push(visit);
    }
    return finish(closed, day);
  }

  /** Closes every open visit. @param {string} day */
  function closeAll(day) {
    return finish([...open.values()], day);
  }

  /** @param {ScanVisit[]} closed @param {string} day */
  function finish(closed, day) {
    const ids = recent.get(day) ?? new Set();
    const kept = [];
    for (const visit of closed) {
      open.delete(visit.idvisit);
      ids.add(visit.idvisit);
      if (!visit.hasVisit) {
        stats.orphans += 1;
        continue;
      }
      kept.push(visit);
    }
    recent.set(day, ids);
    for (const closedOn of [...recent.keys()]) {
      if (dayDiff(day, closedOn) > lateDays) recent.delete(closedOn);
    }
    stats.closed += kept.length;
    return kept;
  }

  /**
   * The earliest day an open visit was first seen, or null when none are
   * open. A day before it has no open visit and is complete.
   */
  function earliestOpen() {
    let earliest = null;
    for (const visit of open.values()) {
      const first = visit.firstDate || visit.lastDay;
      if (earliest === null || first < earliest) earliest = first;
    }
    return earliest;
  }

  /** The open visits, the recently closed ids, the spread visits opened, and the counts, for a day cursor. */
  function snapshot() {
    return { open, recent, merged, stats };
  }

  /** @param {ReturnType<typeof snapshot>} saved */
  function restore(saved) {
    open.clear();
    for (const [idvisit, visit] of saved.open) open.set(idvisit, visit);
    recent.clear();
    for (const [day, ids] of saved.recent) recent.set(day, ids);
    merged.clear();
    for (const idvisit of saved.merged) merged.add(idvisit);
    Object.assign(stats, saved.stats);
  }

  return { add, addPageFacts, closeQuiet, closeAll, earliestOpen, snapshot, restore, stats: () => ({ ...stats, open: open.size }) };
}

/** @param {import('./day-record.js').DayRow} row @returns {ScanVisit} */
function fresh(row) {
  return {
    idvisit: row.idvisit,
    firstDate: row.hasVisit ? row.day : '',
    lastDay: row.day,
    hasVisit: row.hasVisit,
    startedAt: row.startedAt,
    configId: row.configId,
    device: row.device,
    referer: row.referer,
    returning: row.returning,
    country: row.country,
    browser: row.browser,
    entryHsr: row.entryHsr,
    utmSource: row.utmSource,
    refererName: row.refererName,
    utmMedium: row.utmMedium,
    utmCampaign: row.utmCampaign,
    tagUtmSource: row.tagUtmSource,
    tagUtmMedium: row.tagUtmMedium,
    tagUtmCampaign: row.tagUtmCampaign,
    tagUtmDays: Object.fromEntries(TAG_UTM_FIELDS.map((field) => [field, row[field] ? row.day : ''])),
    fpHash: row.fpHash,
    pageviewRows: row.pageviewRows,
    hsrs: new Set(row.hsrs),
    cappedMs: row.cappedMs,
    scrollMax: row.scrollMax,
    firstPages: row.firstPages,
    pageFacts: new Map(),
    events: new Set(row.events),
    orders: new Map(row.orders),
    clicks: row.clicks,
    tags: row.tags,
    arms: new Set(row.arms),
  };
}

/** @param {ScanVisit} visit @param {ReturnType<typeof import('./day-record.js').parsePageFact>} fact */
function addFact(visit, fact) {
  const cell = visit.pageFacts.get(fact.hsr);
  if (!cell) {
    visit.pageFacts.set(fact.hsr, {
      scrollMax: fact.scrollMax,
      landingPageviews: fact.landingPageviews,
      pageCappedMs: fact.pageCappedMs,
    });
    return;
  }
  cell.scrollMax = Math.max(cell.scrollMax, fact.scrollMax);
  cell.landingPageviews += fact.landingPageviews;
  cell.pageCappedMs += fact.pageCappedMs;
}

/**
 * Pageview order: server time, then idloghsr as a number.
 * @param {[string, string, string]} a @param {[string, string, string]} b
 */
function byPageOrder(a, b) {
  if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
  const left = BigInt(a[1] || '0');
  const right = BigInt(b[1] || '0');
  return left < right ? -1 : left > right ? 1 : 0;
}

/** @param {ScanVisit} visit @param {import('./day-record.js').DayRow} row */
function merge(visit, row) {
  visit.lastDay = row.day > visit.lastDay ? row.day : visit.lastDay;
  if (row.hasVisit) {
    if (!visit.hasVisit || row.startedAt < visit.startedAt) {
      for (const field of VISIT_FIELDS) visit[field] = row[field];
    }
    if (!visit.firstDate || row.day < visit.firstDate) visit.firstDate = row.day;
    visit.hasVisit = true;
  }
  visit.pageviewRows += row.pageviewRows;
  for (const hsr of row.hsrs) visit.hsrs.add(hsr);
  visit.cappedMs += row.cappedMs;
  visit.scrollMax = Math.max(visit.scrollMax, row.scrollMax);
  if (row.firstPages.length > 0) {
    visit.firstPages = [...visit.firstPages, ...row.firstPages].sort(byPageOrder).slice(0, 2);
  }
  for (const event of row.events) visit.events.add(event);
  for (const [idorder, revenue] of row.orders) {
    if (!visit.orders.has(idorder)) visit.orders.set(idorder, revenue);
  }
  visit.clicks += row.clicks;
  if (!visit.tags && row.tags) visit.tags = row.tags;
  for (const field of TAG_UTM_FIELDS) {
    if (row[field] && (!visit[field] || row.day < visit.tagUtmDays[field])) {
      visit[field] = row[field];
      visit.tagUtmDays[field] = row.day;
    }
  }
  for (const arm of row.arms) visit.arms.add(arm);
}
