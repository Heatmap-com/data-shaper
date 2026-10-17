/**
 * The day store keeps what the day scan read from the warehouse for one
 * site and one day, so a later run replays the day instead of reading it
 * again. Two kinds of entry:
 *
 * - `day`: the day's parsed daySql rows (key '').
 * - `page-facts`: the day's parsed pageFactsSql rows for one page (key: the idsitehsr).
 *
 * A write replaces the entry whole. A read returns the latest write, or
 * null when the store holds none. `prune` drops a site's entries of days
 * before a date and returns how many it dropped; a store whose table
 * expires rows itself (the ClickHouse TTL) drops none.
 *
 * @typedef {'day' | 'page-facts'} DayEntryKind
 *
 * @typedef {Object} DayEntryKey
 * @property {number} idsite
 * @property {DayEntryKind} kind
 * @property {string} key '' for day rows, the idsitehsr for page facts
 * @property {string} day YYYY-MM-DD
 *
 * @typedef {Object} DayShape what the day's query kept beyond the day itself
 * @property {string[]} events the event names it read, sorted
 * @property {boolean} partnerTags whether rows carry the A/B arms
 *
 * @typedef {Object} DayEntryBody
 * @property {number} version the day-record format version it was read with
 * @property {boolean} final read once the day was past the overlap
 * @property {DayShape | null} shape set for day rows
 * @property {object[]} rows
 *
 * @typedef {DayEntryKey & DayEntryBody} DayEntry
 *
 * @typedef {Object} DayStore
 * @property {string} id the adapter id
 * @property {(key: DayEntryKey) => Promise<DayEntry | null>} read
 * @property {(entry: DayEntry) => Promise<void>} write
 * @property {(args: {idsite: number, before: string}) => Promise<number>} prune
 */
