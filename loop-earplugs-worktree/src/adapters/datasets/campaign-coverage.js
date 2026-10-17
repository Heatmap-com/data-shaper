import { fetchSessionTags } from '../_lib/session-tags.js';
import { fetchSessionRows, filtersFor } from '../_lib/session-stream.js';

/**
 * campaign-coverage: how much of the page's entry sessions carry a campaign
 * tag, per source. utm_source is the session stream's utm_source (the
 * session tags, else custom_var_k5); udp_session_tags is a non-empty
 * session_tags JSON row. campaign-weekly reads this and stays empty under a
 * 5 percent tagged share.
 */

export const adapter = {
  id: 'campaign-coverage',
  dependsOn: [],
  scope: 'page',
  provides: ['H03'],

  /**
   * @param {import('../../../ports/qualifier.js').QualifiedPage} page
   * @param {import('../../../ports/dataset.js').RunContext} ctx
   */
  async collect(page, ctx) {
    const [sessions, tagsByVisit] = await Promise.all([fetchSessionRows(ctx, page.idsite), fetchSessionTags(ctx, page)]);
    const hsr = String(page.idsitehsr);

    /** @type {Map<string, object>} filter -> accumulator per source */
    const acc = new Map();
    const accFor = (filter) => {
      let a = acc.get(filter);
      if (!a) {
        a = {
          entrySessions: 0,
          sourceTagged: 0,
          sourceValues: new Set(),
          tagsTagged: 0,
          tagsValues: new Set(),
        };
        acc.set(filter, a);
      }
      return a;
    };

    for (const s of sessions) {
      if (s.entryHsr !== hsr) continue;
      for (const filter of filtersFor(s.tier)) {
        const a = accFor(filter);
        a.entrySessions += 1;
        if (s.utmSource !== '') {
          a.sourceTagged += 1;
          a.sourceValues.add(s.utmSource);
        }
        const raw = tagsByVisit.get(s.idvisit);
        if (raw != null) {
          a.tagsTagged += 1;
          const value = firstJsonValue(raw, /source/i);
          if (value !== null) a.tagsValues.add(value);
        }
      }
    }

    const rows = [];
    for (const [filter, a] of acc) {
      rows.push({
        dims: { tag_source: 'utm_source', bot_filter: filter },
        metrics: { entry_sessions: a.entrySessions, sessions_with_tag: a.sourceTagged, distinct_tags: a.sourceValues.size },
      });
      rows.push({
        dims: { tag_source: 'udp_session_tags', bot_filter: filter },
        metrics: { entry_sessions: a.entrySessions, sessions_with_tag: a.tagsTagged, distinct_tags: a.tagsValues.size },
      });
    }

    return { id: adapter.id, rows };
  },
};

/**
 * The value of the first JSON key matching `re`, null when the JSON does not
 * parse or no key matches.
 * @param {string} raw
 * @param {RegExp} re
 */
export function firstJsonValue(raw, re) {
  try {
    const obj = JSON.parse(raw);
    for (const [key, value] of Object.entries(obj)) {
      if (re.test(key) && value != null && String(value) !== '') return String(value).slice(0, 64);
    }
  } catch {
    // unparsable row: counts as tagged (non-empty) but contributes no value
  }
  return null;
}
