import { mapNameRows } from './naming-mapper.js';
import { summarizeArtifact } from './capture-artifact.js';
import { fileArtifacts } from './capture/artifacts.js';

/**
 * The capture consumer (CAPTURE-BEFORE-ANALYSIS.md, plan §9.3). N agents poll
 * ae_capture_queue, claim rows token-exclusively, run the naming bot as an
 * external command, read the harvested names.json, map the rows onto the
 * taxonomy, then — when the claimed job names device classes — read and
 * validate render.<device>.json next to names.json, land the screenshots per
 * the Q9 default, and call completeCapture with the render payloads. The same
 * port the analysis runner's capture gate waits on. The engine never imports
 * the bot; saliency stays a separate worker until the plan's Q8 is resolved.
 * Running the bot is the HarvestPort's job (src/capture/harvester.js), and
 * the artifact files are src/capture/artifacts.js.
 */

/**
 * @param {object} opts
 * @param {import('./ports/persistence/capture-store.js').CaptureStore} opts.persistence
 * @param {import('./config.js')} opts.config
 * @param {object} opts.logger
 * @param {import('./ports/dataset.js').Clock} opts.clock
 * @param {number} [opts.agentCount] overrides config.agents.naming
 * @param {import('./ports/harvest.js').HarvestPort} opts.harvester runs the bot and reads names.json
 * @param {import('./capture/artifacts.js').ArtifactLoader} [opts.artifacts] render artifacts and screenshots
 */
export async function runCaptureAgents({ persistence, config, logger, clock, agentCount, harvester, artifacts = fileArtifacts }) {
  const count = Math.max(1, Number(agentCount ?? config.agents?.naming ?? 1));
  logger.info({ agents: count }, 'capture consumer started');

  async function agent(agentIndex) {
    for (;;) {
      const job = await persistence.claimCapture();
      if (!job) return;
      const started = Date.now();
      logger.info({ agent: agentIndex, idsite: job.idsite, idsitehsr: job.idsitehsr, url: job.url }, 'capture claimed');
      try {
        const rows = await harvester.harvestNames(job, config.naming, logger);
        const names = mapNameRows(rows, { pageUrl: job.url });
        const renders = await artifacts.harvestRenders(job, config.naming, names, logger);
        const notes = [];
        const renderPayloads = [];
        const devices = [];
        let sectionsFound = 0;
        const renderedSelectors = new Set();
        for (const { device, artifact, dir } of renders) {
          devices.push(device);
          const summary = summarizeArtifact(artifact);
          sectionsFound += summary.sections_found;
          for (const selector of summary.selectors) renderedSelectors.add(selector);
          const screenshotUri = await artifacts.landScreenshot(artifact, { device, dir, job, naming: config.naming }, notes);
          renderPayloads.push({
            device_class: device,
            viewport_w: artifact.viewport.w,
            viewport_h: artifact.viewport.h,
            page_height_px: artifact.page_height_px,
            fold_px: artifact.fold_px,
            screenshot_uri: screenshotUri,
            content_hash: artifact.content_hash,
            dom_hash: artifact.dom_hash,
            rendered_at: artifact.rendered_at,
            renderer_version: artifact.renderer_version,
            sections: artifact.sections ?? [],
            elements: artifact.elements ?? [],
          });
        }
        for (const note of notes) {
          logger.info({ agent: agentIndex, idsite: job.idsite, idsitehsr: job.idsitehsr }, note);
        }
        await persistence.completeCapture({
          idsite: job.idsite,
          idsitehsr: job.idsitehsr,
          url: job.url,
          capturedOn: clock.todayUtc(),
          coverage: {
            named_selectors: names.length,
            devices,
            elements_bound: names.filter((n) => renderedSelectors.has(n.selector)).length,
            sections_found: sectionsFound,
          },
          hasRender: renderPayloads.length > 0,
          bindings: names.map((n) => ({ selector: n.selector, element_class: n.element_class, name: n.name })),
          renders: renderPayloads,
        });
        logger.info(
          {
            agent: agentIndex,
            idsite: job.idsite,
            idsitehsr: job.idsitehsr,
            harvested: rows.length,
            named: names.length,
            devices,
            seconds: (Date.now() - started) / 1000,
          },
          'capture complete',
        );
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        logger.error({ agent: agentIndex, idsite: job.idsite, idsitehsr: job.idsitehsr, err }, 'capture failed');
        await persistence.failCapture({ idsite: job.idsite, idsitehsr: job.idsitehsr, reason });
      }
    }
  }

  await Promise.all(Array.from({ length: count }, (_, i) => agent(i)));
  logger.info({ agents: count }, 'capture consumer drained');
}
