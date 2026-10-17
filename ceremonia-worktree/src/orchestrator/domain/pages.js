/** The page list a job carries. CLI pages win, then the run's source, then its fallback. */
export function resolvePages({ cliPages, runPages, site }) {
  if (cliPages?.length) return cliPages.map((url) => ({ url }));
  const source = runPages?.source ?? 'site';
  if (source === 'site' && site.pages?.include?.length) return site.pages.include.map((page) => ({ ...page }));
  if (source === 'qualifier') return [{ url: site.origin, role: 'home' }];
  if ((runPages?.fallback ?? 'home') === 'home') return [{ url: site.origin, role: 'home' }];
  return [];
}

/** The units one stage runs. `forEach: pages` is one unit per page. */
export function unitsFor(stage, job) {
  if (stage.forEach === 'pages') return job.pages.map((page) => ({ key: page.url, page }));
  return [{ key: 'site' }];
}
