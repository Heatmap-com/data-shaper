import { describe, expect, it } from 'vitest';
import { adapter as experimentsWeekly } from '../src/adapters/datasets/experiments-weekly.js';
import { adapter as sisterPages } from '../src/adapters/datasets/sister-pages.js';
import { adapter as siteBaselines } from '../src/adapters/datasets/site-baselines.js';
import { adapter as cardHistory } from '../src/adapters/datasets/card-history.js';

/**
 * Phase-3 site-scope datasets (plan §10.1: experiments-weekly, sister-pages,
 * site-baselines, card-history) through a fake gateway, following the
 * pattern of datasets-v2.test.js. Every query label the four adapters emit
 * is routed here; anything new fails loudly with "unexpected query".
 */

const WINDOW = { windowStart: '2026-09-26', windowEnd: '2026-10-02' };
const WEEK = '2026-09-28';
const logger = { info() {}, warn() {}, error() {} };

let nextVisit = 0;

/** One raw session row as the session-stream queries return it. */
function s(over = {}) {
  nextVisit += 1;
  return {
    idvisit: String(nextVisit),
    first_date: WEEK,
    week: WEEK,
    device: 1,
    referer: 1,
    returning: 0,
    entry_hsr: '222',
    country: 'us',
    browser: 'Chrome',
    fp_hash: 'fp1',
    utm_source: '',
    pageviews: 2,
    capped_ms: 20000,
    saw_product: 0,
    saw_atc: 0,
    saw_checkout: 0,
    saw_purchase: 0,
    orders: 0,
    revenue: 0,
    ...over,
  };
}

/**
 * @param {object} opts
 * @param {object[]} [opts.sessions] rows for sessions:entry
 * @param {object[]} [opts.partnerTags] raw udp_partner_tags rows
 * @param {object[]} [opts.experimentTables] system.tables existence rows
 * @param {object[]} [opts.experiments] ae_experiment_current rows
 * @param {object[]} [opts.pageTargets] ae_page_target_current rows
 * @param {object[]} [opts.secondPages] site-baselines:second-pageview rows
 * @param {object[]} [opts.cards] raw ae_strategy_card rows (grouped in-handler)
 */
function fakeGateway({ sessions = [], partnerTags = [], experimentTables = [{ n: 1 }], experiments = [], pageTargets = [], secondPages = [], cards = [] }) {
  /** @type {Array<{sql: string, params: object, label: string}>} */
  const queries = [];
  return {
    queries,
    async query(sql, params, label) {
      queries.push({ sql, params, label });
      switch (label) {
        case 'sessions:entry':
          return sessions;
        case 'experiments-weekly:partner-tags':
          return partnerTags;
        case 'experiments-weekly:experiment-table':
          return experimentTables;
        case 'experiments-weekly:experiments':
          return experiments;
        case 'sister-pages:page-targets':
          return pageTargets;
        case 'site-baselines:second-pageview':
          return secondPages;
        case 'card-history:cards': {
          // Mirror the adapter's SQL: group by (catalog, strategy, segment),
          // latest by generated_at, most recent first, capped.
          const groups = new Map();
          for (const c of cards) {
            const key = `${c.catalog_id}|${c.strategy_id}|${c.segment_key}`;
            let g = groups.get(key);
            if (!g) {
              g = {
                catalog_id: c.catalog_id,
                strategy_id: c.strategy_id,
                segment_key: c.segment_key,
                batches: new Set(),
                last: null,
              };
              groups.set(key, g);
            }
            g.batches.add(c.batch_id);
            if (!g.last || String(c.generated_at) >= String(g.last.generated_at)) g.last = c;
          }
          return [...groups.values()]
            .map((g) => ({
              catalog_id: g.catalog_id,
              strategy_id: g.strategy_id,
              segment_key: g.segment_key,
              batches_seen: g.batches.size,
              last_verdict: g.last.verdict,
              last_trigger_state: g.last.trigger_state,
              last_batch_id: g.last.batch_id,
              last_metric: g.last.metric,
              last_value: g.last.value,
              last_generated_at: g.last.generated_at,
            }))
            .sort(
              (a, b) =>
                String(b.last_generated_at).localeCompare(String(a.last_generated_at)) ||
                a.catalog_id.localeCompare(b.catalog_id) ||
                a.strategy_id.localeCompare(b.strategy_id) ||
                a.segment_key.localeCompare(b.segment_key),
            )
            .slice(0, Number(params.cap));
        }
        case 'bot:fingerprints':
        case 'bot:version-shares':
        case 'bot:version-lookback':
          return [];
        default:
          throw new Error(`unexpected query: ${label}`);
      }
    },
    async explain() {
      return 'plan';
    },
    async columns(table) {
      if (table === 'udp_partner_tags') {
        return ['experience_id', 'variant_id', 'server_date', 'idvisit', 'idloghsr', 'idsite'].map((name) => ({
          name,
          type: 'String',
        }));
      }
      return [{ name: 'visitor_returning' }, { name: 'custom_var_k5' }, { name: 'config_browser_name' }];
    },
  };
}

