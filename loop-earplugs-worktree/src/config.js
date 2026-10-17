import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const seedScript = path.join(repoRoot, 'bin', 'seed-named-page.sh');

/**
 * Agent and naming-consumer configuration.
 *
 * Precedence: environment variables override the config file, which
 * overrides defaults. The config file path is ANALYSIS_CONFIG or
 * ./analysis.config.json next to the working directory.
 *
 *   {
 *     "agents": { "analysis": 2, "naming": 3 },
 *     "naming": {
 *       "botDir": "/abs/path/to/cnn-ai-bot",
 *       "command": "/abs/path/to/analysis-engine/bin/seed-named-page.sh {url} {idsite}",
 *       "datasetRoot": "/abs/path/to/cnn-ai-bot/dataset",
 *       "botTimeoutMs": 600000
 *     },
 *     "elementNamesPath": "/abs/path/to/element-names.json",
 *     "dayScan": true,
 *     "dayStore": { "adapter": "local", "dir": "/abs/path/to/day-records", "overlapDays": 2, "keepDays": 400 },
 *     "profilesDir": "/abs/path/to/profiles",
 *     "profile": "lp"
 *   }
 *
 * dayScan reads a site's sessions a day at a time (src/scan) in place of
 * the whole-window queries; ANALYSIS_DAY_SCAN=0 turns it off. dayStore
 * keeps the days the scan reads (src/scan/day-records.js), so the next
 * window reads only its new days: adapter `local` (files under dir,
 * ~/.cache/analysis-engine/day-records by default), `clickhouse`
 * (ae_scan_day), or `off`. A day older than overlapDays full days before
 * today is final and replays from the store. A site's run drops its days
 * older than keepDays from the store. profilesDir
 * holds the execution profiles, `<id>.profile.json`; the repo's
 * profiles/ by default. profile is the one `--batch` uses without
 * `--profile`; `lp` by default.
 *
 * Environment: ANALYSIS_AGENTS, NAMING_AGENTS, ANALYSIS_ELEMENT_NAMES, ANALYSIS_DAY_SCAN, ANALYSIS_DAY_STORE,
 * ANALYSIS_DAY_STORE_DIR, ANALYSIS_DAY_OVERLAP, ANALYSIS_DAY_KEEP, ANALYSIS_PROFILES_DIR, ANALYSIS_PROFILE, CNN_AI_BOT_DIR,
 * NAMING_ENGINE_ASSETS, NAMING_CONTAINER, NAMING_COMMAND,
 * NAMING_DATASET_ROOT, NAMING_BOT_TIMEOUT_MS.
 */

const DEFAULTS = {
  agents: { analysis: 1, naming: 1 },
  naming: {
    botDir: '',
    assetsDir: '',
    container: '',
    command: '',
    datasetRoot: '',
    botTimeoutMs: 600_000,
  },
};

/** @param {string | undefined} value @param {number} fallback */
function intOr(value, fallback) {
  if (value === undefined || value.trim() === '') return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function loadConfig(env = process.env) {
  /** @type {Partial<typeof DEFAULTS>} */
  let file = {};
  const configPath = env.ANALYSIS_CONFIG ?? 'analysis.config.json';
  if (existsSync(configPath)) {
    file = JSON.parse(readFileSync(configPath, 'utf8'));
  }

  const namingFile = file.naming ?? {};
  const botDir = env.CNN_AI_BOT_DIR ?? namingFile.botDir ?? DEFAULTS.naming.botDir;
  const assetsDir = env.NAMING_ENGINE_ASSETS ?? namingFile.assetsDir ?? DEFAULTS.naming.assetsDir;
  const container = env.NAMING_CONTAINER ?? namingFile.container ?? DEFAULTS.naming.container;
  const command =
    env.NAMING_COMMAND ?? namingFile.command ??
    (botDir ? `${seedScript} {url} {idsite}` : '');
  const datasetRoot =
    env.NAMING_DATASET_ROOT ?? namingRootDefault(namingFile, botDir);

  return {
    agents: {
      analysis: intOr(env.ANALYSIS_AGENTS, file.agents?.analysis ?? DEFAULTS.agents.analysis),
      naming: intOr(env.NAMING_AGENTS, file.agents?.naming ?? DEFAULTS.agents.naming),
    },
    naming: {
      botDir,
      assetsDir,
      container,
      command,
      datasetRoot,
      botTimeoutMs: intOr(env.NAMING_BOT_TIMEOUT_MS, namingFile.botTimeoutMs ?? DEFAULTS.naming.botTimeoutMs),
    },
    elementNamesPath: env.ANALYSIS_ELEMENT_NAMES || file.elementNamesPath || null,
    dayScan: env.ANALYSIS_DAY_SCAN !== undefined ? env.ANALYSIS_DAY_SCAN !== '0' : file.dayScan !== false,
    dayStore: {
      adapter: env.ANALYSIS_DAY_STORE || file.dayStore?.adapter || 'local',
      dir: env.ANALYSIS_DAY_STORE_DIR || file.dayStore?.dir || path.join(os.homedir(), '.cache', 'analysis-engine', 'day-records'),
      overlapDays: intOr(env.ANALYSIS_DAY_OVERLAP, file.dayStore?.overlapDays ?? 2),
      keepDays: intOr(env.ANALYSIS_DAY_KEEP, file.dayStore?.keepDays ?? 400),
    },
    profilesDir: env.ANALYSIS_PROFILES_DIR || file.profilesDir || path.join(repoRoot, 'profiles'),
    profile: env.ANALYSIS_PROFILE || file.profile || 'lp',
    trend: {
      segmentationBudget: Math.max(16, intOr(env.ANALYSIS_SEGMENTATION_BUDGET, file.trend?.segmentationBudget ?? 48)),
      maxBackfillWeeks: Math.max(1, intOr(env.ANALYSIS_MAX_BACKFILL_WEEKS, file.trend?.maxBackfillWeeks ?? 26)),
    },
  };
}

/** @param {Partial<typeof DEFAULTS.naming>} namingFile @param {string} botDir */
function namingRootDefault(namingFile, botDir) {
  if (namingFile.datasetRoot) return namingFile.datasetRoot;
  if (botDir) return `${botDir}/dataset`;
  return '';
}
