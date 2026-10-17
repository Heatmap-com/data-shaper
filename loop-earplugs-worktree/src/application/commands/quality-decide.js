import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { checkDecisions } from '../../domain/quality/decisions.js';
import { decisionFor, withDecision } from '../quality/decide.js';
import { valueOf } from './args.js';

const USAGE = '--quality-decide <finding id> --from <out>/<dataset>/quality.json (--exclude | --include | --reprocess \'<patch JSON>\') --by <name> --note "<why>" [--for-rule] [--dataset-only]';

/**
 * Records a person's answer to a data-quality finding in the site's
 * orchestration/sites/<slug>/quality-decisions.json, where the next
 * `--shape` reads it: exclude or include the finding's members (or, with
 * `--for-rule`, every finding of the screen), or screen again under the
 * patched constants. `--dataset-only` limits it to the finding's dataset.
 * Reads no warehouse and writes no table; a usage error exits 2.
 */
export const qualityDecide = {
  flag: 'quality-decide',
  usage: USAGE,
  async run(flags, ctx) {
    const findingId = valueOf(flags, 'quality-decide');
    const from = valueOf(flags, 'from');
    const choices = ['exclude', 'include', 'reprocess'].filter((name) => flags[name] !== undefined);
    const by = valueOf(flags, 'by');
    const note = valueOf(flags, 'note');
    const usage = (text) => ({ ok: false, errors: [text, `usage: node src/cli.js ${USAGE}`], exitCode: 2 });
    if (!findingId || !from) return usage('--quality-decide needs a finding id and --from <quality.json>');
    if (choices.length !== 1) return usage('give one of --exclude, --include, --reprocess');
    if (!by || !note) return usage('--by and --note say who decided and why');
    const decision = /** @type {'exclude' | 'include' | 'reprocess'} */ (choices[0]);
    let params = null;
    if (decision === 'reprocess') {
      const raw = valueOf(flags, 'reprocess');
      if (!raw) return usage('--reprocess takes the patch of the screen as JSON, e.g. \'{"method":{"params":{"k":5}}}\'');
      try {
        params = JSON.parse(raw);
      } catch (err) {
        return usage(`--reprocess: ${message(err)}`);
      }
    }

    let ledger;
    try {
      ledger = JSON.parse(await readFile(from, 'utf8'));
    } catch (err) {
      return { ok: false, errors: [`${from}: ${message(err)}`], exitCode: 1 };
    }
    const registry = await ctx.quality();
    const slug = ledger.slug ?? registry.slugOf(ledger.idsite);
    if (!slug) return { ok: false, errors: [`idsite ${ledger.idsite} has no folder under orchestration/sites; add one with a site.json naming the idsite`], exitCode: 1 };
    const file = registry.decisionsFile(slug);

    let record;
    let current = null;
    try {
      record = decisionFor(ledger, findingId, { decision, params, forRule: flags['for-rule'] !== undefined, datasetOnly: flags['dataset-only'] !== undefined, by, note, today: ctx.clock.todayUtc() });
      current = await readCurrent(file);
      if (decision === 'reprocess') {
        const { problems } = registry.resolve(ledger.idsite, ledger.dataset, undefined, [record]);
        if (problems.length > 0) throw new Error(`the patch does not resolve: ${problems.join('; ')}`);
      }
    } catch (err) {
      return { ok: false, errors: [message(err)], exitCode: 1 };
    }
    const next = withDecision(current, ledger.idsite, record);
    checkDecisions(next, file);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(next, null, 2)}\n`);
    const what = record.applies === 'rule' ? `every finding of ${record.rule}` : decision === 'reprocess' ? `${record.rule}, screened again with ${JSON.stringify(record.params)}` : `${record.members.length} members of ${findingId}`;
    return { ok: true, output: `${decision}: ${what}${record.dataset ? ` in dataset ${record.dataset}` : ' in every dataset of the site'}; recorded in ${file}. Build again with --shape to apply it.` };
  },
};

async function readCurrent(file) {
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
  return checkDecisions(JSON.parse(raw), file);
}

const message = (err) => (err instanceof Error ? err.message : String(err));
