import { addDays, eachDate } from '../triggers/time.js';
import { daySql, dayEvents, pageFactsSql, parseDayRow, parsePageFact, spreadVisitsSql } from './day-record.js';
import { createLiveDayRecords } from './day-records.js';
import { createOpenVisits } from './open-visits.js';

/**
 * @typedef {object} ScanConsumer
 * @property {string} start the first day this consumer's visits read, inclusive
 * @property {(visits: import('./open-visits.js').ScanVisit[], day: string) => (void | Promise<void>)} onClosed
 * @property {(day: string, open: ReturnType<typeof createOpenVisits>) => (void | Promise<void>)} [onDay] after the day's visits closed
 */

/**
 * @typedef {object} DayCursor
 * @property {() => Promise<{day: string, lanes: object[]} | null>} load the last day read and each consumer's open visits, or null to start at the first day
 * @property {(saved: {day: string, lanes: object[]}) => Promise<void>} save after each day
 */

/**
 * Reads one site a day at a time, oldest first, one query in flight. Each
 * consumer keeps its own open visits from its own start day, so a consumer
 * that starts at the window sees a visit exactly as the window query does:
 * from its first in-window row. Visits quiet for `hold` days close and go
 * to `onClosed` with the day just read; the rest close after the last day.
 * Node holds the open visits and whatever the consumers fold, never a
 * window's rows.
 *
 * With `pages`, a second query per day reads each visit's facts on those
 * pages (scroll, pageviews, capped time).
 *
 * A visit whose days are further apart than `hold` would close between
 * them. Before the first day, the scan lists those visits and reads their
 * rows over the whole range; each lane opens one whole on its first day.
 * Mellow's month has about 2,000 of 4.7 million.
 *
 * With a `cursor`, the scan saves after each day and starts after the day a
 * saved state names. The consumers' own state is the cursor's to keep.
 *
 * The days come from `records` (see day-records.js), by default the live
 * queries. The spread visits are always read live.
 *
 * @param {object} args
 * @param {import('../ports/dataset.js').QueryGateway} args.gateway
 * @param {number} args.idsite
 * @param {import('./day-records.js').DayRecords} [args.records]
 * @param {string} args.end last day, inclusive
 * @param {ScanConsumer[]} args.consumers
 * @param {Iterable<string>} [args.events] event names beyond the session-stream funnel events
 * @param {number[]} [args.pages] idsitehsr values whose per-visit facts ride on the visits
 * @param {boolean} [args.partnerTags] read each visit's A/B arms (see daySql)
 * @param {DayCursor} [args.cursor]
 * @param {number} [args.hold]
 * @param {number} [args.lateDays]
 * @param {{info?: Function}} [args.logger]
 */
export async function scanDays({ gateway, idsite, records, end, consumers, events = [], pages = [], partnerTags = false, cursor, hold = 1, lateDays = 3, logger }) {
  if (consumers.length === 0) throw new Error('scanDays: at least one consumer');
  const first = consumers.map((consumer) => consumer.start).sort()[0];
  const params = { idsite, events: dayEvents(events) };
  const spread = await readSpread({ gateway, idsite, start: first, end, events: params.events, pages, partnerTags, hold });
  const lanes = consumers.map((consumer) => ({
    consumer,
    open: createOpenVisits({ hold, lateDays, ahead: aheadFrom(spread, consumer.start) }),
  }));
  const saved = cursor ? await cursor.load() : null;
  if (saved) lanes.forEach((lane, i) => lane.open.restore(saved.lanes[i]));
  const start = saved ? addDays(saved.day, 1) : first;
  const days = eachDate(start, end);
  const source = records ?? createLiveDayRecords({ gateway, idsite });
  const before = source.stats();
  for (const day of days) {
    const rows = await source.day(day, { events: params.events, partnerTags });
    const facts = await source.pageFacts(day, pages);
    for (const { consumer, open } of lanes) {
      if (day < consumer.start) continue;
      open.add(rows);
      open.addPageFacts(facts);
      const closed = open.closeQuiet(day);
      if (closed.length > 0) await consumer.onClosed(closed, day);
      if (consumer.onDay) await consumer.onDay(day, open);
    }
    logger?.info?.({ idsite, day, rows: rows.length, open: lanes.map((lane) => lane.open.stats().open) }, 'scan day');
    if (cursor) await cursor.save({ day, lanes: lanes.map((lane) => lane.open.snapshot()) });
  }
  for (const { consumer, open } of lanes) {
    const rest = open.closeAll(end);
    if (rest.length > 0) await consumer.onClosed(rest, end);
  }
  const after = source.stats();
  return {
    days: days.length,
    resumedAfter: saved?.day ?? null,
    queries: spread.queries + after.queries - before.queries,
    ...(records ? { records: since(before, after) } : {}),
    hold,
    lateDays,
    spreadVisits: spread.ids.length,
    lanes: lanes.map(({ consumer, open }) => ({ start: consumer.start, ...open.stats() })),
  };
}

/** Each count's growth from `before` to `after`. */
function since(before, after) {
  return Object.fromEntries(Object.entries(after).map(([name, value]) => [name, value - (before[name] ?? 0)]));
}

const SPREAD_CHUNK = 2000;

/**
 * The spread visits over the scan's days: their ids, then every row and
 * chosen-page fact they have, read over the range in chunks of ids.
 */
async function readSpread({ gateway, idsite, start, end, events, pages, partnerTags, hold }) {
  const range = { idsite, start, end };
  const ids = (await gateway.query(spreadVisitsSql({ partnerTags }), { ...range, events, hold }, 'scan:spread'))
    .map((row) => String(row.idvisit));
  let queries = 1;
  const rows = [];
  const facts = [];
  for (let i = 0; i < ids.length; i += SPREAD_CHUNK) {
    const visits = ids.slice(i, i + SPREAD_CHUNK).map((id) => BigInt(id));
    const dayRows = await gateway.query(daySql({ partnerTags, spread: true }), { ...range, events, visits }, 'scan:spread-days');
    for (const row of dayRows) rows.push(parseDayRow(row, String(row.day)));
    queries += 1;
    if (pages.length === 0) continue;
    const pageRows = await gateway.query(pageFactsSql({ spread: true }), { ...range, pages, visits }, 'scan:spread-page-facts');
    for (const row of pageRows) facts.push(parsePageFact(row));
    queries += 1;
  }
  return { ids, rows, facts, queries };
}

/**
 * A lane's view of the spread visits: the rows and facts on its days,
 * oldest first, for the visits that have any.
 * @param {{rows: import('./day-record.js').DayRow[], facts: Array<{idvisit: string, day?: string}>}} spread
 * @param {string} start the lane's first day
 */
function aheadFrom(spread, start) {
  /** @type {Map<string, {rows: import('./day-record.js').DayRow[], facts: object[]}>} */
  const ahead = new Map();
  const cell = (idvisit) => {
    if (!ahead.has(idvisit)) ahead.set(idvisit, { rows: [], facts: [] });
    return ahead.get(idvisit);
  };
  for (const row of spread.rows) if (row.day >= start) cell(row.idvisit).rows.push(row);
  for (const fact of spread.facts) if (fact.day >= start && ahead.has(fact.idvisit)) ahead.get(fact.idvisit).facts.push(fact);
  for (const { rows } of ahead.values()) rows.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  return ahead;
}
