import { configuredDatabase } from '../query-gateway/clickhouse.js';
import { missingColumns } from '../_lib/checks.js';
import { fetchSessionRows, filtersFor } from '../_lib/session-stream.js';
import { srmPvalue } from '../../experiments/stats.js';
import { armKey } from '../../scan/day-record.js';
import { mapState } from '../../scan/snapshot.js';

/**
 * experiments-weekly: the site's A/B arms from udp_partner_tags, per
 * (Monday week, experience, variant) with sessions (the arm assignment
 * counts), orders and revenue joined from the whole-site session stream
 * (entry sessions on any page, keyed by idvisit). A per-experience,
 * per-week sample-ratio-mismatch p-value compares the arm assignment
 * counts against the declared allocation in ae_experiment
 * when that table exists; without declared arms the rows still carry
 * sessions/orders/revenue and SRM stays uncomputed. H16 (assignment
 * counts) and O04 (the experiment registry read itself).
 *
 * Bot tiers can only be applied in JS (the bot context is a fingerprint
 * lookup), so the aggregation happens here: from the raw tag rows on the
 * window path, and on the day scan from each session's arms (a day-record
 * column) folded on the site pass. The row grain keeps the
 * exclude_confirmed tier, the trustworthy one for SRM.
 *
 * udp_partner_tags has idvisit and idloghsr swapped; its idloghsr column
 * is the visit id the session stream is keyed on.
 *
 * A site with no partner tags at all is not an experiment site (probe
 * D-07, site 3207): zero rows and an explicit not_applicable requirement.
 */

const ROW_CAP = 5000;
const TAG_COLUMNS = ['experience_id', 'variant_id', 'server_date', 'idloghsr'];

export const adapter = {
  id: 'experiments-weekly',
  dependsOn: [],
  scope: 'site',
  pass: 'site',
  provides: ['H16', 'O04'],

  /**
   * @param {{idsite: number, siteName: string}} page site-level page arg
   * @param {import('../../../ports/dataset.js').RunContext} ctx
   */
  async collect(page, ctx) {
    const blocked = await blockedResult(ctx);
    if (blocked) return blocked;

    const tagRows = await ctx.gateway.query(
      `SELECT toString(toMonday(server_date)) AS week,
              toString(experience_id) AS experience_id,
              toString(variant_id) AS variant_id,
              toString(idloghsr) AS idvisit
         FROM default.udp_partner_tags
        WHERE idsite = {idsite:UInt32}
          AND server_date BETWEEN {w0:Date} AND {w1:Date}`,
      windowParams(page, ctx),
      'experiments-weekly:partner-tags',
    );
    if (tagRows.length === 0) return noTagsResult();

    const notes = {};
    const declared = await declaredArms(ctx, page.idsite, notes);
    const sessions = await fetchSessionRows(ctx, page.idsite);
    const byVisit = new Map(sessions.map((s) => [s.idvisit, s]));

    /** @type {Map<string, ArmCell>} */
    const cells = new Map();
    /** @type {Set<string>} cell key + idvisit: one tag row per session */
    const seen = new Set();
    for (const t of tagRows) {
      const key = armKey(t.week, t.experience_id, t.variant_id);
      if (!cells.has(key)) cells.set(key, armCell(t.week, t.experience_id, t.variant_id));
      const visitKey = `${key}|${t.idvisit}`;
      if (seen.has(visitKey)) continue;
      seen.add(visitKey);
      const s = byVisit.get(t.idvisit);
      if (s) countSession(cells.get(key), s); // a tagged session outside the stream window counts nothing
    }
    return armsResult(cells, declared, notes);
  },

  /**
   * The site-pass folder: the arm cells come from the window's distinct
   * (week, experience, variant) tags, and each session of the window counts
   * once toward each arm the day scan read for it.
   * @param {{idsite: number, siteName: string}} page
   * @param {import('../../../ports/dataset.js').RunContext} ctx
   * @returns {Promise<import('../../../ports/dataset.js').SessionFolder>}
   */
  async open(page, ctx) {
    const blocked = await blockedResult(ctx);
    if (blocked) return settled(blocked);
    const arms = await ctx.gateway.query(
      `SELECT DISTINCT toString(toMonday(server_date)) AS week,
              toString(experience_id) AS experience_id,
              toString(variant_id) AS variant_id
         FROM default.udp_partner_tags
        WHERE idsite = {idsite:UInt32}
          AND server_date BETWEEN {w0:Date} AND {w1:Date}`,
      windowParams(page, ctx),
      'experiments-weekly:arms',
    );
    if (arms.length === 0) return settled(noTagsResult());

    const notes = {};
    const declared = await declaredArms(ctx, page.idsite, notes);
    /** @type {Map<string, ArmCell>} */
    const cells = new Map(arms.map((r) => [armKey(r.week, r.experience_id, r.variant_id), armCell(r.week, r.experience_id, r.variant_id)]));
    return {
      ...mapState(cells),
      partnerTags: true,
      fold(sessions) {
        for (const s of sessions) {
          for (const key of s.arms ?? []) {
            const cell = cells.get(key);
            if (cell) countSession(cell, s);
          }
        }
      },
      finish: () => armsResult(cells, declared, notes),
    };
  },
};

