import { byIdvisit, daySql, pageFactsSql, parseDayRow, parsePageFact } from './day-record.js';

/**
 * The day scan's reads of one site's day: the day rows (daySql) and the
 * chosen pages' facts (pageFactsSql). The live source runs the queries.
 * The stored source answers from a day store and reads live what the store
 * lacks, then stores it, so a later run replays the day as the warehouse
 * returned it.
 *
 * Bump DAY_RECORD_VERSION when daySql, pageFactsSql, or their parsing
 * change what a row holds: every stored day is then read again.
 */
export const DAY_RECORD_VERSION = 2;

/**
 * @typedef {import('../ports/day-store.js').DayShape} DayShape
 *
 * @typedef {object} DayRecords
 * @property {(day: string, shape: DayShape) => Promise<import('./day-record.js').DayRow[]>} day the day's rows in idvisit order
 * @property {(day: string, pages: number[]) => Promise<Array<ReturnType<typeof parsePageFact>>>} pageFacts
 * @property {() => DayRecordStats} stats
 *
 * @typedef {object} DayRecordStats
 * @property {number} queries warehouse queries run
 * @property {number} [daysStored] days answered from the store
 * @property {number} [daysLive] days read from the warehouse
 * @property {number} [pageDaysStored] page-days answered from the store
 * @property {number} [pageDaysLive] page-days read from the warehouse
 * @property {number} [written] entries written to the store
 */

/**
 * @param {{gateway: import('../ports/query-gateway.js').QueryGateway, idsite: number}} args
 * @returns {DayRecords}
 */
export function createLiveDayRecords({ gateway, idsite }) {
  let queries = 0;
  return {
    async day(day, shape) {
      queries += 1;
      const rows = await gateway.query(daySql({ partnerTags: shape.partnerTags }), { idsite, events: shape.events, day }, 'scan:day');
      return byIdvisit(rows.map((row) => parseDayRow(row, day)));
    },
    async pageFacts(day, pages) {
      if (pages.length === 0) return [];
      queries += 1;
      return byFact((await gateway.query(pageFactsSql(), { idsite, day, pages }, 'scan:page-facts')).map(parsePageFact));
    },
    stats: () => ({ queries }),
  };
}

/**
 * Days on or before `finalThrough` are final: a stored final day is used as
 * stored. A later day is read live on each run, and once within the run it
 * is reused, so the page pass replays the site pass's reads.
 *
 * A stored day serves a request whose event names it holds, and whose A/B
 * arms it holds when they are asked for. Its rows are narrowed to the
 * request: events outside it and unrequested arms are dropped, then any row
 * left with no fact, which is the row set the narrower query returns. A
 * stored day that lacks a requested name is read live with both shapes'
 * union, so the store only widens.
 *
 * @param {object} args
 * @param {DayRecords} args.live
 * @param {import('../ports/day-store.js').DayStore} args.store
 * @param {number} args.idsite
 * @param {string} args.finalThrough YYYY-MM-DD
 * @returns {DayRecords}
 */
export function createStoredDayRecords({ live, store, idsite, finalThrough }) {
  /** @type {Set<string>} entries this source wrote, reusable while it lives */
  const fresh = new Set();
  const stats = { daysStored: 0, daysLive: 0, pageDaysStored: 0, pageDaysLive: 0, written: 0 };
  const usable = (entry, id) => entry && entry.version === DAY_RECORD_VERSION && (entry.final || fresh.has(id));

  async function save(kind, key, day, shape, rows) {
    await store.write({ idsite, kind, key, day, version: DAY_RECORD_VERSION, final: day <= finalThrough, shape, rows });
    fresh.add(`${kind}|${key}|${day}`);
    stats.written += 1;
  }

  return {
    async day(day, shape) {
      const want = normalShape(shape);
      const id = `day||${day}`;
      const entry = await store.read({ idsite, kind: 'day', key: '', day });
      if (usable(entry, id) && covers(entry.shape, want)) {
        stats.daysStored += 1;
        return narrowed(entry.rows.map((row) => ({ ...row, day })), entry.shape, want);
      }
      const wide = entry?.version === DAY_RECORD_VERSION && entry.shape ? union(entry.shape, want) : want;
      const rows = await live.day(day, wide);
      stats.daysLive += 1;
      await save('day', '', day, wide, rows.map(({ day: _day, ...row }) => row));
      return narrowed(rows, wide, want);
    },
    async pageFacts(day, pages) {
      const facts = [];
      const missing = [];
      for (const page of pages) {
        const key = String(page);
        const entry = await store.read({ idsite, kind: 'page-facts', key, day });
        if (usable(entry, `page-facts|${key}|${day}`)) {
          facts.push(...entry.rows);
          stats.pageDaysStored += 1;
        } else {
          missing.push(page);
        }
      }
      if (missing.length > 0) {
        const read = await live.pageFacts(day, missing);
        stats.pageDaysLive += missing.length;
        for (const page of missing) {
          const key = String(page);
          await save('page-facts', key, day, null, read.filter((fact) => fact.hsr === key));
        }
        facts.push(...read);
      }
      return byFact(facts);
    },
    stats: () => ({ ...live.stats(), ...stats }),
  };
}

/** @param {DayShape} shape */
function normalShape(shape) {
  return { events: [...new Set(shape.events)].sort(), partnerTags: Boolean(shape.partnerTags) };
}

/** @param {DayShape} have @param {DayShape} want */
function covers(have, want) {
  if (!have) return false;
  if (want.partnerTags && !have.partnerTags) return false;
  const names = new Set(have.events);
  return want.events.every((name) => names.has(name));
}

/** @param {DayShape} a @param {DayShape} b */
function union(a, b) {
  return normalShape({ events: [...a.events, ...b.events], partnerTags: a.partnerTags || b.partnerTags });
}

/**
 * @param {import('./day-record.js').DayRow[]} rows
 * @param {DayShape} have
 * @param {DayShape} want
 */
function narrowed(rows, have, want) {
  const sameEvents = have.events.length === want.events.length;
  if (sameEvents && have.partnerTags === want.partnerTags) return rows;
  const names = new Set(want.events);
  const out = [];
  for (const row of rows) {
    const next = {
      ...row,
      events: sameEvents ? row.events : row.events.filter((name) => names.has(name)),
      arms: want.partnerTags ? row.arms : [],
    };
    if (hasFact(next)) out.push(next);
  }
  return out;
}

/**
 * Whether one of daySql's fact CTEs holds the row: the union that makes
 * its spine.
 * @param {import('./day-record.js').DayRow} row
 */
function hasFact(row) {
  return row.hasVisit || row.pageviewRows > 0 || row.events.length > 0 || row.orders.length > 0
    || row.clicks > 0 || row.tags !== '' || row.arms.length > 0;
}

/**
 * Page facts in visit then page order, however they were gathered.
 * @param {Array<ReturnType<typeof parsePageFact>>} facts
 */
function byFact(facts) {
  return facts.sort((a, b) => {
    const left = BigInt(a.idvisit || '0');
    const right = BigInt(b.idvisit || '0');
    if (left !== right) return left < right ? -1 : 1;
    return a.hsr < b.hsr ? -1 : a.hsr > b.hsr ? 1 : 0;
  });
}
