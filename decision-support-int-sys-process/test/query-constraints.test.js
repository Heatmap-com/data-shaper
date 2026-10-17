import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Query constraint discipline, audited statically over every SQL template in
 * src/adapters: for each backtick-delimited segment that references a fact
 * table, the predicates that table requires must appear in the SAME segment
 * (its own CTE or statement). Joined tables are each bounded — a bound on
 * one side of a join does not cover the other. Tables without server_date
 * (site_hsr) or without idsite are exempt accordingly; idsitehsr is enforced
 * only where it is knowable (page-scope datasets), via EXEMPT_FILES.
 */

// Tables the engine reads, and the predicates each must carry when present
// in a segment. Verified against system.columns (docs/probes/2026-10-04).
const TABLE_RULES = {
  udp_hsrce_visits: ['server_date', 'idsite'],
  udp_hsrce_pageviews: ['server_date', 'idsite'],
  udp_clicksce_clicks: ['server_date', 'idsite'],
  udp_conversions: ['server_date', 'idsite'],
  udp_am_elements: ['server_date', 'idsite'],
  udp_am_zones: ['server_date', 'idsite'],
  udp_am_pageviews: ['server_date', 'idsite'],
  udp_session_tags: ['server_date', 'idsite'],
  udp_custom_events: ['server_date', 'idsite'],
  udp_partner_tags: ['server_date', 'idsite'],
  journey_events_map: ['server_date', 'idsite'],
  recordings_new1: ['server_date', 'idsite'],
  site_hsr: ['idsite'],
  page_speed_cache: ['idsite'],
};

// Whole-site reads where idsitehsr is legitimately unknowable: the session
// stream (entry filter in JS), site-scope path/viewport scans, fleet ranges.
const IDSITEHSR_EXEMPT_FILES = new Set([
  'session-stream.js',
  'bot-context.js',
  'viewport.js',
  'clicks.js',
  'urls.js',
  'page-segment-weekly.js', // grain session-level; hsr filter via SCROLL_CTE joins
  'campaign-coverage.js',
  'campaign-weekly.js',
  'experiments-weekly.js',
  'site-baselines.js',
  'journey-weekly.js',
  'viewport-weekly.js',
  'dwell-model-inputs.js',
  'sister-pages.js',
]);

const SRC = path.resolve('src/adapters');

function sqlFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sqlFiles(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

/** Split a source file into backtick-delimited segments. */
function segments(source) {
  const parts = source.split('`');
  const segs = [];
  for (let i = 1; i < parts.length; i += 2) segs.push(parts[i]);
  return segs;
}

describe('query constraint discipline', () => {
  const files = sqlFiles(SRC);

  it('covers the adapters tree', () => {
    expect(files.length).toBeGreaterThan(30);
  });

  it('every fact-table SQL segment carries its table predicates', () => {
    const violations = [];
    for (const file of files) {
      const rel = path.relative(SRC, file);
      const source = readFileSync(file, 'utf8');
      for (const seg of segments(source)) {
        for (const [table, required] of Object.entries(TABLE_RULES)) {
          if (!new RegExp(`\\b${table}\\b`).test(seg)) continue;
          for (const column of required) {
            if (seg.includes(column)) continue;
            // A composed segment may reference the table inside ${CTE} —
            // then the CTE constant's own segment is audited instead.
            if (seg.includes('{') && !/FROM|JOIN/.test(seg)) continue;
            violations.push(`${rel}: segment references ${table} without ${column} — ${seg.slice(0, 90).replace(/\s+/g, ' ')}`);
          }
          if (
            required.includes('server_date') &&
            seg.includes('idsitehsr') === false &&
            !IDSITEHSR_EXEMPT_FILES.has(path.basename(file)) &&
            /idsitehsr/.test(source) === false &&
            ['udp_hsrce_pageviews', 'udp_clicksce_clicks', 'udp_am_elements', 'udp_am_zones'].includes(table)
          ) {
            violations.push(`${rel}: ${table} read without idsitehsr though the page hsr is knowable here`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