/**
 * @typedef {object} ArmCell
 * @property {string} week
 * @property {string} experience_id
 * @property {string} variant_id
 * @property {{none: number, exclude_confirmed: number}} tierSessions
 * @property {number} orders
 * @property {number} revenue
 */

/** @param {string} week @param {string} experienceId @param {string} variantId @returns {ArmCell} */
function armCell(week, experienceId, variantId) {
  return {
    week,
    experience_id: experienceId,
    variant_id: variantId,
    tierSessions: { none: 0, exclude_confirmed: 0 },
    orders: 0,
    revenue: 0,
  };
}

/**
 * Sessions count per bot tier so the exclude_confirmed assignment counts
 * feed the SRM test.
 * @param {ArmCell} cell @param {{tier: string | null, orders: number, revenue: number}} s
 */
function countSession(cell, s) {
  for (const filter of filtersFor(s.tier)) cell.tierSessions[filter] += 1;
  cell.orders += s.orders;
  cell.revenue += s.revenue;
}

/** @param {{idsite: number}} page @param {import('../../../ports/dataset.js').RunContext} ctx */
function windowParams(page, ctx) {
  return { idsite: page.idsite, w0: ctx.windowStart, w1: ctx.windowEnd };
}

/** @param {object} result @returns {import('../../../ports/dataset.js').SessionFolder} */
function settled(result) {
  return { fold() {}, finish: () => result };
}

/** @param {import('../../../ports/dataset.js').RunContext} ctx */
async function blockedResult(ctx) {
  const missing = await missingColumns(ctx, 'udp_partner_tags', TAG_COLUMNS);
  if (missing.length === 0) return null;
  const detail = `udp_partner_tags missing columns: ${missing.join(', ')}`;
  return {
    id: adapter.id,
    rows: [],
    notes: { experiments_weekly_blocked: detail },
    requirements: [{ key: 'H16', status: 'partial', rowCount: 0, detail }],
  };
}

function noTagsResult() {
  return {
    id: adapter.id,
    rows: [],
    notes: { experiments_weekly_note: 'no partner tags for this site' },
    requirements: [{ key: 'H16', status: 'not_applicable', rowCount: 0, detail: 'no partner tags for this site' }],
  };
}

/**
 * Declared allocation for the SRM check. ae_experiment may not exist on
 * installs that predate the governance tables; absence means no declared
 * allocation, not a failure.
 * @param {import('../../../ports/dataset.js').RunContext} ctx
 * @param {number} idsite
 * @param {object} notes
 * @returns {Promise<Map<string, Array<{arm: string, allocation: number}>>>} experience_id -> arms
 */
async function declaredArms(ctx, idsite, notes) {
  const declared = new Map();
  const table = await ctx.gateway.query(
    `SELECT count() AS n
       FROM system.tables
      WHERE database = '${configuredDatabase()}' AND table = 'ae_experiment'`,
    {},
    'experiments-weekly:experiment-table',
  );
  if (Number(table[0]?.n ?? 0) > 0) {
    const rows = await ctx.gateway.query(
      `SELECT toString(experiment_id) AS experiment_id, arms
         FROM ${configuredDatabase()}.ae_experiment_current
        WHERE idsite = {idsite:UInt32}`,
      { idsite },
      'experiments-weekly:experiments',
    );
    for (const r of rows) {
      const parsed = parseArms(r.arms);
      if (parsed.length > 0) declared.set(String(r.experiment_id), parsed);
    }
  } else {
    notes.experiments_note = 'ae_experiment table absent; no declared allocation; SRM not computed';
  }
  return declared;
}

