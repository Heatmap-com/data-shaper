import { configuredDatabase } from '../query-gateway/clickhouse.js';
import { missingColumns } from './checks.js';
import { SHIPPED_DEFAULTS, declaredSegmentation } from '../../application/segmentation/registry.js';
import { runVersions, stampVersions } from '../../application/segmentation/versions.js';
import { loadSegmentationCatalog } from '../../catalog/segmentations.js';
import { addDays, lifecycle } from '../../experiments/lifecycle.js';
import {
  applyOperatorArms,
  buildExperiments,
  canonicalVariant,
  classifyKind,
  inferDevice,
  inferScope,
  inferSurface,
  markSharedControls,
  normalizeSelector,
  rawKey,
} from '../../experiments/normalize.js';
import { elementReadoutRows, readoutRows, sectionReadoutRows, toExperimentRows } from '../../experiments/readout.js';
import {
  elementFactSql,
  experimentFactSql,
  pageFactSql,
  registrySql,
  sectionFactSql,
  tagDaysSql,
  tagSurfaceSql,
} from '../../experiments/sql.js';

/**
 * The partner experiment scan in two parts. scanExperiments finds every
 * experiment seen on the site in the last SCAN_DAYS, normalized and dated;
 * readExperiments reads out the chosen ones and stores their descriptors
 * and daily rows. experiment-analysis chooses the largest analyzable ones;
 * the experiment profile's selector chooses by its criteria. The scan is
 * kept in the site memo, so the selector and the readout share one scan.
 */

export const SCAN_DAYS = 60;
export const SECTION_CAP = 40;
export const SECTION_MIN_VISITS = 100;
export const ELEMENT_CAP = 40;
export const ELEMENT_MIN_VISITS = 100;
const WRITE_CHUNK = 50_000;

/** @type {ReadonlyArray<import('../../ports/segmentation.js').Segmentation> | null} */
let shippedExperimentSegmentations = null;

/**
 * The site's experiment segmentations from the run's registry, else the
 * shipped default, which is all declared.
 * @param {import('../../ports/dataset.js').RunContext} ctx
 * @param {number} idsite
 */
function experimentSegmentations(ctx, idsite) {
  if (ctx.segmentations) return ctx.segmentations.select(idsite, 'experiments');
  shippedExperimentSegmentations ??= SHIPPED_DEFAULTS.experiments.map((id) => {
    const seg = loadSegmentationCatalog().find((item) => item.id === id);
    if (!seg) throw new Error(`the shipped experiment segmentation ${id} is not in the catalog`);
    return declaredSegmentation(seg);
  });
  return shippedExperimentSegmentations;
}
const SCAN_MEMO = 'experiment-scan';

/**
 * @typedef {Object} ExperimentScan
 * @property {string} scanStart
 * @property {string} scanEnd
 * @property {object} notes
 * @property {boolean} stopped the scan could not run or found no partner tags; notes say which
 * @property {ReturnType<typeof describe>[]} experiments
 */

/**
 * @param {import('../../ports/dataset.js').RunContext} ctx
 * @param {number} idsite
 * @returns {Promise<ExperimentScan>}
 */
export async function scanExperiments(ctx, idsite) {
  const memo = ctx.batchNotes?.get(SCAN_MEMO);
  if (memo?.idsite === idsite) return memo.scan;
  const scan = await runScan(ctx, idsite);
  ctx.batchNotes?.set(SCAN_MEMO, { idsite, scan });
  return scan;
}

/**
 * @param {import('../../ports/dataset.js').RunContext} ctx
 * @param {number} idsite
 * @returns {Promise<ExperimentScan>}
 */
