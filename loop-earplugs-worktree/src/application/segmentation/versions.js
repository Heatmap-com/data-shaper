import { resolveSegmentationVersions } from '../../domain/segmentation/index.js';

/**
 * The versions of a run's segmentations against what the site has
 * recorded, and the definition rows the run writes once its rows are
 * stored. A store without the segmentation role versions nothing.
 * @param {ReadonlyArray<import('../../ports/segmentation.js').Segmentation>} segmentations
 * @param {import('../../ports/segmentation.js').RunInputs} inputs
 * @param {{idsite: number, persistence: object}} run
 */
export async function runVersions(segmentations, inputs, run) {
  if (typeof run.persistence?.readSegmentationDefinitions !== 'function') {
    return { resolved: [], byId: new Map(), pending: [], record: async () => {} };
  }
  const recorded = await run.persistence.readSegmentationDefinitions(run.idsite);
  const resolved = resolveSegmentationVersions(segmentations.map((seg) => ({ id: seg.id, stamp: seg.stamp(inputs) })), recorded);
  const byId = new Map(resolved.map((row) => [row.id, row]));
  const pending = segmentations.filter((seg) => byId.get(seg.id).isNew).map((seg) => ({
    idsite: run.idsite,
    segmentation: seg.id,
    version: byId.get(seg.id).version,
    kind: seg.kind,
    stamp: byId.get(seg.id).stamp,
    definition: seg.definition(inputs),
    values: [...seg.values],
  }));
  return {
    resolved,
    byId,
    pending,
    /** Writes the new definitions; call after the rows are stored, so a failed write leaves the old version current. */
    record: async () => {
      if (pending.length > 0) await run.persistence.writeSegmentationDefinitions(pending);
    },
  };
}

/**
 * Every row whose segment is a segmentation carries that segmentation's
 * version in `metrics.segmentation_version`. The `all` rows carry none.
 * @template {{segment: string, metrics?: object}} T
 * @param {T[]} rows
 * @param {Map<string, {version: number}>} byId
 * @returns {T[]}
 */
export function stampVersions(rows, byId) {
  if (byId.size === 0) return rows;
  return rows.map((row) => {
    const resolved = row.segment === 'all' ? null : byId.get(row.segment);
    return resolved ? { ...row, metrics: { ...(row.metrics ?? {}), segmentation_version: resolved.version } } : row;
  });
}

/** The run result's view of the versions. @param {ReturnType<typeof resolveSegmentationVersions>} resolved */
export const versionNotes = (resolved) => resolved.map(({ id, version, changed }) => ({ id, version, changed }));
