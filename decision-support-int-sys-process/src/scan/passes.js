import { scanDays } from './day-scan.js';
import { decodeSnapshot, encodeSnapshot, mapState } from './snapshot.js';
import { secondHsrOf, sessionRowOf } from './views.js';

/**
 * The two passes a site analysis makes over the day scan in place of the
 * whole-window session query.
 *
 * The site pass feeds every session of the window, a day at a time, to the
 * folders of the page-independent reductions (the qualifier, the page
 * selector, and the `pass: 'site'` datasets). Node holds what the folders
 * keep, never the window's sessions.
 *
 * The page pass keeps, per target page, the session rows the page datasets
 * read: the page's entry sessions, with its scroll and time facts, and when
 * asked the sessions that viewed it. Memory follows the targets' traffic.
 *
 * Both lanes start at windowStart, so a visit that began before the window
 * is seen from its first in-window row, as the window query sees it.
 *
 * With a cursor store, a pass saves after each day: each lane's open visits
 * and each named folder's state. A pass restores a saved state that holds
 * every lane and folder it runs, for the same site, window, and pass, and
 * reads from the next day; a pass saved after its last day only closes the
 * visits still open. A folder without `snapshot` and `restore` turns the
 * cursor off for its pass.
 */

const CURSOR_VERSION = 2;
const CURSOR_MAX_BYTES = 64 * 1024 * 1024;

/**
 * @typedef {object} CursorStore
 * @property {() => Promise<string | null>} load
 * @property {(text: string, day: string) => Promise<void>} save
 * @property {number} [maxBytes] a larger state is not saved
 */

/**
 * A folder with a `lane` reads visits on its own lane (its own start day and
 * events, and a hook after each day); the others fold session rows from the
 * window's lane. When a folder sets `partnerTags`, the scan reads the A/B
 * arms and each session row carries its `arms`.
 *
 * @param {object} args
 * @param {import('../ports/dataset.js').QueryGateway} args.gateway
 * @param {number} args.idsite
 * @param {import('./day-records.js').DayRecords} [args.records] the days' source; the live queries by default
 * @param {{windowStart: string, windowEnd: string}} args.window
 * @param {Parameters<typeof sessionRowOf>[1]} args.bot
 * @param {import('../ports/dataset.js').SessionFolder[]} args.folders
 * @param {string[]} [args.names] one per folder, for the cursor
 * @param {CursorStore} [args.cursor]
 * @param {object} [args.logger]
 */
export async function runSitePass({ gateway, idsite, records, window, bot, folders, names = [], cursor, logger }) {
  const sessionFolders = folders.filter((folder) => !folder.lane);
  const lanes = folders.filter((folder) => folder.lane).map((folder) => folder.lane);
  const laneNames = [
    ...(sessionFolders.length > 0 ? ['report'] : []),
    ...folders.map((folder, i) => (folder.lane ? `lane:${names[i]}` : null)).filter(Boolean),
  ];
  const partnerTags = sessionFolders.some((folder) => folder.partnerTags);
  const consumers = [...lanes];
  if (sessionFolders.length > 0) {
    consumers.unshift({
      start: window.windowStart,
      onClosed(visits) {
        const rows = visits.map((visit) => ({
          ...sessionRowOf(visit, bot),
          secondHsr: secondHsrOf(visit),
          ...(partnerTags ? { arms: [...visit.arms] } : {}),
        }));
        for (const folder of sessionFolders) folder.fold(rows);
      },
    });
  }
  return scanDays({
    gateway,
    idsite,
    records,
    end: window.windowEnd,
    events: lanes.flatMap((lane) => lane.events ?? []),
    partnerTags,
    cursor: dayCursor({
      store: cursor,
      key: { pass: 'site', idsite, windowStart: window.windowStart, windowEnd: window.windowEnd },
      laneNames,
      parts: folders.map((folder, i) => [names[i], folder]),
      logger,
    }),
    logger,
    consumers,
  });
}

/**
 * @param {object} args
 * @param {import('../ports/dataset.js').QueryGateway} args.gateway
 * @param {number} args.idsite
 * @param {import('./day-records.js').DayRecords} [args.records] the days' source; the live queries by default
 * @param {{windowStart: string, windowEnd: string}} args.window
 * @param {Parameters<typeof sessionRowOf>[1]} args.bot
 * @param {number[]} args.pages the target idsitehsrs
 * @param {boolean} [args.viewed] also keep the sessions that viewed each page
 * @param {CursorStore} [args.cursor]
 * @param {object} [args.logger]
 */
