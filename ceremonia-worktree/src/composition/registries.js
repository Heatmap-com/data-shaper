import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { siteSegmentationSpec } from '../application/segmentation/site-spec.js';
import { profilesById } from '../domain/profile.js';

const repoOrchestration = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'orchestration');

/** The orchestration directory: ORCHESTRATION_ROOT, else the repo's. */
export function orchestrationRoot(env) {
  return env.ORCHESTRATION_ROOT || repoOrchestration;
}

/**
 * The audit brand registry, `registries/brands.json`.
 * @param {string} root
 * @returns {Promise<import('../audit/brands.js').BrandEntry[]>}
 */
export async function loadBrands(root) {
  const doc = JSON.parse(await readFile(path.join(root, 'registries', 'brands.json'), 'utf8'));
  return doc.brands ?? [];
}

/**
 * Every site's trend selector seeds, `sites/<slug>/trend-seeds.json`. Each
 * row names its idsite, so a site without a seed file contributes nothing.
 * @param {string} root
 * @returns {Promise<import('../ports/persistence.js').AeTrendSelectorRow[]>}
 */
export async function loadTrendSeeds(root) {
  let dirs;
  try {
    dirs = await readdir(path.join(root, 'sites'), { withFileTypes: true });
  } catch (err) {
    if (err?.code === 'ENOENT') return [];
    throw err;
  }
  const seeds = [];
  for (const dir of dirs.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()) {
    let raw;
    try {
      raw = await readFile(path.join(root, 'sites', dir, 'trend-seeds.json'), 'utf8');
    } catch (err) {
      if (err?.code === 'ENOENT') continue;
      throw err;
    }
    seeds.push(...(JSON.parse(raw).selectors ?? []));
  }
  return seeds;
}

/**
 * Every site's segmentation file, `sites/<slug>/segmentations.json`: its
 * default selection per grain, its overrides of shipped declarations, and
 * its own declarations. The registry checks what they say; this checks the
 * shape and that no two files name one idsite.
 * @param {string} root
 * @returns {Promise<import('../ports/segmentation.js').SiteSegmentationSpec[]>}
 */
export async function loadSegmentationSpecs(root) {
  let dirs;
  try {
    dirs = await readdir(path.join(root, 'sites'), { withFileTypes: true });
  } catch (err) {
    if (err?.code === 'ENOENT') return [];
    throw err;
  }
  const specs = [];
  const slugs = new Map();
  for (const slug of dirs.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()) {
    const where = `sites/${slug}/segmentations.json`;
    let raw;
    try {
      raw = await readFile(path.join(root, 'sites', slug, 'segmentations.json'), 'utf8');
    } catch (err) {
      if (err?.code === 'ENOENT') continue;
      throw err;
    }
    let doc;
    try {
      doc = JSON.parse(raw);
    } catch (err) {
      throw new Error(`${where}: ${err instanceof Error ? err.message : String(err)}`);
    }
    const spec = siteSegmentationSpec(doc, slug, where);
    if (slugs.has(spec.idsite)) throw new Error(`idsite ${spec.idsite} has two segmentation files: sites/${slugs.get(spec.idsite)} and sites/${slug}`);
    slugs.set(spec.idsite, slug);
    specs.push(spec);
  }
  return specs;
}

/**
 * Every site's `sites/<slug>/<name>`, parsed: the slug, the site's folder,
 * where the file is (for messages), and its document. Sites without the
 * file are skipped.
 * @param {string} root
 * @param {string} name
 * @returns {Promise<Array<{slug: string, dir: string, where: string, doc: object}>>}
 */
export async function loadSiteFiles(root, name) {
  let dirs;
  try {
    dirs = await readdir(path.join(root, 'sites'), { withFileTypes: true });
  } catch (err) {
    if (err?.code === 'ENOENT') return [];
    throw err;
  }
  const files = [];
  for (const slug of dirs.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()) {
    const dir = path.join(root, 'sites', slug);
    const where = `sites/${slug}/${name}`;
    let raw;
    try {
      raw = await readFile(path.join(dir, name), 'utf8');
    } catch (err) {
      if (err?.code === 'ENOENT') continue;
      throw err;
    }
    try {
      files.push({ slug, dir, where, doc: JSON.parse(raw) });
    } catch (err) {
      throw new Error(`${where}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return files;
}

/**
 * The execution profiles, `<dir>/*.profile.json`, checked and frozen.
 * @param {string} dir
 * @param {string[]} catalogIds the loaded catalog ids
 * @returns {Promise<Map<string, Readonly<import('../domain/profile.js').Profile>>>}
 */
export async function loadProfiles(dir, catalogIds) {
  const files = (await readdir(dir)).filter((name) => name.endsWith('.profile.json')).sort();
  const documents = [];
  for (const name of files) {
    const file = path.join(dir, name);
    let raw;
    try {
      raw = JSON.parse(await readFile(file, 'utf8'));
    } catch (err) {
      throw new Error(`${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
    documents.push({ file, raw });
  }
  return profilesById(documents, catalogIds);
}
