import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildMovers, decompose, headlineNumbers, siteWeek } from './brief-views.js';
import { coverageCheck, weekCoverage } from './coverage.js';
import { journeySummary } from './flows-views.js';
import { classify } from './noise.js';
import { distinct, toObjects } from './query.js';

const here = dirname(fileURLToPath(import.meta.url));
const dataRoot = join(here, '..', '..', 'data');

function expectDays(manifest, dataset, expected) {
  const cov = weekCoverage(manifest, dataset);
  assert.ok(cov, `${dataset} should be weekly`);
  for (const [week, days] of Object.entries(expected)) assert.equal(cov.get(week), days, `${dataset} ${week}`);
}

function load(slug, file) {
  return toObjects(JSON.parse(readFileSync(join(dataRoot, 'sites', slug, file), 'utf8')));
}

function manifestOf(slug) {
  return JSON.parse(readFileSync(join(dataRoot, 'sites', slug, 'manifest.json'), 'utf8'));
}

const mellow = existsSync(join(dataRoot, 'sites', 'mellow', 'manifest.json'));
const loop = existsSync(join(dataRoot, 'sites', 'loop-earplugs', 'manifest.json'));
if (!mellow || !loop) {
  console.log('snapshot data is missing; skipped data-backed assertions');
} else {
  const mellowManifest = manifestOf('mellow');
  const loopManifest = manifestOf('loop-earplugs');
  const bundle = { '2026-09-07': 3, '2026-09-14': 7, '2026-09-21': 7, '2026-09-28': 7, '2026-10-05': 6 };
  const whole = { '2026-09-07': 7, '2026-09-14': 7, '2026-09-21': 7, '2026-09-28': 7, '2026-10-05': 7 };
  for (const name of ['tag_trend', 'trend', 'selector-weekly']) expectDays(mellowManifest, name, bundle);
  for (const name of ['funnel', 'journeys']) expectDays(mellowManifest, name, whole);
  const loopBundle = { '2026-09-07': 2, '2026-09-14': 7, '2026-09-21': 7, '2026-09-28': 7, '2026-10-05': 7 };
  for (const name of ['tag_trend', 'trend', 'selector-weekly']) expectDays(loopManifest, name, loopBundle);

  const funnel = load('mellow', 'funnel.json');
  const tags = load('mellow', 'tag_trend.json');
  const report = coverageCheck(mellowManifest, (name) => (name === 'tag_trend' ? tags : funnel));
  assert.equal(report.ok, true, JSON.stringify(report.weeks));

  const weeks = distinct(funnel, 'week');
  const device = 'all';
  const meta = new Map();
  for (const r of funnel) {
    if (r.segment !== 'traffic_source' || r.segment_value !== 'meta' || r.viewport_type !== device) continue;
    const g = meta.get(r.week) ?? { sessions: 0, buyers: 0 };
    g.sessions += r.sessions; g.buyers += r.buyers;
    meta.set(r.week, g);
  }
  const metaPoints = weeks.map((w) => ({ week: w, num: meta.get(w).buyers, den: meta.get(w).sessions, days: 7 }));
  assert.equal(classify(metaPoints, weeks.length - 1, { kind: 'rate' }).label, 'unusual');
  const metaSessions = weeks.map((w) => ({ week: w, value: meta.get(w).sessions, days: 7 }));
  assert.equal(classify(metaSessions, weeks.length - 1, { kind: 'count' }).label, 'unusual');

  const campaign = new Map();
  for (const r of funnel) {
    if (r.segment !== 'traffic_source' || r.segment_value !== 'campaign' || r.viewport_type !== device) continue;
    const g = campaign.get(r.week) ?? { sessions: 0, buyers: 0 };
    g.sessions += r.sessions; g.buyers += r.buyers;
    campaign.set(r.week, g);
  }
  const campaignPoints = weeks.map((w) => ({ week: w, num: campaign.get(w).buyers, den: campaign.get(w).sessions, days: 7 }));
  assert.equal(classify(campaignPoints, weeks.length - 1, { kind: 'rate' }).label, 'normal');

  const returning = new Map();
  for (const r of funnel) {
    if (r.segment !== 'returning' || r.viewport_type !== device) continue;
    const value = String(r.segment_value);
    if (value !== 'returning' && value !== 'true' && value !== '1') continue;
    const g = returning.get(r.week) ?? { sessions: 0, buyers: 0 };
    g.sessions += r.sessions; g.buyers += r.buyers;
    returning.set(r.week, g);
  }
  const returningPoints = weeks.map((w) => ({ week: w, num: returning.get(w)?.buyers ?? 0, den: returning.get(w)?.sessions ?? 0, days: 7 }));
  assert.equal(classify(returningPoints, weeks.length - 1, { kind: 'rate' }).label, 'normal');

  const journeys = journeySummary(load('mellow', 'journeys.json'));
  const completion = (path) => weeks.map((w) => {
    const row = journeys.find((r) => r.kind === 'general' && r.path === path && r.segment === 'all' && r.segment_value === 'all' && r.viewport_type === 'all' && r.week === w);
    return { week: w, num: row?.end_sessions ?? 0, den: row?.start_sessions ?? 0, days: 7 };
  });
  assert.equal(classify(completion('content > pdp'), weeks.length - 1, { kind: 'rate' }).label, 'slide');
  assert.equal(classify(completion('home > content > pdp'), weeks.length - 1, { kind: 'rate' }).label, 'normal');

  assert.equal(classify([{ value: 90, days: 7 }, { value: 90, days: 7 }], 1, { kind: 'count' }).label, 'thin');
  assert.equal(classify([{ value: 1000, days: 7 }, { value: 2000, days: 6 }], 1, { kind: 'count' }).label, 'partial');

  const week = '2026-10-05';
  const prev = ['2026-09-28'];
  const headRows = siteWeek(funnel).filter((r) => r.segment === 'all' && r.segment_value === 'all' && r.viewport_type === 'all');
  const head = headlineNumbers(headRows, { week, compareWeeks: prev, weeks });
  assert.ok(Math.abs(head.previous.revenue - 2579051) < 1, head.previous.revenue);
  assert.ok(Math.abs(head.current.revenue - 2892975) < 1, head.current.revenue);
  assert.equal(head.previous.sessions, 1037914);
  assert.equal(head.current.sessions, 1324742);
  assert.ok(Math.abs(head.previous.session_conversion - 0.0196) < 0.0002);
  assert.ok(Math.abs(head.current.session_conversion - 0.0176) < 0.0002);
  assert.ok(Math.abs(head.previous.rps - 2.48) < 0.02);
  assert.ok(Math.abs(head.current.rps - 2.18) < 0.02);
  assert.ok(Math.abs(head.previous.aov - 125.09) < 0.05);
  assert.ok(Math.abs(head.current.aov - 122.92) < 0.05);

  const totals = {
    traffic_source: [712722, -429239, 30441],
    device: [712722, -14484, -384313],
    entry: [712722, -176536, -222262],
    returning: [712722, -80488, -318310],
  };
  for (const [dimension, [volume, mix, rate]] of Object.entries(totals)) {
    const result = decompose(funnel, { week, compareWeeks: prev, dimension, device: 'all' });
    const change = result.revenue1 - result.revenue0;
    assert.ok(Math.abs(result.volume + result.mix + result.rate - change) < 1, `${dimension} effects ${result.volume + result.mix + result.rate} vs ${change}`);
    assert.ok(Math.abs(result.volume - volume) < 1, `${dimension} volume ${result.volume}`);
    assert.ok(Math.abs(result.mix - mix) < 1, `${dimension} mix ${result.mix}`);
    assert.ok(Math.abs(result.rate - rate) < 1, `${dimension} rate ${result.rate}`);
  }
  const traffic = decompose(funnel, { week, compareWeeks: prev, dimension: 'traffic_source', device: 'all' });
  const near = (key, volume, mix, rate) => {
    const row = traffic.rows.find((r) => r.key === key);
    assert.ok(row, key);
    assert.ok(Math.abs(row.volume - volume) < 100, `${key} volume ${row.volume}`);
    assert.ok(Math.abs(row.mix - mix) < 100, `${key} mix ${row.mix}`);
    assert.ok(Math.abs(row.rate - rate) < 100, `${key} rate ${row.rate}`);
  };
  near('meta', 179500, 125800, -136700);
  near('search', 226000, -251000, 39500);
  near('campaign', 92200, -121200, 100200);
  near('direct', 136200, -146800, 19000);
  near('social', 70400, -23800, 12300);
  near('website', 8400, -12200, -3900);

  const built = buildMovers({ funnel, journeys, week, compareWeeks: prev, weeks, device: 'all', fieldLabel: (v) => v });
  const find = (measure, value) => built.all.find((item) => item.measure === measure && (item.value === value || item.subject === value));
  const metaSessionsMover = find('sessions', 'meta');
  const metaRate = find('session_conversion', 'meta');
  const lane = built.all.find((item) => item.source === 'journey' && item.value === 'content > pdp');
  const step = built.all.find((item) => item.measure === 'step_pv');
  assert.equal(metaSessionsMover.noise.label, 'unusual');
  assert.ok(Math.abs(metaSessionsMover.stake - 305000) < 20000, metaSessionsMover.stake);
  assert.equal(metaRate.noise.label, 'unusual');
  assert.ok(Math.abs(metaRate.stake + 123000) < 15000, metaRate.stake);
  assert.equal(lane.noise.label, 'slide');
  assert.ok(Math.abs(lane.stake + 164000) < 20000, lane.stake);
  assert.equal(find('session_conversion', 'campaign').noise.label, 'normal');
  assert.ok(Math.abs(step.before - 0.5931) < 0.001, step.before);
  assert.ok(Math.abs(step.after - 0.5195) < 0.001, step.after);
  assert.ok(Math.abs(step.stake + 410000) < 20000, step.stake);
  assert.ok(built.ranked.some((item) => item.value === 'meta' && item.measure === 'sessions'));
  assert.ok(built.ranked.some((item) => item.value === 'meta' && item.measure === 'session_conversion'));
  assert.ok(built.all.some((item) => item.value === 'content > pdp' && item.noise.label === 'slide'));
  assert.ok(built.all.some((item) => item.measure === 'step_pv'));
}

console.log('selftest passed');
