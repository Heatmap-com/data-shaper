import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { adapter as deadCohort } from '../../src/adapters/quality-methods/dead-cohort.js';
import { adapter as iqrFence } from '../../src/adapters/quality-methods/iqr-fence.js';
import { adapter as robustZ } from '../../src/adapters/quality-methods/robust-z.js';
import { adapter as alwaysAsk } from '../../src/adapters/quality-triage/always-ask.js';
import { adapter as impactTriage } from '../../src/adapters/quality-triage/impact.js';
import { decisionFor, withDecision } from '../../src/application/quality/decide.js';
import { createQualityRegistry } from '../../src/application/quality/registry.js';
import { findingId } from '../../src/application/quality/screen.js';
import { requestQualitySpec, siteQualitySpec } from '../../src/application/quality/site-files.js';
import { loadQualityScreens } from '../../src/catalog/quality.js';
import { checkDecision, checkDecisions, decisionsFor } from '../../src/domain/quality/decisions.js';
import { impactOf, memberKey, renderQuestion, splitByDecisions, totalsOf } from '../../src/domain/quality/findings.js';
import { checkScreen, resolveScreen } from '../../src/domain/quality/screens.js';
import { ascending, mad, median, quantile } from '../../src/domain/quality/stats.js';

const SCREENS = loadQualityScreens();
const shipped = (id) => SCREENS.find((screen) => screen.id === id);
const registryWith = (options = {}) => createQualityRegistry({ screens: SCREENS, methods: [iqrFence, robustZ, deadCohort], triages: [impactTriage, alwaysAsk], ...options });

/** 998 orders between $10 and $60, and two of $2,000. */
function storeOrders() {
  const rows = [];
  for (let i = 0; i < 998; i += 1) rows.push({ key: `o${i}`, idvisit: `${i}`, revenue: 10 + (i % 51) });
  rows.push({ key: 'w1', idvisit: '9001', revenue: 2000 }, { key: 'w2', idvisit: '9002', revenue: 2000 });
  return rows;
}

const orderSubject = { kind: 'orders', measure: 'revenue' };
const DECIDED = { by: 'kenn', at: '2026-10-14', note: 'wholesale' };

describe('the statistics', () => {
  it('quantiles interpolate between ranks, and the MAD is the median distance', () => {
    const sorted = ascending([4, 1, 3, 2, 100]);
    expect(quantile(sorted, 0.25)).toBe(2);
    expect(median(sorted)).toBe(3);
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(mad(sorted)).toBe(1);
  });
});

describe('whale orders', () => {
  const rows = storeOrders();
  const totals = totalsOf('orders', rows);

  it('the IQR fence flags the two $2,000 orders and nothing of the usual 998', () => {
    const params = { ...iqrFence.defaults, k: 3 };
    expect(iqrFence.check(params, orderSubject)).toEqual([]);
    const { candidates, stats } = iqrFence.screen({ subject: orderSubject, rows, params, totals });
    expect(candidates).toHaveLength(1);
    expect(candidates[0].members.sort()).toEqual(['w1', 'w2']);
    expect(candidates[0].values).toMatchObject({ count: 2, low: 2000, high: 2000 });
    expect(stats.rows).toBe(1000);
    expect(Number(candidates[0].values.fence)).toBeLessThan(2000);
    expect(Number(candidates[0].values.fence)).toBeGreaterThan(60);
  });

  it('the robust z-score agrees', () => {
    const { candidates } = robustZ.screen({ subject: orderSubject, rows, params: robustZ.defaults, totals });
    expect(candidates[0].members.sort()).toEqual(['w1', 'w2']);
  });

  it('skips a store with too few orders to say what is usual', () => {
    const few = rows.slice(0, 10);
    const result = iqrFence.screen({ subject: orderSubject, rows: few, params: iqrFence.defaults, totals: totalsOf('orders', few) });
    expect(result.candidates).toEqual([]);
    expect(result.skipped).toMatch(/10 rows/);
  });

  it('measures what excluding them does, and the shipped screen asks about it', () => {
    const impact = impactOf('orders', rows, totals, new Set(['w1', 'w2']));
    expect(impact.orders).toBe(2);
    expect(impact.revenueShare).toBeCloseTo(4000 / totals.revenue, 6);
    expect(impact.aovWithout).toBeCloseTo((totals.revenue - 4000) / 998, 6);
    const screen = shipped('whale_orders');
    const verdict = impactTriage.triage({ candidate: { members: ['w1', 'w2'] }, impact, params: { ...impactTriage.defaults, ...screen.triage.params, ask: { ...impactTriage.defaults.ask, ...screen.triage.params.ask } } });
    expect(verdict.ask).toBe(true);
    expect(verdict.why).toMatch(/revenue/);
  });

  it('renders the question with each value in its unit, and leaves an unknown name visible', () => {
    const text = renderQuestion('{{count}} orders over {{fence}} hold {{revenueShare}}; {{typo}}', { count: 2, fence: 112.5, revenueShare: 0.0947 }, { count: 'count', fence: 'money', revenueShare: 'share' });
    expect(text).toBe('2 orders over 112.50 hold 9.47%; {{typo}}');
  });
});

