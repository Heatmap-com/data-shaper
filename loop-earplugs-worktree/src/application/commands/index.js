import { audit } from './audit.js';
import { descriptorImport, governanceImport, toolRegistryImport } from './imports.js';
import { replay, tagTrend, trafficExclusion, trend } from './enrichment.js';
import { capture, createBatch, runBatch, saliency, seedReference } from './batch.js';
import { qualityDecide } from './quality-decide.js';
import { segmentationCheck } from './segmentation-check.js';
import { shape } from './shape.js';

/**
 * The engine commands, each `{flag, usage, run(flags, ctx)}`. `run` returns
 * `{ok: true, output}` or `{ok: false, errors}`, which may also carry an
 * `output` to print and an `exitCode` other than 1. The first command whose
 * flag is set runs, so `--replay --batch` and `--run --batch` reach replay
 * and run before batch creation.
 */
export const COMMANDS = [
  descriptorImport,
  governanceImport,
  audit,
  trend,
  tagTrend,
  segmentationCheck,
  qualityDecide,
  shape,
  trafficExclusion,
  seedReference,
  toolRegistryImport,
  replay,
  runBatch,
  createBatch,
  capture,
  saliency,
];

export function findCommand(flags) {
  return COMMANDS.find((command) => flags[command.flag] !== undefined) ?? null;
}

export const usage = () => `usage: node src/cli.js (${COMMANDS.map((command) => command.usage).join(' | ')})`;
