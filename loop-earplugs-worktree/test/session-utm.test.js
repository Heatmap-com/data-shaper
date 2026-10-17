import { describe, expect, it } from 'vitest';
import { VISITS_CTE } from '../src/adapters/_lib/sql.js';
import { sessionCtes } from '../src/enrichment/trend-sql.js';
import { createLocalWarehouse } from './support/local-warehouse.js';

/**
 * The tag puts a session's UTMs on its session tags; the visit's custom
 * variables hold them for fewer sessions. The session queries read the tag
 * value first and fall back to the custom variable, key by key.
 */
const DAY = '2026-09-08';
const visit = (idvisit, k5, v1, v4) => ({
  idsite: 1, idvisit, server_date: DAY, visit_first_action_time: `${DAY} 10:00:00`, custom_var_k5: k5, custom_var_v1: v1, custom_var_v4: v4,
});
const tag = (idvisit, idloghsr, tags) => ({ idsite: 1, idvisit, idloghsr, server_date: DAY, session_tags: tags });

const ROWS = {
  udp_hsrce_visits: [
    visit(1, 'Google', null, null),
    visit(2, ' Klaviyo ', 'Email', 'Oct'),
    visit(3, null, null, null),
    visit(4, 'google', 'cpc', null),
  ],
  udp_session_tags: [
    tag(1, 5, '{"UTM_Source":" Facebook ","utm_medium":"Paid"}'),
    tag(1, 3, '{"utm_source":"","utm_campaign":"Fall "}'),
    tag(3, 7, '{}'),
    tag(4, 9, '{"utm_medium":"display"}'),
    tag(4, 2, '{"utm_medium":"social"}'),
  ],
};

const EXPECTED = {
  1: ['facebook', 'paid', 'Fall'],
  2: ['klaviyo', 'email', 'Oct'],
  3: ['', '', ''],
  4: ['google', 'social', ''],
};

describe('session UTMs', () => {
  const params = { idsite: 1, w0: '2026-09-07', w1: '2026-09-13' };

  it('reads the session tags first, key by key, and the custom variables for the rest', async () => {
    const warehouse = createLocalWarehouse(ROWS);
    const rows = await warehouse.query(
      `WITH ${sessionCtes()} SELECT toString(idvisit) AS idvisit, utm_source, utm_medium, utm_campaign FROM visits`,
      params,
      'test:session-utm',
    );
    expect(Object.fromEntries(rows.map((r) => [r.idvisit, [r.utm_source, r.utm_medium, r.utm_campaign]]))).toEqual(EXPECTED);
  }, 60_000);

  it('gives the session stream the same utm_source', async () => {
    const warehouse = createLocalWarehouse(ROWS);
    const rows = await warehouse.query(`WITH ${VISITS_CTE} SELECT toString(idvisit) AS idvisit, utm_source FROM visits`, params, 'test:session-utm');
    expect(Object.fromEntries(rows.map((r) => [r.idvisit, r.utm_source ?? '']))).toEqual(
      Object.fromEntries(Object.entries(EXPECTED).map(([id, [source]]) => [id, source])),
    );
  }, 60_000);
});