/**
 * @param {object} gateway
 * @param {Map<string, object>} [datasets]
 */
function makeCtx(gateway, datasets = new Map()) {
  return {
    batchId: 'b1',
    ...WINDOW,
    gateway,
    logger,
    clock: { todayUtc: () => '2026-10-03' },
    datasets,
    batchNotes: new Map(),
  };
}

const SITE = { idsite: 1, siteName: 'one' };

/** @param {Array<{dims: object, metrics: object}>} rows @param {object} dims */
function row(rows, dims) {
  return rows.find((r) => Object.entries(dims).every(([k, v]) => r.dims[k] === v));
}

/** 100 tagged sessions on experience exp1; session 7 carries the order. */
function experimentSessions() {
  return Array.from({ length: 100 }, (_, i) =>
    s({ idvisit: String(i + 1), orders: i + 1 === 7 ? 1 : 0, revenue: i + 1 === 7 ? 100 : 0 }),
  );
}

/** Tag rows: sessions 1..controlCount are control, the rest treatment. */
function experimentTags(controlCount) {
  return Array.from({ length: 100 }, (_, i) => ({
    week: WEEK,
    experience_id: 'exp1',
    variant_id: i + 1 <= controlCount ? 'control' : 'treatment',
    idvisit: String(i + 1),
  }));
}

const FIFTY_FIFTY = [
  { experiment_id: 'exp1', arms: JSON.stringify([{ arm: 'control', allocation: 50 }, { arm: 'treatment', allocation: 50 }]) },
];

describe('experiments-weekly', () => {
  it('is a site-scope adapter providing H16 and O04', () => {
    expect(experimentsWeekly.scope).toBe('site');
    expect(experimentsWeekly.provides).toEqual(['H16', 'O04']);
    expect(experimentsWeekly.dependsOn).toEqual([]);
  });

  it('emits arm rows with sessions/orders/revenue and a balanced SRM p-value', async () => {
    const gateway = fakeGateway({
      sessions: experimentSessions(),
      partnerTags: experimentTags(50),
      experiments: FIFTY_FIFTY,
    });
    const result = await experimentsWeekly.collect(SITE, makeCtx(gateway));

    const control = row(result.rows, { experience_id: 'exp1', variant_id: 'control', bot_filter: 'exclude_confirmed' });
    expect(control).toBeDefined();
    expect(control.metrics.sessions).toBe(50);
    expect(control.metrics.orders_udp).toBe(1);
    expect(control.metrics.revenue_udp).toBe(100);
    expect(control.metrics.srm_pvalue).toBeCloseTo(1, 6); // chi-square 0
    expect(control.metrics.declared_allocation).toBe(0.5);
    expect(control.metrics.srm_note).toBe('');

    const treatment = row(result.rows, { experience_id: 'exp1', variant_id: 'treatment', bot_filter: 'exclude_confirmed' });
    expect(treatment.metrics.sessions).toBe(50);
    expect(treatment.metrics.orders_udp).toBe(0);

    // the fact query binds idsite and the batch window
    const tagQuery = gateway.queries.find((q) => q.label === 'experiments-weekly:partner-tags');
    expect(tagQuery.sql).toContain('server_date BETWEEN {w0:Date} AND {w1:Date}');
    expect(tagQuery.sql).toContain('idsite = {idsite:UInt32}');
    expect(tagQuery.params).toEqual({ idsite: 1, w0: WINDOW.windowStart, w1: WINDOW.windowEnd });
  });

  it('flags a 60/40 assignment split against a 50/50 declaration', async () => {
    const gateway = fakeGateway({
      sessions: experimentSessions(),
      partnerTags: experimentTags(60),
      experiments: FIFTY_FIFTY,
    });
    const result = await experimentsWeekly.collect(SITE, makeCtx(gateway));

    const control = row(result.rows, { variant_id: 'control' });
    expect(control.metrics.sessions).toBe(60);
    // chi-square 4 at 1 dof: p ~ 0.0455
    expect(control.metrics.srm_pvalue).toBeGreaterThan(0.04);
    expect(control.metrics.srm_pvalue).toBeLessThan(0.05);
  });

  it('emits arms without SRM when ae_experiment is absent', async () => {
    const gateway = fakeGateway({
      sessions: experimentSessions(),
      partnerTags: experimentTags(50),
      experimentTables: [{ n: 0 }],
    });
    const result = await experimentsWeekly.collect(SITE, makeCtx(gateway));

    expect(result.rows).toHaveLength(2);
    const control = row(result.rows, { variant_id: 'control' });
    expect(control.metrics.sessions).toBe(50);
    expect(control.metrics.srm_pvalue).toBeNull();
    expect(control.metrics.declared_allocation).toBeNull();
    expect(control.metrics.srm_note).toBe('no declared allocation; SRM not computed');
    expect(result.notes.experiments_note).toContain('no declared allocation');
    // the existence probe ran, the arms read did not
    expect(gateway.queries.some((q) => q.label === 'experiments-weekly:experiment-table')).toBe(true);
    expect(gateway.queries.some((q) => q.label === 'experiments-weekly:experiments')).toBe(false);
  });

  it('emits zero rows and a not_applicable requirement for a no-tags site (3207)', async () => {
    const gateway = fakeGateway({ sessions: [], partnerTags: [] });
    const result = await experimentsWeekly.collect(SITE, makeCtx(gateway));

    expect(result.rows).toEqual([]);
    expect(result.requirements).toEqual([
      { key: 'H16', status: 'not_applicable', rowCount: 0, detail: 'no partner tags for this site' },
    ]);
  });
});

