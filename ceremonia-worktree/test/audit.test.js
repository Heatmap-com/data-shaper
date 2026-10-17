import { describe, expect, it } from 'vitest';
import { createGateway } from '../src/adapters/query-gateway/clickhouse.js';
import { contextAcquisitionQueries } from '../src/audit/queries/context.js';
import { funnelAcquisitionQueries, funnelChannelQuery, funnelWeeklyQuery, siteKpiQuery } from '../src/audit/queries/funnel.js';
import { elementScorecardQuery, templateAcquisitionQueries, templateWeeklyQuery } from '../src/audit/queries/template.js';
import { shapeAcquisition } from '../src/audit/shape.js';
import { selectBrands } from '../src/audit/brands.js';

const BRANDS = [{ key: 'ceremonia', name: 'Ceremonia', domain: 'ceremonia.com' }];
import { classifyTemplate } from '../src/audit/classify.js';
import { revenueAtStakeByStep } from '../src/audit/funnel.js';
import { mixRateRows } from '../src/audit/interpret.js';
import { parseAuditInputs } from '../src/audit/matrix.js';
import { choosePilot, rankFindings } from '../src/audit/rank.js';
import { readinessQueries } from '../src/audit/queries/readiness.js';
import { gapDates, interpretReadiness } from '../src/audit/readiness.js';
import { runAudit } from '../src/audit/runner.js';
import { boundGaps, chunkDaysFor, templateIds, trackedIds, weekChunks } from '../src/audit/bounds.js';
import { sessionSqlGaps } from '../src/audit/sql.js';
import { revenueAtStake, trendLabel, twoProportionZ } from '../src/audit/stats.js';
import { addDays, auditWindows, daysInclusive } from '../src/audit/windows.js';

const TODAY = '2026-10-06';
const windows = auditWindows(TODAY);

describe('audit windows', () => {
  it('uses complete ISO weeks and a 28-day snapshot ending yesterday', () => {
    expect(new Date(`${windows.trendEnd}T00:00:00Z`).getUTCDay()).toBe(0);
    expect(new Date(`${windows.trendStart}T00:00:00Z`).getUTCDay()).toBe(1);
    expect(daysInclusive(windows.trendStart, windows.trendEnd)).toBe(52 * 7);
    expect(daysInclusive(windows.elementStart, windows.elementEnd)).toBe(26 * 7);
    expect(daysInclusive(windows.extendedStart, windows.trendEnd)).toBe(104 * 7);
    expect(windows.snapshotEnd).toBe('2026-10-05');
    expect(daysInclusive(windows.snapshotStart, windows.snapshotEnd)).toBe(28);
    expect(windows.priorEnd).toBe(addDays(windows.snapshotStart, -1));
    expect(daysInclusive(windows.priorStart, windows.priorEnd)).toBe(28);
    expect(windows.trendEnd < TODAY).toBe(true);
  });
});

describe('audit stats', () => {
  it('labels a trend only when the slope and year-over-year agree', () => {
    expect(trendLabel(1.2, 0.1)).toBe('improving');
    expect(trendLabel(-0.4, -0.2)).toBe('deteriorating');
    expect(trendLabel(1.2, -0.2)).toBe('disputed');
    expect(trendLabel(0, 0.2)).toBe('stable');
    expect(trendLabel(null, 0.2)).toBe('insufficient');
  });

  it('z-tests a proportion and prices revenue at stake', () => {
    const separated = twoProportionZ(100, 1000, 50, 1000);
    expect(separated.significant).toBe(true);
    const same = twoProportionZ(80, 1000, 80, 1000);
    expect(same.significant).toBe(false);
    expect(revenueAtStake(100, 0.05, 0.02, 40)).toBeCloseTo(120);
  });
});