export async function runPagePass({ gateway, idsite, records, window, bot, pages, viewed = false, cursor, logger }) {
  const keys = new Set(pages.map(String));
  /** @type {Map<string, {entries: object[], viewers: object[]}>} */
  const byPage = new Map([...keys].map((key) => [key, { entries: [], viewers: [] }]));
  const kept = mapState(byPage);
  const stats = await scanDays({
    gateway,
    idsite,
    records,
    end: window.windowEnd,
    pages: [...keys].map(Number),
    cursor: dayCursor({
      store: cursor,
      key: { pass: 'page', idsite, windowStart: window.windowStart, windowEnd: window.windowEnd, pages: [...keys].sort(), viewed },
      laneNames: ['report'],
      parts: [['page-rows', kept]],
      logger,
    }),
    logger,
    consumers: [
      {
        start: window.windowStart,
        onClosed(visits) {
          for (const visit of visits) {
            const entry = keys.has(visit.entryHsr) ? visit.entryHsr : null;
            const seen = viewed ? [...visit.hsrs].filter((hsr) => keys.has(hsr)) : [];
            if (entry === null && seen.length === 0) continue;
            const row = sessionRowOf(visit, bot);
            if (entry !== null) byPage.get(entry).entries.push({ row, facts: factsOf(visit, entry) });
            for (const hsr of seen) byPage.get(hsr).viewers.push({ row, facts: factsOf(visit, hsr) });
          }
        },
      },
    ],
  });
  return {
    stats,
    /**
     * The session source for one target page.
     * @param {number} idsitehsr
     * @returns {import('../ports/dataset.js').SessionSource}
     */
    sourceFor(idsitehsr) {
      const kept = byPage.get(String(idsitehsr));
      if (!kept) throw new Error(`page pass: ${idsitehsr} is not a target of the pass`);
      return {
        async rows(rowIdsite, opts = {}) {
          checkSite(rowIdsite, idsite);
          if (Number.isInteger(opts.idsitehsr) && opts.idsitehsr !== idsitehsr) {
            throw new Error(`page pass: the source for ${idsitehsr} carries no facts for ${opts.idsitehsr}`);
          }
          if (opts.viewed && !viewed) throw new Error('page pass: viewers were not kept; a dataset reads them without sessions: "viewed"');
          return rowsOf(opts.viewed ? kept.viewers : kept.entries, Number.isInteger(opts.idsitehsr));
        },
      };
    },
    /**
     * The entry sessions of every target, for the site datasets that read
     * across the targets.
     * @returns {import('../ports/dataset.js').SessionSource}
     */
    targetsSource() {
      return {
        async rows(rowIdsite, opts = {}) {
          checkSite(rowIdsite, idsite);
          if (opts.viewed || Number.isInteger(opts.idsitehsr)) {
            throw new Error('page pass: the targets source carries entry sessions only');
          }
          return [...byPage.values()].flatMap((kept) => rowsOf(kept.entries, false));
        },
      };
    },
  };
}

/**
 * The scan's cursor over a pass's lanes and parts, or undefined when the
 * pass has no store or a part keeps no state.
 * @param {object} args
 * @param {CursorStore} [args.store]
 * @param {object} args.key what a saved state must match
 * @param {string[]} args.laneNames one per scan consumer, in order
 * @param {Array<[string, {snapshot?: () => unknown, restore?: (saved: any) => void}]>} args.parts
 * @param {object} [args.logger]
 * @returns {import('./day-scan.js').DayCursor | undefined}
 */
function dayCursor({ store, key, laneNames, parts, logger }) {
  if (!store) return undefined;
  const stateless = parts.filter(([, part]) => typeof part.snapshot !== 'function' || typeof part.restore !== 'function');
  if (stateless.length > 0) {
    logger?.warn?.({ parts: stateless.map(([name]) => name) }, 'day cursor off: a folder keeps no state');
    return undefined;
  }
  const keyText = JSON.stringify({ v: CURSOR_VERSION, ...key });
  const maxBytes = store.maxBytes ?? CURSOR_MAX_BYTES;
  return {
    async load() {
      const text = await store.load();
      if (!text) return null;
      const saved = decodeSnapshot(text);
      if (saved?.key !== keyText) return null;
      const complete = laneNames.every((name) => saved.lanes.has(name)) && parts.every(([name]) => saved.parts.has(name));
      if (!complete) return null;
      for (const [name, part] of parts) part.restore(saved.parts.get(name));
      logger?.info?.({ pass: key.pass, day: saved.day }, 'day cursor restored');
      return { day: saved.day, lanes: laneNames.map((name) => saved.lanes.get(name)) };
    },
    async save({ day, lanes }) {
      const text = encodeSnapshot({
        key: keyText,
        day,
        lanes: new Map(laneNames.map((name, i) => [name, lanes[i]])),
        parts: new Map(parts.map(([name, part]) => [name, part.snapshot()])),
      }, { maxBytes });
      if (text === null) {
        logger?.warn?.({ pass: key.pass, day, maxBytes }, 'day cursor not saved: state over the cap');
        return;
      }
      await store.save(text, day);
    },
  };
}

/** @param {number} asked @param {number} scanned */
function checkSite(asked, scanned) {
  if (Number(asked) !== Number(scanned)) throw new Error(`page pass: scanned site ${scanned}, asked for ${asked}`);
}

/**
 * @param {import('./open-visits.js').ScanVisit} visit
 * @param {string} hsr
 */
function factsOf(visit, hsr) {
  const facts = visit.pageFacts.get(hsr);
  return {
    scrollMax: facts?.scrollMax ?? 0,
    landingPageviews: facts?.landingPageviews ?? 0,
    pageCappedMs: facts?.pageCappedMs ?? 0,
  };
}

/**
 * @param {Array<{row: object, facts: object}>} kept
 * @param {boolean} withFacts
 */
function rowsOf(kept, withFacts) {
  return kept.map(({ row, facts }) => (withFacts ? { ...row, ...facts } : { ...row }));
}
