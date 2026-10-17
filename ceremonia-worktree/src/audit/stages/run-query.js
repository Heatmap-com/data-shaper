/**
 * Run audit queries through the gateway. A failed query becomes an error
 * row rather than stopping the brand, and long windows run as week chunks.
 */

import { chunkDaysFor, weekChunks } from '../bounds.js';
import { shapeAcquisition } from '../shape.js';
import { daysInclusive } from '../windows.js';

/**
 * @param {{query: Function}} gateway
 * @param {Array<{id: string, label: string, sql: string, params: object}>} queries
 */
export async function runSet(gateway, queries) {
  /** @type {Array<{dims: object, metrics: object}>} */
  const rows = [];
  for (const query of queries) {
    rows.push(...(await runLabeled(gateway, query)));
  }
  return rows;
}

/**
 * @param {{query: Function}} gateway
 * @param {{id: string, label: string, sql: string, params: object}} query
 */
export async function runLabeled(gateway, query) {
  const raw = await runQuery(gateway, query);
  if (raw.error) return [{ dims: { query: query.id }, metrics: { error: raw.error } }];
  return shapeAcquisition(query.id, raw.rows);
}

/** @param {{query: Function}} gateway @param {{sql: string, params: object, label: string, chunkDays?: number}} query */
export async function runQuery(gateway, query) {
  const chunkDays = query.chunkDays ?? chunkDaysFor(query.sql, query.params ?? {});
  try {
    const rows = await runChunks(gateway, query, query.params?.start, query.params?.end, chunkDays);
    return { rows };
  } catch (err) {
    return { rows: [], error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Monday-aligned week chunks. A timed-out chunk is retried as 7-day pieces
 * so a week is never split across two aggregations.
 * @param {{query: Function}} gateway
 * @param {{sql: string, params: object, label: string}} query
 * @param {string|undefined} start
 * @param {string|undefined} end
 * @param {number} chunkDays
 */
async function runChunks(gateway, query, start, end, chunkDays) {
  const chunks = chunkDays > 0 && start && end ? weekChunks(start, end, chunkDays) : [null];
  /** @type {object[]} */
  const rows = [];
  for (const chunk of chunks) {
    const params = chunk ? { ...query.params, start: chunk.start, end: chunk.end } : query.params;
    const label = chunk && chunks.length > 1 ? `${query.label}:${chunk.start}` : query.label;
    try {
      const part = await gateway.query(query.sql, params, label);
      rows.push(...part);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const timedOut = /timeout|max_execution_time|memory limit/i.test(message);
      const span = chunk ? daysInclusive(chunk.start, chunk.end) : 0;
      const monday = chunk ? new Date(`${chunk.start}T00:00:00Z`).getUTCDay() === 1 : false;
      if (timedOut && chunk && monday && span > 7) {
        rows.push(...(await runChunks(gateway, query, chunk.start, chunk.end, 7)));
        continue;
      }
      throw err;
    }
  }
  return rows;
}