async function runScan(ctx, idsite) {
  const scanEnd = ctx.windowEnd;
  const scanStart = minDate(addDays(scanEnd, -(SCAN_DAYS - 1)), ctx.windowStart);
  const notes = { experiment_scan: { start: scanStart, end: scanEnd } };
  const stopped = (extra) => ({ scanStart, scanEnd, notes: { ...notes, ...extra }, stopped: true, experiments: [] });

  const missing = await missingColumns(ctx, 'udp_partner_tags', [
    'experience_id', 'variant_id', 'friendly_name', 'partner', 'server_date', 'idloghsr',
  ]);
  if (missing.length > 0) {
    return stopped({ experiment_analysis_blocked: `udp_partner_tags missing columns: ${missing.join(', ')}` });
  }

  const tagDays = (await ctx.gateway.query(tagDaysSql(), { idsite, s0: scanStart, s1: scanEnd }, 'experiment:tag-days')).map((r) => ({
    day: String(r.day),
    partner: String(r.partner ?? ''),
    experience_id: String(r.experience_id ?? ''),
    variant_id: String(r.variant_id ?? ''),
    friendly_name: String(r.friendly_name ?? ''),
    visits: Number(r.visits ?? 0),
  }));
  if (tagDays.length === 0) return stopped({ experiment_analysis_note: 'no partner tags in the scan' });

  const registry = await readRegistry(ctx, idsite, notes);
  const declared = await readDeclared(ctx, idsite);
  const operator = await readOperator(ctx, idsite);
  const surfaceRows = await readSurfaceRows(ctx, idsite, scanStart, scanEnd);

  const experiments = markSharedControls(buildExperiments(tagDays, registry)).map((built) => describe(built, {
    operator: operator.get(built.key),
    declared: declared.get(built.key) ?? declared.get(built.partnerExperimentId),
    surfaceRows,
    scanStart,
    scanEnd,
  }));
  return { scanStart, scanEnd, notes, stopped: false, experiments };
}

/**
 * @typedef {Object} ExperimentReadout
 * @property {ReturnType<typeof plan>[]} plans the chosen experiments, in the order given
 * @property {Set<string>} analyzed their keys
 * @property {object[]} factRows the ae_experiment_row rows
 * @property {Map<string, object[]>} rowsByExperiment
 * @property {object} notes
 */

/**
 * Reads out the chosen experiments of a scan: the fact, page, section, and
 * element queries, then the observed descriptor of every scanned
 * experiment and the chosen ones' daily rows.
 * @param {import('../../ports/dataset.js').RunContext} ctx
 * @param {number} idsite
 * @param {ExperimentScan} scan
 * @param {ExperimentScan['experiments']} chosen
 * @returns {Promise<ExperimentReadout>}
 */
export async function readExperiments(ctx, idsite, scan, chosen) {
  const { scanStart, scanEnd } = scan;
  /** @type {object} */
  const notes = {};
  const plans = chosen.map((exp, index) => plan(exp, index, scanStart, scanEnd));
  const analyzed = new Set(plans.map((p) => p.exp.key));

  /** @type {object[]} */
  const factRows = [];
  let versions = null;
  if (plans.length > 0) {
    const params = queryParams(idsite, plans);
    const withViewed = params.expo.length > 0;
    const segmentations = experimentSegmentations(ctx, idsite);
    versions = await runVersions(segmentations, {}, { idsite, persistence: ctx.persistence });
    const raw = await ctx.gateway.query(experimentFactSql({ withViewed, segmentations }), { ...params }, 'experiment:facts');
    appendAll(factRows, stampVersions(toExperimentRows(raw, plans, { batchId: ctx.batchId, idsite, kind: 'experiment' }), versions.byId));

    const pagePairs = plans.flatMap((p) => p.exp.pages.map((id) => `${p.index}|${id}`));
    if (pagePairs.length > 0) {
      const pages = [...new Set(plans.flatMap((p) => p.exp.pages))];
      const rawPages = await ctx.gateway.query(pageFactSql(), { ...params, pages, pagePairs }, 'experiment:pages');
      appendAll(factRows, toExperimentRows(rawPages, plans, { batchId: ctx.batchId, idsite, kind: 'page' }));
    }

    const zone = zoneParams(plans);
    const missingSections = await missingColumns(ctx, 'section_level_data', [
      'event_type', 'idvisit', 'idsitehsr', 'section_name', 'section_path', 'element_selector', 'server_date',
    ]);
    // Rollup and element rows add to the readout; a failed scan is a note
    // and the experiment rows above still stand.
    if (missingSections.length > 0) {
      notes.experiment_sections_blocked = `section_level_data missing columns: ${missingSections.join(', ')}`;
    } else {
      try {
        const rawSections = await ctx.gateway.query(
          sectionFactSql(),
          { ...params, ...zone.query, sectionCap: SECTION_CAP, sectionMin: SECTION_MIN_VISITS },
          'experiment:sections',
        );
        appendAll(factRows, toExperimentRows(rawSections, plans, { batchId: ctx.batchId, idsite, kind: 'section' }));
      } catch (err) {
        notes.experiment_sections_error = errorText(err);
      }
    }
    try {
      const rawElements = await ctx.gateway.query(
        elementFactSql({ withSections: missingSections.length === 0 }),
        { ...params, ...zone.query, elementCap: ELEMENT_CAP, elementMin: ELEMENT_MIN_VISITS },
        'experiment:elements',
      );
      appendAll(factRows, toExperimentRows(rawElements, plans, { batchId: ctx.batchId, idsite, kind: 'element', elements: zone.elements }));
    } catch (err) {
      notes.experiment_elements_error = errorText(err);
    }
  }

  const descriptorRows = scan.experiments.map((exp) => descriptorRow(idsite, exp, analyzed.has(exp.key), scanEnd));
  if (typeof ctx.persistence?.writeExperimentDescriptors === 'function') {
    await ctx.persistence.writeExperimentDescriptors(descriptorRows);
  }
  if (typeof ctx.persistence?.writeExperimentRows === 'function') {
    for (let i = 0; i < factRows.length; i += WRITE_CHUNK) {
      await ctx.persistence.writeExperimentRows(factRows.slice(i, i + WRITE_CHUNK));
    }
    await versions?.record();
  } else if (factRows.length > 0) {
    notes.experiment_rows_unwritten = 'persistence has no writeExperimentRows; rows were computed and not stored';
  }

  /** @type {Map<string, object[]>} */
  const rowsByExperiment = new Map();
  for (const row of factRows) {
    if (!rowsByExperiment.has(row.experimentKey)) rowsByExperiment.set(row.experimentKey, []);
    rowsByExperiment.get(row.experimentKey).push(row);
  }
  return { plans, analyzed, factRows, rowsByExperiment, notes };
}

