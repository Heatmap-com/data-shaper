import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { splitCommand, substitute } from './capture/bot-runner.js';

/**
 * The saliency worker (data-capture-plan.md §9.3 Phase 4 task 4; decision
 * D-08). Ships DISABLED behind AE_ENABLE_SALIENCY until the model and
 * licence question (Q8) is resolved: with the flag unset the worker logs one
 * line and returns, and M04 stays `missing` with detail `model_not_selected`.
 *
 * When enabled, the worker sweeps ae_page_capture_current once (the shipped
 * mode; `--once` on the CLI) and exits:
 *
 *   1. Sites: AE_SALIENCY_SITES (comma list) when set, otherwise the distinct
 *      idsites in ae_page_render_current, discovered through the gateway
 *      under a `fleet:` label (the sanctioned fleet-scan exception) with a
 *      LIMIT. Every other query carries {idsite} — one site per query — and
 *      the pages/nodes/render reads additionally scope by idsitehsr.
 *   2. Pages per site: has_render = 1 AND has_saliency = 0 AND
 *      status = 'complete'.
 *   3. Per page: read ae_page_render_current (screenshot_uri per device) and
 *      ae_render_node_current, run the model command once per device
 *      screenshot, parse its stdout, then rewrite the ae_render_node rows
 *      and flip has_saliency via persistence.writeSaliency — one call per
 *      device, made only after EVERY device screenshot of the page
 *      succeeded, so the mark-done is never premature on multi-device pages.
 *
 * Model command contract (env AE_SALIENCY_COMMAND): a template using the
 * placeholders {screenshot} {device} {idsite} {idsitehsr}, split into the
 * executable and its arguments with the same minimal shell-word semantics as
 * the capture consumer's bot runner (substitute/splitCommand from
 * src/capture/bot-runner.js). The command must print
 * ONE JSON object to stdout mapping the page's ae_render_node.node_id values
 * to their predictions, e.g.:
 *
 *   { "s1": { "share": 0.62, "quartile": 3 }, "el:7": { "share": 0.11, "quartile": 1 } }
 *
 *   - share:     number in [0, 1] — the node's share of total predicted
 *                saliency on that device screenshot (model-computed).
 *   - quartile:  integer 1..4 — the node's within-page/within-viewport
 *                quartile (model-computed).
 *
 * A malformed entry fails the whole page: the page is logged as skipped and
 * has_saliency stays 0. Nodes the model omits keep NULL saliency.
 *
 * The model id written to ae_render_node.saliency_model is AE_SALIENCY_MODEL
 * when set, otherwise the command's executable (first template word).
 * Screenshots live on local disk on the capture host (D-08, Q9 default);
 * screenshot_uri is used as the path, absolute or relative to the worker's
 * cwd. Pre-cutover clusters without the ae_ tables surface UNKNOWN_TABLE
 * from the gateway: the worker logs once and returns quietly. Per-page
 * failures (missing screenshot, non-zero model exit, unparsable output) are
 * logged with the reason and the sweep continues.
 */

// Same default budget as the capture consumer's bot runner.
const SALIENCY_TIMEOUT_MS = 600_000;

// Bound on the fleet-wide site-discovery scan when AE_SALIENCY_SITES is unset.
const SITE_DISCOVERY_LIMIT = 100;

const pendingCapturesSql = (database) => `
  SELECT idsite, idsitehsr
    FROM ${database}.ae_page_capture_current
   WHERE idsite = {idsite:UInt32}
     AND has_render = 1
     AND has_saliency = 0
     AND status = 'complete'
   ORDER BY idsitehsr`;

const renderSql = (database) => `
  SELECT device_class, screenshot_uri
    FROM ${database}.ae_page_render_current
   WHERE idsite = {idsite:UInt32}
     AND idsitehsr = {idsitehsr:UInt64}
   ORDER BY device_class`;

const nodeSql = (database) => `
  SELECT device_class, node_id
    FROM ${database}.ae_render_node_current
   WHERE idsite = {idsite:UInt32}
     AND idsitehsr = {idsitehsr:UInt64}`;

const sitesSql = (database) => `
  SELECT DISTINCT idsite
    FROM ${database}.ae_page_render_current
   LIMIT {limit:UInt16}`;

/**
 * @param {unknown} err
 */
function isUnknownTable(err) {
  return (
    Boolean(err) &&
    typeof err === 'object' &&
    /** @type {{type?: string, message?: string}} */ (err).type === 'UNKNOWN_TABLE'
  ) || /UNKNOWN_TABLE|Unknown table/i.test(String(/** @type {Error} */ (err)?.message ?? err));
}

/**
 * @param {string} template AE_SALIENCY_COMMAND after env substitution
 * @param {{screenshot: string, device: string, idsite: string, idsitehsr: string}} values
 * @returns {Promise<string>} model stdout
 */
function runModelCommand(template, values) {
  const substituted = substitute(template, values);
  const [cmd, ...args] = splitCommand(substituted);
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: SALIENCY_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const tail = String(stderr ?? '')
          .trim()
          .split('\n')
          .slice(-5)
          .join(' | ');
        reject(new Error(`model command failed (${cmd}): ${err.message}; ${tail}`));
        return;
      }
      resolve(String(stdout ?? ''));
    });
  });
}

/**
 * Parses the model's stdout into AeSaliencyNode rows. Throws (page skipped)
 * on non-JSON, a non-object payload, an invalid entry, or an empty map.
 *
 * @param {string} stdout
 * @param {string} device
 * @returns {Array<{node_id: string, saliency_share: number, saliency_quartile: number}>}
 */
