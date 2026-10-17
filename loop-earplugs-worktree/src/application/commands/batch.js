import { loadCatalog } from '../../catalog/index.js';
import { CriteriaError, parseCriteria, resolveCriteria } from '../../domain/criteria.js';
import { profileFingerprint } from '../../domain/profile.js';
import { createAeBatch, runAeBatch } from '../../runner-ae.js';
import { runCaptureAgents } from '../../capture-consumer.js';
import { runSaliencyWorker } from '../../saliency-worker.js';
import { profileDatasets } from '../../site-analysis/roles.js';
import { ok, parseList, positiveInt, runSites } from './args.js';

/** The criteria schema of a profile that keeps the configured page selector: no criteria. */
const NO_CRITERIA = Object.freeze({ type: 'object', properties: {}, additionalProperties: false });

/**
 * The profile by id.
 * @param {string} id
 * @param {object} ctx
 */
async function namedProfile(id, ctx) {
  const profiles = await ctx.profiles();
  const profile = profiles.get(id);
  if (!profile) throw new Error(`unknown profile "${id}"; profiles: ${[...profiles.keys()].join(', ')}`);
  return profile;
}

/**
 * The profile's subject selector, or null when it keeps the configured
 * page selector. Its subject type is the profile's.
 * @param {Readonly<import('../../domain/profile.js').Profile>} profile
 * @param {object} ctx
 */
function profileSelector(profile, ctx) {
  if (!profile.selector) return null;
  const selector = ctx.select('subject-selectors', profile.selector.use);
  if (selector.subjectType !== profile.subjectType) {
    throw new Error(`profile "${profile.id}" selects ${profile.subjectType} subjects; selector "${selector.id}" selects ${selector.subjectType}`);
  }
  return selector;
}

/**
 * The profile's criteria with `--select` over them, checked against the
 * selector's schema.
 * @param {Readonly<import('../../domain/profile.js').Profile>} profile
 * @param {object | null} selector
 * @param {string | undefined} select the --select JSON
 */
function profileCriteria(profile, selector, select) {
  const schema = selector?.descriptor?.criteria ?? NO_CRITERIA;
  try {
    return resolveCriteria(schema, profile.selector?.criteria ?? {}, parseCriteria(select));
  } catch (err) {
    if (!(err instanceof CriteriaError)) throw err;
    throw new Error(`profile "${profile.id}": ${err.message}; criteria schema: ${JSON.stringify(schema)}`);
  }
}

/**
 * A subject selector carrying the batch's criteria: qualify calls it in the
 * place of the page selector, and select-subjects calls it for subjects
 * other than pages.
 * @param {import('../../ports/subject.js').SubjectSelectorPort} selector
 * @param {object} criteria
 */
function withCriteria(selector, criteria) {
  return {
    id: selector.id,
    subjectType: selector.subjectType,
    select: (site, qualification, siteCtx) => selector.select(site, qualification, siteCtx, criteria),
    open: selector.open && ((site, siteCtx) => {
      const folder = selector.open(site, siteCtx);
      return folder && { ...folder, finish: (s, qualification, c) => folder.finish(s, qualification, c, criteria) };
    }),
  };
}

/** The site source, qualifier, and page selector a batch is created and run with. */
function batchAdapters(flags, ctx, selector = null, criteria = {}) {
  return {
    siteSource: ctx.select('site-sources', flags['site-source'], 'ANALYSIS_SITE_SOURCE'),
    qualifier: ctx.select('qualifiers', flags.qualifier, 'ANALYSIS_QUALIFIER', 'prefer-non-home'),
    pageSelector: selector
      ? withCriteria(selector, criteria)
      : ctx.select('page-selectors', flags['page-selector'], 'ANALYSIS_PAGE_SELECTOR', 'primary-only'),
  };
}

/**
 * A created batch's profile, re-read and compared with the one the batch
 * stored, and its criteria. A batch from before profiles runs as `lp`.
 * @param {object} batch
 * @param {object} ctx
 */
async function batchProfile(batch, ctx) {
  const profile = await namedProfile(batch.profile || 'lp', ctx);
  const stored = batch.metadata?.profile;
  if (stored !== undefined && stored !== profileFingerprint(profile)) {
    throw new Error(`profile "${profile.id}" changed after batch ${batch.batchId} was created; create a new batch`);
  }
  return { profile, criteria: batch.metadata?.criteria ?? {} };
}

export const seedReference = {
  flag: 'seed-reference',
  usage: '--seed-reference',
  async run(flags, ctx) {
    await ctx.ensure('ae', 'v1');
    const bundle = loadCatalog();
    await ctx.persistence().seedReference(bundle);
    return ok({
      seeded: {
        requirements: bundle.requirements.requirements.length,
        strategies: Object.values(bundle.strategies).reduce((n, c) => n + c.strategies.filter((s) => !s.card_only).length, 0),
        crosswalk_members: bundle.crosswalk.entries.reduce((n, e) => n + e.members.length, 0),
        screen_rules: bundle.screenRules.rules.length,
      },
    });
  },
};

