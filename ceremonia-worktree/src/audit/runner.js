import { randomUUID } from 'node:crypto';
import { parseAuditInputs } from './matrix.js';
import { toAuditRows } from './persist.js';
import { crossBrandMedian, pilotRows, rankFindings } from './rank.js';
import { contextStage } from './stages/context.js';
import { funnelStage } from './stages/funnel.js';
import { loadPageScope } from './stages/page-scope.js';
import { readinessStage } from './stages/readiness.js';
import { siteKpiStage } from './stages/site-kpis.js';
import { templateStage } from './stages/template.js';
import { emit, stage } from '../telemetry/span.js';
import { auditWindows, daysInclusive } from './windows.js';

const PHASES = ['readiness', 'funnel', 'template', 'context', 'all'];

/**
 * Run the Roswell audit. Landing-page adapters are not invoked.
 *
 * phase `readiness` stops after R1–R13. `funnel` adds the F group.
 * `template` adds the H, L, P, C, K and G groups. `context` adds X1–X4, X6
 * and X8. `all` runs each stage. A blocked verdict still continues when the phase is `all`.
 *
 * @param {object} opts
 * @param {import('../ports/query-gateway.js').QueryGateway} opts.gateway
 * @param {Array<{key: string, name: string, domain: string, idsite: number}>} opts.brands from selectBrands
 * @param {import('../ports/dataset.js').Clock} opts.clock
 * @param {'readiness'|'funnel'|'template'|'context'|'all'} [opts.phase]
 * @param {unknown} [opts.inputs] matrix, url rules, and sale calendar
 * @param {{createBatch: Function, writeDatasetRows: Function}} [opts.persistence]
 * @param {object} [opts.logger]
 * @param {boolean} [opts.dryRun]
 */
export async function runAudit(opts) {
  const phase = opts.phase ?? 'readiness';
  if (!PHASES.includes(phase)) {
    throw new Error(`unknown audit phase "${phase}"`);
  }
  const windows = auditWindows(opts.clock.todayUtc());
  const inputs = parseAuditInputs(opts.inputs ?? { entries: [], urlRules: [], events: [] });
  const brands = opts.brands ?? [];
  if (brands.length === 0) throw new Error('runAudit needs at least one brand');
  const batchId = randomUUID();
  /** @type {object[]} */
  const brandResults = [];
  if (opts.persistence && !opts.dryRun) {
    await opts.persistence.createBatch({
      batchId,
      windowStart: windows.trendStart,
      windowEnd: windows.trendEnd,
      windowDays: daysInclusive(windows.trendStart, windows.trendEnd),
      siteSource: 'audit-roswell',
      qualifier: 'audit',
      pageSelector: 'audit',
      status: 'running',
      sitesQueued: brands.length,
      sitesAnalyzed: 0,
      sitesFailed: 0,
      metadata: { phase, bot_exclusion: 'portal §11.4' },
    });
  }

  for (const brand of brands) {
    const result = await runBrand(brand, { ...opts, phase, windows, inputs });
    brandResults.push(result);
    if (opts.persistence && !opts.dryRun) {
      await stage(opts.telemetry, 'persist', {
        brand: result.brand,
        idsite: result.idsite,
        rows: result.readinessRows.length + result.funnelRows.length + result.templateRows.length + result.contextRows.length,
      }, () => writeBrand(opts.persistence, batchId, result));
    }
  }

  const cards = brandResults.map((b) => ({
    brand: b.brand,
    verdict: b.verdict,
    revenueAtStake: b.revenueAtStake,
    reportableShare: b.reportableShare,
    completeness: b.completeness,
  }));
  const x9 = pilotRows(cards);
  const x10 = rankFindings(brandResults.flatMap((b) => b.findings));
  const x7 = crossBrandMedian(brandResults.flatMap((b) => b.templateCr));
  const x5 = brandResults.flatMap((b) => b.changePoints);

  if (opts.persistence && !opts.dryRun) {
    const anchor = brandResults.find((b) => b.idsite > 0);
    if (anchor) {
      const ranked = toAuditRows(batchId, anchor.idsite, 'audit-rank', [...x9, ...x10, ...x7, ...x5]);
      if (ranked.length > 0) await opts.persistence.writeDatasetRows(ranked);
    }
  }

  return {
    batchId,
    windows,
    phase,
    pilot: x9.find((r) => r.metrics.pilot)?.dims.brand ?? null,
    brands: brandResults.map((b) => ({
      brand: b.brand,
      idsite: b.idsite,
      verdict: b.verdict,
      reasons: b.reasons,
      revenueAtStake: b.revenueAtStake,
      rows: {
        readiness: b.readinessRows.length,
        funnel: b.funnelRows.length,
        template: b.templateRows.length,
        context: b.contextRows.length,
      },
    })),
  };
}

