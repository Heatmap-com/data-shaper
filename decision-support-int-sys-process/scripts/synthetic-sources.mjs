#!/usr/bin/env node
/**
 * Writes synthetic Meta Ads, GA4, and site catalog files for the
 * synthetic-file adapter, so a dataset request that reads external sources
 * can be built without a real connector.
 *
 *   node scripts/synthetic-sources.mjs --out <dir> --from 2026-08-24 --to 2026-10-04
 *     [--seed 7] [--campaigns fall_sale,retarget,brand] [--gaps 2026-09-10,2026-09-11]
 *     [--coverage-end 2026-09-30] [--clean]
 *
 * Point a site at the files with orchestration/sites/<slug>/sources.json:
 *
 *   { "idsite": <idsite>, "connections": {
 *       "meta_ads": { "adapter": "synthetic-file", "dir": "<dir>" },
 *       "ga4": { "adapter": "synthetic-file", "dir": "<dir>" },
 *       "site_catalog": { "adapter": "synthetic-file", "dir": "<dir>" } } }
 *
 * Campaign names should match the site's utm_campaign values, or the spend
 * lands on campaigns no session arrived from. --gaps leaves days out, and
 * the coverage file still vouches for the whole span, so a build reports
 * them as zero; without --gaps the coverage is the span. --coverage-end
 * makes the coverage stop early, as a connection that has not refreshed,
 * so a build whose window runs past it is blocked. --clean writes the
 * keys as the shipped kinds expect them, without export spellings.
 */
import path from 'node:path';
import { parseFlags } from '../src/application/commands/args.js';
import { isIsoDay } from '../src/domain/shaping/dates.js';
import { DEFAULT_CAMPAIGNS, syntheticSources, writeSyntheticSources } from './lib/synthetic-sources.mjs';

const flags = parseFlags(process.argv.slice(2));
const list = (value) => (typeof value === 'string' && value !== 'true' ? value.split(',').map((item) => item.trim()).filter(Boolean) : null);
const out = flags.out && flags.out !== 'true' ? path.resolve(flags.out) : null;
if (!out || !isIsoDay(flags.from) || !isIsoDay(flags.to) || flags.from > flags.to) {
  process.stderr.write('usage: node scripts/synthetic-sources.mjs --out <dir> --from YYYY-MM-DD --to YYYY-MM-DD [--seed n] [--campaigns a,b] [--gaps d1,d2] [--coverage-end YYYY-MM-DD] [--clean]\n');
  process.exit(2);
}
const gaps = list(flags.gaps) ?? [];
const sets = syntheticSources({
  from: flags.from,
  to: flags.to,
  seed: flags.seed ? Number(flags.seed) : 7,
  campaigns: list(flags.campaigns) ?? DEFAULT_CAMPAIGNS,
  gaps,
  messy: flags.clean === undefined,
});
const coverageEnd = isIsoDay(flags['coverage-end']) ? flags['coverage-end'] : null;
const span = { start: flags.from, end: coverageEnd ?? flags.to };
const files = writeSyntheticSources(out, sets, { coverage: gaps.length > 0 || coverageEnd ? { meta_ads: span, ga4: span } : {} });
for (const file of files) process.stdout.write(`${file}\n`);
