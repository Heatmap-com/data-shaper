import { fetchSessionTags } from '../_lib/session-tags.js';
import { fetchSessionRows, filtersFor } from '../_lib/session-stream.js';
import { adapter as coverageAdapter } from './campaign-coverage.js';

/**
 * campaign-weekly: weekly grain over the page's tagged entry sessions,
 * keyed by utm source/medium/campaign plus content and term (H04).
 * utm_source is the session stream's (the session tags, else
 * custom_var_k5); udp_session_tags JSON keys matching
 * source/medium/campaign/content/term fill the rest. No rows when the tagged share is under 5 percent;
 * campaigns under 30 sessions roll into 'other'. Rule 12.
 */

const MIN_SHARE = 0.05;
const ROLLUP_MIN_SESSIONS = 30;
const VALUE_MAX = 64;
const VALUE_MAX_DETAIL = 128;

export const adapter = {
  id: 'campaign-weekly',
  dependsOn: ['campaign-coverage'],
  scope: 'page',
  provides: ['H03', 'H04'],

  /**
   * @param {import('../../../ports/qualifier.js').QualifiedPage} page
   * @param {import('../../../ports/dataset.js').RunContext} ctx
   */
  async collect(page, ctx) {
    const coverage = ctx.datasets.get('campaign-coverage') ?? (await coverageAdapter.collect(page, ctx));
    const share = taggedShare(coverage.rows);
    if (share == null || share < MIN_SHARE) {
      return {
        id: adapter.id,
        rows: [],
        notes: {
          campaign_weekly_note: 'tagged share under 5 percent; no rows',
          campaign_tagged_share: share == null ? 0 : round4(share),
        },
      };
    }

    const [sessions, tagsByVisit] = await Promise.all([fetchSessionRows(ctx, page.idsite), fetchSessionTags(ctx, page)]);
    const hsr = String(page.idsitehsr);

    /** @type {Map<string, object>} */
    const cells = new Map();
    for (const s of sessions) {
      if (s.entryHsr !== hsr) continue;
      const raw = tagsByVisit.get(s.idvisit);
      let json = null;
      if (raw != null) {
        try {
          json = JSON.parse(raw);
        } catch {
          json = null;
        }
      }
      const fromJson = (re, max = VALUE_MAX) => {
        if (!json) return null;
        for (const [key, value] of Object.entries(json)) {
          if (re.test(key) && value != null && String(value) !== '') return String(value).slice(0, max);
        }
        return null;
      };
      const utmSource = s.utmSource !== '' ? s.utmSource.slice(0, VALUE_MAX) : (fromJson(/source/i) ?? 'unknown');
      const utmMedium = fromJson(/medium/i) ?? 'unknown';
      const utmCampaign = fromJson(/campaign/i) ?? 'unknown';
      const utmContent = fromJson(/content/i, VALUE_MAX_DETAIL) ?? 'unknown';
      const utmTerm = fromJson(/term/i, VALUE_MAX_DETAIL) ?? 'unknown';
      if (utmSource === 'unknown' && raw == null && s.utmSource === '') continue;
      for (const filter of filtersFor(s.tier)) {
        const dims = {
          week: s.week,
          utm_source: utmSource,
          utm_medium: utmMedium,
          utm_campaign: utmCampaign,
          utm_content: utmContent,
          utm_term: utmTerm,
          bot_filter: filter,
        };
        const key = JSON.stringify(dims);
        let cell = cells.get(key);
        if (!cell) {
          cell = { dims, sessions: 0, singlePageview: 0, orders: 0, revenue: 0 };
          cells.set(key, cell);
        }
        cell.sessions += 1;
        if (s.pageviews === 1) cell.singlePageview += 1;
        cell.orders += s.orders;
        cell.revenue += s.revenue;
      }
    }

    /** @type {Map<string, number>} `${source}|${medium}|${campaign}|${filter}` -> window sessions */
    const totals = new Map();
    for (const cell of cells.values()) {
      const key = `${cell.dims.utm_source}|${cell.dims.utm_medium}|${cell.dims.utm_campaign}|${cell.dims.bot_filter}`;
      totals.set(key, (totals.get(key) ?? 0) + cell.sessions);
    }

    /** @type {Map<string, object>} rolled-up cells, keyed by final dims */
    const rolled = new Map();
    for (const cell of cells.values()) {
      const tk = `${cell.dims.utm_source}|${cell.dims.utm_medium}|${cell.dims.utm_campaign}|${cell.dims.bot_filter}`;
      const dims = { ...cell.dims };
      if ((totals.get(tk) ?? 0) < ROLLUP_MIN_SESSIONS) dims.utm_campaign = 'other';
      const key = JSON.stringify(dims);
      let target = rolled.get(key);
      if (!target) {
        target = { dims, sessions: 0, singlePageview: 0, orders: 0, revenue: 0 };
        rolled.set(key, target);
      }
      target.sessions += cell.sessions;
      target.singlePageview += cell.singlePageview;
      target.orders += cell.orders;
      target.revenue += cell.revenue;
    }

    const rows = [...rolled.values()].map((cell) => ({
      dims: cell.dims,
      metrics: {
        sessions: cell.sessions,
        single_pageview_sessions: cell.singlePageview,
        orders_udp: cell.orders,
        revenue_udp: round2(cell.revenue),
      },
    }));

    return {
      id: adapter.id,
      rows,
      notes: {
        campaign_rollup_min_sessions: ROLLUP_MIN_SESSIONS,
        campaign_tagged_share: round4(share),
      },
    };
  },
};

/**
 * Combined tagged share across sources for the exclude_confirmed filter
 * (falling back to none): sum(sessions_with_tag) / sum(entry_sessions).
 * @param {Array<{dims: object, metrics: object}>} rows
 */
function taggedShare(rows) {
  let picked = rows.filter((r) => r.dims.bot_filter === 'exclude_confirmed');
  if (picked.length === 0) picked = rows.filter((r) => r.dims.bot_filter === 'none');
  const entry = picked.reduce((sum, r) => sum + (r.metrics.entry_sessions ?? 0), 0);
  if (entry === 0) return null;
  return picked.reduce((sum, r) => sum + (r.metrics.sessions_with_tag ?? 0), 0) / entry;
}

/** @param {number} n */
function round2(n) {
  return Math.round(n * 100) / 100;
}

/** @param {number} n */
function round4(n) {
  return Math.round(n * 10000) / 10000;
}
