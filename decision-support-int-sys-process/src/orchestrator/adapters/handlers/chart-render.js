import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { declaredCharts } from '../../domain/charts.js';
import { adapter as command } from './command.js';

/**
 * Draws every chart the job's run declares. The chart specs go to
 * `<run dir>/charts.json`, and the command in the stage's handler spec runs
 * with `--specs <that file>` appended, so the renderer and its arguments stay
 * in the descriptor.
 *
 * @type {import('../../ports/stage-handler.js').StageHandler}
 */
export const adapter = {
  id: 'chart-render',
  async run(ctx, spec) {
    const charts = declaredCharts(ctx.job.run);
    if (!charts.length) return { status: 'ok', message: 'this run declares no charts' };
    const specsFile = path.join(ctx.runDir, 'charts.json');
    await writeFile(specsFile, `${JSON.stringify({ charts }, null, 2)}\n`);
    return command.run(ctx, { ...spec, args: [...(spec.args ?? []), '--specs', specsFile] });
  },
};