describe('sister-pages', () => {
  it('is a site-scope adapter providing H24', () => {
    expect(sisterPages.scope).toBe('site');
    expect(sisterPages.provides).toEqual(['H24']);
  });

  it('computes per-target entry metrics, rps and single-pageview share', async () => {
    const gateway = fakeGateway({
      pageTargets: [
        { idsitehsr: '222', url: 'https://x.com/pages/lp', page_title: 'LP', page_type: 'content', role: 'primary' },
        { idsitehsr: '333', url: 'https://x.com/products/a', page_title: 'A', page_type: 'product', role: 'sister' },
      ],
      sessions: [
        s({ idvisit: '1', entry_hsr: '222', referer: 1 }),
        s({ idvisit: '2', entry_hsr: '222', referer: 1, pageviews: 1 }),
        s({ idvisit: '3', entry_hsr: '222', referer: 1, pageviews: 1 }),
        s({ idvisit: '4', entry_hsr: '222', referer: 1, orders: 1, revenue: 40 }),
        s({ idvisit: '5', entry_hsr: '333', referer: 2 }),
        s({ idvisit: '6', entry_hsr: '333', referer: 2 }),
        s({ idvisit: '7', entry_hsr: '444', referer: 1 }), // not a target: ignored
      ],
    });
    const result = await sisterPages.collect(SITE, makeCtx(gateway));

    const lp = row(result.rows, { idsitehsr: '222', channel: 'direct', role: 'primary', bot_filter: 'exclude_confirmed' });
    expect(lp).toBeDefined();
    expect(lp.dims.url).toBe('https://x.com/pages/lp');
    expect(lp.metrics.entry_sessions).toBe(4);
    expect(lp.metrics.orders_udp).toBe(1);
    expect(lp.metrics.revenue_udp).toBe(40);
    expect(lp.metrics.rps).toBeCloseTo(10);
    expect(lp.metrics.single_pageview_share).toBeCloseTo(0.5);

    const pdp = row(result.rows, { idsitehsr: '333', channel: 'search', role: 'sister', bot_filter: 'exclude_confirmed' });
    expect(pdp.metrics.entry_sessions).toBe(2);
    expect(pdp.metrics.rps).toBe(0);
    expect(pdp.metrics.single_pageview_share).toBe(0);

    // two cells (direct LP, search PDP), each on both bot tiers; the
    // non-target page stays out
    expect(result.rows).toHaveLength(4);
    expect(result.rows.filter((r) => r.dims.bot_filter === 'none')).toHaveLength(2);
    expect(row(result.rows, { idsitehsr: '333', channel: 'search', bot_filter: 'none' })).toBeDefined();
    expect(result.rows.some((r) => r.dims.idsitehsr === '444')).toBe(false);

    // the target read binds batch and site
    const targetQuery = gateway.queries.find((q) => q.label === 'sister-pages:page-targets');
    expect(targetQuery.params).toEqual({ batchId: 'b1', idsite: 1 });
  });
});

