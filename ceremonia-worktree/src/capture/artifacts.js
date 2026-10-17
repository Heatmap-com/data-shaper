import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { normalizeRenderArtifact, validateRenderArtifact } from '../capture-artifact.js';

/**
 * The capture artifacts the naming bot leaves under `naming.datasetRoot`:
 * names.json, render.<device>.json beside it, and the screenshots they name.
 */

/**
 * dataset/{idsite}/{kind}/{slug}/<fileName> — the bot's own path rule
 * (seedSlugForUrl: last URL path segment, lowercased; root seeds index).
 * The kind directory is bot-side; the slug is unique per site in practice,
 * so the four kinds are probed in turn.
 * @param {{idsite: number, url: string}} job
 * @param {{datasetRoot?: string}} naming
 * @param {string} [fileName] defaults to names.json
 */
export function artifactPath(job, naming, fileName = 'names.json') {
  if (!naming.datasetRoot) return null;
  let pathname;
  try {
    pathname = new URL(job.url).pathname;
  } catch {
    return null;
  }
  const segments = pathname.split('/').filter((s) => s.length > 0);
  const last = segments[segments.length - 1];
  const slug = last ? last.toLowerCase() : 'index';
  for (const kind of ['landing', 'page', 'pdp', 'collection']) {
    const candidate = path.join(naming.datasetRoot, String(job.idsite), kind, slug, fileName);
    if (existsSync(candidate)) return candidate;
  }
  return path.join(naming.datasetRoot, String(job.idsite), 'landing', slug, fileName);
}

/**
 * @param {{idsite: number, url: string}} job
 * @param {{datasetRoot?: string}} naming
 */
export function namesArtifactPath(job, naming) {
  return artifactPath(job, naming, 'names.json');
}

/**
 * The page's harvested names.json, as NameRows.
 * @param {{idsite: number, url: string}} job
 * @param {{datasetRoot?: string}} naming
 * @returns {Promise<Array<object>>}
 */
export async function readNames(job, naming) {
  const artifact = namesArtifactPath(job, naming);
  if (!artifact) {
    throw new Error('no naming command configured and no datasetRoot to read names.json from');
  }
  if (!existsSync(artifact)) {
    throw new Error(`names.json not found at ${artifact}`);
  }
  const rows = JSON.parse(await readFile(artifact, 'utf8'));
  if (!Array.isArray(rows)) {
    throw new Error(`names.json at ${artifact} is not a NameRow array`);
  }
  return rows;
}

/**
 * Reads and validates render.<device>.json for every device class the claimed
 * job asks for ([] means naming-only — the Phase 2 behavior). Files live next
 * to names.json under the same directory rule. A missing or unparseable file,
 * or a validation failure, throws with the device class named so the agent's
 * failCapture names what the bot owed us.
 *
 * @param {{idsite: number, idsitehsr: number, url: string, deviceClasses?: string[]}} job
 * @param {{datasetRoot?: string}} naming
 * @param {Array<{selector: string}>} bindings mapped names, to prove every
 *   bound selector rendered
 * @param {object} logger
 * @returns {Promise<Array<{device: string, artifact: object, dir: string}>>}
 */
export async function harvestRenders(job, naming, bindings, logger) {
  const devices = job.deviceClasses ?? [];
  if (devices.length === 0) return [];
  const namesPath = namesArtifactPath(job, naming);
  if (!namesPath) {
    throw new Error('no datasetRoot to read render artifacts from');
  }
  const dir = path.dirname(namesPath);
  const renders = [];
  for (const device of devices) {
    const renderPath = path.join(dir, `render.${device}.json`);
    if (!existsSync(renderPath)) {
      throw new Error(`render artifact for device "${device}" not found at ${renderPath}`);
    }
    let artifact;
    try {
      artifact = normalizeRenderArtifact(JSON.parse(await readFile(renderPath, 'utf8')));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`render artifact for device "${device}" is not parseable JSON: ${message}`);
    }
    try {
      validateRenderArtifact(artifact, bindings);
    } catch (err) {
      throw new Error(`render artifact for device "${device}": ${err instanceof Error ? err.message : String(err)}`);
    }
    logger.info(
      { idsite: job.idsite, idsitehsr: job.idsitehsr, device, sections: artifact.sections?.length ?? 0, elements: artifact.elements?.length ?? 0 },
      'render artifact harvested',
    );
    renders.push({ device, artifact, dir });
  }
  return renders;
}

/**
 * Q9 default object store: local disk on the capture host. When the artifact
 * names a screenshot that exists next to it, copy it to
 * <datasetRoot>/../captures/<idsite>/<idsitehsr>/<device>.<file> and store
 * that dataset-relative path as screenshot_uri. A missing screenshot file is
 * a note, not a failure — the uri stays ''.
 *
 * @param {object} artifact
 * @param {{device: string, dir: string, job: {idsite: number, idsitehsr: number}, naming: {datasetRoot?: string}}} ctx
 * @param {string[]} notes
 * @returns {Promise<string>}
 */
export async function landScreenshot(artifact, ctx, notes) {
  const screenshot = artifact.screenshot;
  if (typeof screenshot !== 'string' || screenshot.trim() === '') return '';
  const source = path.join(ctx.dir, screenshot);
  if (!existsSync(source)) {
    notes.push(`screenshot "${screenshot}" for device ${ctx.device} not found; screenshot_uri left empty`);
    return '';
  }
  const capturesDir = path.join(
    ctx.naming.datasetRoot ?? ctx.dir,
    '..',
    'captures',
    String(ctx.job.idsite),
    String(ctx.job.idsitehsr),
  );
  await mkdir(capturesDir, { recursive: true });
  const dest = path.join(capturesDir, `${ctx.device}.${path.basename(screenshot)}`);
  await copyFile(source, dest);
  return path.relative(ctx.naming.datasetRoot ?? ctx.dir, dest);
}

/**
 * The capture consumer's view of the artifacts.
 * @typedef {Object} ArtifactLoader
 * @property {typeof readNames} readNames
 * @property {typeof harvestRenders} harvestRenders
 * @property {typeof landScreenshot} landScreenshot
 */

/** @type {ArtifactLoader} */
export const fileArtifacts = Object.freeze({ readNames, harvestRenders, landScreenshot });
