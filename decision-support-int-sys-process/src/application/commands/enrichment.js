import { DEFAULT_RANK_DAYS, runTrend } from '../../enrichment/trend-run.js';
import { DEFAULT_PATH_LIMIT } from '../../enrichment/trend-aggregate.js';
import { DEFAULT_LOOKBACK_DAYS, runTagTrend } from '../../enrichment/tag-trend-run.js';
import { runTrafficExclusion } from '../../traffic-exclusion/run.js';
import { runReplay } from '../../replay.js';
import { DEFAULT_BACKFILL_WEEKS, DEFAULT_OVERLAP_WEEKS } from '../../enrichment/trend-window.js';
import { ok, oneSite, parseList, positiveInt, wholeNumber, window } from './args.js';

const SPAN_USAGE = '(--window-start YYYY-MM-DD --window-end YYYY-MM-DD | --next-weeks [--overlap-weeks 1] [--backfill-weeks 8])';

/**
 * The explicit window, or `--next-weeks`: from the stored weeks to the last
 * whole week before today.
 */
function trendSpan(flags, command, clock) {
  if (flags['next-weeks'] !== 'true') return window(flags, command);
  if (flags['window-start'] || flags['window-end']) {
    throw new Error(`--${command} takes --next-weeks or --window-start and --window-end, not both`);
  }
  return {
    nextWeeks: {
      today: clock.todayUtc(),
      overlapWeeks: wholeNumber(flags['overlap-weeks'] ?? String(DEFAULT_OVERLAP_WEEKS), 'overlap-weeks'),
      backfillWeeks: positiveInt(flags['backfill-weeks'] ?? String(DEFAULT_BACKFILL_WEEKS), 'backfill-weeks'),
    },
  };
}

/**
 * The segmentations a run reads: `--segmentations a,b`, else the site's
 * default, else the shipped one. Checked before any query.
 */
async function segmentationsFor(flags, command, grain, idsite, ctx) {
  const value = flags.segmentations;
  if (value === 'true') throw new Error(`--${command} --segmentations needs a list of ids`);
  const ids = value === undefined ? null : parseList(value);
  if (ids && ids.length === 0) throw new Error(`--${command} --segmentations needs a list of ids`);
  const registry = await ctx.segmentations();
  try {
    const list = registry.select(idsite, grain, ids);
    return { list, source: registry.sourceOf(idsite, grain, ids) };
  } catch (err) {
    throw new Error(`--${command} --segmentations: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Week-over-week journeys, top pages, and configured selectors for one site. */
export const trend = {
  flag: 'trend',
  usage: `--trend --sites <idsite> ${SPAN_USAGE} [--path-limit 3] [--rerank] [--rank-days 30] [--segmentations id,id] [--backfill-all]`,
  async run(flags, ctx) {
    const idsite = oneSite(flags, 'trend');
    const span = trendSpan(flags, 'trend', ctx.clock);
    const pathLimit = positiveInt(flags['path-limit'] ?? String(DEFAULT_PATH_LIMIT), 'path-limit');
    const rankDays = positiveInt(flags['rank-days'] ?? String(DEFAULT_RANK_DAYS), 'rank-days');
    const segmentations = await segmentationsFor(flags, 'trend', 'trend', idsite, ctx);
    await ctx.ensure('trend');
    const result = await runTrend({
      idsite,
      ...span,
      pathLimit,
      rankDays,
      rerank: flags.rerank === 'true',
      seeds: await ctx.registries.trendSeeds(),
      segmentations: segmentations.list,
      segmentationBudget: ctx.config.trend.segmentationBudget,
      maxBackfillWeeks: ctx.config.trend.maxBackfillWeeks,
      backfillAll: flags['backfill-all'] === 'true',
      gateway: ctx.gateway(),
      persistence: ctx.persistence(),
      logger: ctx.logger,
    });
    return ok({ ...result, segmentationSource: segmentations.source });
  },
};

/** Week-over-week session-tag values for one site, by the trend strategies plus return intent. */
export const tagTrend = {
  flag: 'tag-trend',
  usage: `--tag-trend --sites <idsite> ${SPAN_USAGE} [--lookback-days 30] [--rerank] [--tag-selector id] [--segmentations id,id] [--backfill-all]`,
  async run(flags, ctx) {
    const idsite = oneSite(flags, 'tag-trend');
    const span = trendSpan(flags, 'tag-trend', ctx.clock);
    const lookbackDays = positiveInt(flags['lookback-days'] ?? String(DEFAULT_LOOKBACK_DAYS), 'lookback-days');
    const selector = ctx.select('session-tag-selectors', flags['tag-selector'], 'ANALYSIS_TAG_SELECTOR', 'traffic-variance');
    const segmentations = await segmentationsFor(flags, 'tag-trend', 'tagTrend', idsite, ctx);
    await ctx.ensure('trend');
    const result = await runTagTrend({
      idsite,
      ...span,
      lookbackDays,
      rerank: flags.rerank === 'true',
      selector,
      segmentations: segmentations.list,
      segmentationBudget: ctx.config.trend.segmentationBudget,
      maxBackfillWeeks: ctx.config.trend.maxBackfillWeeks,
      backfillAll: flags['backfill-all'] === 'true',
      gateway: ctx.gateway(),
      persistence: ctx.persistence(),
      logger: ctx.logger,
    });
    return ok({ ...result, segmentationSource: segmentations.source });
  },
};

/** One traffic-exclusion model version for one site and window. */
export const trafficExclusion = {
  flag: 'traffic-exclusion',
  usage: '--traffic-exclusion --sites <idsite> --window-start YYYY-MM-DD --window-end YYYY-MM-DD [--exclusion-adapter id]',
  async run(flags, ctx) {
    const idsite = oneSite(flags, 'traffic-exclusion');
    const span = window(flags, 'traffic-exclusion');
    const adapter = ctx.select('traffic-exclusion', flags['exclusion-adapter'] ?? 'viewport-dead', 'ANALYSIS_EXCLUSION_ADAPTER');
    await ctx.ensure('ae');
    return ok(await runTrafficExclusion({
      idsite,
      ...span,
      adapter,
      gateway: ctx.gateway(),
      persistence: ctx.persistence(),
      logger: ctx.logger,
    }));
  },
};

/** Re-runs the replay datasets of one site in an existing batch. */
export const replay = {
  flag: 'replay',
  usage: '--replay --batch <id> --sites <idsite> [--datasets id,id]',
  async run(flags, ctx) {
    const batchId = flags.batch;
    if (!batchId || batchId === 'true') throw new Error('--replay requires --batch <batch_id>');
    const sites = parseList(flags.sites);
    if (sites.length !== 1) throw new Error('--replay requires --sites with one idsite');
    await ctx.ensure('ae', 'v1');
    const result = await runReplay({
      batchId,
      idsite: Number(sites[0]),
      datasetIds: flags.datasets ? parseList(flags.datasets) : null,
      datasets: ctx.adapters('datasets'),
      descriptorSources: ctx.adapters('descriptor-sources'),
      persistence: ctx.persistence(),
      gateway: ctx.gateway(),
      database: ctx.database,
      logger: ctx.logger,
      elementNamesPath: ctx.config.elementNamesPath,
      segmentations: await ctx.segmentations(),
    });
    return ok({ batchId, idsite: Number(sites[0]), ...result });
  },
};
