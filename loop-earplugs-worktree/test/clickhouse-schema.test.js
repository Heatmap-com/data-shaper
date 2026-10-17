import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ensureAeSchema, ensureSchema, ensureTrendTables } from '../src/adapters/persistence/clickhouse/schema-migrator.js';

/**
 * A client that records every statement and answers the system-table
 * probes from `answers`, keyed by a fragment of the query.
 * @param {Record<string, object[]>} answers
 */
function recordingClient(answers = {}) {
  /** @type {string[]} */
  const sent = [];
  const answer = (query) => Object.entries(answers).find(([fragment]) => query.includes(fragment))?.[1] ?? [];
  return {
    sent,
    async query({ query }) {
      sent.push(`query: ${query.replace(/\s+/g, ' ').trim()}`);
      return { json: async () => answer(query) };
    },
    async command({ query }) {
      sent.push(`command: ${query.replace(/\s+/g, ' ').trim()}`);
    },
  };
}

/** @param {string[]} sent */
function digest(sent) {
  return {
    count: sent.length,
    heads: sent.map((s) => s.slice(0, 90)),
    sha: createHash('sha256').update(sent.join('\n')).digest('hex').slice(0, 24),
  };
}

describe('ClickHouse schema characterization', () => {
  it('keeps the v1, schema-2, and trend DDL for journey_events', async () => {
    const v1 = recordingClient({ 'system.databases': [{ name: 'journey_events' }] });
    await ensureSchema(v1, 'journey_events');
    const ae = recordingClient();
    await ensureAeSchema(ae, 'journey_events');
    const fresh = recordingClient();
    await ensureTrendTables(fresh, 'journey_events');
    const rebuild = recordingClient({
      'system.tables': [{ name: 'ae_trend_row' }],
      'system.columns': [],
      'count()': [{ n: 0 }],
    });
    await ensureTrendTables(rebuild, 'journey_events');
    expect({
      v1: digest(v1.sent),
      ae: digest(ae.sent),
      trendFresh: digest(fresh.sent),
      trendRebuild: digest(rebuild.sent.slice(0, 6)),
    }).toMatchSnapshot();
  });
});
