import { describe, expect, it } from 'vitest';
import pino from 'pino';
import { adapter } from '../src/adapters/datasets/experiment-analysis.js';
import { createMemoryAePersistence } from '../src/adapters/persistence/memory.js';
import { lifecycle } from '../src/experiments/lifecycle.js';
import {
  buildExperiments,
  canonicalVariant,
  classifyKind,
  inferDevice,
  inferScope,
  inferSurface,
  markSharedControls,
  normalizeSelector,
} from '../src/experiments/normalize.js';
import { meanDifference, srmPvalue, twoProportion } from '../src/experiments/stats.js';
import {
  elementFactSql,
  experimentFactSql,
  normalizedSelectorSql,
  pageFactSql,
  sectionFactSql,
  tagDaysSql,
  tagSurfaceSql,
} from '../src/experiments/sql.js';
import { parseGovernanceImport } from '../src/governance-import.js';
import { queryBoundGaps } from '../src/governance/query-bounds.js';
import { shipped } from './support/segmentations.js';

const logger = pino({ level: 'silent' });

/** @param {string} start @param {number} n @param {(i: number) => object} row */
function days(start, n, row) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(`${start}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + i);
    out.push({ day: d.toISOString().slice(0, 10), ...row(i) });
  }
  return out;
}

/** Shoplift "Hero Test": control tag carries the test name, the variant has suffixed ids, one stray arm. */
const SHOPLIFT = [
  ...days('2026-10-01', 10, () => ({ partner: 'shoplift', experience_id: 'exp-a', variant_id: 'control', friendly_name: 'Hero Test', visits: 1000 })),
  ...days('2026-10-01', 10, () => ({ partner: 'shoplift', experience_id: 'exp-a', variant_id: 'sl-ABC', friendly_name: 'Big hero', visits: 900 })),
  ...days('2026-10-01', 10, () => ({ partner: 'shoplift', experience_id: 'exp-a', variant_id: 'sl-ABC#slr-x1', friendly_name: 'Big hero', visits: 100 })),
  { day: '2026-10-02', partner: 'shoplift', experience_id: 'exp-a', variant_id: 'sl-zzz', friendly_name: 'Old', visits: 5 },
];

/** Shoplift tags the tested template with the arm and every other page as control. */
const SHOPLIFT_SURFACE = [
  { partner: 'shoplift', experience_id: 'exp-a', variant_id: 'control', idsitehsr: '11', template: 'home', tags: 1000 },
  { partner: 'shoplift', experience_id: 'exp-a', variant_id: 'control', idsitehsr: '22', template: 'pdp', tags: 900 },
  { partner: 'shoplift', experience_id: 'exp-a', variant_id: 'sl-ABC', idsitehsr: '11', template: 'home', tags: 990 },
  { partner: 'shoplift', experience_id: 'exp-a', variant_id: 'sl-ABC', idsitehsr: '22', template: 'pdp', tags: 5 },
];

describe('experiment normalization', () => {
  it('canonicalizes variant ids and drops ids that name no arm', () => {
    expect(canonicalVariant('sl-A29EF047#slr-8xsw8m9p50nr')).toBe('sl-a29ef047');
    expect(canonicalVariant('sl-A29EF047?fbclid=abc')).toBe('sl-a29ef047');
    expect(canonicalVariant('_removed_')).toBe('');
    expect(canonicalVariant('  ')).toBe('');
  });

  it('folds suffixed Shoplift variants into one arm, names the test from the control tag, and marks the stray arm', () => {
    const [exp] = buildExperiments(SHOPLIFT);
    expect(exp.key).toBe('shoplift:exp-a');
    expect(exp.name).toBe('Hero Test');
    const live = exp.arms.filter((a) => !a.stray);
    expect(live.map((a) => a.arm)).toEqual(['control', 'sl-abc']);
    expect(live[0]).toMatchObject({ isControl: true, label: 'Control', visits: 10_000 });
    expect(live[1]).toMatchObject({ isControl: false, label: 'Big hero', visits: 10_000 });
    expect(live[1].aliases).toEqual(['sl-ABC', 'sl-ABC#slr-x1']);
    expect(exp.arms.find((a) => a.arm === 'sl-zzz').stray).toBe(true);
    expect(exp.rawKeys.get('shoplift|exp-a|sl-ABC#slr-x1')).toBe('sl-abc');
    expect(classifyKind(exp)).toBe('experiment');
  });

  it('folds Intelligems tags without an experience id into the experiment their variant belongs to', () => {
    const tags = [
      { day: '2026-10-01', partner: 'intelligem', experience_id: 'E1', variant_id: 'v1', friendly_name: 'Price Test - Control Group', visits: 500 },
      { day: '2026-10-01', partner: 'intelligem', experience_id: '', variant_id: 'v1', friendly_name: 'Price Test - Control Group', visits: 500 },
      { day: '2026-10-01', partner: 'intelligem', experience_id: 'E1', variant_id: 'v2', friendly_name: 'Price Test - Variant 1', visits: 480 },
      { day: '2026-10-01', partner: 'intelligem', experience_id: '', variant_id: 'v2', friendly_name: 'Price Test - Variant 1', visits: 480 },
    ];
    const experiments = buildExperiments(tags);
    expect(experiments).toHaveLength(1);
    const [exp] = experiments;
    expect(exp.key).toBe('intelligem:E1');
    expect(exp.name).toBe('Price Test');
    expect(exp.arms.map((a) => [a.arm, a.label, a.isControl, a.visits])).toEqual([
      ['v1', 'Control Group', true, 500],
      ['v2', 'Variant 1', false, 480],
    ]);
  });

  it('classifies rollouts and personalizations and reads the device from the name', () => {
    const one = (name) => buildExperiments([
      { day: '2026-10-01', partner: 'intelligem', experience_id: '', variant_id: 'v', friendly_name: `${name} - Arm`, visits: 10 },
    ])[0];
    expect(classifyKind(one('Rollout of BW143a: Bundle'))).toBe('rollout');
    expect(classifyKind(one('[PERSONALIZATION] Post Purchase Upsell'))).toBe('personalization');
    expect(inferDevice('M | HP | Hero')).toBe('mobile');
    expect(inferDevice('DT Cart Drawer')).toBe('desktop');
    expect(inferDevice('Reviews Test V2')).toBe('');
  });

  it('reads kind, device, and scope from the rule tables in order', () => {
    const exp = (name, extra = {}) => ({
      partner: 'shoplift',
      name,
      registryTypes: [],
      arms: [{ arm: 'a', stray: false }, { arm: 'b', stray: false }],
      ...extra,
    });
    expect(classifyKind(exp('Rollout of X', { partner: 'heatmap-report' }))).toBe('internal');
    expect(classifyKind(exp('Rollout of X'))).toBe('rollout');
    expect(classifyKind(exp('Personalisation: returning'))).toBe('personalization');
    expect(classifyKind(exp('Rollout of X', { arms: [{ arm: 'a', stray: false }, { arm: 'b', stray: true }] }))).toBe('rollout');
    expect(classifyKind(exp('Hero', { arms: [{ arm: 'a', stray: false }, { arm: 'b', stray: true }] }))).toBe('single_arm');
    expect(classifyKind(exp('Rollouts for Q4'))).toBe('experiment');

    expect(['Mob: PDP', 'mb-hero', 'PDP | Mobile ATF', 'd - Mobile nav'].map(inferDevice)).toEqual(['mobile', 'mobile', 'mobile', 'mobile']);
    expect(['D: hero', 'dsk|nav', 'dt cart', 'PDP Desktop', 'DTC hero', 'Dmitri test'].map(inferDevice)).toEqual([
      'desktop', 'desktop', 'desktop', 'desktop', '', '',
    ]);

    expect(inferScope(exp('HP hero', { registryTypes: ['unknownType', 'product'] }))).toEqual({ scope: 'template', templates: ['pdp'], scopeSource: 'registry' });
    expect(inferScope(exp('[HP] hero and PDP gallery'))).toEqual({ scope: 'template', templates: ['home', 'pdp'], scopeSource: 'name' });
    expect(inferScope(exp('HP cart drawer'))).toEqual({ scope: 'site', templates: [], scopeSource: 'name' });
    expect(inferScope(exp('Reviews Test V2'))).toEqual({ scope: 'unknown', templates: [], scopeSource: 'none' });
  });

  it('finds a partial surface when control is tagged off the tested template', () => {
    const [exp] = buildExperiments(SHOPLIFT);
    const surface = inferSurface(exp, SHOPLIFT_SURFACE);
    expect(surface.all).toBe(false);
    expect(surface.templates).toEqual(['home']);
    expect(surface.pages).toEqual(['11']);
    expect(surface.offSurface.get('control')).toBeCloseTo(0.4737, 3);
  });

  it('finds a full surface when every arm fires on every template', () => {
    const [exp] = buildExperiments([
      { day: '2026-10-01', partner: 'shoplift', experience_id: 't', variant_id: '1001', friendly_name: 'Theme', visits: 100 },
      { day: '2026-10-01', partner: 'shoplift', experience_id: 't', variant_id: '2002', friendly_name: 'Theme', visits: 100 },
    ]);
    const rows = ['1001', '2002'].flatMap((variant_id) => [
      { partner: 'shoplift', experience_id: 't', variant_id, idsitehsr: '1', template: 'home', tags: 50 },
      { partner: 'shoplift', experience_id: 't', variant_id, idsitehsr: '2', template: 'pdp', tags: 48 },
      { partner: 'shoplift', experience_id: 't', variant_id, idsitehsr: '3', template: 'cart', tags: 1 },
    ]);
    const surface = inferSurface(exp, rows);
    expect(surface.all).toBe(true);
    expect(surface.templates).toEqual(['home', 'pdp']);
    expect(exp.name).toBe('Theme');
  });

  it('gives one surface whatever order the tag rows arrive in', () => {
    const [exp] = buildExperiments([
      { day: '2026-10-01', partner: 'shoplift', experience_id: 't', variant_id: '1001', friendly_name: 'Theme', visits: 100 },
      { day: '2026-10-01', partner: 'shoplift', experience_id: 't', variant_id: '2002', friendly_name: 'Theme', visits: 100 },
    ]);
    const tag = (variant_id, idsitehsr, template, tags) => ({ partner: 'shoplift', experience_id: 't', variant_id, idsitehsr, template, tags });
    const single = [tag('1001', '3', 'pdp', 5), tag('1001', '1', 'home', 5)];
    const partial = [
      tag('2002', '9', 'home', 60), tag('1001', '5', 'home', 30), tag('1001', '1', 'home', 30),
      tag('2002', '7', 'cart', 40), tag('1001', '2', 'cart', 40),
    ];
    for (const rows of [single, partial, [...single, tag('2002', '4', 'plp', 0)]]) {
      const forward = inferSurface(exp, rows);
      const backward = inferSurface(exp, [...rows].reverse());
      expect(backward.templates).toEqual(forward.templates);
      expect(backward.pages).toEqual(forward.pages);
      expect([...backward.offSurface]).toEqual([...forward.offSurface]);
    }
    expect(inferSurface(exp, single).templates).toEqual(['home', 'pdp']);
  });

  it('marks the live theme shared across theme tests as their control', () => {
    const theme = (id, variant) => [
      { day: '2026-10-01', partner: 'shoplift', experience_id: id, variant_id: '148822163549', friendly_name: id, visits: 100 },
      { day: '2026-10-01', partner: 'shoplift', experience_id: id, variant_id: variant, friendly_name: id, visits: 100 },
    ];
    const experiments = markSharedControls(buildExperiments([...theme('a', '1'), ...theme('b', '2'), ...theme('c', '3')]));
    for (const exp of experiments) {
      expect(exp.arms[0]).toMatchObject({ arm: '148822163549', isControl: true, controlSource: 'shared_arm' });
      expect(exp.arms[1].isControl).toBe(false);
    }
  });
});

describe('experiment lifecycle', () => {
  const scan = { windowEnd: '2026-10-10', scanStart: '2026-08-12' };

  it('ends a test at its last active day, not at the trickle of cached tags', () => {
    const daily = new Map([
      ['2026-09-14', 183_432], ['2026-09-15', 425_469], ['2026-09-16', 357_374], ['2026-09-17', 420_203],
      ['2026-09-18', 17_626], ['2026-09-19', 1251], ['2026-09-25', 119], ['2026-10-10', 40],
    ]);
    const life = lifecycle(daily, scan);
    expect(life).toMatchObject({
      status: 'ended',
      observedStart: '2026-09-14',
      observedEnd: '2026-09-17',
      lastSeen: '2026-10-10',
      activeDays: 4,
      startedBeforeScan: false,
    });
    expect(life.tailVisits).toBe(17_626 + 1251 + 119 + 40);
  });

  it('is running within a day of the window end, recent within 14 days, trace under 200 visits', () => {
    expect(lifecycle(new Map([['2026-10-09', 500], ['2026-10-10', 600]]), scan).status).toBe('running');
    expect(lifecycle(new Map([['2026-10-01', 500], ['2026-10-02', 600]]), scan).status).toBe('recent');
    expect(lifecycle(new Map([['2026-10-10', 150]]), scan).status).toBe('trace');
  });
});

describe('experiment statistics', () => {
  it('srm is 1 for an exact split and tiny for a 60/40 split', () => {
    const arms = [{ arm: 'a', allocation: 0.5 }, { arm: 'b', allocation: 0.5 }];
    expect(srmPvalue(new Map([['a', 1000], ['b', 1000]]), arms)).toBeCloseTo(1, 6);
    expect(srmPvalue(new Map([['a', 600], ['b', 400]]), arms)).toBeLessThan(1e-9);
  });

  it('two-proportion and mean-difference tests report lift against control', () => {
    const cvr = twoProportion(70, 1000, 50, 1000);
    expect(cvr.lift).toBeCloseTo(0.4, 6);
    expect(cvr.p).toBeGreaterThan(0.05);
    expect(cvr.p).toBeLessThan(0.1);
    const rps = meanDifference({ n: 1000, sum: 7000, sumSq: 700_000 }, { n: 1000, sum: 5000, sumSq: 500_000 });
    expect(rps.lift).toBeCloseTo(0.4, 6);
    expect(rps.p).toBeGreaterThan(0);
  });
});

describe('experiment SQL bounds', () => {
  it('every fact alias is bound on idsite and server_date', () => {
    for (const sql of [
      tagDaysSql(),
      tagSurfaceSql(),
      experimentFactSql({ withViewed: true, segmentations: shipped('experiments') }),
      experimentFactSql({ withViewed: false, segmentations: shipped('experiments') }),
      pageFactSql(),
      sectionFactSql(),
      elementFactSql(),
      elementFactSql({ withSections: false }),
    ]) {
      expect(queryBoundGaps(sql)).toEqual([]);
    }
  });

  it('keys selectors without Shopify template ids, in SQL and in JS', () => {
    const raw = '#shopify-section-template--20045246103645__custom_hero_v1 > div.container';
    expect(normalizeSelector(raw)).toBe('#shopify-section-template--__custom_hero_v1 > div.container');
    expect(normalizeSelector('#shopify-section-sections--20045245579357__header a')).toBe('#shopify-section-sections--__header a');
    expect(normalizedSelectorSql('cl.idselector')).toBe(String.raw`replaceRegexpAll(cl.idselector, '(template|sections)--\\d+__', '\\1--__')`);
    expect(elementFactSql({ withSections: false })).not.toContain('section_level_data');
  });

  it('reads the visit from the swapped idloghsr column of udp_partner_tags', () => {
    expect(tagDaysSql()).toContain('uniqExact(pt.idloghsr)');
    expect(experimentFactSql({ withViewed: false, segmentations: shipped('experiments') })).toContain('toUInt64(pt.idloghsr) AS idvisit');
    expect(experimentFactSql({ withViewed: false, segmentations: shipped('experiments') })).not.toMatch(/pt\.idvisit/);
  });
});

describe('experiment_descriptor governance import', () => {
  it('parses an operator descriptor', () => {
    const { experimentDescriptors, errors } = parseGovernanceImport([
      {
        kind: 'experiment_descriptor',
        idsite: 5769,
        experiment_key: 'shoplift:exp-a',
        name: 'Hero Test',
        hypothesis: 'A bigger hero lifts PDP entry',
        experiment_kind: 'experiment',
        scope: 'template',
        templates: ['home'],
        pages: [11],
        elements: [{ selector: '#hero .cta', arm: 'sl-abc', element_class: 'cta' }],
        arms: [
          { arm: 'control', is_control: true, allocation: 0.5 },
          { arm: 'sl-abc', label: 'Big hero', allocation: 0.5, aliases: ['sl-ABC#slr-x1'] },
        ],
        start: '2026-10-01',
        end: '2026-10-31',
      },
    ]);
    expect(errors).toEqual([]);
    expect(experimentDescriptors).toHaveLength(1);
    expect(experimentDescriptors[0]).toMatchObject({
      idsite: 5769,
      experimentKey: 'shoplift:exp-a',
      provenance: 'operator',
      partner: 'shoplift',
      partnerExperimentId: 'exp-a',
      scope: 'template',
      scopeSource: 'operator',
      templates: ['home'],
      pages: [11],
      declaredStart: '2026-10-01',
      declaredEnd: '2026-10-31',
    });
    expect(experimentDescriptors[0].arms[1]).toEqual({ arm: 'sl-abc', label: 'Big hero', allocation: 0.5, aliases: ['sl-ABC#slr-x1'] });
  });

  it('parses rollup zones with a default role and rejects a blank section or unknown role', () => {
    const ok = parseGovernanceImport([
      {
        kind: 'experiment_descriptor',
        idsite: 5769,
        experiment_key: 'shoplift:exp-a',
        zones: [{ section: ' custom-hero ' }, { section: 'header', role: 'guardrail' }],
        elements: [{ selector: '#hero a', section: 'custom-hero' }],
      },
    ]);
    expect(ok.errors).toEqual([]);
    expect(ok.experimentDescriptors[0].zones).toEqual([{ section: 'custom-hero', role: 'treated' }, { section: 'header', role: 'guardrail' }]);
    expect(ok.experimentDescriptors[0].elements).toEqual([{ selector: '#hero a', section: 'custom-hero' }]);

    const bad = parseGovernanceImport([
      { kind: 'experiment_descriptor', idsite: 1, experiment_key: 'shoplift:x', zones: [{ section: '' }, { section: 'hero', role: 'primary' }] },
    ]);
    expect(bad.errors.map((e) => e.replace(/^row 0: /, '').split(' ')[0])).toEqual(['zones[0]', 'zones[1].role']);
  });

  it('rejects a bad key, scope, template, page, allocation, and date', () => {
    const { errors } = parseGovernanceImport([
      {
        kind: 'experiment_descriptor',
        idsite: 1,
        experiment_key: 'no-partner',
        scope: 'galaxy',
        templates: ['homepage'],
        pages: [0],
        arms: [{ arm: 'a', allocation: 2 }],
        start: '10/01/2026',
      },
    ]);
    expect(errors.map((e) => e.replace(/^row 0: /, '').split(' ')[0])).toEqual([
      'experiment_key', 'scope', 'templates', 'pages', 'arms[0].allocation', 'start',
    ]);
  });
});

/**
 * A gateway that answers the dataset's labelled queries and records the
 * params each one got.
 * @param {{facts?: object[], pages?: object[], sections?: object[], elements?: object[], registryThrows?: boolean, elementsThrow?: boolean, noSectionTable?: boolean}} [opts]
 */
function fakeGateway(opts = {}) {
  /** @type {Map<string, object>} */
  const calls = new Map();
  return {
    calls,
    async columns(table) {
      if (table === 'section_level_data' && !opts.noSectionTable) {
        return ['event_type', 'idvisit', 'idsitehsr', 'section_name', 'section_path', 'element_selector', 'server_date'].map((name) => ({ name, type: 'String' }));
      }
      if (table !== 'udp_partner_tags') return [];
      return ['experience_id', 'variant_id', 'friendly_name', 'partner', 'server_date', 'idvisit', 'idloghsr'].map((name) => ({ name, type: 'String' }));
    },
    async query(sql, params, label) {
      calls.set(label, params);
      switch (label) {
        case 'experiment:tag-days':
          return SHOPLIFT;
        case 'experiment:surface':
          return SHOPLIFT_SURFACE;
        case 'experiment:registry':
          if (opts.registryThrows) throw new Error('Table default.partner_tags_logs does not exist');
          return [];
        case 'experiment:declared-table':
          return [{ n: 0 }];
        case 'experiment:facts':
          return opts.facts ?? FACTS;
        case 'experiment:pages':
          return opts.pages ?? [];
        case 'experiment:sections':
          return opts.sections ?? [];
        case 'experiment:elements':
          if (opts.elementsThrow) throw new Error('Memory limit exceeded');
          return opts.elements ?? [];
        default:
          throw new Error(`unexpected query: ${label}`);
      }
    },
  };
}

/** exp 0: control (arm 0) 1000 sessions 50 orders of 100; variant (arm 1) 1000 sessions 70 orders; 10 multi-arm visits. */
const FACTS = [
  { exp: 0, arm_index: 0, day: '2026-10-01', basis: 'assigned', viewport_type: 'all', segment: 'all', segment_value: 'all', sessions: 1000, buyers: 50, orders: 50, revenue: 5000, revenue_sq: 500_000, progressed: 120 },
  { exp: 0, arm_index: 1, day: '2026-10-01', basis: 'assigned', viewport_type: 'all', segment: 'all', segment_value: 'all', sessions: 1000, buyers: 70, orders: 70, revenue: 7000, revenue_sq: 700_000, progressed: 150 },
  { exp: 0, arm_index: 1, day: '2026-10-01', basis: 'assigned', viewport_type: 'mobile', segment: 'all', segment_value: 'all', sessions: 600, buyers: 40, orders: 40, revenue: 4000, revenue_sq: 400_000, progressed: 90 },
  { exp: 0, arm_index: 0, day: '2026-10-01', basis: 'multi_arm', viewport_type: 'all', segment: 'all', segment_value: 'all', sessions: 10, buyers: 0, orders: 0, revenue: 0, revenue_sq: 0, progressed: 0 },
];

/** @param {object} gateway @param {object} persistence */
function ctxFor(gateway, persistence) {
  return {
    batchId: '00000000-0000-0000-0000-000000000001',
    windowStart: '2026-09-11',
    windowEnd: '2026-10-10',
    gateway,
    persistence,
    logger,
    clock: { todayUtc: () => '2026-10-11' },
    datasets: new Map(),
    batchNotes: new Map(),
  };
}

describe('experiment-analysis dataset', () => {
  it('is a site dataset discovered by id', () => {
    expect(adapter).toMatchObject({ id: 'experiment-analysis', scope: 'site', dependsOn: [] });
  });

  it('assigns on the tag surface, reads out the running experiment, and persists descriptors and rows', async () => {
    const gateway = fakeGateway({ registryThrows: true });
    const memory = createMemoryAePersistence();
    const result = await adapter.collect({ idsite: 5769 }, ctxFor(gateway, memory.adapter));

    const facts = gateway.calls.get('experiment:facts');
    expect(facts.surfaceAll).toEqual([]);
    expect(facts.surfacePages).toEqual(['0|11']);
    expect(facts.raw).not.toContain('shoplift|exp-a|sl-zzz');
    expect(new Set(facts.mapped)).toEqual(new Set(['0:0', '0:1']));
    expect(facts.expo).toEqual([]);
    expect([facts.d0, facts.d1]).toEqual(['2026-10-01', '2026-10-10']);

    const life = result.rows.find((r) => r.dims.basis === 'lifecycle');
    expect(life.metrics).toMatchObject({
      name: 'Hero Test',
      kind: 'experiment',
      status: 'running',
      scope: 'template',
      scope_source: 'tags',
      templates: ['home'],
      exposure_rule: 'surface',
      control_arm: 'control',
      stray_arms: 1,
    });

    const readout = result.rows.filter((r) => r.dims.basis === 'assigned');
    expect(readout.map((r) => r.dims.arm)).toEqual(['control', 'sl-abc']);
    expect(result.rows.some((r) => r.dims.basis === 'exposed')).toBe(false);
    const variant = readout[1].metrics;
    expect(variant).toMatchObject({ cvr: 0.07, srm_pvalue: 1, srm_basis: 'assumed_equal', multi_arm_visits: 10, assigned_share: 0.5 });
    expect(variant.cvr_lift).toBeCloseTo(0.4, 4);
    expect(readout[0].metrics.cvr_lift).toBeNull();

    expect(result.notes).toMatchObject({ experiments_detected: 1, experiments_running: 1, experiments_analyzed: 1, experiment_rows: 4 });
    expect(result.notes.experiment_registry_note).toMatch(/partner_tags_logs unreadable/);

    const snap = memory.snapshot();
    expect(snap.experimentRows).toHaveLength(4);
    expect(snap.experimentDescriptors).toHaveLength(1);
    expect(snap.experimentDescriptors[0]).toMatchObject({ experimentKey: 'shoplift:exp-a', provenance: 'observed', status: 'running', scopeSource: 'tags' });
    expect((await memory.adapter.readSegmentationDefinitions(5769)).map((r) => [r.segmentation, r.version])).toEqual([['returning', 1], ['traffic_source', 1]]);
  });

  it('applies the operator descriptor: declared allocation, pages, and the exposed basis', async () => {
    const memory = createMemoryAePersistence();
    const { experimentDescriptors } = parseGovernanceImport([
      {
        kind: 'experiment_descriptor',
        idsite: 5769,
        experiment_key: 'shoplift:exp-a',
        name: 'Hero Test (operator)',
        hypothesis: 'A bigger hero lifts PDP entry',
        pages: [11],
        arms: [
          { arm: 'control', allocation: 0.5 },
          { arm: 'sl-abc', allocation: 0.5 },
        ],
      },
    ]);
    await memory.adapter.writeExperimentDescriptors(experimentDescriptors);
    const pageRows = [
      { exp: 0, arm_index: 0, day: '2026-10-01', idsitehsr: '11', viewport_type: 'all', sessions: 400, buyers: 20, orders: 20, revenue: 2000, revenue_sq: 200_000, progressed: 50 },
      { exp: 0, arm_index: 1, day: '2026-10-01', idsitehsr: '11', viewport_type: 'all', sessions: 410, buyers: 30, orders: 30, revenue: 3000, revenue_sq: 300_000, progressed: 60 },
    ];
    const facts = FACTS.flatMap((r) => (r.basis === 'assigned' && r.viewport_type === 'all' ? [r, { ...r, basis: 'exposed', sessions: r.sessions - 100 }] : [r]));
    const gateway = fakeGateway({ facts, pages: pageRows });
    const result = await adapter.collect({ idsite: 5769 }, ctxFor(gateway, memory.adapter));

    expect(gateway.calls.get('experiment:facts').expo).toEqual(['0|p:11']);
    expect(gateway.calls.get('experiment:pages').pagePairs).toEqual(['0|11']);

    const life = result.rows.find((r) => r.dims.basis === 'lifecycle');
    expect(life.metrics).toMatchObject({ name: 'Hero Test (operator)', exposure_rule: 'pages', scope: 'page' });
    const readout = result.rows.filter((r) => r.dims.basis !== 'lifecycle');
    expect(readout.map((r) => `${r.dims.arm}/${r.dims.basis}`)).toEqual(['control/assigned', 'sl-abc/assigned', 'control/exposed', 'sl-abc/exposed']);
    expect(readout[1].metrics).toMatchObject({ srm_basis: 'declared', declared_allocation: 0.5 });

    const snap = memory.snapshot();
    expect(snap.experimentDescriptors.map((d) => d.provenance).sort()).toEqual(['observed', 'operator']);
    const observed = snap.experimentDescriptors.find((d) => d.provenance === 'observed');
    expect(observed).toMatchObject({ name: 'Hero Test (operator)', hypothesis: 'A bigger hero lifts PDP entry', pages: [11] });
    expect(snap.experimentRows.filter((r) => r.idsitehsr === 11)).toHaveLength(2);
  });

  it('writes rollup section and element rows and reads them out against control', async () => {
    const memory = createMemoryAePersistence();
    const { experimentDescriptors, errors } = parseGovernanceImport([
      {
        kind: 'experiment_descriptor',
        idsite: 5769,
        experiment_key: 'shoplift:exp-a',
        zones: [{ section: 'custom-hero' }],
        elements: [{ selector: '#shopify-section-template--20045246103645__hero > a', element_class: 'cta' }],
      },
    ]);
    expect(errors).toEqual([]);
    await memory.adapter.writeExperimentDescriptors(experimentDescriptors);

    const cell = (arm, basis, section, sessions, buyers) => ({
      exp: 0, arm_index: arm, day: '2026-10-01', section, section_path: section ? `["${section}"]` : '', basis, viewport_type: 'all',
      sessions, buyers, orders: buyers, revenue: buyers * 100, revenue_sq: buyers * 10_000, progressed: buyers * 2,
    });
    const sections = [
      cell(0, 'section_captured', '', 200, 15),
      cell(1, 'section_captured', '', 140, 12),
      cell(0, 'section_seen', 'custom-hero', 100, 10),
      cell(1, 'section_seen', 'custom-hero', 84, 9),
      cell(0, 'section_clicked', 'custom-hero', 20, 4),
      cell(1, 'section_clicked', 'custom-hero', 21, 5),
    ];
    const click = (arm, selector, section, sessions, clicks) => ({
      exp: 0, arm_index: arm, day: '2026-10-01', selector, section, section_path: section ? `["${section}"]` : '', viewport_type: 'all',
      clicks, sessions, buyers: 5, orders: 5, revenue: 500, revenue_sq: 50_000, progressed: 10,
    });
    const elements = [
      click(0, '#shopify-section-template--__hero > a', 'custom-hero', 100, 120),
      click(1, '#shopify-section-template--__hero > a', 'custom-hero', 150, 160),
      click(0, 'button#Checkout', '', 300, 310),
      click(1, 'button#Checkout', '', 300, 305),
    ];
    const gateway = fakeGateway({ sections, elements });
    const result = await adapter.collect({ idsite: 5769 }, ctxFor(gateway, memory.adapter));

    expect(gateway.calls.get('experiment:sections')).toMatchObject({
      zoneAll: [], zonePages: ['0|11'], zonePageIds: [11], zoneAnyPage: 0, zonePairs: ['0|custom-hero'], sectionCap: 40, sectionMin: 100,
    });
    expect(gateway.calls.get('experiment:elements').elementPairs).toEqual(['0|#shopify-section-template--__hero > a']);

    const snap = memory.snapshot();
    const sectionRows = snap.experimentRows.filter((r) => r.metrics.row_kind === 'section');
    expect(sectionRows.map((r) => `${r.arm}/${r.basis}/${r.section}`).sort()).toEqual([
      'control/section_captured/', 'control/section_clicked/custom-hero', 'control/section_seen/custom-hero',
      'sl-abc/section_captured/', 'sl-abc/section_clicked/custom-hero', 'sl-abc/section_seen/custom-hero',
    ]);
    expect(sectionRows.find((r) => r.basis === 'section_seen').metrics.section_path).toEqual(['custom-hero']);
    const elementRows = snap.experimentRows.filter((r) => r.metrics.row_kind === 'element');
    expect(elementRows).toHaveLength(4);
    expect(elementRows.every((r) => r.basis === 'clicked' && r.idsitehsr === 0)).toBe(true);
    expect(elementRows.find((r) => r.section === 'custom-hero')).toMatchObject({ elementClass: 'cta', clicks: 120 });
    expect(snap.experimentDescriptors.find((d) => d.provenance === 'observed').zones).toEqual([{ section: 'custom-hero', role: 'treated' }]);

    const capture = result.rows.filter((r) => r.dims.basis === 'section_captured');
    expect(capture.map((r) => [r.dims.arm, r.metrics.capture_rate])).toEqual([['control', 0.2], ['sl-abc', 0.14]]);
    expect(capture[1].metrics.capture_pvalue).toBeLessThan(0.01);

    const hero = result.rows.filter((r) => r.dims.basis === 'section' && r.dims.section === 'custom-hero');
    expect(hero.map((r) => r.metrics.seen_rate)).toEqual([0.5, 0.6]);
    expect(hero[1].metrics).toMatchObject({ zone_role: 'treated', section_path: ['custom-hero'], seen_rate_lift: 0.2, click_rate: 0.15, seen_outcomes_comparable: 0 });
    expect(hero[0].metrics.seen_outcomes_comparable).toBeNull();

    const cta = result.rows.filter((r) => r.dims.basis === 'element' && r.dims.selector === '#shopify-section-template--__hero > a');
    expect(cta.map((r) => r.metrics.click_rate)).toEqual([0.1, 0.15]);
    expect(cta[1].dims.section).toBe('custom-hero');
    expect(cta[1].metrics).toMatchObject({ element_class: 'cta', click_rate_lift: 0.5, clicks_per_clicker: 1.0667 });
    expect(cta[1].metrics.click_rate_pvalue).toBeLessThan(0.01);

    expect(result.notes).toMatchObject({ experiment_section_rows: 6, experiment_element_rows: 4 });
  });

  it('keeps the experiment readout when the section table is missing and the element scan fails', async () => {
    const gateway = fakeGateway({ noSectionTable: true, elementsThrow: true });
    const result = await adapter.collect({ idsite: 5769 }, ctxFor(gateway, createMemoryAePersistence().adapter));
    expect(result.notes.experiment_sections_blocked).toMatch(/section_level_data missing columns/);
    expect(result.notes.experiment_elements_error).toMatch(/Memory limit/);
    expect(gateway.calls.has('experiment:sections')).toBe(false);
    expect(result.rows.filter((r) => r.dims.basis === 'assigned')).toHaveLength(2);
    expect(result.rows.some((r) => r.dims.basis === 'section_captured' || r.dims.basis === 'element')).toBe(false);
  });

  it('keeps its rows, notes, queries, and stored rows (characterization)', async () => {
    const TIME = /^\d{4}-\d\d-\d\d[ T]\d\d:\d\d/;
    const scrub = (value) => {
      if (typeof value === 'string' && TIME.test(value)) return '<time>';
      if (Array.isArray(value)) return value.map(scrub);
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v)]));
      return value;
    };
    const run = async (opts) => {
      const gateway = fakeGateway(opts);
      const labels = [];
      const query = gateway.query;
      gateway.query = async (sql, params, label) => {
        labels.push(label);
        return query(sql, params, label);
      };
      const memory = createMemoryAePersistence();
      const result = await adapter.collect({ idsite: 5769 }, ctxFor(gateway, memory.adapter));
      const snap = memory.snapshot();
      return scrub({ result, labels, experimentRows: snap.experimentRows, experimentDescriptors: snap.experimentDescriptors });
    };
    expect(await run({ registryThrows: true })).toMatchSnapshot();
    expect(await run({ noSectionTable: true, elementsThrow: true })).toMatchSnapshot();
  });

  it('returns no rows and a note on a site without partner tags', async () => {
    const gateway = fakeGateway();
    gateway.query = async (sql, params, label) => {
      if (label === 'experiment:tag-days') return [];
      throw new Error(`unexpected query: ${label}`);
    };
    const result = await adapter.collect({ idsite: 3207 }, ctxFor(gateway, createMemoryAePersistence().adapter));
    expect(result.rows).toEqual([]);
    expect(result.notes.experiment_analysis_note).toBe('no partner tags in the scan');
  });
});