describe('audit sql', () => {
  it('puts the portal bot predicate and the site parameter on session queries', () => {
    const brand = { key: 'ceremonia', name: 'Ceremonia', domain: 'ceremonia.com', idsite: 9 };
    for (const id of ['R3', 'R8', 'R10']) {
      const query = readinessQueries(brand, windows).find((q) => q.id === id);
      expect(sessionSqlGaps(query.sql), id).toEqual([]);
    }
    expect(sessionSqlGaps(siteKpiQuery(9, windows).sql)).toEqual([]);
    expect(sessionSqlGaps(funnelWeeklyQuery(9, windows).sql)).toEqual([]);
    expect(sessionSqlGaps(templateWeeklyQuery(9, windows).sql)).toEqual([]);
    const scorecard = elementScorecardQuery(9, 'pdp', windows, [
      {
        idsite: 9,
        template: 'pdp',
        element_class: 'pdp.add_to_cart',
        element_name: 'Add to cart',
        selector_match: 'button.add',
        position: null,
        valid_from: '2024-01-01',
        valid_to: '2099-01-01',
        absent: false,
      },
    ]);
    expect(sessionSqlGaps(scorecard.sql)).toEqual([]);
    expect(scorecard.sql).toContain('log_hsr_event');
    expect(scorecard.sql).toContain('idloghsr');
    expect(scorecard.sql).toContain('event_type = 2');
  });

  it('refuses a log_hsr_event scan that omits the site parameter', async () => {
    const gateway = createGateway({ async query() { return { json: async () => [] }; } }, { logger: { info() {} } });
    await expect(gateway.query('SELECT * FROM default.log_hsr_event', {}, 'audit')).rejects.toThrow(/gateway refused/);
  });
});

describe('readiness verdict', () => {
  it('blocks a brand the registry does not contain', () => {
    const brand = selectBrands(BRANDS, ['ceremonia'])[0];
    const verdict = interpretReadiness(brand, windows, { R1: { rows: [] } });
    expect(verdict.verdict).toBe('blocked');
    expect(verdict.reasons).toContain('R1 missing');
  });

  it('is partial when revenue is usable but templates and the matrix are not', () => {
    const brand = { ...selectBrands(BRANDS, ['ceremonia'])[0], idsite: 9 };
    const days = [];
    for (let day = windows.trendStart; day <= windows.trendEnd; day = addDays(day, 1)) {
      days.push({ day, sessions: 20 });
    }
    const results = {
      R1: { rows: [{ idsite: 9, name: 'Ceremonia', main_url: 'https://ceremonia.com', platform: 'shopify', currency: 'USD', status: 'active' }] },
      'R2:log_visit': { rows: [{ max_date: windows.yesterday }] },
      'R2:log_hsr': { rows: [{ max_date: windows.yesterday }] },
      'R2:log_conversion': { rows: [{ max_date: windows.yesterday }] },
      'R2:journey_events_map': { rows: [{ max_date: windows.yesterday }] },
      R3: { rows: days },
      R4: { rows: [{ orders: 100, zero_revenue: 0, distinct_orders: 100 }] },
      R4unmatched: { rows: [{ orders: 100, unmatched: 0 }] },
      R5pages: { rows: [{ idsitehsr: '1', pageviews: 10 }] },
      R5urls: { rows: [{ idsitehsr: '1', url: 'https://ceremonia.com/' }] },
      R6: { rows: [{ event_type: 'checkout_completed', sessions: 100 }] },
      R8: { rows: [{ device: 'Mobile', returning: 'new', channel: 'Direct', sessions: 2000, buyers: 80 }] },
    };
    const verdict = interpretReadiness(brand, windows, results, { entries: [] });
    expect(verdict.verdict).toBe('partial');
    expect(verdict.reasons.some((r) => r.startsWith('R5'))).toBe(true);
    expect(verdict.reasons.some((r) => r.startsWith('R9'))).toBe(true);
    expect(gapDates([{ day: windows.trendStart, sessions: 0 }], windows.trendStart, windows.trendStart)).toEqual([windows.trendStart]);
  });
});