/** Runs a created batch: qualify, select pages, and run the datasets per site. */
export const runBatch = {
  flag: 'run',
  usage: '--run --batch <id> [--agents N] [--sites <idsite,...> | --platform shopify --status active] [--max-pages N]',
  async run(flags, ctx) {
    // invoked as --run --batch <id>: the id is the value of --batch
    const batchId = flags.batch;
    if (!batchId || batchId === 'true') throw new Error('--run requires --batch <batch_id>');
    const maxPagesPerSite = flags['max-pages'] ? positiveInt(flags['max-pages'], 'max-pages') : 6;
    await ctx.ensure('ae', 'v1');
    const batch = await ctx.persistence().getBatch(batchId);
    if (!batch) throw new Error(`ae batch ${batchId} not found`);
    const { profile, criteria } = await batchProfile(batch, ctx);
    const adapters = batchAdapters(flags, ctx, profileSelector(profile, ctx), criteria);
    const counts = await runAeBatch(batchId, {
      persistence: ctx.persistence(),
      gateway: ctx.gateway(),
      logger: ctx.logger,
      clock: ctx.clock,
      ...adapters,
      subjectSelector: adapters.pageSelector,
      sites: runSites(flags),
      elementNamesPath: ctx.config.elementNamesPath,
      segmentations: await ctx.segmentations(),
      datasets: profileDatasets(profile, ctx.adapters('datasets')),
      steps: profile.steps,
      subjectType: profile.subjectType,
      descriptorSources: ctx.adapters('descriptor-sources'),
      trafficExclusion: ctx.select('traffic-exclusion', flags['exclusion-adapter'] ?? 'viewport-dead', 'ANALYSIS_EXCLUSION_ADAPTER'),
      agentCount: flags.agents ? Number.parseInt(flags.agents, 10) : ctx.config.agents.analysis,
      pageSelectorOpts: { maxPagesPerSite },
      dayScan: ctx.config.dayScan,
      ...(ctx.config.dayScan && ctx.dayStore?.() ? { dayStore: ctx.dayStore() } : {}),
      telemetry: ctx.telemetry,
    });
    return ok({ batchId, counts });
  },
};

/** Creates a batch over the selected sites and catalogs and prints its id. */
export const createBatch = {
  flag: 'batch',
  usage: "--batch [--profile lp] [--select '{...}'] [--sites <idsite,...>] [--window-days 30] [--catalogs LP,PO]",
  async run(flags, ctx) {
    const bundle = loadCatalog();
    const profile = await namedProfile(flags.profile ?? ctx.config.profile, ctx);
    const selector = profileSelector(profile, ctx);
    const criteria = profileCriteria(profile, selector, flags.select);
    const inProfile = profile.catalogs === 'all' ? Object.keys(bundle.strategies) : profile.catalogs;
    const catalogs = flags.catalogs ? parseList(flags.catalogs) : inProfile;
    const unknown = catalogs.filter((id) => !bundle.strategies[id]);
    if (unknown.length > 0) {
      throw new Error(`unknown catalogs: ${unknown.join(', ')}; loaded: ${Object.keys(bundle.strategies).join(', ')}`);
    }
    const outside = catalogs.filter((id) => !inProfile.includes(id));
    if (outside.length > 0) throw new Error(`catalogs ${outside.join(', ')} are outside profile "${profile.id}": ${inProfile.join(', ')}`);
    const windowDays = positiveInt(flags['window-days'] ?? '30', 'window-days');
    await ctx.ensure('ae', 'v1');
    const { siteSource, qualifier, pageSelector } = batchAdapters(flags, ctx, selector, criteria);
    const { batchId } = await createAeBatch({
      persistence: ctx.persistence(),
      windowDays,
      catalogs,
      standards: bundle.standards,
      siteSourceId: siteSource.id,
      qualifierId: qualifier.id,
      pageSelectorId: pageSelector.id,
      profile: profile.id,
      subjectType: profile.subjectType,
      metadata: { profile: profileFingerprint(profile), criteria },
      logger: ctx.logger,
      clock: ctx.clock,
    });
    return ok(`batch_id: ${batchId}`);
  },
};

export const capture = {
  flag: 'capture',
  usage: '--capture [--agents N]',
  async run(flags, ctx) {
    await ctx.ensure('ae', 'v1');
    await runCaptureAgents({
      persistence: ctx.persistence(),
      config: ctx.config,
      logger: ctx.logger,
      clock: ctx.clock,
      agentCount: flags.agents ? Number.parseInt(flags.agents, 10) : undefined,
      harvester: ctx.harvester,
    });
    return ok(undefined);
  },
};

/** One sweep, then exit. AE_ENABLE_SALIENCY and AE_SALIENCY_COMMAND gate the worker itself (D-08). */
export const saliency = {
  flag: 'saliency',
  usage: '--saliency [--once]',
  async run(flags, ctx) {
    await ctx.ensure('ae', 'v1');
    await runSaliencyWorker({ persistence: ctx.persistence(), gateway: ctx.gateway(), saliency: ctx.saliency, logger: ctx.logger, database: ctx.database });
    return ok(undefined);
  },
};
