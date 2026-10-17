import { describe, expect, it } from 'vitest';
import { createGateway } from '../src/adapters/query-gateway/clickhouse.js';
import { boundGaps } from '../src/audit/bounds.js';
import { queryBoundGaps } from '../src/governance/query-bounds.js';

const three = `
SELECT count()
FROM default.log_hsr AS h
JOIN default.log_hsr_event AS e ON e.idloghsr = h.idloghsr
JOIN default.log_visit AS v ON v.idvisit = h.idvisit
WHERE h.idsite = {idsite:UInt32}
  AND h.server_date BETWEEN {start:Date} AND {end:Date}
  AND e.idsite = {idsite:UInt32}
  AND e.server_date BETWEEN {start:Date} AND {end:Date}
  AND v.idsite = {idsite:UInt32}
  AND v.server_date BETWEEN {start:Date} AND {end:Date}
`;

describe('query bounds', () => {
  it('requires server_date and idsite on every joined alias that has them', () => {
    expect(queryBoundGaps(three)).toEqual([]);
    const dropped = three.replace('AND e.server_date BETWEEN {start:Date} AND {end:Date}', '');
    expect(queryBoundGaps(dropped)).toEqual(['e.server_date (log_hsr_event)']);
    const joinedOnly = three.replace(
      'AND e.server_date BETWEEN {start:Date} AND {end:Date}',
      'AND e.server_date = h.server_date',
    );
    expect(queryBoundGaps(joinedOnly)).toEqual(['e.server_date (log_hsr_event)']);
  });

  it('requires idsitehsr on every alias that has it when the page is known', () => {
    expect(queryBoundGaps(three, { idsitehsr: true })).toEqual([
      'h.idsitehsr (log_hsr)',
      'e.idsitehsr (log_hsr_event)',
    ]);
    const page = `${three}
      AND h.idsitehsr = {idsitehsr:UInt64}
      AND e.idsitehsr = {idsitehsr:UInt64}`;
    expect(queryBoundGaps(page, { idsitehsr: true })).toEqual([]);
    expect(boundGaps(page, { idsitehsr: true })).toEqual([]);
  });

  it('does not require idsitehsr on a site-level query', () => {
    expect(queryBoundGaps(three, { idsitehsr: false })).toEqual([]);
  });
});

describe('gateway query bounds', () => {
  const gateway = createGateway(
    { async query() { return { json: async () => [] }; } },
    { logger: { info() {} } },
  );

  it('refuses a trend query that leaves a joined server_date unconstrained', async () => {
    const sql = three.replace('AND v.server_date BETWEEN {start:Date} AND {end:Date}', '');
    await expect(
      gateway.query(sql, { idsite: 1, start: '2026-09-01', end: '2026-09-07' }, 'trend:journey'),
    ).rejects.toThrow(/v\.server_date/);
  });

  it('refuses a page trend that knows idsitehsr and does not constrain it', async () => {
    await expect(
      gateway.query(three, { idsite: 1, idsitehsr: 33, start: '2026-09-01', end: '2026-09-07' }, 'trend:element'),
    ).rejects.toThrow(/h\.idsitehsr/);
  });

  it('allows the same site-level query when idsitehsr is not known', async () => {
    const rows = await gateway.query(
      three,
      { idsite: 1, start: '2026-09-01', end: '2026-09-07' },
      'trend:journey',
    );
    expect(rows).toEqual([]);
  });
});
