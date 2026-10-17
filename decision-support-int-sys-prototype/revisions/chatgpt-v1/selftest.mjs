#!/usr/bin/env node
// Numeric checks for ChatGPT - V1. Skips snapshot checks when data/sites/mellow is missing.
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { aggregate, format } from './query.js';
import { compatibility, coverage, daysInWeek } from './contracts.js';
import { buildAnalysis, fmtPct, mixRateSplit, partitionEffects, shapleyBridge } from './derive.js';
import { normsinv, screenRate, zStar } from './screening.js';

const here = dirname(fileURLToPath(import.meta.url));
const data = join(here, '..', '..', 'data');
const mellowDir = join(data, 'sites', 'mellow');
let failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) console.log(`  ok  ${name}`);
  else { failed += 1; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const near = (a, b, tol) => a !== null && b !== null && Math.abs(a - b) <= tol;

console.log('synthetic');
const allNull = aggregate([{ v: null }, { v: null }], ['k'], [{ sum: 'v' }]);
check('all-null aggregate is null', allNull[0].sums.v === null);
const some = aggregate([{ k: 'a', v: null }, { k: 'a', v: 2 }, { k: 'a', v: 3 }], ['k'], [{ sum: 'v' }]);
check('partial sum keeps present values', some[0].sums.v === 5 && some[0].partial === true, `sum=${some[0].sums.v} partial=${some[0].partial}`);
check('format(null) is an em dash', format(null) === '—', JSON.stringify(format(null)));

const undefinedRatio = shapleyBridge(
  { sessions: 100, buyers: 0, orders: 0, revenue: 0 },
  { sessions: 150, buyers: 10, orders: 10, revenue: 500 },
);
check('undefined ratio falls back to two factors', undefinedRatio.fallback === true);
check('two-factor residual is about zero', near(undefinedRatio.residual, 0, 1e-6), String(undefinedRatio.residual));

const z = zStar(15);
check('z* at M=15 is about 2.94', near(z, 2.94, 0.02), z.toFixed(3));
check('normsinv(0.975) is about 1.96', near(normsinv(0.975), 1.96, 0.001));

const meta = screenRate({
  kind: 'rate', trust: 'ok', x0: 8000, n0: 880000, x1: 7000, n1: 880000,
}, { M: 15, config: { minimumAbsoluteDelta: 0.002, minimumRelativeDelta: 0.1, minimumDenominatorBothWeeks: 200, minimumSuccessesAndFailuresBothWeeks: 20, minimumEquivalentOutcomes: 20 } });
check('a 0.11-point drop fails the absolute floor', meta.fails.includes('absolute-floor') && !meta.review);

if (!existsSync(mellowDir)) {
  console.log('data/sites/mellow is missing; snapshot checks skipped');
  process.exitCode = failed ? 1 : 0;
} else {
  console.log('mellow');
  const manifest = JSON.parse(readFileSync(join(mellowDir, 'manifest.json'), 'utf8'));
  const loop = JSON.parse(readFileSync(join(data, 'sites', 'loop-earplugs', 'manifest.json'), 'utf8'));
  const funnel = JSON.parse(readFileSync(join(mellowDir, 'funnel.json'), 'utf8'));
  const journeys = JSON.parse(readFileSync(join(mellowDir, 'journeys.json'), 'utf8'));
  const tags = JSON.parse(readFileSync(join(mellowDir, 'tag_trend.json'), 'utf8'));
  const toObj = (table) => table.rows.map((r) => Object.fromEntries(table.columns.map((c, i) => [c, r[i]])));
  const funnelRows = toObj(funnel);
  const journeyRows = toObj(journeys);
  const tagRows = toObj(tags);
  const views = JSON.parse(readFileSync(join(here, 'views.json'), 'utf8'));
  const screening = views.screening ?? {
    minimumDenominatorBothWeeks: 200,
    minimumSuccessesAndFailuresBothWeeks: 20,
    minimumAbsoluteDelta: 0.002,
    minimumRelativeDelta: 0.1,
    minimumEquivalentOutcomes: 20,
  };
  const rules = views.answerRules ?? [
    { id: 'journey_completion_decline', claimTemplate: '', prohibitedClaims: ['recoverable revenue'], requiredCaveats: [] },
    { id: 'channel_on_site_value', claimTemplate: '', prohibitedClaims: ['wasted spend', 'unprofitable'], requiredCaveats: ['last_touch', 'no_spend_data'] },
    { id: 'event_reach_movement', claimTemplate: '', prohibitedClaims: ['abandon'], requiredCaveats: ['unordered'] },
    { id: 'channel_rate_change', claimTemplate: '', prohibitedClaims: ['wasted spend'], requiredCaveats: ['last_touch', 'no_spend_data'] },
  ];

  const rowsOf = (name) => (name === 'tag_trend' ? tagRows : funnelRows);
  const analysis = buildAnalysis({
    funnelRows, journeyRows, manifest,
    context: { week: '2026-10-05', compareWeek: '2026-09-28', segment: 'all', segmentValue: 'all', device: 'all', rowsOf },
    screening, rules, emptyState: 'No eligible movement found in the loaded coverage. This is not a claim that the site is healthy.',
  });

  const bridge = analysis.bridge;
  const byFactor = Object.fromEntries(bridge.contributions.map((c) => [c.factor, c.value]));
  check('bridge sessions', near(byFactor.sessions, 669334, 1), String(Math.round(byFactor.sessions)));
  check('bridge rate', near(byFactor.rate, -307903, 1), String(Math.round(byFactor.rate)));
  check('bridge orders per buyer', near(byFactor.ops, 626, 1), String(Math.round(byFactor.ops)));
  check('bridge average order', near(byFactor.aov, -48132, 1), String(Math.round(byFactor.aov)));
  check('bridge residual', near(bridge.residual, 0, 0.01) && near(bridge.observed, 313924, 1), `obs=${bridge.observed} res=${bridge.residual}`);

  const expectSplit = {
    traffic_source: [-0.268, 0.060],
    device: [-0.009, -0.199],
    entry: [-0.110, -0.098],
    returning: [-0.049, -0.159],
  };
  for (const [name, [mix, rate]] of Object.entries(expectSplit)) {
    const got = partitionEffects(funnelRows, name, 'all', '2026-10-05', '2026-09-28');
    const mixPt = got.mix * 100; const ratePt = got.rate * 100;
    const entered = (got.entered + got.exited) * 100;
    const sum = (got.mix + got.rate + got.entered + got.exited) * 100;
    const obs = got.observed * 100;
    check(`${name} mix`, near(mixPt, mix, 0.001), mixPt.toFixed(3));
    check(`${name} rate`, near(ratePt, rate, 0.001), ratePt.toFixed(3));
    check(`${name} identity`, near(sum, obs, 0.001), `sum=${sum.toFixed(4)} obs=${obs.toFixed(4)} entered=${entered.toFixed(4)}`);
  }
  const channelRev = partitionEffects(funnelRows, 'traffic_source', 'all', '2026-10-05', '2026-09-28');
  const metaRev = channelRev.revenue.find((r) => r.key === 'meta');
  check('Meta revenue change', near(metaRev.delta, 168619, 1), String(Math.round(metaRev.delta)));
  check('channel revenue sums to the change', near(channelRev.revenueSum, bridge.observed, 1), String(Math.round(channelRev.revenueSum)));

  const deviceAll = scopeSessions(funnelRows, 'all');
  const deviceSum = ['mobile', 'desktop', 'tablet'].reduce((s, d) => s + scopeSessions(funnelRows, d), 0);
  check('device rows add up', deviceAll === deviceSum, `${deviceSum} vs ${deviceAll}`);

  check('family size is 15', analysis.M === 15, String(analysis.M));
  const reviewable = [
    ...analysis.eventReach.filter((r) => r.screen.review).map((r) => r.subject),
    ...analysis.journeys.filter((r) => r.screen.review).map((r) => r.subject),
    ...analysis.channels.filter((r) => r.rate.screen.review).map((r) => r.subject),
  ];
  const expectReview = ['Product viewed', 'Bought', 'Content → product page', 'Product page → content → product page', 'Campaign'];
  check('five reviewable names', expectReview.every((n) => reviewable.includes(n)) && reviewable.length === 5, reviewable.join(' | '));
  const metaRate = analysis.channels.find((c) => c.key === 'meta').rate;
  check('Meta conversion fails only the absolute floor', metaRate.screen.fails.length === 1 && metaRate.screen.fails[0] === 'absolute-floor', metaRate.screen.fails.join(','));

  const reach = Object.fromEntries(analysis.eventReach.map((r) => [r.metric, r]));
  check('product viewed', near(reach.product_viewed.current, 0.5195, 0.0001) && reach.product_viewed.x1 === 688156, fmtPct(reach.product_viewed.current));
  check('added to cart', near(reach.added_to_cart.current, 0.1027, 0.0001) && reach.added_to_cart.x1 === 136083);
  check('checkout', near(reach.checkout_started.current, 0.0477, 0.00015) && reach.checkout_started.x1 === 63254);
  check('bought', near(reach.buyers.current, 0.01757, 0.00005) && reach.buyers.x1 === 23275);
  const content = analysis.journeys.find((j) => j.path === 'content > pdp');
  check('content → product page', near(content.current, 0.0924, 0.0001) && content.n1 === 482800, `${fmtPct(content.current)} starts ${content.n1}`);
  const meta = analysis.channels.find((c) => c.key === 'meta');
  check('Meta share', near(meta.share1, 0.664, 0.001), fmtPct(meta.share1));
  check('Meta buying rate', near(meta.rate.current, 0.00795, 0.00005), fmtPct(meta.rate.current));
  check('Meta revenue', near(meta.rev1, 818319, 1), String(Math.round(meta.rev1)));
  check('Meta revenue per session', near(meta.rev1 / meta.n1, 0.93, 0.005));
  const search = analysis.channels.find((c) => c.key === 'search');
  check('Search buying rate', near(search.rate.current, 0.0448, 0.0002), fmtPct(search.rate.current));
  const campaign = analysis.channels.find((c) => c.key === 'campaign');
  check('Campaign buying rate', near(campaign.rate.prior, 0.0424, 0.0002) && near(campaign.rate.current, 0.0576, 0.0002), `${fmtPct(campaign.rate.prior)} → ${fmtPct(campaign.rate.current)}`);

  const claims = analysis.findings.map((f) => f.claim);
  check('three findings', analysis.findings.length === 3, claims.join(' || '));
  check('finding 1 is product viewed', /Product viewed: 51\.95%/.test(claims[0] ?? '') && /−7\.36 points/.test(claims[0] ?? ''), claims[0]);
  check('finding 2 is the journey with more starts', /Product page → content → product page: 2\.51%/.test(claims[1] ?? '') && /651,050/.test(claims[1] ?? ''), claims[1]);
  check('finding 3 is Meta', /Meta: 66\.4% of sessions/.test(claims[2] ?? '') && /3\.66%/.test(claims[2] ?? ''), claims[2]);
  check('Campaign is an improvement', /Campaign sessions that bought/.test(analysis.improvements[0]?.claim ?? ''), analysis.improvements.map((f) => f.claim).join(' | '));
  const banned = [...analysis.findings, ...analysis.improvements].flatMap((f) => {
    const text = `${f.claim} ${f.caveats.join(' ')}`;
    return (f.prohibited ?? []).filter((p) => text.toLowerCase().includes(p.toLowerCase())).map((p) => `${f.ruleId}:${p}`);
  });
  check('no prohibited phrase', banned.length === 0, banned.join(','));
  check('new claims do not say abandon', ![...claims, ...analysis.improvements.map((f) => f.claim)].join(' ').toLowerCase().includes('abandon'));

  const flowCov = coverage(manifest, 'funnel');
  check('funnel weeks are verified', [...flowCov.values()].every((v) => v.state === 'verified' && v.days === 7));
  const tagCov = coverage(manifest, 'tag_trend');
  check('5 Oct tag week is 6/7 inferred', tagCov.get('2026-10-05').days === 6 && tagCov.get('2026-10-05').state === 'partial-inferred');
  const pairs = compatibility(manifest, rowsOf, 'tag_trend', 'funnel');
  const ratio = Object.fromEntries(pairs.map((p) => [p.week, p]));
  check('7 Sep incompatible', ratio['2026-09-07'].state === 'incompatible');
  check('middle weeks compatible', ['2026-09-14', '2026-09-21', '2026-09-28'].every((w) => ratio[w].state === 'compatible'), ['2026-09-14', '2026-09-21', '2026-09-28'].map((w) => ratio[w].ratio.toFixed(3)).join(','));
  check('5 Oct incompatible', ratio['2026-10-05'].state === 'incompatible', String(ratio['2026-10-05'].ratio));
  const loopBundle = loop.bundle.window;
  check('Loop 7 Sep is 2/7', daysInWeek('2026-09-07', loopBundle.start, loopBundle.end) === 2, String(daysInWeek('2026-09-07', loopBundle.start, loopBundle.end)));
  check('Loop 5 Oct is 7/7', daysInWeek('2026-10-05', loopBundle.start, loopBundle.end) === 7);

  const limits = analysis.limits.join(' ');
  check('limits name the 6-day week', /6 of 7 days/.test(limits) && /0\.2%/.test(limits), limits.slice(0, 220));
}

function scopeSessions(rows, device) {
  return rows.filter((r) => r.segment === 'all' && r.viewport_type === device && r.week === '2026-10-05')
    .reduce((s, r) => s + r.sessions, 0);
}

// silence unused import if mixRateSplit is only reached through partitionEffects
void mixRateSplit;

console.log(failed ? `${failed} failed` : 'selftest passed');
process.exitCode = failed ? 1 : 0;