describe('funnel stake and ranking', () => {
  it('prices sessions lost at a step by the RPS of sessions that reached it', () => {
    const stakes = revenueAtStakeByStep([
      {
        device: 'Mobile',
        returning: 'new',
        sessions: 1000,
        buyers: 100,
        reach_homepage_viewed: 400,
        prog_homepage_viewed: 400,
        revenue_homepage_viewed: 800,
      },
    ]);
    const home = stakes.find((r) => r.dims.step === 'homepage_viewed');
    expect(home.metrics.sessions_lost).toBe(600);
    expect(home.metrics.revenue_at_stake).toBe(1200);
  });

  it('picks the pilot from brands that are not blocked and ranks stake', () => {
    expect(choosePilot([
      { brand: 'a', verdict: 'blocked', revenueAtStake: 999, reportableShare: 1 },
      { brand: 'b', verdict: 'partial', revenueAtStake: 10, reportableShare: 0.2 },
      { brand: 'c', verdict: 'ready', revenueAtStake: 40, reportableShare: 0.1 },
    ])).toBe('c');
    const ranked = rankFindings([
      { brand: 'c', query: 'F14', label: 'small', revenueAtStake: 5 },
      { brand: 'c', query: 'F14', label: 'large', revenueAtStake: 50 },
    ]);
    expect(ranked[0].metrics.rank).toBe(1);
    expect(ranked[0].dims.label).toBe('large');
  });
});

describe('matrix and templates', () => {
  it('rejects a class outside the audit vocabulary', () => {
    expect(() => parseAuditInputs({
      entries: [{
        idsite: 9,
        template: 'pdp',
        element_class: 'hero_cta',
        element_name: 'Hero',
        selector_match: '.hero',
        valid_from: '2024-01-01',
        valid_to: '2099-01-01',
      }],
    })).toThrow(/does not belong/);
  });

  it('classifies a product URL under a collection path as a PDP', () => {
    expect(classifyTemplate('https://shop.example/collections/hair/products/oil')).toBe('pdp');
    expect(classifyTemplate('https://shop.example/collections/hair')).toBe('plp');
    expect(classifyTemplate('https://shop.example/cart')).toBe('cart_page');
    expect(classifyTemplate('https://shop.example/')).toBe('home');
  });
});