/**
 * The rows: one per arm cell on the exclude_confirmed tier, with the SRM
 * p-value per (experience, week) over the assignment counts vs the declared
 * allocation. Cells are read in key order.
 * @param {Map<string, ArmCell>} cells
 * @param {Map<string, Array<{arm: string, allocation: number}>>} declared
 * @param {object} notes
 */
function armsResult(cells, declared, notes) {
  const ordered = [...cells.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, cell]) => cell);
  /** @type {Map<string, {pvalue: number | null, note: string}>} */
  const srmByVariant = new Map();
  /** @type {Map<string, {declared: Array | null, observed: Map<string, number>}>} */
  const groups = new Map();
  for (const cell of ordered) {
    const key = `${cell.week}|${cell.experience_id}`;
    let group = groups.get(key);
    if (!group) {
      group = { declared: declared.get(cell.experience_id) ?? null, observed: new Map() };
      groups.set(key, group);
    }
    group.observed.set(cell.variant_id, cell.tierSessions.exclude_confirmed);
  }
  for (const [key, group] of groups) {
    const pvalue = srmPvalue(group.observed, group.declared);
    const note =
      group.declared == null
        ? 'no declared allocation; SRM not computed'
        : pvalue == null
          ? 'observed variants do not match declared arms; SRM not computed'
          : '';
    for (const variant of group.observed.keys()) {
      srmByVariant.set(`${key}|${variant}`, { pvalue, note });
    }
  }

  const rows = ordered
    .map((cell) => {
      const srm = srmByVariant.get(`${cell.week}|${cell.experience_id}|${cell.variant_id}`);
      return {
        dims: {
          week: cell.week,
          experience_id: cell.experience_id,
          variant_id: cell.variant_id,
          bot_filter: 'exclude_confirmed',
        },
        metrics: {
          sessions: cell.tierSessions.exclude_confirmed,
          sessions_unfiltered: cell.tierSessions.none,
          orders_udp: cell.orders,
          revenue_udp: round2(cell.revenue),
          srm_pvalue: srm?.pvalue ?? null,
          declared_allocation: allocationFor(declared.get(cell.experience_id), cell.variant_id),
          srm_note: srm?.note ?? '',
        },
      };
    })
    .sort(
      (a, b) =>
        a.dims.week.localeCompare(b.dims.week) ||
        a.dims.experience_id.localeCompare(b.dims.experience_id) ||
        a.dims.variant_id.localeCompare(b.dims.variant_id),
    )
    .slice(0, ROW_CAP);

  if (rows.length >= ROW_CAP) notes.experiments_weekly_capped = `rows capped at ${ROW_CAP}`;
  return { id: adapter.id, rows, notes };
}

/**
 * Declared arms JSON -> [{arm, allocation}] with allocations normalized to
 * shares summing to 1. Returns [] on anything unusable.
 * @param {unknown} raw
 * @returns {Array<{arm: string, allocation: number}>}
 */
function parseArms(raw) {
  let parsed;
  try {
    parsed = JSON.parse(String(raw ?? '[]'));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const arms = [];
  for (const entry of parsed) {
    const arm = String(entry?.arm ?? '').trim();
    const allocation = Number(entry?.allocation ?? NaN);
    if (arm === '' || !Number.isFinite(allocation) || allocation <= 0) continue;
    arms.push({ arm, allocation });
  }
  if (arms.length === 0) return [];
  const total = arms.reduce((sum, a) => sum + a.allocation, 0);
  const scale = total > 1.5 ? 100 : 1; // percentages vs shares
  for (const a of arms) a.allocation = a.allocation / scale;
  return arms;
}

/**
 * @param {Array<{arm: string, allocation: number}> | null | undefined} arms
 * @param {string} variant
 */
function allocationFor(arms, variant) {
  if (!arms) return null;
  const hit = arms.find((a) => a.arm === variant);
  return hit ? round4(hit.allocation) : null;
}

/** @param {number} n */
function round2(n) {
  return Math.round(n * 100) / 100;
}

/** @param {number} n */
function round4(n) {
  return Math.round(n * 10000) / 10000;
}