/**
 * One brand through the stages its phase asks for. Each stage gets the
 * inputs it reads; a blocked verdict still runs every stage when the
 * phase is `all`, so a stale or untrusted table keeps the rest of the
 * site's evidence.
 * @param {{key: string, name: string, domain: string, idsite: number}} brand
 * @param {object} ctx
 */
async function runBrand(brand, ctx) {
  const { gateway, windows, inputs, phase, telemetry } = ctx;
  const readinessStarted = Date.now();
  const readiness = await readinessStage(gateway, brand, windows, inputs);
  emit(telemetry, {
    name: 'stage',
    durationMs: Date.now() - readinessStarted,
    ok: true,
    attrs: { stage: 'readiness', brand: brand.key, idsite: readiness.idsite, verdict: readiness.verdict },
  });
  const idsite = readiness.idsite;
  /** @type {Array<{dims: object, metrics: object}>} */
  const funnelRows = [];
  let templateRows = [];
  let contextRows = [];
  /** @type {object[]} */
  const findings = [];
  let templateCr = [];
  let changePoints = [];
  let kpis = [];
  let revenueAtStake = 0;

  const goFurther = idsite > 0 && (readiness.verdict !== 'blocked' || phase === 'all');
  const wantFunnel = phase === 'funnel' || phase === 'all';
  const wantTemplate = phase === 'template' || phase === 'all';
  const wantContext = phase === 'context' || phase === 'all';
  const rules = inputs.urlRules.filter((r) => r.idsite === idsite);
  const entries = inputs.entries.filter((e) => e.idsite === idsite);
  let scope = null;
  if (goFurther && (wantFunnel || wantTemplate || wantContext)) {
    try {
      scope = await loadPageScope(gateway, idsite, rules);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (wantFunnel) funnelRows.push({ dims: { query: 'pages' }, metrics: { error: message } });
    }
  }

  if (goFurther && (wantFunnel || wantContext)) {
    const events = inputs.events.filter((e) => e.idsite === idsite);
    const site = await siteKpiStage(gateway, { brand: brand.key, idsite, windows, events });
    kpis = site.kpis;
    changePoints = site.changePoints;
    if (wantFunnel) funnelRows.push(...(site.error ? [{ dims: { query: 'F1' }, metrics: { error: site.error } }] : kpis));
  }

  if (goFurther && wantFunnel) {
    const funnel = await stage(telemetry, 'funnel', { brand: brand.key, idsite }, () =>
      funnelStage(gateway, { brand: brand.key, idsite, windows, rules, scope, kpis }));
    funnelRows.push(...funnel.rows);
    findings.push(...funnel.findings);
    revenueAtStake = funnel.revenueAtStake;
  }

  if (goFurther && wantTemplate) {
    const checkoutTracked = Number(readiness.rows.find((row) => row.dims.query === 'R5')?.metrics?.by_template?.checkout ?? 0) > 0;
    const exitRows = funnelRows.filter((row) => row.dims.query === 'F9');
    const template = await stage(telemetry, 'template', { brand: brand.key, idsite }, () =>
      templateStage(gateway, { brand: brand.key, idsite, windows, rules, entries, scope, checkoutTracked, exitRows }));
    templateRows = template.rows;
    templateCr = template.templateCr;
  }

  if (goFurther && wantContext) {
    contextRows = await stage(telemetry, 'context', { brand: brand.key, idsite }, () =>
      contextStage(gateway, { idsite, windows, rules, scope, kpis }));
  }

  return {
    brand: brand.key,
    idsite,
    verdict: readiness.verdict,
    reasons: readiness.reasons,
    reportableShare: readiness.reportableShare,
    completeness: readiness.completeness,
    revenueAtStake,
    readinessRows: readiness.rows,
    funnelRows,
    templateRows,
    contextRows,
    findings,
    templateCr,
    changePoints,
  };
}

/**
 * @param {{createBatch?: Function, writeDatasetRows: Function}} persistence
 * @param {string} batchId
 * @param {object} brand
 */
async function writeBrand(persistence, batchId, brand) {
  if (!(brand.idsite > 0)) return;
  /** @type {object[]} */
  const stored = [
    ...toAuditRows(batchId, brand.idsite, 'audit-readiness', brand.readinessRows),
    ...toAuditRows(batchId, brand.idsite, 'audit-funnel', brand.funnelRows),
    ...toAuditRows(batchId, brand.idsite, 'audit-template', brand.templateRows),
    ...toAuditRows(batchId, brand.idsite, 'audit-context', brand.contextRows),
  ];
  if (stored.length > 0) await persistence.writeDatasetRows(stored);
}