describe('site-baselines', () => {
  it('is a site-scope adapter providing H24', () => {
    expect(siteBaselines.scope).toBe('site');
    expect(siteBaselines.provides).toEqual(['H24']);
  });

  it('computes exit and pogo shares per channel plus a weekly totals row', async () => {
    const gateway = fakeGateway({
      sessions: [
        s({ idvisit: '1', entry_hsr: '222', referer: 1, pageviews: 1 }), // exit
        s({ idvisit: '2', entry_hsr: '222', referer: 1, pageviews: 3, revenue: 30 }), // pogo
        s({ idvisit: '3', entry_hsr: '222', referer: 1, pageviews: 2 }), // moves on
        s({ idvisit: '4', entry_hsr: '333', referer: 2, pageviews: 1 }), // exit, search
      ],
      secondPages: [
        { idvisit: '2', hsr: '222' }, // returns to the entry page: pogo
        { idvisit: '3', hsr: '999' },
      ],
    });
    const result = await siteBaselines.collect(SITE, makeCtx(gateway));

    const direct = row(result.rows, { week: WEEK, channel: 'direct', bot_filter: 'exclude_confirmed' });
    expect(direct.metrics.entry_sessions).toBe(3);
    expect(direct.metrics.exit_share).toBeCloseTo(1 / 3);
    expect(direct.metrics.pogo_share).toBeCloseTo(1 / 3);
    expect(direct.metrics.rps).toBeCloseTo(10); // 30 / 3

    const totals = row(result.rows, { week: WEEK, channel: 'all', bot_filter: 'exclude_confirmed' });
    expect(totals.metrics.entry_sessions).toBe(4);
    expect(totals.metrics.exit_share).toBeCloseTo(0.5);
    expect(totals.metrics.rps).toBeCloseTo(7.5); // 30 / 4

    const search = row(result.rows, { channel: 'search', bot_filter: 'exclude_confirmed' });
    expect(search.metrics.entry_sessions).toBe(1);
    expect(search.metrics.exit_share).toBe(1);

    const secondQuery = gateway.queries.find((q) => q.label === 'site-baselines:second-pageview');
    expect(secondQuery.sql).toContain('row_number()');
    expect(secondQuery.sql).toContain('server_date BETWEEN {w0:Date} AND {w1:Date}');
  });
});

describe('card-history', () => {
  it('is a site-scope adapter providing H26', () => {
    expect(cardHistory.scope).toBe('site');
    expect(cardHistory.provides).toEqual(['H26']);
  });

  it('keeps the latest verdict per strategy and segment across batches', async () => {
    const cards = [
      { batch_id: 'b1', idsite: 1, catalog_id: 'LP', strategy_id: 'J2', segment_key: 'all', verdict: 'include', trigger_state: 'triggered', metric: 'rps', value: 0.8, generated_at: '2026-09-25 00:00:00.000' },
      { batch_id: 'b2', idsite: 1, catalog_id: 'LP', strategy_id: 'J2', segment_key: 'all', verdict: 'exclude', trigger_state: 'silent', metric: 'rps', value: 0.2, generated_at: '2026-10-02 00:00:00.000' },
      { batch_id: 'b2', idsite: 1, catalog_id: 'TD', strategy_id: 'F-ROUTE', segment_key: 'mobile', verdict: 'blocked', trigger_state: 'blocked', metric: '', value: null, generated_at: '2026-10-02 00:00:00.001' },
    ];
    const gateway = fakeGateway({ cards });
    const result = await cardHistory.collect(SITE, makeCtx(gateway));

    expect(result.rows).toHaveLength(2);
    // most recent first
    const fRoute = result.rows[0];
    expect(fRoute.dims.strategy_id).toBe('F-ROUTE');
    expect(fRoute.dims.segment_key).toBe('mobile');
    expect(fRoute.dims.last_batch_id).toBe('b2');
    expect(fRoute.metrics.batches_seen).toBe(1);
    expect(fRoute.metrics.last_verdict).toBe('blocked');

    const j2 = result.rows[1];
    expect(j2.dims.strategy_id).toBe('J2');
    expect(j2.metrics.batches_seen).toBe(2);
    expect(j2.metrics.last_verdict).toBe('exclude'); // latest generated_at wins
    expect(j2.metrics.last_trigger_state).toBe('silent');
    expect(j2.metrics.value).toBe(0.2);

    const cardQuery = gateway.queries.find((q) => q.label === 'card-history:cards');
    expect(cardQuery.sql).toContain('ae_strategy_card_current');
    expect(cardQuery.sql).toContain('argMax(verdict, generated_at)');
    expect(cardQuery.sql).toContain('uniqExact(batch_id)');
    expect(cardQuery.params.idsite).toBe(1);
  });

  it('caps at 500 rows and notes the cap', async () => {
    const cards = Array.from({ length: 600 }, (_, i) => ({
      batch_id: 'b1',
      idsite: 1,
      catalog_id: 'LP',
      strategy_id: `S${i}`,
      segment_key: 'all',
      verdict: 'include',
      trigger_state: 'silent',
      metric: '',
      value: null,
      generated_at: `2026-09-25 00:00:00.${String(i % 1000).padStart(3, '0')}`,
    }));
    const result = await cardHistory.collect(SITE, makeCtx(fakeGateway({ cards })));
    expect(result.rows).toHaveLength(500);
    expect(result.notes.card_history_capped).toBe('rows capped at 500');
  });

  it('returns zero rows on a fresh install', async () => {
    const result = await cardHistory.collect(SITE, makeCtx(fakeGateway({})));
    expect(result.rows).toEqual([]);
  });
});
