import { describe, expect, it } from 'vitest';
import { FACT_BOUNDS, createQueryBoundGaps, factBounds, queryBoundGaps } from '../../src/governance/query-bounds.js';

/**
 * The fact-table bounds and the gap check over them. The table list is the
 * one the closed map held before bounds could be declared by a dataset
 * descriptor, so moving a table keeps every rule.
 */

const BEFORE = {
  log_visit: { date: 'server_date', idsite: true },
  log_hsr: { date: 'server_date', idsite: true, idsitehsr: true },
  log_hsr_event: { date: 'server_date', idsite: true, idsitehsr: true },
  log_conversion: { date: 'server_date', idsite: true },
  journey_events_map: { date: 'server_date', idsite: true },
  udp_hsrce_visits: { date: 'server_date', idsite: true },
  udp_hsrce_pageviews: { date: 'server_date', idsite: true, idsitehsr: true },
  udp_clicksce_clicks: { date: 'server_date', idsite: true, idsitehsr: true },
  udp_conversions: { date: 'server_date', idsite: true },
  journey_custom_map: { date: 'server_date', idsite: true, idsitehsr: true },
  session_tags: { date: 'server_date', idsite: true, idsitehsr: true },
  udp_session_tags: { date: 'server_date', idsite: true, idsitehsr: true },
  partner_tags: { date: 'server_date', idsite: true, idsitehsr: true },
  udp_partner_tags: { date: 'server_date', idsite: true },
  udp_am_zones: { date: 'server_date', idsite: true, idsitehsr: true },
  udp_am_elements: { date: 'server_date', idsite: true, idsitehsr: true },
  section_level_data: { date: 'server_date', idsite: true, idsitehsr: true },
  conversion_item: { date: 'server_time', idsite: true },
  industry_insight: { date: 'server_date' },
  site_hsr: { idsite: true, idsitehsr: true },
  page_speed_cache: { date: 'fetched_at', idsite: true },
};

describe('fact-table bounds', () => {
  it('hold the same rule for every table', () => {
    expect({ ...FACT_BOUNDS }).toEqual(BEFORE);
  });

  it('flag each unbound alias, and idsitehsr only when the page is known', () => {
    const sql = `SELECT 1 FROM journey_events.section_level_data AS s
      JOIN udp_partner_tags AS t ON t.idvisit = s.idvisit
     WHERE s.idsite = {idsite:UInt32} AND s.server_date BETWEEN {a:Date} AND {b:Date}
       AND t.server_date = s.server_date`;
    expect(queryBoundGaps(sql)).toEqual(['t.server_date (udp_partner_tags)', 't.idsite (udp_partner_tags)']);
    expect(queryBoundGaps(sql, { idsitehsr: true })).toEqual([
      's.idsitehsr (section_level_data)',
      't.server_date (udp_partner_tags)',
      't.idsite (udp_partner_tags)',
    ]);
    expect(queryBoundGaps('SELECT 1 FROM conversion_item WHERE idsite = 1')).toEqual(['conversion_item.server_time']);
  });

  it("take a dataset descriptor's factTables, and reject a bad or conflicting declaration", () => {
    const bounds = factBounds([
      { source: 'shared', factTables: { log_visit: { date: 'server_date', idsite: true } } },
      { source: 'a.descriptor.json', factTables: { new_table: { date: 'day', idsite: true } } },
      { source: 'b.descriptor.json', factTables: { new_table: { idsite: true, date: 'day' } } },
    ]);
    const gaps = createQueryBoundGaps(bounds);
    expect(gaps('SELECT 1 FROM new_table WHERE idsite = 1')).toEqual(['new_table.day']);
    expect(gaps('SELECT 1 FROM section_level_data')).toEqual([]);

    expect(() => factBounds([
      { source: 'a.descriptor.json', factTables: { t: { date: 'server_date' } } },
      { source: 'b.descriptor.json', factTables: { t: { date: 'server_time' } } },
    ])).toThrow('b.descriptor.json: factTables.t differs from the bounds in a.descriptor.json');
    expect(() => factBounds([{ source: 'x', factTables: { t: { day: 'd' } } }])).toThrow('x: factTables.t has unknown key "day"');
    expect(() => factBounds([{ source: 'x', factTables: { t: { idsite: 'yes' } } }])).toThrow('x: factTables.t.idsite must be true or false');
  });
});
