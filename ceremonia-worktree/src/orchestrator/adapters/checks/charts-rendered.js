import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { declaredCharts } from '../../domain/charts.js';

const MANIFEST = 'charts.json';

/**
 * Every chart the run declares is drawn into `media`, or listed in
 * `<media>/charts.json` as skipped with a reason, and the drawing is at least
 * as new as the bundle profile it came from.
 *
 * spec: { use: 'charts-rendered', media: '<dir>', bundle: '<full bundle dir>' }
 */
export const adapter = {
  id: 'charts-rendered',
  validate(spec) {
    return ['media', 'bundle'].filter((key) => typeof spec[key] !== 'string' || !spec[key]).map((key) => `needs ${key}`);
  },
  describe(ctx, spec) {
    const media = ctx.render(spec.media);
    const files = declaredCharts(ctx.job.run).map((chart) => chart.file);
    return `each declared chart is drawn into ${media} or listed as skipped, with its reason, in ${path.join(media, MANIFEST)}, and both are newer than ${path.join(ctx.render(spec.bundle), '00_site_profile.json')}: ${files.join(', ') || 'none declared'}`;
  },
  async evaluate(ctx, spec) {
    const charts = declaredCharts(ctx.job.run);
    if (!charts.length) return { ok: true, summary: 'this run declares no charts', details: [] };
    const media = ctx.render(spec.media);
    const profile = path.join(ctx.render(spec.bundle), '00_site_profile.json');
    const bundleTime = (await stat(profile).catch(() => null))?.mtimeMs;
    if (bundleTime === undefined) return fail(`no bundle profile at ${profile}; charts are drawn from the full bundle`);
    const manifestFile = path.join(media, MANIFEST);
    const manifestInfo = await stat(manifestFile).catch(() => null);
    if (!manifestInfo) return fail(`no chart manifest at ${manifestFile}`);
    if (manifestInfo.mtimeMs < bundleTime) return fail(`${manifestFile} is older than the bundle profile`);
    let entries;
    try {
      entries = new Map(JSON.parse(await readFile(manifestFile, 'utf8')).charts.map((entry) => [entry.file, entry]));
    } catch (err) {
      return fail(`${manifestFile} is not a chart manifest: ${err.message}`);
    }

    const details = [];
    for (const chart of charts) {
      const entry = entries.get(chart.file);
      if (!entry) {
        details.push({ name: chart.file, ok: false, message: 'not in the manifest' });
      } else if (entry.status === 'skipped') {
        details.push({ name: chart.file, ok: Boolean(entry.reason), message: entry.reason ? `skipped: ${entry.reason}` : 'skipped without a reason' });
      } else {
        const info = await stat(path.join(media, chart.file)).catch(() => null);
        const ok = Boolean(info && info.size > 0 && info.mtimeMs >= bundleTime);
        details.push({ name: chart.file, ok, message: !info ? 'missing' : ok ? `${info.size} byte(s)` : 'older than the bundle profile' });
      }
    }
    const bad = details.filter((row) => !row.ok);
    const skipped = details.filter((row) => row.ok && row.message.startsWith('skipped'));
    return {
      ok: bad.length === 0,
      summary: bad.length ? `charts not drawn: ${bad.map((row) => `${row.name} (${row.message})`).join(', ')}` : `${details.length - skipped.length} chart(s) drawn, ${skipped.length} skipped`,
      details,
    };
  },
};

function fail(summary) {
  return { ok: false, summary, details: [{ name: 'charts', ok: false, message: summary }] };
}
