import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { runAudit } from '../../audit/runner.js';
import { selectBrands } from '../../audit/brands.js';
import { ok, parseList, valueOf } from './args.js';

/** Roswell audit. It does not qualify a landing page and does not run the udp_* dataset adapters. */
export const audit = {
  flag: 'audit',
  usage: '--audit [--phase readiness|funnel|template|context|all] [--brands ceremonia,dvf] [--sites 1,2] [--matrix inputs.json] [--dry-run]',
  async run(flags, ctx) {
    const phase = valueOf(flags, 'phase') ?? 'readiness';
    const keys = valueOf(flags, 'brands') ? parseList(flags.brands) : undefined;
    const idsites = valueOf(flags, 'sites') ? parseList(flags.sites).map((s) => Number.parseInt(s, 10)) : [];
    const matrix = valueOf(flags, 'matrix');
    const { inputs, brandIds } = matrix ? await loadAuditInputs(matrix) : { inputs: {}, brandIds: {} };
    const brands = selectBrands(await ctx.registries.brands(), keys, idsites).map((brand) => ({
      ...brand,
      idsite: brand.idsite > 0 ? brand.idsite : (brandIds[brand.key] ?? 0),
    }));
    let { gateway, persistence } = ctx.injected;
    if (!gateway) {
      await ctx.ensure('ae');
      persistence = ctx.persistence();
      gateway = ctx.gateway();
    }
    return ok(await runAudit({
      gateway,
      persistence,
      brands,
      clock: ctx.clock,
      phase,
      inputs,
      logger: ctx.logger,
      telemetry: ctx.telemetry,
      dryRun: flags['dry-run'] !== undefined,
    }));
  },
};

/**
 * One matrix file, a comma-separated list, or a directory of brand JSON files.
 * A file named `<brand>.json` supplies that brand's idsite when --sites is omitted.
 */
export async function loadAuditInputs(matrixFlag) {
  /** @type {string[]} */
  const files = [];
  for (const part of String(matrixFlag).split(',').map((s) => s.trim()).filter(Boolean)) {
    const info = await stat(part);
    if (info.isDirectory()) {
      const names = (await readdir(part)).filter((name) => name.endsWith('.json')).sort();
      files.push(...names.map((name) => path.join(part, name)));
    } else {
      files.push(part);
    }
  }
  const inputs = { entries: [], urlRules: [], events: [] };
  /** @type {Record<string, number>} */
  const brandIds = {};
  for (const file of files) {
    const doc = JSON.parse(await readFile(file, 'utf8'));
    inputs.entries.push(...(doc.entries ?? []));
    inputs.urlRules.push(...(doc.urlRules ?? []));
    inputs.events.push(...(doc.events ?? []));
    const id = (doc.entries ?? []).find((entry) => Number(entry.idsite) > 0)?.idsite;
    if (id) brandIds[path.basename(file, '.json')] = Number(id);
  }
  return { inputs, brandIds };
}
