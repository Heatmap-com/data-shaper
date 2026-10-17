import { execFileSync } from 'node:child_process';

/**
 * The warehouse tables the session stream, the trigger facts, and the day
 * scan read, with the column types those queries rely on. Visit times are
 * text, as on the live table.
 */
export const TABLES = {
  udp_hsrce_visits: {
    engine: 'MergeTree ORDER BY tuple()',
    columns: {
      idsite: 'UInt32', idvisit: 'UInt64', server_date: 'Date', visit_first_action_time: 'String',
      config_id: 'Nullable(String)', config_device_type: 'UInt8', referer_type: 'UInt8',
      visitor_returning: 'Nullable(Bool)', location_country: 'Nullable(String)', location_city: 'String',
      config_resolution: 'String', config_browser_name: 'String', config_browser_version: 'String',
      visit_entry_idaction_url: 'String', custom_var_k5: 'Nullable(String)',
      referer_name: 'Nullable(String)', custom_var_v1: 'Nullable(String)', custom_var_v4: 'Nullable(String)',
    },
  },
  udp_hsrce_pageviews: {
    engine: 'MergeTree ORDER BY tuple()',
    columns: {
      idsite: 'UInt32', idvisit: 'UInt64', idloghsr: 'UInt64', idsitehsr: 'UInt64', server_date: 'Date', server_time: 'String',
      time_on_page: 'Nullable(UInt64)', scroll_y_max_relative: 'Nullable(UInt16)', viewport_h_px: 'Nullable(UInt16)',
    },
  },
  journey_events_map: {
    engine: 'MergeTree ORDER BY tuple()',
    columns: { idsite: 'UInt32', idvisit: 'Int64', server_date: 'Date', event_type: 'String', ts_ms: 'UInt64' },
  },
  udp_conversions: {
    engine: 'ReplacingMergeTree ORDER BY (idsite, idvisit, idorder, server_date)',
    columns: { idsite: 'UInt32', idvisit: 'UInt64', server_date: 'Date', idorder: 'String', revenue: 'Float64' },
  },
  udp_clicksce_clicks: {
    engine: 'MergeTree ORDER BY tuple()',
    columns: {
      idsite: 'UInt32', idvisit: 'UInt64', idloghsr: 'UInt64', idsitehsr: 'UInt64', server_date: 'Date', date: 'String', hour: 'String',
      idselector: 'String', meta1: 'String', a_x: 'Nullable(Int32)', a_y: 'Nullable(Int32)', time_since_load: 'Nullable(Int64)',
    },
  },
  udp_session_tags: {
    engine: 'MergeTree ORDER BY tuple()',
    columns: { idsite: 'UInt32', idvisit: 'UInt64', idloghsr: 'UInt64', server_date: 'Date', session_tags: 'String' },
  },
  udp_partner_tags: {
    engine: 'MergeTree ORDER BY tuple()',
    columns: {
      idsite: 'UInt32', idvisit: 'UInt64', idloghsr: 'UInt64', idsitehsr: 'UInt64', server_date: 'Date',
      partner: 'String', experience_id: 'String', variant_id: 'String',
    },
  },
  udp_am_elements: {
    engine: 'MergeTree ORDER BY tuple()',
    columns: { idsite: 'UInt32', server_date: 'Date', selector: 'String', label: 'String', role: 'String' },
  },
  site_hsr: {
    engine: 'MergeTree ORDER BY tuple()',
    columns: { idsite: 'UInt32', idsitehsr: 'UInt64', screenshot_url: 'String', name: 'String' },
  },
};

const DEFAULTS = { UInt32: 0, UInt64: 0, Int64: 0, Int32: 0, UInt8: 0, UInt16: 0, Float64: 0, String: '', Date: '1970-01-01' };

/** @param {string} value */
function paramValue(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => (typeof item === 'number' || typeof item === 'bigint' ? String(item) : `'${String(item).replaceAll("'", "\\'")}'`)).join(',')}]`;
  }
  return String(value);
}

/**
 * A query gateway over `clickhouse local`, loaded with `rows` per table. Each
 * query creates the tables, inserts the rows, and runs, so queries see the
 * same data and nothing persists between them. `calls` records each label;
 * `columns` lists a table's columns as the column checks read them.
 *
 * @param {Record<string, object[]>} rows table name → rows; missing columns take type defaults
 * @param {Record<string, Record<string, string>>} [extraColumns] table name → more columns, for a warehouse that has them
 */
export function createLocalWarehouse(rows, extraColumns = {}) {
  const tables = Object.fromEntries(Object.entries(TABLES).map(([table, spec]) => [table, { ...spec, columns: { ...spec.columns, ...extraColumns[table] } }]));
  const setup = ['CREATE DATABASE IF NOT EXISTS default'];
  for (const [table, spec] of Object.entries(tables)) {
    const structure = Object.entries(spec.columns).map(([name, type]) => `${name} ${type}`).join(', ');
    setup.push(`CREATE TABLE default.${table} (${structure}) ENGINE = ${spec.engine}`);
    const data = (rows[table] ?? []).map((row) => {
      const full = {};
      for (const [name, type] of Object.entries(spec.columns)) {
        full[name] = row[name] ?? (type.startsWith('Nullable') ? null : DEFAULTS[type]);
      }
      return JSON.stringify(full);
    });
    if (data.length > 0) {
      setup.push(`INSERT INTO default.${table} SELECT * FROM format(JSONEachRow, '${structure}', $$${data.join('\n')}$$)`);
    }
  }
  const calls = [];
  return {
    calls,
    async columns(table) {
      return Object.entries(tables[table.replace(/^default\./, '')]?.columns ?? {}).map(([name, type]) => ({ name, type }));
    },
    async query(sql, params = {}, label = '') {
      calls.push(label);
      const args = ['local', '--multiquery'];
      for (const [name, value] of Object.entries(params)) args.push(`--param_${name}=${paramValue(value)}`);
      const script = `${setup.join(';\n')};\n${sql.trim().replace(/;\s*$/, '')}\nFORMAT JSONEachRow`;
      const out = execFileSync('clickhouse', [...args, '--query', script], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      return out.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    },
  };
}
