import { describe, expect, it } from 'vitest';
import { AE_SCHEMA_SQL } from '../src/adapters/persistence/clickhouse/schema-migrator.js';
import { aeFactTableRe, DEFAULT_DATABASE as DATABASE } from '../src/adapters/query-gateway/clickhouse.js';

const AE_FACT_TABLE_RE = aeFactTableRe(DATABASE);

/**
 * DDL lint for src/persistence/schema2.sql (data-capture-plan.md §8.4/§8.5/§8.7):
 * (a) every ReplacingMergeTree table has a `<name>_current` view reading
 *     through FINAL; the two append-only MergeTree tables (ae_schema_version,
 *     ae_ingest_run) have none; (b) every PARTITION BY toYYYYMM(x) column is
 *     in that table's ORDER BY; (c) no PII columns; (d) no destructive DDL;
 * (e) the gateway's AE_FACT_TABLE_RE matches the fact tables and exempts the
 *     queues.
 */

function stripLineComments(sql) {
  return sql
    .split('\n')
    .map((line) => {
      const i = line.indexOf('--');
      return i === -1 ? line : line.slice(0, i);
    })
    .join('\n');
}

const SQL = stripLineComments(AE_SCHEMA_SQL);

const tableChunks = SQL.split(/(?=CREATE TABLE IF NOT EXISTS \$\{DATABASE\}\.)/).filter((c) =>
  c.startsWith('CREATE TABLE IF NOT EXISTS'),
);

function tableInfo(chunk) {
  const name = chunk.match(/^CREATE TABLE IF NOT EXISTS \$\{DATABASE\}\.(\w+)/)[1];
  const engine = chunk.match(/ENGINE = (\w+)/)?.[1] ?? null;
  const partitionBy = chunk.match(/PARTITION BY toYYYYMM\((\w+)\)/)?.[1] ?? null;
  const orderBy = chunk
    .match(/ORDER BY \(([^)]*)\)/)?.[1]
    .split(',')
    .map((c) => c.trim()) ?? [];
  const columns = [...chunk.matchAll(/^ {4}(\w+)\s+(\S+)/gm)].map((m) => m[1]);
  return { name, engine, partitionBy, orderBy, columns };
}

const tables = tableChunks.map(tableInfo);

describe('schema2.sql lint', () => {
  it('has 64 tables and 62 views, every view reading through FINAL', () => {
    const views = AE_SCHEMA_SQL.match(/CREATE OR REPLACE VIEW IF NOT EXISTS \$\{DATABASE\}\.(\w+)/g) ?? [];
    expect(tables).toHaveLength(64);
    expect(views).toHaveLength(62);
    const viewBodies = AE_SCHEMA_SQL.match(
      /CREATE OR REPLACE VIEW IF NOT EXISTS \$\{DATABASE\}\.\w+_current AS\s*SELECT \* FROM \$\{DATABASE\}\.\w+ FINAL;/g,
    );
    expect(viewBodies).toHaveLength(62);
  });

  it('every ReplacingMergeTree table has a _current view; the append-only tables have none', () => {
    // Every table except the two append-only MergeTree tables
    // (ae_schema_version, ae_ingest_run) is ReplacingMergeTree and has a
    // _current view.
    const replacing = tables.filter((t) => t.engine?.startsWith('ReplacingMergeTree'));
    expect(replacing).toHaveLength(62);
    for (const table of replacing) {
      expect(
        AE_SCHEMA_SQL.includes(`CREATE OR REPLACE VIEW IF NOT EXISTS \${DATABASE}.${table.name}_current`),
        `${table.name}_current`,
      ).toBe(true);
    }
    expect(AE_SCHEMA_SQL).not.toContain('ae_schema_version_current');
    expect(AE_SCHEMA_SQL).not.toContain('ae_ingest_run_current');
    const schemaVersion = tables.find((t) => t.name === 'ae_schema_version');
    const ingestRun = tables.find((t) => t.name === 'ae_ingest_run');
    expect(schemaVersion.engine).toBe('MergeTree');
    expect(ingestRun.engine).toBe('MergeTree');
  });

  it('every PARTITION BY toYYYYMM(x) column appears in the table ORDER BY', () => {
    const partitioned = tables.filter((t) => t.partitionBy !== null);
    expect(partitioned.length).toBeGreaterThan(0);
    for (const table of partitioned) {
      expect(table.orderBy, `${table.name} ORDER BY must include ${table.partitionBy}`).toContain(
        table.partitionBy,
      );
    }
  });

  it('has no PII columns', () => {
    // Flags and consent states that never hold PII values (plan S05/S12):
    // booleans for "contact present" and marketing-consent state strings.
    const allowedFlags = new Set(['email_marketing_state', 'sms_marketing_state', 'has_email', 'has_phone']);
    const piiRe = /email|phone|address|first_name|last_name/i;
    const violations = [];
    for (const table of tables) {
      for (const column of table.columns) {
        if (!piiRe.test(column)) continue;
        if (column.endsWith('_hash') || column.endsWith('_key')) continue;
        if (allowedFlags.has(column)) continue;
        violations.push(`${table.name}.${column}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('contains no destructive DDL', () => {
    expect(AE_SCHEMA_SQL).not.toMatch(/DROP|TRUNCATE|ALTER\s+TABLE.*DELETE/i);
  });

  it('AE_FACT_TABLE_RE matches the fact tables and exempts ae_site_queue', () => {
    for (const table of ['ae_src_order', 'ae_dataset_row', 'ae_analysis_checkpoint', 'ae_trend_row', 'ae_experiment_row', 'ae_experiment_descriptor', 'ae_session_tag_trend', 'ae_session_tag_selection', 'ae_traffic_exclusion_model', 'ae_requirement_status', 'ae_strategy_card', 'ae_trigger_hit', 'ae_trigger_chain']) {
      expect(AE_FACT_TABLE_RE.test(`${DATABASE}.${table}`), table).toBe(true);
    }
    expect(AE_FACT_TABLE_RE.test(`${DATABASE}.ae_site_queue`)).toBe(false);
    expect(AE_FACT_TABLE_RE.test(`${DATABASE}.ae_trigger_definition`)).toBe(false);
    expect(AE_FACT_TABLE_RE.test(`${DATABASE}.ae_segmentation_definition`)).toBe(false);
  });
});
