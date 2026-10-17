import { fetchSessionRows } from '../_lib/session-stream.js';
import { primaryTarget } from '../_lib/page-targets.js';
import { candidateTarget, entryCandidates, entryFolder, largestChannel } from '../_lib/subject-candidates.js';

/**
 * Page selector for Phase 3 (plan §9.2 stage 1): the qualifier's page as
 * `primary`, up to two `sister` pages (the next-highest entry pages by
 * exclude_confirmed sessions in the primary's channel mix, above the LP
 * volume floor, excluding the primary's URL and page type), and one
 * `template_member` each for the pdp / collection / cart / home kinds not
 * already selected — the highest-entry page of each kind. Truncation keeps
 * the priority primary > sisters > template members and drops from the end,
 * so opts.maxPages = 1 degenerates to the primary-only selection.
 *
 * Candidate stats come from the same per-URL aggregation the qualifier
 * runs (fetchSessionRows over the site + site_hsr resolution through
 * _lib helpers), over the full batch window.
 */

const DEFAULT_MAX_PAGES = 6;
const SISTERS_PER_SITE = 2;
const MIN_SISTER_SESSIONS = 30; // the LP volume floor (strategy-triggers FLOOR_ENTRY_SESSIONS)

const TEMPLATE_KINDS = [
  { kind: 'pdp', pageType: 'product' },
  { kind: 'collection', pageType: 'collection' },
  { kind: 'cart', pageType: 'cart' },
  { kind: 'home', pageType: 'home' },
];

/** @type {import('../../ports/page-selector.js').PageSelectorPort} */
export const adapter = {
  id: 'default-six',

  async select(site, qualification, ctx, opts = {}) {
    const maxPages = Math.max(1, Number(opts.maxPages ?? DEFAULT_MAX_PAGES));
    if (maxPages === 1) return [primaryTarget(qualification)];
    const folder = adapter.open(site, ctx);
    folder.fold(await fetchSessionRows(ctx, site.idsite));
    return folder.finish(site, qualification, ctx, opts);
  },

  /**
   * Entry totals per entry page, exclude_confirmed tier (the qualified
   * numbers, same as the qualifier's candidate stats), with the channel mix.
   * The day scan's site pass folds it a day at a time; select folds the
   * window's rows.
   * @param {{idsite: number}} _site
   * @param {import('../../ports/dataset.js').RunContext} _ctx
   */
  open(_site, _ctx) {
    const { byHsr, ...folder } = entryFolder();
    return {
      ...folder,
      async finish(site, qualification, ctx, opts = {}) {
        return choose(site, qualification, ctx, opts, byHsr);
      },
    };
  },
};

/**
 * @param {{idsite: number}} site
 * @param {import('../../ports/qualifier.js').Qualification} qualification
 * @param {import('../../ports/dataset.js').RunContext} ctx
 * @param {{maxPages?: number}} opts
 * @param {Map<string, {sessions: number, orders: number, revenue: number, channels: Map<string, number>}>} byHsr
 */
async function choose(site, qualification, ctx, opts, byHsr) {
  const maxPages = Math.max(1, Number(opts.maxPages ?? DEFAULT_MAX_PAGES));
  const primary = primaryTarget(qualification);
  if (maxPages === 1) return [primary];

  const { candidates, channelsOf } = await entryCandidates(ctx, site.idsite, byHsr);
  const primaryChannels = channelsOf(primary.url);
  const primaryChannel = primaryChannels ? largestChannel(primaryChannels) : '';

  const sisterPool = candidates.filter(
    (c) =>
      c.url !== primary.url &&
      c.type !== primary.pageType &&
      c.entrySessions >= MIN_SISTER_SESSIONS,
  );
  const inChannel = sisterPool.filter((c) => c.channel === primaryChannel && c.channel !== '');
  const rest = sisterPool.filter((c) => !inChannel.includes(c));
  const sisters = [...inChannel, ...rest]
    .slice(0, SISTERS_PER_SITE)
    .map((c) => candidateTarget(c, 'sister', `next-highest entry page (${c.entrySessions} exclude_confirmed sessions, ${c.channel})`));

  const selectedTypes = new Set(
    [primary, ...sisters].map((t) => t.pageType).filter((t) => t !== ''),
  );
  const templateMembers = [];
  for (const { kind, pageType: kindType } of TEMPLATE_KINDS) {
    if (selectedTypes.has(kindType)) continue;
    const pick = candidates.find((c) => c.type === kindType);
    if (!pick) continue;
    selectedTypes.add(kindType);
    templateMembers.push(candidateTarget(pick, 'template_member', `template member: highest-entry ${kind} page`));
  }

  return [primary, ...sisters, ...templateMembers].slice(0, maxPages);
}
