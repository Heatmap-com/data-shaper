#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEngineContext } from './composition/engine.js';
import { parseFlags } from './application/commands/args.js';
import { findCommand, usage } from './application/commands/index.js';

/**
 * The schema-2 CLI (data-capture-plan.md §9.2). v1 src/index.js stays the
 * v1 CLI until cutover; both coexist, pointed at different tables.
 *
 *   node src/cli.js --audit [--phase readiness|funnel|template|context|all] [--brands ceremonia,dvf] [--sites 1,2] [--matrix inputs.json] [--dry-run]
 *   node src/cli.js --trend --sites 5795 --window-start 2026-09-14 --window-end 2026-10-09 [--path-limit 3] [--rerank] [--segmentations traffic_source,channel] [--backfill-all]
 *   node src/cli.js --trend --sites 5795 --next-weeks [--overlap-weeks 1] [--backfill-weeks 8] [--rank-days 30]
 *   node src/cli.js --tag-trend --sites 5795 --window-start 2026-09-14 --window-end 2026-10-09 [--lookback-days 30] [--rerank] [--tag-selector traffic-variance] [--segmentations return_intent] [--backfill-all]
 *   node src/cli.js --tag-trend --sites 5795 --next-weeks [--overlap-weeks 1] [--backfill-weeks 8]
 *   node src/cli.js --segmentation-check --sites 5795 --week 2026-10-05 (--segmentation channel | --segmentation-file orchestration/sites/dvf/segmentations.json)
 *   node src/cli.js --shape examples/shaping/requests.json (--plan | --out ~/work/analysis/<slug>/shapes) [--no-quality]
 *   node src/cli.js --quality-decide <finding id> --from <out>/<dataset>/quality.json (--exclude | --include | --reprocess '<patch JSON>') --by <name> --note "<why>" [--for-rule] [--dataset-only]
 *   node src/cli.js --traffic-exclusion --sites 5795 --window-start 2026-09-14 --window-end 2026-10-09 [--exclusion-adapter viewport-dead]
 *   node src/cli.js --batch [--profile lp] [--select '{...}'] [--sites <idsite,...>] [--window-days 30] [--catalogs LP,PO]
 *   node src/cli.js --run --batch <batch_id> [--agents N] [--sites <idsite,...> | --platform shopify --status active] [--max-pages N]
 *   node src/cli.js --replay --batch <batch_id> --sites <idsite> [--datasets id,id]
 *   node src/cli.js --capture [--agents N]
 *   node src/cli.js --saliency [--once]
 *   node src/cli.js --seed-reference
 *   node src/cli.js --descriptor-import <file.json> [--dry-run]   (§9.6, Phase 5 write path)
 *   node src/cli.js --governance-import <file.json> [--dry-run]   (§9.6, Phase 5 write path)
 *   node src/cli.js --tool-registry-import <file.json> [--dry-run]   (Phase 5)
 *
 * Adapter selection: --site-source / ANALYSIS_SITE_SOURCE,
 * --qualifier / ANALYSIS_QUALIFIER, --page-selector / ANALYSIS_PAGE_SELECTOR,
 * --tag-selector / ANALYSIS_TAG_SELECTOR (default traffic-variance).
 * --profile / ANALYSIS_PROFILE names the execution profile in profiles/
 * (default lp, which keeps the page selector above); --select is JSON
 * criteria over the profile's, checked against its selector's schema.
 *
 * The CLI parses, runs one command from src/application/commands/, and
 * prints: the output on stdout, every error on stderr with exit code 1, or
 * the exit code the command gives.
 */

/**
 * @param {string[]} argv
 * @param {object} [deps] test and deployment overrides: persistence, gateway, client, telemetry, clock
 * @returns {Promise<unknown>} the command's output
 */
export async function main(argv = process.argv.slice(2), deps = {}) {
  const flags = parseFlags(argv);
  const command = findCommand(flags);
  if (!command) throw new Error(usage());
  const ctx = await createEngineContext({ deps });
  try {
    const result = await command.run(flags, ctx);
    if (!result.ok) {
      if (result.output !== undefined) console.log(result.output);
      for (const error of result.errors) console.error(error);
      process.exitCode = result.exitCode ?? 1;
      return undefined;
    }
    if (result.output !== undefined) console.log(typeof result.output === 'string' ? result.output : JSON.stringify(result.output));
    return result.output;
  } finally {
    await ctx.close();
  }
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
