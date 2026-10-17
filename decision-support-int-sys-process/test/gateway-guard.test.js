import { describe, expect, it } from 'vitest';
import { aeFactTableRe, createGateway, DEFAULT_DATABASE as DATABASE } from '../src/adapters/query-gateway/clickhouse.js';

const AE_FACT_TABLE_RE = aeFactTableRe(DATABASE);

/**
 * Gateway fact-table guard (data-capture-plan.md §8.7 V7): the schema-2 guard
 * refuses an ae_ fact-table query without the {idsite} parameter, allows it
 * with one, and keeps allowing the queue tables fleet-wide.
 */

function createFakeClient() {
  return {
    async query() {
      return { json: async () => [] };
    },
    async command() {},
  };
}

const logger = { info() {} };
const gateway = () => createGateway(createFakeClient(), { logger });

describe('gateway fact-table guard', () => {
  it('refuses SELECT * FROM journey_events.ae_src_order without {idsite}', async () => {
    await expect(gateway().query(`SELECT * FROM ${DATABASE}.ae_src_order`, {}, 't')).rejects.toThrow(
      /gateway refused/,
    );
  });

  it(`refuses ${DATABASE}.ae_strategy_card without {idsite}`, async () => {
    await expect(
      gateway().query(`SELECT * FROM ${DATABASE}.ae_strategy_card`, {}, 't'),
    ).rejects.toThrow(/gateway refused/);
  });

  it('allows ae fact tables with the {idsite} placeholder and param', async () => {
    const rows = await gateway().query(
      `SELECT * FROM ${DATABASE}.ae_strategy_card WHERE idsite = {idsite:UInt32}`,
      { idsite: 7 },
      't',
    );
    expect(rows).toEqual([]);
    const srcRows = await gateway().query(
      `SELECT count() AS n FROM ${DATABASE}.ae_src_order WHERE idsite = {idsite:UInt32}`,
      { idsite: 7 },
      't',
    );
    expect(srcRows).toEqual([]);
  });

  it('still allows queue tables (ae_site_queue) without idsite', async () => {
    const rows = await gateway().query(`SELECT * FROM ${DATABASE}.ae_site_queue_current`, {}, 't');
    expect(rows).toEqual([]);
  });

  it('still applies the v1 guard', async () => {
    await expect(gateway().query('SELECT * FROM udp_hsrce_visits', {}, 't')).rejects.toThrow(
      /gateway refused/,
    );
    const rows = await gateway().query(
      'SELECT * FROM udp_hsrce_visits WHERE idsite = {idsite:UInt32}',
      { idsite: 7 },
      't',
    );
    expect(rows).toEqual([]);
  });

  it('fleet: labels skip the guard by design', async () => {
    const rows = await gateway().query(`SELECT * FROM ${DATABASE}.ae_src_order`, {}, 'fleet:scan');
    expect(rows).toEqual([]);
  });

  it('AE_FACT_TABLE_RE matches every ae fact table', () => {
    const factTables = [
      'ae_src_order',
      'ae_src_order_line',
      'ae_src_tool_event',
      'ae_dataset_row',
      'ae_trend_row',
      'ae_requirement_status',
      'ae_strategy_card',
      'ae_page_analysis',
      'ae_site_analysis',
      'ae_element_binding',
      'ae_page_render',
      'ae_render_node',
      'ae_page_capture',
      'ae_page_descriptor',
      'ae_store_descriptor',
      'ae_tool_registry',
      'ae_change_log',
      'ae_source_connection',
      'ae_experiment',
      'ae_review_verdict',
    ];
    for (const table of factTables) {
      expect(AE_FACT_TABLE_RE.test(`${DATABASE}.${table}`), table).toBe(true);
    }
  });

  it('AE_FACT_TABLE_RE exempts queues, batch/version and reference tables', () => {
    const exempt = [
      'ae_site_queue',
      'ae_page_target',
      'ae_capture_queue',
      'ae_batch',
      'ae_schema_version',
      'ae_ingest_run',
      'ae_requirement',
      'ae_strategy_catalog',
      'ae_strategy_crosswalk',
      'ae_screen_rule',
      'ae_audit_matrix',
    ];
    for (const table of exempt) {
      expect(AE_FACT_TABLE_RE.test(`${DATABASE}.${table}`), table).toBe(false);
    }
  });
});