describe('dead cohorts', () => {
  const groups = [
    { key: '0x0', sessions: 2_100_000, buyers: 0, orders: 0, revenue: 0, progressed: 2 },
    { key: '1920x1080', sessions: 3_000_000, buyers: 60_000, orders: 61_000, revenue: 3_000_000, progressed: 150_000 },
    { key: '390x844', sessions: 4_000_000, buyers: 80_000, orders: 81_000, revenue: 4_000_000, progressed: 200_000 },
  ];
  const subject = { kind: 'groups', by: 'resolution', measure: 'sessions' };

  it('flags 2.1 million sessions that never buy, and asks', () => {
    const totals = totalsOf('groups', groups);
    const { candidates } = deadCohort.screen({ subject, rows: groups, params: deadCohort.defaults, totals });
    expect(candidates.map((c) => c.members)).toEqual([['0x0']]);
    const impact = impactOf('groups', groups, totals, new Set(['0x0']));
    expect(impact.sessionShare).toBeCloseTo(2.1 / 9.1, 6);
    const screen = shipped('dead_resolution');
    const question = renderQuestion(screen.question, { ...candidates[0].values, ...impact }, { ...candidates[0].units });
    expect(question).toContain('2,100,000 sessions');
    expect(question).toContain('0x0');
  });

  it('leaves a cohort alone that converts like the rest', () => {
    const fine = groups.slice(1);
    expect(deadCohort.screen({ subject, rows: fine, params: deadCohort.defaults, totals: totalsOf('groups', fine) }).candidates).toEqual([]);
  });
});