describe('audit acquisition', () => {
  const entry = {
    idsite: 9,
    template: 'pdp',
    element_class: 'pdp.add_to_cart',
    element_name: 'Add to cart',
    selector_match: 'button\\.add',
    position: null,
    valid_from: '2024-01-01',
    valid_to: '2099-12-31',
    absent: false,
  };

  it('covers the remaining plan groups and keeps click scans behind a live matrix', () => {
    const funnel = funnelAcquisitionQueries(9, windows, []);
    const ids = funnel.map((q) => q.id);
    expect(ids).toEqual(expect.arrayContaining(['F5', 'F6', 'F8', 'F9', 'F10', 'F11', 'F12']));
    expect(funnelChannelQuery(9, windows).sql).toContain('channel');
    const bare = templateAcquisitionQueries(9, windows, [], [], true).map((q) => q.id);
    expect(bare).not.toContain('H5');
    expect(bare).not.toContain('G6');
    const named = templateAcquisitionQueries(9, windows, [], [entry], true).map((q) => q.id);
    expect(named).toEqual(expect.arrayContaining(['H5', 'P8', 'P9', 'K1', 'K3', 'G6', 'G7']));
    const offsite = templateAcquisitionQueries(9, windows, [], [entry], false).map((q) => q.id);
    expect(offsite).not.toContain('K3');
    const context = contextAcquisitionQueries(9, windows, []).map((q) => q.id);
    expect(context).toEqual(['X2', 'X3', 'X4', 'X8']);
    const queries = [...funnel, ...templateAcquisitionQueries(9, windows, [], [entry], true), ...contextAcquisitionQueries(9, windows, [])];
    for (const query of queries) {
      const gaps = sessionSqlGaps(query.sql).filter((gap) => {
        if ((query.id === 'X3' || query.id === 'X8') && gap === 'bot') return false;
        if (query.id === 'X3' && gap === 'server_date') return false;
        return true;
      });
      expect(gaps, query.id).toEqual([]);
      expect(joinsAfterWhere(query.sql), query.id).toEqual([]);
      if (query.sql.includes('log_hsr_event')) {
        expect(query.sql, query.id).toContain('idloghsr');
        expect(query.sql, query.id).toContain('event_type = 2');
      }
    }
  });

  it('constrains every fact alias and prunes known pages', () => {
    const scope = {
      byTemplate: {
        home: [11], plp: [22], pdp: [33], cart_page: [44], checkout: [55], search: [66],
      },
    };
    const queries = [
      ...funnelAcquisitionQueries(9, windows, [], scope),
      ...templateAcquisitionQueries(9, windows, [], [entry], true, scope),
      ...contextAcquisitionQueries(9, windows, [], scope),
      templateWeeklyQuery(9, windows, [], trackedIds(scope)),
    ];
    for (const query of queries) {
      expect(boundGaps(query.sql), query.id).toEqual([]);
      if (query.sql.includes('idsitehsr IN {hsr:Array(UInt32)}')) {
        expect(query.params.hsr?.length, query.id).toBeGreaterThan(0);
        expect(query.params.hsr.length, query.id).toBeLessThanOrEqual(3000);
      }
    }
    const home = elementScorecardQuery(9, 'home', windows, [{ ...entry, template: 'home', element_class: 'home.hero_cta' }], [], [11]);
    expect(home.sql).toContain("'/cart'");
    expect(home.sql).not.toContain('+ = {idsite');
    expect(parenDepth(home.sql), 'home scorecard').toBe(0);
    const loopback = queries.find((q) => q.id === 'F10');
    expect(loopback.sql).toContain('avg(pdp_n)');
    expect(loopback.sql).not.toContain('avg(pdp_views)');
    const hero = { ...entry, template: 'home', element_class: 'home.hero_slide' };
    const h6 = templateAcquisitionQueries(9, windows, [], [hero], true, scope).find((q) => q.id === 'H6');
    expect(h6.sql).toContain('GROUP BY position, device');
    expect(h6.sql).not.toMatch(/GROUP BY[^\n]*\brevenue\b/);
    const pdp = queries.find((q) => q.id === 'P8');
    expect(pdp.params.hsr).toEqual([33]);
    const trend = queries.find((q) => q.id === 'H5');
    expect(trend.params.hsr).toEqual(trackedIds(scope));
    const wide = queries.find((q) => q.id === 'H2');
    expect(wide.params.hsr).toEqual(trackedIds(scope));
    expect(templateIds(scope, ['checkout'])).toEqual([55]);
  });

  it('splits a Monday trend into whole weeks', () => {
    const chunks = weekChunks(windows.trendStart, windows.trendEnd, 28);
    expect(chunks[0].start).toBe(windows.trendStart);
    expect(chunks.at(-1).end).toBe(windows.trendEnd);
    expect(chunks.every((c) => new Date(`${c.start}T00:00:00Z`).getUTCDay() === 1)).toBe(true);
    const weekly = templateWeeklyQuery(9, windows);
    expect(chunkDaysFor(weekly.sql, weekly.params)).toBe(28);
    const snapshot = funnelAcquisitionQueries(9, windows, []).find((q) => q.id === 'F6');
    expect(chunkDaysFor(snapshot.sql, snapshot.params)).toBe(0);
  });

  it('fans scroll rows out to the template plan ids', () => {
    const rows = shapeAcquisition('H2', [
      { week: '2026-09-28', template: 'home', device: 'Mobile', scroll_depth: 40, pageviews: 10 },
      { week: '2026-09-28', template: 'plp', device: 'Desktop', scroll_depth: 55, pageviews: 8 },
    ]);
    expect(rows.map((row) => row.dims.query).sort()).toEqual(['H2', 'L2']);
  });

  it('decomposes a site CR change into mix and rate', () => {
    const weeks = ['2026-08-03', '2026-08-10', '2026-08-17', '2026-08-24', '2026-08-31', '2026-09-07', '2026-09-14', '2026-09-21'];
    const f1 = weeks.flatMap((week, index) => [{
      dims: { query: 'F1', week, device: 'Mobile', returning: 'new', channel: 'Paid' },
      metrics: { sessions: 100, buyers: index < 4 ? 2 : 5, orders: 2, revenue: 100 },
    }, {
      dims: { query: 'F1', week, device: 'Desktop', returning: 'returning', channel: 'Direct' },
      metrics: { sessions: 100, buyers: 4, orders: 4, revenue: 200 },
    }]);
    const rows = mixRateRows(f1, { trendStart: weeks[0], trendEnd: weeks[7] });
    expect(rows.map((row) => row.dims.measure).sort()).toEqual(['cr', 'rps']);
    expect(rows.every((row) => row.metrics.rate_effect != null)).toBe(true);
  });
});

