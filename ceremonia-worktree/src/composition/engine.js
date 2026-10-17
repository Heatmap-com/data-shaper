import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pino from 'pino';
import { adaptersIn, discoverAdapterRoles, mountAdapters, selectAdapter } from '../discover.js';
import { loadConfig } from '../config.js';
import { createClickHouseAePersistence } from '../adapters/persistence/clickhouse.js';
import { ensureAe, ensureSchema, ensureTrendTables } from '../adapters/persistence/clickhouse/schema-migrator.js';
import { createGateway } from '../adapters/query-gateway/clickhouse.js';
import { clickHouseConfig, clickHouseDatabase, createClickHouseClient } from './clickhouse.js';
import { loadBrands, loadProfiles, loadSegmentationSpecs, loadTrendSeeds, orchestrationRoot } from './registries.js';
import { loadCatalog } from '../catalog/index.js';
import { loadSegmentationRegistry } from './segmentations.js';
import { loadShapingRegistry } from './shaping.js';
import { loadQualityRegistry } from './quality.js';
import { createBotRunner } from '../capture/bot-runner.js';
import { createHarvester } from '../capture/harvester.js';

const adaptersDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'adapters');

const SCHEMAS = {
  ae: ensureAe,
  v1: ensureSchema,
  trend: ensureTrendTables,
};

/**
 * The engine CLI's composition root: the logger, config, clock, discovered
 * adapters, telemetry, and the ClickHouse client, persistence, and gateway.
 * Every environment read for the engine commands happens here. The client
 * and what is built on it are made on first use, so a command that needs no
 * database never connects. `deps` replaces any of them in tests.
 *
 * @param {{env?: NodeJS.ProcessEnv, deps?: {persistence?: object, gateway?: object, client?: object, telemetry?: object, clock?: object, dayStore?: object, shaping?: object, quality?: object}}} [options]
 */
export async function createEngineContext({ env = process.env, deps = {} } = {}) {
  const logger = pino({ level: env.LOG_LEVEL ?? 'info' });
  const config = loadConfig(env);
  const clock = deps.clock ?? { todayUtc: () => new Date().toISOString().slice(0, 10) };
  const roles = await discoverAdapterRoles(adaptersDir);
  mountAdapters(logger, roles);
  const telemetry = await openTelemetry(deps.telemetry, env, logger, adaptersIn(roles, 'telemetry'));

  let client = null;
  let persistence = null;
  let gateway = null;
  let dayStore;
  let profiles = null;
  let segmentations = null;
  let shaping = null;
  let quality = null;
  const ensured = new Set();
  const connect = () => {
    client ??= deps.client ?? createClickHouseClient(clickHouseConfig(env));
    return client;
  };
  const database = clickHouseDatabase(env);

  return {
    logger,
    config,
    clock,
    telemetry,
    database,
    saliency: saliencyConfig(env),
    harvester: createHarvester({ botRunner: createBotRunner({ env }) }),
    adapters: (role) => adaptersIn(roles, role),
    /** The adapter named by the flag, else the environment variable, else the default. */
    select(role, flagValue, envName, fallback) {
      const id = flagValue ?? (envName ? env[envName] : undefined) ?? fallback;
      return selectAdapter(adaptersIn(roles, role), id, envName);
    },
    /** The orchestration registries the engine commands read: audit brands, trend seeds, and site segmentation files. */
    registries: {
      brands: () => loadBrands(orchestrationRoot(env)),
      trendSeeds: () => loadTrendSeeds(orchestrationRoot(env)),
      segmentations: () => loadSegmentationSpecs(orchestrationRoot(env)),
    },
    /** The segmentation registry, built once: the shipped catalog, the computed adapters, and the site files. */
    segmentations() {
      segmentations ??= loadSegmentationRegistry(env, adaptersIn(roles, 'segmentations'));
      return segmentations;
    },
    /** The registry with one site file read in place of the stored one; not cached. */
    segmentationsWith(site) {
      return loadSegmentationRegistry(env, adaptersIn(roles, 'segmentations'), { site });
    },
    /** The shaping registry, built once: attributes, source kinds, site attribute and source files, external-source adapters. */
    shaping() {
      shaping ??= deps.shaping ?? loadShapingRegistry(env, adaptersIn(roles, 'external-sources'));
      return shaping;
    },
    /** The data-quality registry, built once: the shipped screens, the quality-methods and quality-triage adapters, site quality and decision files. */
    quality() {
      quality ??= deps.quality ?? loadQualityRegistry(env, { methods: adaptersIn(roles, 'quality-methods'), triages: adaptersIn(roles, 'quality-triage') });
      return quality;
    },
    /** The execution profiles by id, loaded once. */
    profiles() {
      profiles ??= loadProfiles(config.profilesDir, Object.keys(loadCatalog().strategies));
      return profiles;
    },
    injected: { persistence: deps.persistence ?? null, gateway: deps.gateway ?? null },
    client: connect,
    /** Creates the named table sets once per process: `ae`, `v1`, `trend`. */
    async ensure(...names) {
      for (const name of names) {
        if (ensured.has(name)) continue;
        await SCHEMAS[name](connect(), database);
        ensured.add(name);
      }
    },
    persistence() {
      persistence ??= deps.persistence ?? createClickHouseAePersistence({ client: connect(), database, logger, telemetry }).adapter;
      return persistence;
    },
    gateway() {
      gateway ??= deps.gateway ?? createGateway(connect(), { logger, telemetry, database });
      return gateway;
    },
    /** The day scan's store and overlap from config.dayStore, or null when it is `off`. */
    dayStore() {
      dayStore ??= openDayStore(config.dayStore, adaptersIn(roles, 'day-store'), deps.dayStore, connect, database);
      return dayStore;
    },
    async close() {
      await telemetry?.close?.();
    },
  };
}

