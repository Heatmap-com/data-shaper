/**
 * Dataset roles come from the descriptor. A `card` dataset writes strategy
 * cards for its `catalogId`; the `requirements` dataset reads every other
 * dataset's readiness and runs again once the site datasets exist.
 *
 * @typedef {{id: string, scope?: string, descriptor?: {role?: string, catalogId?: string}}} RoledDataset
 */

/** @param {RoledDataset} dataset */
export const isCard = (dataset) => dataset.descriptor?.role === 'card';

/** @param {RoledDataset} dataset */
export const isRequirements = (dataset) => dataset.descriptor?.role === 'requirements';

/**
 * @param {RoledDataset} dataset
 * @returns {string}
 */
export function catalogIdOf(dataset) {
  const catalogId = dataset.descriptor?.catalogId;
  if (!catalogId) throw new Error(`card dataset "${dataset.id}" has no catalogId in its descriptor`);
  return catalogId;
}

/** @param {RoledDataset} dataset */
export const isSubjectScoped = (dataset) => dataset.scope === 'subject';

/**
 * Page, site, and subject datasets in discovery order, the card datasets,
 * and the requirements dataset. Adapters without an explicit scope are
 * page-scope; `scope: 'subject'` adapters run once per selected subject
 * other than a page.
 * @template {RoledDataset} T
 * @param {T[]} datasets
 */
export function datasetGroups(datasets) {
  const readers = datasets.filter((d) => !isCard(d));
  const cards = datasets.filter(isCard);
  const pageScoped = (d) => d.scope !== 'site' && !isSubjectScoped(d);
  return {
    page: readers.filter(pageScoped),
    site: readers.filter((d) => d.scope === 'site'),
    subject: readers.filter(isSubjectScoped),
    siteCards: cards.filter((d) => d.scope === 'site'),
    pageCards: cards.filter(pageScoped),
    subjectCards: cards.filter(isSubjectScoped),
    requirements: datasets.find(isRequirements) ?? null,
  };
}

/**
 * The datasets a profile runs, in discovery order: its included ids (or
 * every dataset, for `["provides"]`) less the excluded ones, with only the
 * card datasets of its catalogs and only the subject datasets of its
 * subject type. A kept dataset whose dependency is gone fails, naming both.
 * @template {RoledDataset & {dependsOn?: string[], subjectTypes?: string[]}} T
 * @param {{id: string, subjectType?: string, datasets: {include: string[], exclude: string[]}, catalogs: string[] | 'all'}} profile
 * @param {T[]} datasets topologically sorted
 * @returns {T[]}
 */
export function profileDatasets(profile, datasets) {
  const { include, exclude } = profile.datasets;
  const known = new Set(datasets.map((d) => d.id));
  const unknown = [...include.filter((id) => id !== 'provides'), ...exclude].filter((id) => !known.has(id));
  if (unknown.length > 0) throw new Error(`profile "${profile.id}" names unknown datasets: ${unknown.join(', ')}`);
  const wanted = include.includes('provides') ? known : new Set(include);
  const kept = datasets.filter((d) => wanted.has(d.id)
    && !exclude.includes(d.id)
    && (!isCard(d) || profile.catalogs === 'all' || profile.catalogs.includes(catalogIdOf(d)))
    && (!isSubjectScoped(d) || (d.subjectTypes ?? []).includes(profile.subjectType)));
  const keptIds = new Set(kept.map((d) => d.id));
  const missing = kept.flatMap((d) => (d.dependsOn ?? []).filter((dep) => !keptIds.has(dep)).map((dep) => `${d.id} needs ${dep}`));
  if (missing.length > 0) throw new Error(`profile "${profile.id}" leaves out a dependency: ${missing.join(', ')}`);
  return kept;
}