describe('screens through their layers', () => {
  const site = siteQualitySpec({
    idsite: 7,
    rules: { whale_orders: { method: { params: { k: 5 } } } },
    datasets: { revenue_weeks: { rules: { whale_orders: { method: { params: { k: 8 } }, propose: 'include' } } } },
  }, 'seven', 'test');

  it('apply catalog, site, site and dataset, request, then decisions, recording each', () => {
    const screen = resolveScreen(shipped('whale_orders'), {
      dataset: 'revenue_weeks',
      site,
      request: { whale_orders: { method: { params: { minRows: 10 } } } },
      decisions: [{ patch: { method: { params: { k: 6 } } }, layer: 'decision of 2026-10-14 by kenn' }],
    });
    expect(screen.method.params).toMatchObject({ k: 6, minRows: 10, side: 'upper' });
    expect(screen.propose).toBe('include');
    expect(screen.layers.map((l) => [l.path, l.layer])).toEqual([
      ['method.params.k', 'sites/seven/quality.json'],
      ['method.params.k', 'sites/seven/quality.json, dataset revenue_weeks'],
      ['propose', 'sites/seven/quality.json, dataset revenue_weeks'],
      ['method.params.minRows', 'request revenue_weeks'],
      ['method.params.k', 'decision of 2026-10-14 by kenn'],
    ]);
  });

  it('a dataset without its own rules takes the site rules only', () => {
    const registry = registryWith({ siteSpecs: [site] });
    const other = registry.resolve(7, 'traffic', undefined).screens.find((s) => s.id === 'whale_orders');
    expect(other.methodParams.k).toBe(5);
    const own = registry.resolve(7, 'revenue_weeks', undefined).screens.find((s) => s.id === 'whale_orders');
    expect(own.methodParams.k).toBe(8);
    expect(registry.resolve(8, 'revenue_weeks', undefined).screens.find((s) => s.id === 'whale_orders').methodParams.k).toBe(3);
  });

  it('turn a screen off for a site, add a site screen, and refuse a patch of a screen nobody defines', () => {
    const custom = { ...JSON.parse(JSON.stringify(shipped('whale_orders'))), id: 'whale_sessions', label: 'Whale sessions', scope: 'session' };
    delete custom.layers;
    const spec = siteQualitySpec({ idsite: 7, rules: { dead_source: { enabled: false } }, add: [custom] }, 'seven', 'test');
    const resolved = registryWith({ siteSpecs: [spec] }).resolve(7, 'any', undefined);
    expect(resolved.off).toEqual([{ id: 'dead_source', layer: 'sites/seven/quality.json' }]);
    expect(resolved.screens.map((s) => [s.id, s.origin])).toContainEqual(['whale_sessions', 'sites/seven/quality.json']);
    const bad = siteQualitySpec({ idsite: 7, rules: { whale_ordrs: { enabled: false } } }, 'seven', 'test');
    expect(() => registryWith({ siteSpecs: [bad] })).toThrow(/patches screen whale_ordrs, which no layer defines/);
  });

  it('refuse a constant the method does not know, when the registry is built', () => {
    const bad = siteQualitySpec({ idsite: 7, rules: { whale_orders: { method: { params: { kk: 5 } } } } }, 'seven', 'test');
    expect(() => registryWith({ siteSpecs: [bad] })).toThrow(/whale_orders: method iqr-fence: .*kk/);
  });

  it('a request can turn screening off, or patch a screen for its own dataset', () => {
    const registry = registryWith();
    expect(registry.resolve(7, 'd', requestQualitySpec({ off: true }, 'r')).screens).toEqual([]);
    const patched = registry.resolve(7, 'd', requestQualitySpec({ rules: { whale_orders: { method: { params: { k: 1.5 } } } } }, 'r'));
    expect(patched.screens.find((s) => s.id === 'whale_orders').methodParams.k).toBe(1.5);
    expect(() => requestQualitySpec({ rule: {} }, 'r')).toThrow(/unknown key "rule"/);
  });

  it('the example site file resolves for each of its datasets', () => {
    const doc = JSON.parse(readFileSync(new URL('../../examples/shaping/quality.json', import.meta.url), 'utf8'));
    const registry = registryWith({ siteSpecs: [siteQualitySpec(doc, 'frankandeileen', 'example')] });
    const ids = (dataset) => registry.resolve(6277, dataset, undefined).screens.map((s) => [s.id, s.methodParams.k ?? s.methodParams.minSessions]);
    expect(ids('revenue_weeks')).toEqual([['dead_resolution', 5000], ['dead_source', 1000], ['whale_orders', 3], ['zero_viewport_orders', 1000]]);
    expect(ids('traffic_mix').map(([id]) => id)).not.toContain('whale_orders');
    expect(ids('other')).toContainEqual(['whale_orders', 4]);
  });

  it('a screen file names its method, triage, and dispositions', () => {
    expect(() => checkScreen({ ...shipped('whale_orders'), layers: undefined, propose: 'drop' }, 't')).toThrow();
  });
});

