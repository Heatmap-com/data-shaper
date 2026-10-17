import { changePoints, round4 } from './stats.js';

/**
 * Pilot among brands that are not blocked. Revenue at stake wins, then the
 * share of snapshot quadrants that clear the sufficiency floor.
 * @param {Array<{brand: string, verdict: string, revenueAtStake: number, reportableShare: number}>} cards
 */
export function choosePilot(cards) {
  const open = cards.filter((c) => c.verdict !== 'blocked');
  if (open.length === 0) return null;
  open.sort((a, b) => b.revenueAtStake - a.revenueAtStake || b.reportableShare - a.reportableShare || a.brand.localeCompare(b.brand));
  return open[0].brand;
}

/**
 * @param {Array<{brand: string, verdict: string, revenueAtStake: number, reportableShare: number, completeness: number}>} cards
 */
export function pilotRows(cards) {
  const pilot = choosePilot(cards);
  return cards.map((card) => ({
    dims: { query: 'X9', brand: card.brand },
    metrics: {
      verdict: card.verdict,
      revenue_at_stake: round4(card.revenueAtStake),
      reportable_share: round4(card.reportableShare),
      completeness: round4(card.completeness),
      pilot: card.brand === pilot,
    },
  }));
}

/**
 * @param {Array<{brand: string, query: string, label: string, revenueAtStake: number, trend?: string}>} findings
 */
export function rankFindings(findings) {
  return [...findings]
    .filter((f) => Number.isFinite(f.revenueAtStake))
    .sort((a, b) => b.revenueAtStake - a.revenueAtStake || a.label.localeCompare(b.label))
    .map((f, index) => ({
      dims: { query: 'X10', brand: f.brand, label: f.label, source: f.query },
      metrics: {
        rank: index + 1,
        revenue_at_stake: round4(f.revenueAtStake),
        trend: f.trend ?? 'insufficient',
      },
    }));
}

/**
 * Median of a metric across brands for one template and device.
 * @param {Array<{brand: string, template: string, device: string, cr: number, sessions: number}>} rows
 */
export function crossBrandMedian(rows) {
  /** @type {Map<string, Array<{brand: string, cr: number, sessions: number}>>} */
  const groups = new Map();
  for (const row of rows) {
    if (!(row.sessions > 0) || !Number.isFinite(row.cr)) continue;
    const key = `${row.template}|${row.device}`;
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }
  /** @type {Array<{dims: object, metrics: object}>} */
  const out = [];
  for (const [key, list] of groups) {
    if (list.length < 2) continue;
    const [template, device] = key.split('|');
    const crs = list.map((r) => r.cr).sort((a, b) => a - b);
    const mid = crs.length % 2 === 1 ? crs[(crs.length - 1) / 2] : (crs[crs.length / 2 - 1] + crs[crs.length / 2]) / 2;
    for (const row of list) {
      out.push({
        dims: { query: 'X7', brand: row.brand, template, device },
        metrics: {
          cr: round4(row.cr),
          median_cr: round4(mid),
          vs_median: round4(row.cr - mid),
          sessions: row.sessions,
        },
      });
    }
  }
  return out;
}

/**
 * Change points on a weekly series, tagged when a calendar event falls in
 * that ISO week (Monday date).
 * @param {string} brand
 * @param {string[]} weeks Monday dates, aligned with values
 * @param {number[]} values
 * @param {Array<{date: string, label: string}>} events
 * @param {string} [metric]
 */
export function changePointRows(brand, weeks, values, events, metric = 'cr') {
  return changePoints(values).map((flag) => {
    const week = weeks[flag.index] ?? '';
    const end = shift(week, 6);
    const hits = events.filter((e) => e.date >= week && e.date <= end);
    return {
      dims: { query: 'X5', brand, week, metric },
      metrics: {
        week_avg: round4(flag.weekAvg),
        prior_mean: round4(flag.priorMean),
        prior_sd: round4(flag.priorSd),
        events: hits.map((h) => h.label),
      },
    };
  });
}

/** @param {string} iso @param {number} days */
function shift(iso, days) {
  if (!iso) return '';
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