/**
 * The saliency worker's settings from the environment.
 * @param {NodeJS.ProcessEnv} env
 * @returns {import('../saliency-worker.js').SaliencyConfig}
 */
export function saliencyConfig(env) {
  return {
    enabled: env.AE_ENABLE_SALIENCY === '1',
    command: (env.AE_SALIENCY_COMMAND ?? '').trim(),
    model: (env.AE_SALIENCY_MODEL ?? '').trim(),
    sites: (env.AE_SALIENCY_SITES ?? '')
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 0),
  };
}

/**
 * @param {{adapter: string, dir: string, overlapDays: number, keepDays: number}} settings
 * @param {Array<{id: string, create: Function}>} adapters
 * @param {object | undefined} injected a DayStore that replaces the configured one
 * @param {() => object} connect
 * @param {string} database
 * @returns {{store: import('../ports/day-store.js').DayStore, overlapDays: number, keepDays: number} | null}
 */
function openDayStore(settings, adapters, injected, connect, database) {
  if (injected) return { store: injected, overlapDays: settings.overlapDays, keepDays: settings.keepDays };
  if (settings.adapter === 'off') return null;
  const selected = selectAdapter(adapters, settings.adapter, 'ANALYSIS_DAY_STORE');
  const options = { local: () => ({ dir: settings.dir }), clickhouse: () => ({ client: connect(), database }) }[selected.id];
  return { store: selected.create(options ? options() : {}), overlapDays: settings.overlapDays, keepDays: settings.keepDays };
}

/**
 * The localhost adapter, unless the caller passed a telemetry port or
 * turned it off with TELEMETRY=0. The URL is where a person reads what to
 * optimize while the command runs.
 */
async function openTelemetry(injected, env, logger, adapters) {
  if (injected) return injected;
  if (env.TELEMETRY === '0') return null;
  const selected = selectAdapter(adapters, env.TELEMETRY_ADAPTER ?? 'localhost', 'TELEMETRY_ADAPTER');
  const telemetry = selected.create();
  const address = await telemetry.start();
  logger.info({ url: `http://${address.host}:${address.port}/telemetry/summary` }, 'telemetry');
  return telemetry;
}