/**
 * One analyzed experiment's readout rows: per (arm, basis), per arm for the
 * section capture, per (section, arm), and per (element, arm).
 * @param {ReturnType<typeof plan>} p
 * @param {object[]} expRows the experiment's ae_experiment_row rows
 */
export function experimentReadoutRows(p, expRows) {
  return [
    ...readoutRows(p, expRows),
    ...sectionReadoutRows(p, expRows, new Map(p.exp.zones.map((z) => [z.section, z.role]))),
    ...elementReadoutRows(p, expRows),
  ];
}

/**
 * One normalized experiment with its lifecycle and the descriptor fields,
 * operator values winning over inferred ones.
 * @param {ReturnType<typeof buildExperiments>[number]} built
 * @param {{operator?: object, declared?: object, surfaceRows: Map<string, object[]>, scanStart: string, scanEnd: string}} ctx
 */
function describe(built, { operator, declared, surfaceRows, scanStart, scanEnd }) {
  let exp = applyOperatorArms(built, operator?.arms ?? []);
  if (declared && !(operator?.arms ?? []).some((a) => a.allocation != null)) {
    exp = { ...exp, arms: exp.arms.map((a) => ({ ...a, allocation: declared.allocations.get(a.arm) ?? a.allocation })) };
  }
  const life = lifecycle(exp.daily, { windowEnd: scanEnd, scanStart });
  const surface = inferSurface(exp, [...exp.rawKeys.keys()].flatMap((key) => surfaceRows.get(key) ?? []));
  const inferred = scopeFromSurface(inferScope(exp), surface);
  const name = operator?.name || exp.name;
  const kind = operator?.kind || classifyKind({ ...exp, name });
  const templates = operator?.templates?.length > 0 ? operator.templates : inferred.templates;
  const pages = (operator?.pages ?? []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  const scope = operator?.scope || (pages.length > 0 ? 'page' : inferred.scope);
  // Off a partial surface every visit is tagged control, so assignment
  // already requires a tag on the tested templates and is the exposure.
  const exposureRule = pages.length > 0
    ? 'pages'
    : !surface.all
      ? 'surface'
      : scope === 'template' && templates.length > 0 ? 'templates' : 'assigned';
  const declaredStart = operator?.declaredStart ?? declared?.startedAt ?? null;
  const declaredEnd = operator?.declaredEnd ?? declared?.endedAt ?? null;
  const liveArms = exp.arms.filter((a) => !a.stray);
  return {
    ...exp,
    name,
    kind,
    scope,
    scopeSource: operator?.scope || pages.length > 0 ? 'operator' : inferred.scopeSource,
    templates,
    pages,
    elements: Array.isArray(operator?.elements) ? operator.elements : [],
    zones: (Array.isArray(operator?.zones) ? operator.zones : [])
      .filter((z) => String(z?.section ?? '').trim() !== '')
      .map((z) => ({ section: String(z.section).trim(), role: z.role === 'guardrail' ? 'guardrail' : 'treated' })),
    deviceScope: operator?.deviceScope || inferDevice(name),
    hypothesis: operator?.hypothesis ?? '',
    description: operator?.description ?? '',
    declaredStart,
    declaredEnd,
    exposureRule,
    surface,
    lifecycle: life,
    status: life.status,
    analyzable: kind === 'experiment' && (life.status === 'running' || life.status === 'recent') && liveArms.length >= 2,
  };
}

/**
 * Analysis range and the arms the query maps to indexes. Stray arms are
 * not mapped, so their visits are not counted.
 * @param {ReturnType<typeof describe>} exp
 * @param {number} index
 * @param {string} scanStart
 * @param {string} scanEnd
 */
function plan(exp, index, scanStart, scanEnd) {
  let start = maxDate(exp.lifecycle.observedStart, scanStart);
  let end = minDate(exp.lifecycle.observedEnd, scanEnd);
  if (exp.declaredStart) start = maxDate(start, String(exp.declaredStart).slice(0, 10));
  if (exp.declaredEnd) end = minDate(end, String(exp.declaredEnd).slice(0, 10));
  if (end < start) end = start;
  return { index, exp, arms: exp.arms.filter((a) => !a.stray), start, end };
}

/**
 * The query arrays: raw tag keys to `{exp}:{arm}`, per-experiment active
 * ranges, and the exposure targets (`{exp}|t:{template}`, `{exp}|p:{page}`).
 * @param {number} idsite
 * @param {ReturnType<typeof plan>[]} plans
 */
function queryParams(idsite, plans) {
  const raw = [];
  const mapped = [];
  const expo = [];
  const surfaceAll = [];
  const surfacePages = [];
  for (const p of plans) {
    if (p.exp.surface.all) surfaceAll.push(p.index);
    else for (const id of p.exp.surface.pages) surfacePages.push(`${p.index}|${id}`);
    const armIndex = new Map(p.arms.map((a, i) => [a.arm, i]));
    for (const [key, arm] of p.exp.rawKeys) {
      if (!armIndex.has(arm)) continue;
      raw.push(key);
      mapped.push(`${p.index}:${armIndex.get(arm)}`);
    }
    if (p.exp.exposureRule === 'pages') for (const id of p.exp.pages) expo.push(`${p.index}|p:${id}`);
    if (p.exp.exposureRule === 'templates') for (const t of p.exp.templates) expo.push(`${p.index}|t:${t}`);
  }
  return {
    idsite,
    d0: plans.reduce((min, p) => minDate(min, p.start), plans[0].start),
    d1: plans.reduce((max, p) => maxDate(max, p.end), plans[0].end),
    raw,
    mapped,
    starts: plans.map((p) => p.start),
    ends: plans.map((p) => p.end),
    expo,
    surfaceAll,
    surfacePages,
  };
}

/**
 * Registry and name scope win; without them the tag surface says it: a
 * partial surface is a template test on those templates, a full one over
 * more than one template is site-wide.
 * @param {ReturnType<typeof inferScope>} inferred
 * @param {ReturnType<typeof inferSurface>} surface
 */
function scopeFromSurface(inferred, surface) {
  if (inferred.scopeSource === 'registry') return inferred;
  if (!surface.all) return { scope: 'template', templates: surface.templates, scopeSource: 'tags' };
  if (inferred.scopeSource === 'name') return inferred;
  if (surface.templates.length > 1) return { scope: 'site', templates: [], scopeSource: 'tags' };
  return inferred;
}

/**
 * Surface tag counts keyed by raw tag key, so each experiment reads only
 * its own rows.
 * @param {import('../../ports/dataset.js').RunContext} ctx
 * @param {number} idsite
 * @param {string} s0
 * @param {string} s1
 */
async function readSurfaceRows(ctx, idsite, s0, s1) {
  /** @type {Map<string, object[]>} */
  const out = new Map();
  const rows = await ctx.gateway.query(tagSurfaceSql(), { idsite, s0, s1 }, 'experiment:surface');
  for (const r of rows) {
    const row = {
      partner: String(r.partner ?? ''),
      experience_id: String(r.experience_id ?? ''),
      variant_id: String(r.variant_id ?? ''),
      idsitehsr: String(r.idsitehsr ?? ''),
      template: String(r.template ?? ''),
      tags: Number(r.tags ?? 0),
    };
    const key = rawKey(row.partner, row.experience_id, row.variant_id);
    if (!out.has(key)) out.set(key, []);
    out.get(key).push(row);
  }
  return out;
}

/**
 * The section and element scans' arrays. An experiment reads sections and
 * clicks on its operator pages (plus any operator element's page), else on
 * its tag surface's pages, else on every page (`zoneAll`). zonePairs and
 * elementPairs are the operator's zones and elements, always kept;
 * elements maps `{exp}|{normalized selector}` to the operator's arm and
 * class.
 * @param {ReturnType<typeof plan>[]} plans
 */
function zoneParams(plans) {
  const zoneAll = [];
  const zonePages = [];
  /** @type {Set<string>} */
  const pageIds = new Set();
  const zonePairs = [];
  const elementPairs = [];
  /** @type {Map<string, {arm: string, elementClass: string}>} */
  const elements = new Map();
  for (const p of plans) {
    const exp = p.exp;
    const pages = new Set(exp.pages.map(String));
    for (const element of exp.elements) if (element?.idsitehsr) pages.add(String(element.idsitehsr));
    if (exp.pages.length === 0 && !exp.surface.all) for (const id of exp.surface.pages) pages.add(String(id));
    if (exp.pages.length === 0 && exp.surface.all) {
      zoneAll.push(p.index);
    } else {
      for (const id of pages) {
        zonePages.push(`${p.index}|${id}`);
        pageIds.add(id);
      }
    }
    for (const z of exp.zones) zonePairs.push(`${p.index}|${z.section}`);
    for (const element of exp.elements) {
      const selector = normalizeSelector(element?.selector);
      if (selector === '') continue;
      elementPairs.push(`${p.index}|${selector}`);
      elements.set(`${p.index}|${selector}`, {
        arm: element.arm ? canonicalVariant(element.arm) : '',
        elementClass: String(element.element_class ?? element.elementClass ?? ''),
      });
    }
  }
  return {
    query: {
      zoneAll,
      zonePages,
      zonePageIds: [...pageIds].map(Number).filter((n) => Number.isInteger(n) && n > 0),
      zoneAnyPage: zoneAll.length > 0 ? 1 : 0,
      zonePairs,
      elementPairs,
    },
    elements,
  };
}

/** @param {unknown} err */
function errorText(err) {
  return (err instanceof Error ? err.message : String(err)).slice(0, 300);
}

/** @param {ReturnType<typeof describe>} exp @param {boolean} analyzed */
export function lifecycleRow(exp, analyzed) {
  const life = exp.lifecycle;
  return {
    dims: { experiment_key: exp.key, arm: '', basis: 'lifecycle' },
    metrics: {
      name: exp.name,
      partner: exp.partner,
      kind: exp.kind,
      status: exp.status,
      analyzed: analyzed ? 1 : 0,
      observed_start: life.observedStart,
      observed_end: life.observedEnd,
      first_seen: life.firstSeen,
      last_seen: life.lastSeen,
      started_before_scan: life.startedBeforeScan ? 1 : 0,
      peak_daily_visits: life.peakDailyVisits,
      active_days: life.activeDays,
      visits: life.visits,
      tail_visits: life.tailVisits,
      arms: exp.arms.filter((a) => !a.stray).length,
      stray_arms: exp.arms.filter((a) => a.stray).length,
      control_arm: exp.arms.find((a) => a.isControl)?.arm ?? null,
      scope: exp.scope,
      scope_source: exp.scopeSource,
      templates: exp.templates,
      device_scope: exp.deviceScope,
      exposure_rule: exp.exposureRule,
      surface_templates: exp.surface.templates,
      off_surface_share: Object.fromEntries(exp.surface.offSurface),
    },
  };
}

/**
 * The `observed` descriptor row: what the engine inferred, merged with the
 * operator's row. The operator row itself is written by the governance
 * import and never by this dataset.
 * @param {number} idsite
 * @param {ReturnType<typeof describe>} exp
 * @param {boolean} analyzed
 * @param {string} asOf
 */
function descriptorRow(idsite, exp, analyzed, asOf) {
  const life = exp.lifecycle;
  return {
    idsite,
    experimentKey: exp.key,
    provenance: 'observed',
    partner: exp.partner,
    partnerExperimentId: exp.partnerExperimentId,
    name: exp.name,
    hypothesis: exp.hypothesis,
    description: exp.description,
    kind: exp.kind,
    scope: exp.scope,
    scopeSource: exp.scopeSource,
    deviceScope: exp.deviceScope,
    templates: exp.templates,
    pages: exp.pages,
    elements: exp.elements,
    zones: exp.zones,
    arms: exp.arms.map((a) => ({
      arm: a.arm,
      label: a.label,
      is_control: a.isControl,
      allocation: a.allocation,
      aliases: a.aliases,
      visits: a.visits,
      stray: a.stray,
    })),
    declaredStart: exp.declaredStart ? String(exp.declaredStart).slice(0, 10) : null,
    declaredEnd: exp.declaredEnd ? String(exp.declaredEnd).slice(0, 10) : null,
    observedStart: life.observedStart,
    observedEnd: life.observedEnd,
    lastSeen: life.lastSeen,
    peakDailyVisits: life.peakDailyVisits,
    assignedVisits: life.visits,
    status: exp.status,
    statusAsOf: asOf,
    metrics: {
      first_seen: life.firstSeen,
      active_days: life.activeDays,
      tail_visits: life.tailVisits,
      started_before_scan: life.startedBeforeScan,
      exposure_rule: exp.exposureRule,
      surface_templates: exp.surface.templates,
      surface_all: exp.surface.all,
      off_surface_share: Object.fromEntries(exp.surface.offSurface),
      analyzed,
    },
  };
}

/**
 * The partner registry. It is a log table some installs do not have; its
 * absence is a note, not a failure.
 * @param {import('../../ports/dataset.js').RunContext} ctx
 * @param {number} idsite
 * @param {object} notes
 */
async function readRegistry(ctx, idsite, notes) {
  try {
    const rows = await ctx.gateway.query(registrySql(), { idsite }, 'experiment:registry');
    const lastSeen = rows.reduce((max, r) => (String(r.last_seen) > max ? String(r.last_seen) : max), '');
    if (lastSeen) notes.experiment_registry_last_seen = lastSeen;
    return rows;
  } catch (err) {
    notes.experiment_registry_note = `partner_tags_logs unreadable: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`;
    return [];
  }
}

/**
 * Operator registry rows (ae_experiment, governance import): declared
 * allocation and dates, keyed by experiment_id.
 * @param {import('../../ports/dataset.js').RunContext} ctx
 * @param {number} idsite
 * @returns {Promise<Map<string, {allocations: Map<string, number>, startedAt: string | null, endedAt: string | null}>>}
 */
async function readDeclared(ctx, idsite) {
  const out = new Map();
  const table = await ctx.gateway.query(
    `SELECT count() AS n FROM system.tables WHERE database = '${configuredDatabase()}' AND table = 'ae_experiment'`,
    {},
    'experiment:declared-table',
  );
  if (Number(table[0]?.n ?? 0) === 0) return out;
  const rows = await ctx.gateway.query(
    `SELECT toString(experiment_id) AS experiment_id, arms,
            toString(started_at) AS started_at, toString(ended_at) AS ended_at
       FROM ${configuredDatabase()}.ae_experiment_current
      WHERE idsite = {idsite:UInt32}`,
    { idsite },
    'experiment:declared',
  );
  for (const r of rows) {
    /** @type {Map<string, number>} */
    const allocations = new Map();
    try {
      for (const a of JSON.parse(String(r.arms ?? '[]'))) {
        const arm = canonicalVariant(a?.arm);
        if (arm !== '' && Number.isFinite(Number(a?.allocation))) allocations.set(arm, Number(a.allocation));
      }
    } catch {
      // unparseable arms declare nothing
    }
    out.set(String(r.experiment_id), {
      allocations,
      startedAt: r.started_at ? String(r.started_at) : null,
      endedAt: r.ended_at ? String(r.ended_at) : null,
    });
  }
  return out;
}

/**
 * Operator descriptor rows, keyed by experiment key.
 * @param {import('../../ports/dataset.js').RunContext} ctx
 * @param {number} idsite
 */
async function readOperator(ctx, idsite) {
  /** @type {Map<string, object>} */
  const out = new Map();
  if (typeof ctx.persistence?.readExperimentDescriptors !== 'function') return out;
  for (const row of await ctx.persistence.readExperimentDescriptors(idsite)) {
    if (row.provenance === 'operator') out.set(row.experimentKey, row);
  }
  return out;
}

/** @param {object[]} target @param {object[]} rows */
function appendAll(target, rows) {
  for (const row of rows) target.push(row);
}

/** @param {string} a @param {string} b */
function minDate(a, b) {
  return a < b ? a : b;
}

/** @param {string} a @param {string} b */
function maxDate(a, b) {
  return a > b ? a : b;
}