describe('decisions', () => {
  const members = ['order:w1', 'order:w2'];

  it('a member decision wins over a standing one, and a dataset one over a site-wide one', () => {
    const decisions = checkDecisions({
      idsite: 7,
      decisions: [
        { rule: 'whale_orders', decision: 'include', applies: 'rule', ...DECIDED },
        { rule: 'whale_orders', decision: 'exclude', members: ['order:w1'], ...DECIDED },
        { rule: 'whale_orders', decision: 'include', members: ['order:w1'], dataset: 'traffic', ...DECIDED },
      ],
    }, 't').decisions;
    const site = splitByDecisions(members, decisionsFor(decisions, 'whale_orders', 'revenue'));
    expect(site.parts.map((p) => [p.decision.decision, p.members])).toEqual([['exclude', ['order:w1']], ['include', ['order:w2']]]);
    const traffic = splitByDecisions(members, decisionsFor(decisions, 'whale_orders', 'traffic'));
    expect(traffic.parts.map((p) => [p.decision.decision, p.decision.dataset, p.members])).toEqual([['include', 'traffic', ['order:w1']], ['include', null, ['order:w2']]]);
    expect(splitByDecisions(['order:w3'], decisionsFor([], 'whale_orders', 'x')).open).toEqual(['order:w3']);
  });

  it('a decision says who and why, and only a reprocess carries constants', () => {
    expect(() => checkDecision({ rule: 'r', decision: 'exclude', members, by: 'kenn', at: '2026-10-14', note: ' ' }, 't')).toThrow(/who decided and why/);
    expect(() => checkDecision({ rule: 'r', decision: 'exclude', members, params: { k: 1 }, ...DECIDED }, 't')).toThrow(/only a reprocess/);
    expect(() => checkDecision({ rule: 'r', decision: 'reprocess', ...DECIDED }, 't')).toThrow(/carries params/);
    expect(() => checkDecision({ rule: 'r', decision: 'exclude', ...DECIDED }, 't')).toThrow(/lists its members/);
  });

  it('the decide command records a finding\'s members, with what the person saw', () => {
    const finding = { id: findingId(7, 'whale_orders', members), screen: 'whale_orders', label: 'Orders above the far fence', members, question: 'Exclude them?', status: 'awaiting_decision', disposition: 'include', impact: { orders: 2 } };
    const ledger = { dataset: 'revenue', idsite: 7, built: '2026-10-14', window: { start: '2026-09-01', end: '2026-09-30' }, findings: [finding] };
    const record = decisionFor(ledger, finding.id, { decision: 'exclude', by: 'kenn', note: 'wholesale', today: '2026-10-14' });
    expect(record).toMatchObject({ rule: 'whale_orders', decision: 'exclude', applies: 'finding', members, dataset: null, evidence: { question: 'Exclude them?', applied: 'include' } });
    expect(decisionFor(ledger, finding.id, { decision: 'include', forRule: true, datasetOnly: true, by: 'k', note: 'n', today: '2026-10-14' })).toMatchObject({ applies: 'rule', members: [], dataset: 'revenue' });
    expect(() => decisionFor(ledger, 'q_nope', { decision: 'exclude', by: 'k', note: 'n', today: '2026-10-14' })).toThrow(/no finding q_nope/);
    expect(withDecision({ idsite: 7, decisions: [] }, 7, record).decisions).toHaveLength(1);
    expect(() => withDecision({ idsite: 8, decisions: [] }, 7, record)).toThrow(/idsite 8/);
  });

  it('a finding id is stable for the same members in any order', () => {
    expect(findingId(7, 's', ['b', 'a'])).toBe(findingId(7, 's', ['a', 'b']));
    expect(findingId(7, 's', ['a'])).not.toBe(findingId(8, 's', ['a']));
    expect(memberKey({ kind: 'groups', by: 'resolution' }, '0x0')).toBe('group:resolution=0x0');
  });
});