/** @param {string} sql */
function parenDepth(sql) {
  let depth = 0;
  for (const ch of sql) {
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    if (depth < 0) return depth;
  }
  return depth;
}

/**
 * A JOIN after WHERE in the same parenthesized depth is not valid SQL.
 * @param {string} sql
 */
function joinsAfterWhere(sql) {
  /** @type {string[]} */
  const problems = [];
  let depth = 0;
  /** @type {boolean[]} */
  const whereOpen = [false];
  const tokens = sql.split(/(\(|\)|\bWHERE\b|\bLEFT JOIN\b|\bINNER JOIN\b|\bCROSS JOIN\b)/i);
  for (const token of tokens) {
    if (token === '(') {
      depth += 1;
      whereOpen[depth] = false;
    } else if (token === ')') {
      whereOpen[depth] = false;
      depth = Math.max(0, depth - 1);
    } else if (/^WHERE$/i.test(token)) {
      whereOpen[depth] = true;
    } else if (/JOIN/i.test(token) && whereOpen[depth]) {
      problems.push(`depth ${depth}`);
    }
  }
  return problems;
}

describe('audit runner', () => {
  it('does not run the funnel for a blocked brand', async () => {
    const labels = [];
    const summary = await runAudit({
      gateway: {
        async query(_sql, _params, label) {
          labels.push(label);
          return [];
        },
      },
      brands: selectBrands(BRANDS, ['ceremonia']),
      clock: { todayUtc: () => TODAY },
      phase: 'all',
      dryRun: true,
    });
    expect(summary.brands[0].verdict).toBe('blocked');
    expect(labels).toContain('audit:R1');
    expect(labels).not.toContain('audit:F1');
    expect(labels).not.toContain('audit:H1');
  });

  it('stores readiness rows on the audit batch, tagged with the portal bot filter', async () => {
    /** @type {{ batch?: object, rows?: object[] }} */
    const written = {};
    await runAudit({
      gateway: {
        async query(_sql, _params, label) {
          if (label === 'audit:R1') {
            return [{ idsite: 9, name: 'Ceremonia', main_url: 'https://ceremonia.com', platform: 'shopify', currency: 'USD', status: 'active' }];
          }
          return [];
        },
      },
      persistence: {
        async createBatch(batch) { written.batch = batch; },
        async writeDatasetRows(rows) { written.rows = [...(written.rows ?? []), ...rows]; },
      },
      brands: selectBrands(BRANDS, ['ceremonia'], [9]),
      clock: { todayUtc: () => TODAY },
      phase: 'readiness',
    });
    expect(written.batch.siteSource).toBe('audit-roswell');
    expect(written.rows.some((r) => r.datasetId === 'audit-readiness' && r.botFilter === 'portal_11_4' && r.idsite === 9)).toBe(true);
    expect(written.rows.some((r) => r.datasetId === 'page-segment-weekly')).toBe(false);
  });
});
