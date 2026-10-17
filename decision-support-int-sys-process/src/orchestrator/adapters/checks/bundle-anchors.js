import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { evaluateAnchors } from '../../domain/bundle-anchors.js';

/**
 * The bundle folder's profile window and anchors hold against its orders
 * file. With page "focus", the analysed page must also match site.json.
 */
export const adapter = {
  id: 'bundle-anchors',
  describe(ctx, spec) {
    return `anchors in ${ctx.render(spec.bundle)} hold for ${ctx.values.window.start} to ${ctx.values.window.end}`;
  },
  validate(spec) {
    return spec.bundle ? [] : ['bundle-anchors needs bundle'];
  },
  async evaluate(ctx, spec) {
    const dir = ctx.render(spec.bundle);
    const window = ctx.values.window;
    let profileText;
    let csvText;
    try {
      profileText = await readFile(path.join(dir, '00_site_profile.json'), 'utf8');
      csvText = await readFile(path.join(dir, '01_orders.csv'), 'utf8');
    } catch (err) {
      return { ok: false, summary: `missing bundle files in ${dir}`, details: [{ name: dir, ok: false, message: err.code ?? 'missing' }] };
    }
    const profile = JSON.parse(profileText);
    const result = evaluateAnchors(profile, csvText, window);
    if (spec.page === 'focus') {
      let focus = null;
      if (spec.site) {
        try {
          const site = JSON.parse(await readFile(ctx.render(spec.site), 'utf8'));
          focus = site.focus;
        } catch {
          focus = null;
        }
      }
      const page = profile.analysed_page;
      const same = Boolean(focus?.path) && page?.path === focus.path && Number(page?.idsitehsr) === focus.idsitehsr;
      result.details.push({
        name: 'analysed_page',
        ok: same,
        message: same ? page.path : `profile page ${page?.path} (${page?.idsitehsr})`,
      });
      if (!same) {
        result.ok = false;
        result.summary = 'anchor mismatch: analysed page';
      }
    }
    return result;
  },
};
