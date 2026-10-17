import { fetchSessionRows } from '../_lib/session-stream.js';
import { candidateTarget, entryCandidates, entryFolder, pageSubject } from '../_lib/subject-candidates.js';

export const DEFAULT_LIMIT_PER_SITE = 5;

/**
 * The site's highest-entry pages of the asked kinds. Criteria: `kinds`
 * (page types such as product or collection; all kinds when absent),
 * `minEntrySessions`, `urlContains` (a case-insensitive part of the URL),
 * and `limitPerSite`. Most exclude_confirmed entry sessions first. The day
 * scan's site pass folds the entry totals a day at a time; select folds the
 * window's rows.
 * @type {import('../../ports/subject.js').SubjectSelectorPort}
 */
export const adapter = {
  id: 'page-by-kind',
  subjectType: 'page',

  async select(site, qualification, ctx, criteria = {}) {
    const folder = adapter.open(site, ctx);
    folder.fold(await fetchSessionRows(ctx, site.idsite));
    return folder.finish(site, qualification, ctx, criteria);
  },

  open(_site, _ctx) {
    const { byHsr, ...folder } = entryFolder();
    return {
      ...folder,
      async finish(site, _qualification, ctx, criteria = {}) {
        const { candidates } = await entryCandidates(ctx, site.idsite, byHsr);
        return pagesByKind(candidates, criteria);
      },
    };
  },
};

/**
 * @param {import('../_lib/subject-candidates.js').EntryCandidate[]} candidates
 * @param {{kinds?: string[], minEntrySessions?: number, urlContains?: string, limitPerSite?: number}} criteria
 */
export function pagesByKind(candidates, criteria) {
  const kinds = criteria.kinds?.length ? new Set(criteria.kinds) : null;
  const floor = criteria.minEntrySessions ?? 0;
  const part = criteria.urlContains?.toLowerCase() ?? '';
  return candidates
    .filter((c) => (!kinds || kinds.has(c.type)) && c.entrySessions >= floor && c.url.toLowerCase().includes(part))
    .slice(0, criteria.limitPerSite ?? DEFAULT_LIMIT_PER_SITE)
    .map((c) => pageSubject(candidateTarget(c, 'subject', `${c.type} page by entry sessions (${c.entrySessions} exclude_confirmed sessions)`)));
}
