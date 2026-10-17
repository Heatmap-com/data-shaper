import { checkKey, toEntry } from './_entry.js';

const PART_BYTES = 8 * 1024 * 1024;

/**
 * The day store in `ae_scan_day`, for runs on several machines that share
 * one store. An entry is written as numbered parts of at most 8 MB of JSON
 * rows, all with one generated_at. A read takes the parts of the entry's
 * latest generated_at, one row per part, and returns null unless every
 * part is there, so a write that died midway reads as the entry before it.
 * Old days leave by the table's TTL.
 *
 * The client is the composition's @clickhouse/client instance.
 * @param {{client: object, database: string, now?: () => string, partBytes?: number}} opts
 * @returns {import('../../ports/day-store.js').DayStore}
 */
export function createClickHouseDayStore({ client, database, now = nowCh, partBytes = PART_BYTES }) {
  if (!/^\w+$/.test(database ?? '')) throw new Error(`clickhouse day store: database ${database} is not a name`);
  const table = `${database}.ae_scan_day`;
  const where = 'idsite = {idsite:UInt32} AND kind = {kind:String} AND key = {key:String} AND server_date = {day:Date}';
  return {
    id: 'clickhouse',
    async read(key) {
      checkKey(key);
      const res = await client.query({
        query: `SELECT part, parts, version, final, shape, payload
                  FROM ${table}
                 WHERE ${where}
                   AND generated_at = (SELECT max(generated_at) FROM ${table} WHERE ${where})
                 ORDER BY part
                 LIMIT 1 BY part`,
        query_params: { idsite: key.idsite, kind: key.kind, key: key.key, day: key.day },
        format: 'JSONEachRow',
      });
      const parts = await res.json();
      if (parts.length === 0) return null;
      const expected = Number(parts[0].parts);
      if (parts.length !== expected || parts.some((row, i) => Number(row.part) !== i)) return null;
      const head = parts[0];
      return {
        ...key,
        version: Number(head.version),
        final: Number(head.final) === 1,
        shape: head.shape ? JSON.parse(head.shape) : null,
        rows: parts.flatMap((row) => JSON.parse(row.payload)),
      };
    },
    async write(entry) {
      const body = toEntry(entry);
      const payloads = splitRows(body.rows, partBytes);
      const generatedAt = now();
      await client.insert({
        table,
        format: 'JSONEachRow',
        values: payloads.map((payload, part) => ({
          idsite: body.idsite,
          kind: body.kind,
          key: body.key,
          server_date: body.day,
          version: body.version,
          final: body.final ? 1 : 0,
          shape: body.shape ? JSON.stringify(body.shape) : '',
          part,
          parts: payloads.length,
          rows: payload.rows,
          payload: payload.text,
          generated_at: generatedAt,
        })),
      });
    },
    /** The table's TTL drops days after 400; a delete mutation here would rewrite parts. */
    async prune() {
      return 0;
    },
  };
}

/**
 * The rows as JSON arrays of at most PART_BYTES each, at least one.
 * @param {object[]} rows
 * @returns {Array<{rows: number, text: string}>}
 */
export function splitRows(rows, limit = PART_BYTES) {
  const parts = [];
  let current = [];
  let bytes = 2;
  for (const row of rows) {
    const text = JSON.stringify(row);
    if (current.length > 0 && bytes + text.length + 1 > limit) {
      parts.push({ rows: current.length, text: `[${current.join(',')}]` });
      current = [];
      bytes = 2;
    }
    current.push(text);
    bytes += text.length + 1;
  }
  parts.push({ rows: current.length, text: `[${current.join(',')}]` });
  return parts;
}

function nowCh() {
  return new Date().toISOString().replace('T', ' ').slice(0, -1);
}

export const adapter = {
  id: 'clickhouse',
  create: createClickHouseDayStore,
};
