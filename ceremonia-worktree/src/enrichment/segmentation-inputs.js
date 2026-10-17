import { resolveDefinitions } from '../triggers/definitions.js';
import { overridesFrom } from '../triggers/load.js';

export const DEFAULT_LOOKBACK_DAYS = 30;

/**
 * The inputs the selected computed segmentations read, gathered once per
 * run. A selection of declared segmentations reads none, so it makes no
 * store call.
 * @param {ReadonlyArray<import('../ports/segmentation.js').Segmentation>} segmentations
 * @param {{idsite: number, lookbackDays?: number, persistence: object}} run
 * @returns {Promise<import('../ports/segmentation.js').RunInputs>}
 */
export async function runInputs(segmentations, run) {
  const wanted = new Set(segmentations.flatMap((seg) => seg.inputs));
  /** @type {import('../ports/segmentation.js').RunInputs} */
  const inputs = {};
  if (wanted.has('lookbackDays')) inputs.lookbackDays = run.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;
  if (wanted.has('interest')) inputs.interest = await interestPredicate(run.persistence, run.idsite);
  return inputs;
}

/**
 * The showed-interest thresholds in force for the site, so high intent on a
 * previous visit means what the trigger chains mean by it.
 * @param {import('../ports/persistence/trigger-store.js').TriggerStore} persistence
 * @param {number} idsite
 */
export async function interestPredicate(persistence, idsite) {
  const recorded = typeof persistence.readTriggerDefinitions === 'function'
    ? await persistence.readTriggerDefinitions(idsite)
    : [];
  const definitions = resolveDefinitions(overridesFrom(recorded), recorded);
  const found = definitions.find((row) => row.predicate?.type === 'session_interest');
  if (!found) throw new Error('no session_interest trigger definition');
  return found.predicate;
}
