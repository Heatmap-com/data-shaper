import { stat } from 'node:fs/promises';

/**
 * Every templated path exists and holds at least minBytes (default 1). With
 * `newerThan`, each file is also at least as new as every path listed there,
 * so an output built from older inputs counts as missing.
 */
export const adapter = {
  id: 'files-exist',
  describe(ctx, spec) {
    const size = spec.minBytes ? ` with at least ${spec.minBytes} bytes` : '';
    const newer = spec.newerThan?.length ? `, each newer than ${spec.newerThan.map((entry) => ctx.render(entry)).join(', ')}` : '';
    return `these files exist${size}${newer}: ${(spec.paths ?? []).map((entry) => ctx.render(entry)).join(', ')}`;
  },
  async evaluate(ctx, spec) {
    const minBytes = spec.minBytes ?? 1;
    const inputs = [];
    for (const entry of spec.newerThan ?? []) {
      const file = ctx.render(entry);
      const info = await stat(file).catch(() => null);
      if (info) inputs.push({ file, mtimeMs: info.mtimeMs });
    }
    const details = [];
    for (const entry of spec.paths ?? []) {
      const file = ctx.render(entry);
      try {
        const info = await stat(file);
        const older = inputs.find((input) => input.mtimeMs > info.mtimeMs);
        const ok = info.size >= minBytes && !older;
        details.push({ name: file, ok, message: older ? `older than ${older.file}` : `${info.size} byte(s)` });
      } catch (err) {
        details.push({ name: file, ok: false, message: err.code ?? 'missing' });
      }
    }
    const ok = details.every((row) => row.ok);
    const missing = details.filter((row) => !row.ok).map((row) => row.name);
    return {
      ok,
      summary: ok ? `${details.length} file(s) present` : `missing, too small, or stale: ${missing.join(', ')}`,
      details,
    };
  },
};
