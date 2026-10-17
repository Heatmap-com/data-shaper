import { siteFromDomain } from '../domain/site.js';

const rowId = (row) => (typeof row === 'string' ? row : (row.id ?? row.use));

/** The resolved run for a site, layer by layer: which file set each stage, its handler, check, fallback, and prompt sources. */
export function createRunExplainer({ descriptors, resolver, prompts }) {
  return async function explain({ site: selector, run: ref, sets }) {
    const site = (await descriptors.site(selector)) ?? siteFromDomain(selector);
    const resolved = await resolver.resolve({ site, ref, sets });
    const layers = [];
    for (const entry of resolved.refs) layers.push({ ...entry, body: (await descriptors.runFile(entry.file)).body });
    const lines = [`run ${resolved.run.id} for ${site.domain} (${site.slug})`, 'layers (root first):'];
    for (const entry of resolved.refs) lines.push(`  ${entry.file}`);
    lines.push('stages:');
    for (const stage of resolved.run.stages) {
      const layer = layers.filter((entry) => (entry.body.stages ?? []).some((row) => rowId(row) === stage.id)).at(-1);
      lines.push(`  ${stage.id} — use ${stage.use}, layer ${layer?.file ?? '(unknown)'}`);
      lines.push(`    handler: ${stage.handler?.use ?? 'none'}; check: ${stage.check?.use ?? 'none'}; fallback agent: ${stage.fallback?.agent ?? 'none'}`);
      for (const prompt of [stage.handler?.prompt ?? stage.prompt, stage.fallback?.prompt].filter(Boolean)) {
        const sources = await prompts.sources(prompt, { site: site.slug }).catch(() => ['(unresolved)']);
        lines.push(`    prompt ${prompt}: ${sources.join(' + ')}`);
      }
    }
    return lines.join('\n');
  };
}
