/**
 * Segmentation versions, following resolveDefinitions for triggers. A
 * segmentation's version moves when its stamp, the canonical resolved
 * definition, moves.
 *
 * `isNew` means the run records a definition row: there was none, or the
 * stamp differs. `changed` means a recorded version existed and its stamp
 * differs, so rows stored under it no longer mean what they meant.
 *
 * @param {ReadonlyArray<{id: string, stamp: string}>} stamps the run's segmentations
 * @param {ReadonlyArray<{segmentation: string, version: number, stamp: string}>} recorded latest per segmentation
 * @returns {Array<{id: string, version: number, stamp: string, isNew: boolean, changed: boolean, previous: number | null}>}
 */
export function resolveSegmentationVersions(stamps, recorded) {
  const latest = new Map(recorded.map((row) => [row.segmentation, row]));
  return stamps.map(({ id, stamp }) => {
    const prior = latest.get(id);
    if (!prior) return { id, version: 1, stamp, isNew: true, changed: false, previous: null };
    if (prior.stamp === stamp) return { id, version: prior.version, stamp, isNew: false, changed: false, previous: prior.version };
    return { id, version: prior.version + 1, stamp, isNew: true, changed: true, previous: prior.version };
  });
}
