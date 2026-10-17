/**
 * Fill the analysis prompt. The template is provider-neutral. The site
 * block is the files and the names, not a provider's ids.
 *
 * @param {string} template
 * @param {object} site
 * @returns {string}
 */
export function renderPrompt(template, site) {
  const values = {
    SITE: site.slug,
    BRAND: site.brand,
    DOMAIN: site.domain,
    WINDOW: site.window,
    CURRENCY: site.currency,
    ANALYSED_PAGE: site.analysedPage,
    DATA_GUIDE: site.dataGuide,
    PROFILE: site.profilePath,
    ANCHORS: site.anchorsPath,
    NOTES: site.notesPath,
    STYLE_GUIDE: site.styleGuidePath,
    MEDIA_PREFIX: site.mediaPrefix,
    DATA_FILES: site.dataFiles.map((file) => `- \`${file}\``).join('\n'),
    SOURCE_REPORTS: site.reports.map((report) => `- \`${report.sourcePath}\` — ${report.job}`).join('\n'),
    OUTPUTS: site.reports.map((report) => `- \`${report.outputPath}\` — ${report.job}`).join('\n'),
  };
  const missing = [];
  const rendered = template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_, key) => {
    if (values[key] == null || values[key] === '') missing.push(key);
    return values[key] ?? '';
  });
  if (missing.length) throw new Error(`prompt is missing ${missing.join(', ')}`);
  return rendered;
}