function parseModelMap(stdout, device) {
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`model output for ${device} is not JSON`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`model output for ${device} is not a node map`);
  }
  const nodes = [];
  for (const [nodeId, value] of Object.entries(/** @type {Record<string, unknown>} */ (parsed))) {
    const share = Number(value?.share);
    const quartile = Number(value?.quartile);
    if (!Number.isFinite(share) || share < 0 || share > 1) {
      throw new Error(`model output for ${device}: node ${nodeId} has an invalid share`);
    }
    if (!Number.isInteger(quartile) || quartile < 1 || quartile > 4) {
      throw new Error(`model output for ${device}: node ${nodeId} has an invalid quartile`);
    }
    nodes.push({ node_id: nodeId, saliency_share: share, saliency_quartile: quartile });
  }
  if (nodes.length === 0) {
    throw new Error(`model output for ${device} is empty`);
  }
  return nodes;
}

/**
 * What the worker runs, built in composition from AE_ENABLE_SALIENCY,
 * AE_SALIENCY_COMMAND, AE_SALIENCY_MODEL, and AE_SALIENCY_SITES.
 *
 * @typedef {Object} SaliencyConfig
 * @property {boolean} enabled
 * @property {string} command the model command template; empty when unset
 * @property {string} model the model name recorded on each node; empty means the command's executable
 * @property {number[]} sites the sites to sweep; empty means discover them
 */

/**
 * @param {object} opts
 * @param {import('./ports/persistence/capture-store.js').CaptureStore} opts.persistence
 * @param {import('./ports/query-gateway.js').QueryGateway} opts.gateway
 * @param {SaliencyConfig} opts.saliency
 * @param {object} opts.logger
 * @param {string} opts.database the database the ae_* tables live in
 */
export async function runSaliencyWorker({ persistence, gateway, saliency, logger, database }) {
  if (!saliency.enabled) {
    logger.info('saliency worker disabled: AE_ENABLE_SALIENCY is not 1 (ships off until Q8 resolves; M04 stays model_not_selected)');
    return;
  }
  const template = saliency.command;
  if (!template) {
    logger.warn('saliency worker enabled but AE_SALIENCY_COMMAND is empty; nothing to run');
    return;
  }
  const model = saliency.model || splitCommand(template)[0];
  const reasonOf = (err) => (err instanceof Error ? err.message : String(err));

  /** @type {number[]} */
  let sites = [...saliency.sites];
  if (sites.length === 0) {
    try {
      const rows = await gateway.query(sitesSql(database), { limit: SITE_DISCOVERY_LIMIT }, 'fleet:saliency-sites');
      sites = rows.map((r) => Number(r.idsite));
    } catch (err) {
      if (isUnknownTable(err)) {
        logger.warn('saliency tables not present yet (pre-cutover); saliency worker exiting');
        return;
      }
      throw err;
    }
  }
  logger.info({ model, sites: sites.length }, 'saliency worker started');

  let done = 0;
  let skipped = 0;

  for (const idsite of sites) {
    /** @type {object[]} */
    let pages;
    try {
      pages = await gateway.query(pendingCapturesSql(database), { idsite }, 'saliency:pending-captures');
    } catch (err) {
      if (isUnknownTable(err)) {
        logger.warn('saliency tables not present yet (pre-cutover); saliency worker exiting');
        return;
      }
      throw err;
    }

    for (const page of pages) {
      const key = { idsite: Number(page.idsite), idsitehsr: Number(page.idsitehsr) };
      try {
        await processPage(key, model);
        done += 1;
      } catch (err) {
        if (isUnknownTable(err)) {
          logger.warn('saliency tables not present yet (pre-cutover); saliency worker exiting');
          return;
        }
        skipped += 1;
        logger.warn({ idsite: key.idsite, idsitehsr: key.idsitehsr, reason: reasonOf(err) }, 'saliency page skipped');
      }
    }
  }

  logger.info({ sites: sites.length, done, skipped }, 'saliency worker drained');

  /**
   * Runs the model for every device of one page and, only when all devices
   * succeeded, rewrites the node rows and marks the capture done.
   *
   * @param {{idsite: number, idsitehsr: number}} key
   * @param {string} model
   */
  async function processPage(key, model) {
    const renders = await gateway.query(renderSql(database), key, 'saliency:renders');
    const nodes = await gateway.query(nodeSql(database), key, 'saliency:render-nodes');
    if (renders.length === 0) throw new Error('page has has_render = 1 but no ae_page_render rows');
    if (nodes.length === 0) throw new Error('page has no ae_render_node rows');

    const started = Date.now();
    /** @type {Array<{device_class: string, nodes: Array<{node_id: string, saliency_share: number, saliency_quartile: number}>}>} */
    const results = [];
    for (const render of renders) {
      const device = String(render.device_class ?? '');
      const screenshot = String(render.screenshot_uri ?? '');
      if (!screenshot) throw new Error(`no screenshot_uri for device ${device || '?'}`);
      if (!existsSync(screenshot)) throw new Error(`screenshot not found: ${screenshot}`);
      const stdout = await runModelCommand(template, {
        screenshot,
        device,
        idsite: String(key.idsite),
        idsitehsr: String(key.idsitehsr),
      });
      results.push({ device_class: device, nodes: parseModelMap(stdout, device) });
    }

    let nodesWritten = 0;
    for (const result of results) {
      const written = await persistence.writeSaliency({
        idsite: key.idsite,
        idsitehsr: key.idsitehsr,
        device_class: result.device_class,
        nodes: result.nodes,
        model,
      });
      nodesWritten += written.length;
    }
    logger.info(
      {
        idsite: key.idsite,
        idsitehsr: key.idsitehsr,
        devices: results.length,
        nodes: nodesWritten,
        seconds: Number(((Date.now() - started) / 1000).toFixed(2)),
      },
      'saliency complete',
    );
  }
}
