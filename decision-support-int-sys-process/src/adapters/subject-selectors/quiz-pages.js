import { fetchSessionRows } from '../_lib/session-stream.js';
import { candidateTarget, entryCandidates, entryFolder, pageSubject } from '../_lib/subject-candidates.js';

export const DEFAULT_LIMIT_PER_SITE = 3;
export const DEFAULT_URL_TERMS = Object.freeze(['quiz']);
export const DEFAULT_TOOL_TERMS = Object.freeze(['quiz']);

/** Candidates checked for the descriptor signal, highest entry first. */
const DESCRIPTOR_READS = 50;

/**
 * The site's quiz pages, highest entry first. A page is a quiz when its URL
 * holds one of `urlContains`, or else when its stored page descriptor's
 * `p12.tools` names one of `toolTerms`. A page with neither signal is not
 * selected. Criteria: `urlContains`, `toolTerms` (both case-insensitive),
 * `minEntrySessions`, and `limitPerSite`.
 * @type {import('../../ports/subject.js').SubjectSelectorPort}
 */
export const adapter = {
  id: 'quiz-pages',
  subjectType: 'quiz',

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
        return quizPages(candidates, criteria, (hsr) => descriptorTools(ctx, site.idsite, hsr));
      },
    };
  },
};

/**
 * @param {import('../_lib/subject-candidates.js').EntryCandidate[]} candidates sorted by entry sessions
 * @param {{urlContains?: string[], toolTerms?: string[], minEntrySessions?: number, limitPerSite?: number}} criteria
 * @param {(hsr: string) => Promise<string>} toolsOf the page's p12.tools descriptor text, '' when none
 */
export async function quizPages(candidates, criteria, toolsOf) {
  const urlTerms = (criteria.urlContains ?? DEFAULT_URL_TERMS).map((t) => t.toLowerCase());
  const toolTerms = (criteria.toolTerms ?? DEFAULT_TOOL_TERMS).map((t) => t.toLowerCase());
  const limit = criteria.limitPerSite ?? DEFAULT_LIMIT_PER_SITE;
  const eligible = candidates.filter((c) => c.entrySessions >= (criteria.minEntrySessions ?? 0));
  const subjects = [];
  for (const [i, c] of eligible.entries()) {
    if (subjects.length >= limit) break;
    const urlTerm = urlTerms.find((term) => c.url.toLowerCase().includes(term));
    const toolTerm = urlTerm || i >= DESCRIPTOR_READS ? undefined : matching(await toolsOf(c.hsr), toolTerms);
    const signal = urlTerm ? 'url' : toolTerm ? 'descriptor' : null;
    if (!signal) continue;
    const reason = urlTerm
      ? `URL holds "${urlTerm}" (${c.entrySessions} exclude_confirmed sessions)`
      : `descriptor p12.tools names "${toolTerm}" (${c.entrySessions} exclude_confirmed sessions)`;
    subjects.push(pageSubject(candidateTarget(c, 'subject', reason), 'quiz', { signal }));
  }
  return subjects;
}

/** @param {string} text @param {string[]} terms */
function matching(text, terms) {
  const lower = text.toLowerCase();
  return terms.find((term) => lower.includes(term));
}

/**
 * The page's p12.tools descriptor values as text, from the store.
 * @param {import('../../ports/dataset.js').RunContext} ctx
 * @param {number} idsite
 * @param {string} hsr
 */
async function descriptorTools(ctx, idsite, hsr) {
  if (!ctx.persistence?.readPageDescriptor) return '';
  const rows = await ctx.persistence.readPageDescriptor({ idsite, template_key: `url:${hsr}`, device_class: 'all' });
  return rows.filter((row) => String(row.field_path).startsWith('p12.tools')).map((row) => String(row.value_json ?? '')).join(' ');
}
