import { experimentReadoutRows, lifecycleRow, readExperiments, scanExperiments } from '../_lib/experiment-scan.js';

/**
 * experiment-analysis: every partner experiment seen on the site in the
 * last SCAN_DAYS, normalized and dated, with a readout for the ones that
 * are running or ended within RECENT_DAYS.
 *
 * Writes ae_experiment_descriptor (one `observed` row per experiment: the
 * inferred descriptor merged with the operator's) and ae_experiment_row
 * (daily rows per experiment, arm, basis, page, rollup section, selector,
 * viewport, and segment). Returns one `lifecycle` row per experiment and,
 * per analyzed experiment, readout rows per (arm, basis), per arm for the
 * section capture, per (section, arm), and per (element, arm).
 *
 * Sections and elements are read on the experiment's pages: the operator's
 * pages, else the tag surface's pages, else every page. Operator zones and
 * elements are always kept; the busiest others fill up to the caps.
 */

export const MAX_EXPERIMENTS = 25;

export const adapter = {
  id: 'experiment-analysis',
  dependsOn: [],
  scope: 'site',
  provides: [],

  /**
   * @param {{idsite: number, siteName?: string}} page
   * @param {import('../../ports/dataset.js').RunContext} ctx
   */
  async collect(page, ctx) {
    const scan = await scanExperiments(ctx, page.idsite);
    if (scan.stopped) return { id: adapter.id, rows: [], notes: scan.notes };
    const { experiments } = scan;
    const notes = { ...scan.notes };

    const analyzable = experiments.filter((e) => e.analyzable).sort((a, b) => b.visits - a.visits);
    if (analyzable.length > MAX_EXPERIMENTS) {
      notes.experiment_analysis_capped = `analyzed the ${MAX_EXPERIMENTS} largest of ${analyzable.length}`;
    }
    const { plans, analyzed, factRows, rowsByExperiment, notes: readNotes } = await readExperiments(
      ctx,
      page.idsite,
      scan,
      analyzable.slice(0, MAX_EXPERIMENTS),
    );
    Object.assign(notes, readNotes);

    const rows = [
      ...experiments.map((exp) => lifecycleRow(exp, analyzed.has(exp.key))),
      ...plans.flatMap((p) => experimentReadoutRows(p, rowsByExperiment.get(p.exp.key) ?? [])),
    ];

    notes.experiments_detected = experiments.length;
    notes.experiments_running = experiments.filter((e) => e.kind === 'experiment' && e.status === 'running').length;
    notes.experiments_recent = experiments.filter((e) => e.kind === 'experiment' && e.status === 'recent').length;
    notes.experiments_analyzed = plans.length;
    notes.experiment_rows = factRows.length;
    notes.experiment_section_rows = factRows.filter((r) => r.metrics.row_kind === 'section').length;
    notes.experiment_element_rows = factRows.filter((r) => r.metrics.row_kind === 'element').length;
    notes.experiments_in_flight = experiments
      .filter((e) => analyzed.has(e.key))
      .map((e) => ({ key: e.key, name: e.name, status: e.status, start: e.lifecycle.observedStart, end: e.lifecycle.observedEnd, scope: e.scope }));
    return { id: adapter.id, rows, notes };
  },
};
