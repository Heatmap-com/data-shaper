// Phase 0 probe runner — READ-ONLY. Every query is a system.* lookup, a
// bounded aggregate, or a LIMITed sample on the three pilot sites
// (3199, 3207, 3228). No writes, no DDL. Output: docs/probes/<date>-*.md
// tables get their data from the JSON this prints.
// Usage: node scripts/probes/run-probes.mjs > /tmp/probes.json
import { clickHouseConfig, createClickHouseClient } from '../../src/composition/clickhouse.js';

const client = createClickHouseClient(clickHouseConfig(process.env));
const q = async (sql, params = {}) =>
  (await client.query({ query: sql, query_params: params, format: 'JSONEachRow' })).json();

const PILOTS = [3199, 3207, 3228];
const out = { run_at: new Date().toISOString(), pilots: PILOTS, probes: {} };

// ── P1: udp_custom_events + journey_custom_map columns and payload shape ──
out.probes.custom_events_columns = await q(
  `SELECT table, name, type FROM system.columns
    WHERE database = 'default' AND table IN ('udp_custom_events', 'journey_custom_map')
    ORDER BY table, position`,
);
out.probes.custom_events_sample = await q(
  `SELECT idsite, event_type, event_id, toString(server_time) AS server_time
     FROM default.udp_custom_events
    WHERE idsite IN {p:Array(UInt32)} AND server_date >= toDate('2026-09-01')
    ORDER BY server_time DESC LIMIT 10`,
  { p: PILOTS },
);
out.probes.custom_events_volume = await q(
  `SELECT idsite, count() AS rows, uniqExact(event_type) AS distinct_names,
          min(server_date) AS first_seen, max(server_date) AS last_seen
     FROM default.udp_custom_events
    WHERE idsite IN {p:Array(UInt32)} AND server_date >= toDate('2026-06-01')
    GROUP BY idsite ORDER BY idsite`,
  { p: PILOTS },
);

// ── P2: browser + visitor-id columns on visits/pageviews ──
out.probes.visits_columns = await q(
  `SELECT table, name, type FROM system.columns
    WHERE database = 'default' AND table IN ('udp_hsrce_visits', 'udp_hsr_pageviews', 'udp_hsrce_pageviews')
      AND (positionCaseInsensitive(name, 'visitor') > 0 OR positionCaseInsensitive(name, 'browser') > 0
           OR positionCaseInsensitive(name, 'config_device') > 0 OR name = 'idvisit')
    ORDER BY table, position`,
);

// ── P3: attention tables coverage and retention ──
for (const t of ['udp_am_elements', 'udp_am_zones', 'udp_am_pageviews']) {
  out.probes[`attention_${t}`] = {
    columns: await q(
      `SELECT name, type FROM system.columns WHERE database = 'default' AND table = {t:String} ORDER BY position`,
      { t },
    ),
    coverage: await q(
      `SELECT idsite, count() AS rows, min(server_date) AS first_seen, max(server_date) AS last_seen
         FROM default.${t} WHERE idsite IN {p:Array(UInt32)} GROUP BY idsite ORDER BY idsite`,
      { p: PILOTS },
    ),
  };
}
out.probes.am_zones_sample = await q(
  `SELECT * FROM default.udp_am_zones WHERE idsite = 3199 AND server_date >= toDate('2026-09-28') LIMIT 3`,
);

// ── P4: udp_conversions.idorder shape (Shopify join feasibility, Q7) ──
out.probes.idorder_shape = await q(
  `SELECT idsite, count() AS orders, uniqExact(idorder) AS distinct_ids,
          min(length(idorder)) AS min_len, max(length(idorder)) AS max_len,
          anyHeavy(idorder) AS sample
     FROM default.udp_conversions FINAL
    WHERE idsite IN {p:Array(UInt32)} AND server_date >= toDate('2026-09-01')
    GROUP BY idsite ORDER BY idsite`,
  { p: PILOTS },
);

// ── P5: recordings_new1 filterability ──
out.probes.recordings_columns = await q(
  `SELECT name, type FROM system.columns WHERE database = 'default' AND table = 'recordings_new1' ORDER BY position`,
);
out.probes.recordings_coverage = await q(
  `SELECT idsite, count() AS rows, min(server_date) AS first_seen, max(server_date) AS last_seen
     FROM default.recordings_new1 WHERE idsite IN {p:Array(UInt32)} GROUP BY idsite ORDER BY idsite`,
  { p: PILOTS },
);

// ── P6: partner tags (H16 experiments) and page_speed_cache (H15) ──
out.probes.partner_tags = await q(
  `SELECT idsite, count() AS rows, uniqExact(experience_id) AS experiences, uniqExact(variant_id) AS variants,
          min(server_date) AS first_seen, max(server_date) AS last_seen
     FROM default.udp_partner_tags
    WHERE idsite IN {p:Array(UInt32)} AND server_date >= toDate('2026-06-01') AND server_date <= toDate('2026-10-03')
    GROUP BY idsite ORDER BY idsite`,
  { p: PILOTS },
);
out.probes.page_speed_cache = await q(
  `SELECT idsite, count() AS rows, min(fetched_at) AS first_fetched, max(fetched_at) AS last_fetched
     FROM journey_events.page_speed_cache WHERE idsite IN {p:Array(UInt32)} GROUP BY idsite ORDER BY idsite`,
  { p: PILOTS },
);

console.log(JSON.stringify(out, null, 1));
process.exit(0);
