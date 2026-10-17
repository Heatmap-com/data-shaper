import { pageType } from '../../page-type.js';
import { mapState } from '../../scan/snapshot.js';
import { refererName } from './dims.js';
import { fetchHsrPages } from './urls.js';

/**
 * The per-URL entry candidates page selectors choose from: entry totals per
 * entry page, exclude_confirmed tier, with the channel mix, added up per
 * URL. A selector folds session rows into the entry folder (a day at a time
 * in the day scan, or the window's rows at once), then reads candidates.
 */

/** @typedef {{sessions: number, orders: number, revenue: number, channels: Map<string, number>}} EntryCell */

/**
 * @typedef {Object} EntryCandidate
 * @property {string} url
 * @property {string} type page type of the URL
 * @property {string} title
 * @property {string} hsr the entry page with the most sessions for the URL
 * @property {number} entrySessions
 * @property {number} orders
 * @property {number} revenue
 * @property {string} channel the URL's largest channel
 */

/** Entry totals per entry page, as a session folder. */
export function entryFolder() {
  /** @type {Map<string, EntryCell>} */
  const byHsr = new Map();
  return {
    byHsr,
    ...mapState(byHsr),
    /** @param {object[]} sessions */
    fold(sessions) {
      for (const s of sessions) {
        if (s.entryHsr === '' || s.entryHsr === '0') continue;
        if (s.tier === 'confirmed') continue;
        let cell = byHsr.get(s.entryHsr);
        if (!cell) {
          cell = { sessions: 0, orders: 0, revenue: 0, channels: new Map() };
          byHsr.set(s.entryHsr, cell);
        }
        cell.sessions += 1;
        cell.orders += s.orders;
        cell.revenue += s.revenue;
        const channel = refererName(s.referer);
        cell.channels.set(channel, (cell.channels.get(channel) ?? 0) + 1);
      }
    },
  };
}

const largest = (counts) => [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]?.[0] ?? '';

/**
 * The candidates, most entry sessions first, and each URL's channel mix.
 * Entry pages that resolve to one URL add up per URL.
 * @param {import('../../ports/dataset.js').RunContext} ctx
 * @param {number} idsite
 * @param {Map<string, EntryCell>} byHsr
 * @returns {Promise<{candidates: EntryCandidate[], channelsOf: (url: string) => Map<string, number> | undefined}>}
 */
export async function entryCandidates(ctx, idsite, byHsr) {
  const hsrPages = await fetchHsrPages(ctx, idsite);
  /** @type {Map<string, {sessions: number, orders: number, revenue: number, hsrs: Map<string, number>, channels: Map<string, number>}>} */
  const byUrl = new Map();
  for (const [hsr, totals] of byHsr) {
    const page = hsrPages.get(hsr);
    if (!page || !page.url) continue;
    let cell = byUrl.get(page.url);
    if (!cell) {
      cell = { sessions: 0, orders: 0, revenue: 0, hsrs: new Map(), channels: new Map() };
      byUrl.set(page.url, cell);
    }
    cell.sessions += totals.sessions;
    cell.orders += totals.orders;
    cell.revenue += totals.revenue;
    cell.hsrs.set(hsr, totals.sessions);
    for (const [channel, n] of totals.channels) cell.channels.set(channel, (cell.channels.get(channel) ?? 0) + n);
  }

  /** @type {EntryCandidate[]} */
  const candidates = [];
  for (const [url, cell] of byUrl) {
    const hsr = largest(cell.hsrs);
    candidates.push({
      url,
      type: pageType(url),
      title: hsrPages.get(hsr)?.title ?? '',
      hsr,
      entrySessions: cell.sessions,
      orders: cell.orders,
      revenue: cell.revenue,
      channel: largest(cell.channels),
    });
  }
  candidates.sort((a, b) => b.entrySessions - a.entrySessions || (a.url < b.url ? -1 : 1));
  return { candidates, channelsOf: (url) => byUrl.get(url)?.channels };
}

export { largest as largestChannel };

/**
 * A candidate as a page target.
 * @param {EntryCandidate} candidate
 * @param {string} role
 * @param {string} selectionReason
 */
export function candidateTarget(candidate, role, selectionReason) {
  return {
    idsitehsr: Number(candidate.hsr),
    url: candidate.url,
    pageTitle: candidate.title,
    pageType: candidate.type,
    role,
    selectionReason,
    entrySessions: candidate.entrySessions,
    orders: candidate.orders,
    revenue: candidate.revenue,
  };
}

/**
 * A page target as a page-shaped subject.
 * @param {import('../../ports/persistence.js').AePageTarget} target
 * @param {'page' | 'quiz'} [subjectType]
 * @param {Object<string, string | number>} [dims]
 * @returns {import('../../ports/subject.js').SubjectTarget}
 */
export function pageSubject(target, subjectType = 'page', dims = {}) {
  return { ...target, subjectType, subjectKey: String(target.idsitehsr), label: target.url ?? '', dims: { kind: target.pageType ?? '', ...dims } };
}
