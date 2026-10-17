#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pino from 'pino';
import { adaptersIn, discoverAdapterRoles, mountAdapters, selectAdapter } from './discover.js';
import { computeWindow, createBatch, runBatch } from './runner.js';
import { loadConfig } from './config.js';
import { runNamingAgents } from './naming-consumer.js';
import { createBotRunner } from './capture/bot-runner.js';
import { createHarvester } from './capture/harvester.js';
import { openV1ClickHouse } from './composition/v1.js';
import { runSites } from './application/commands/args.js';

/**
 * @deprecated The v1 CLI (plan R4.3). It runs until phase 5, when the
 * orchestrator's units replace deploy/analysis-{naming,capture,saliency}.service
 * and the server cron lines in docs/RUNBOOK.md, and then it is removed. New
 * work goes through bin/orchestrator and src/cli.js. Until then only the
 * R2.3 port fixes land here.
 *
 * CLI:
 *   node src/index.js --site-source static-idsites --idsites 3199,3207,3228
 *   node src/index.js --resume <batch_id>
 *   node src/index.js --naming-complete --idsite 3199 --idsitehsr 63918696 --url https://... --names names.json
 *   node src/index.js --naming-agents 3            (run the naming consumer; count overrides config)
 *
 * Adapter selection: --site-source / ANALYSIS_SITE_SOURCE,
 * --qualifier / ANALYSIS_QUALIFIER, --persistence / ANALYSIS_PERSISTENCE.
 * The runner looks the id up in the discovered list; there is no switch.
 *
 * Agent counts come from analysis.config.json {"agents": {...}} or
 * ANALYSIS_AGENTS / NAMING_AGENTS env vars; defaults are 1 and 1.
 */

const here = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  /** @type {Record<string, string>} */
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        flags[key] = 'true';
      } else {
        flags[key] = next;
        i += 1;
      }
    }
  }
  return flags;
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });
  const config = loadConfig(process.env);
  logger.warn('src/index.js is the deprecated v1 path; phase 5 replaces it with bin/orchestrator (plan R4.3)');

  const roles = await discoverAdapterRoles(path.join(here, 'adapters'));
  mountAdapters(logger, roles);
  const siteSources = adaptersIn(roles, 'site-sources');
  const qualifiers = adaptersIn(roles, 'qualifiers');
  const datasets = adaptersIn(roles, 'datasets');
  const persistences = adaptersIn(roles, 'persistence');

  const persistenceChoice = selectAdapter(
    persistences,
    flags.persistence ?? process.env.ANALYSIS_PERSISTENCE ?? 'clickhouse',
    'ANALYSIS_PERSISTENCE',
  );

  // Only the clickhouse adapter knows how to build a client and gateway.
  let persistence = persistenceChoice;
  /** @type {import('./ports/query-gateway.js').QueryGateway | null} */
  let gateway = null;
  if (persistenceChoice.id === 'clickhouse') {
    const store = await openV1ClickHouse({ env: process.env, logger });
    persistence = store.persistence;
    gateway = store.gateway;
  } else if (typeof persistenceChoice.createGateway === 'function') {
    gateway = persistenceChoice.createGateway();
  }
  if (flags['naming-complete']) {
    const idsite = Number(flags.idsite);
    const idsitehsr = Number(flags.idsitehsr);
    if (!idsite || !idsitehsr) {
      throw new Error('--naming-complete requires --idsite and --idsitehsr');
    }
    const names = flags.names ? JSON.parse(await readFile(flags.names, 'utf8')) : [];
    await persistence.completeNaming({
      idsite,
      idsitehsr,
      url: flags.url ?? '',
      namedOn: new Date().toISOString().slice(0, 10),
      names,
    });
    logger.info({ idsite, idsitehsr, names: names.length }, 'naming complete; awaiting pages re-queued for analysis');
    return;
  }

  const clock = { todayUtc: () => new Date().toISOString().slice(0, 10) };

  if (flags['naming-agents'] !== undefined) {
    const count = Number.parseInt(flags['naming-agents'], 10);
    if (!Number.isFinite(count) || count < 1) {
      throw new Error('--naming-agents requires a positive integer');
    }
    await runNamingAgents({
      persistence,
      config: { ...config, agents: { ...config.agents, naming: count } },
      logger,
      clock,
      harvester: createHarvester({ botRunner: createBotRunner({ env: process.env }) }),
    });
    return;
  }

  if (!gateway) {
    gateway = {
      query: async () => {
        throw new Error('no QueryGateway available with this persistence adapter');
      },
      explain: async () => {
        throw new Error('no QueryGateway available with this persistence adapter');
      },
      columns: async () => [],
    };
  }

  // A resumed batch describes itself: the stored row names the site source
  // and qualifier it ran with. Flags and env vars still win when given.
  let resumed = null;
  if (flags.resume) {
    resumed = await persistence.readBatch(flags.resume);
    if (!resumed) throw new Error(`batch ${flags.resume} not found`);
  }

  const siteSource = selectAdapter(
    siteSources,
    flags['site-source'] ?? process.env.ANALYSIS_SITE_SOURCE ?? resumed?.siteSource,
    'ANALYSIS_SITE_SOURCE',
  );
  const qualifier = selectAdapter(
    qualifiers,
    flags.qualifier ?? process.env.ANALYSIS_QUALIFIER ?? resumed?.qualifier ?? 'prefer-non-home',
    'ANALYSIS_QUALIFIER',
  );

  const deps = {
    persistence,
    siteSource,
    qualifier,
    datasets,
    logger,
    clock,
    gateway,
    siteSourceId: siteSource.id,
    agentCount: config.agents.analysis,
    sites: runSites(flags, 'idsites'),
    elementNamesPath: config.elementNamesPath,
  };

  let batchId;
  let window;
  if (resumed) {
    batchId = resumed.batchId;
    window = { windowStart: resumed.windowStart, windowEnd: resumed.windowEnd };
    if (resumed.siteSource !== siteSource.id) {
      logger.warn({ batch: resumed.siteSource, cli: siteSource.id }, 'site source differs from the original batch');
    }
  } else {
    window = computeWindow(clock);
    ({ batchId } = await createBatch({ ...deps, window }));
  }

  try {
    const counts = await runBatch(batchId, { ...deps, ...window });
    logger.info({ batchId, ...counts }, 'done');
  } catch (err) {
    try {
      await persistence.createBatch({
        batchId,
        windowStart: window.windowStart,
        windowEnd: window.windowEnd,
        siteSource: siteSource.id,
        qualifier: qualifier.id,
        minSessions: qualifier.config.minSessions,
        minOrders: qualifier.config.minOrders,
        minShareOfHome: qualifier.config.minShareOfHome,
        status: 'failed',
      });
    } catch {
      // best effort
    }
    throw err;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
