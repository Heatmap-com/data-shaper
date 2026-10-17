import { describe, expect, it } from 'vitest';
import { resolveSegmentationVersions } from '../src/domain/segmentation/index.js';
import { runVersions, stampVersions, versionNotes } from '../src/application/segmentation/versions.js';
import { createMemoryAePersistence } from '../src/adapters/persistence/memory.js';
import { shipped } from './support/segmentations.js';

describe('resolveSegmentationVersions', () => {
  it('starts at version 1, keeps an unchanged stamp, and moves a changed one', () => {
    const recorded = [
      { segmentation: 'buyer', version: 2, stamp: 'b' },
      { segmentation: 'channel', version: 4, stamp: 'old' },
    ];
    expect(resolveSegmentationVersions([{ id: 'returning', stamp: 'r' }, { id: 'buyer', stamp: 'b' }, { id: 'channel', stamp: 'new' }], recorded)).toEqual([
      { id: 'returning', version: 1, stamp: 'r', isNew: true, changed: false, previous: null },
      { id: 'buyer', version: 2, stamp: 'b', isNew: false, changed: false, previous: 2 },
      { id: 'channel', version: 5, stamp: 'new', isNew: true, changed: true, previous: 4 },
    ]);
  });
});

describe('run versions', () => {
  const segs = shipped('trend');

  it('records each definition once, after the rows, and stamps the non-all rows', async () => {
    const { adapter } = createMemoryAePersistence();
    const first = await runVersions(segs, {}, { idsite: 7, persistence: adapter });
    expect(versionNotes(first.resolved)).toEqual(segs.map((seg) => ({ id: seg.id, version: 1, changed: false })));
    expect(await adapter.readSegmentationDefinitions(7)).toEqual([]);
    await first.record();
    const stored = await adapter.readSegmentationDefinitions(7);
    expect(stored.map((r) => [r.idsite, r.segmentation, r.version, r.kind])).toEqual(
      segs.map((seg) => [7, seg.id, 1, seg.kind]).sort((a, b) => (a[1] < b[1] ? -1 : 1)),
    );
    expect(stored.find((r) => r.segmentation === 'buyer').values).toEqual([...segs.find((s) => s.id === 'buyer').values]);

    const again = await runVersions(segs, {}, { idsite: 7, persistence: adapter });
    expect(again.pending).toEqual([]);

    const rows = stampVersions([
      { segment: 'all', metrics: {} },
      { segment: 'buyer', metrics: { row_kind: 'x' } },
    ], again.byId);
    expect(rows).toEqual([
      { segment: 'all', metrics: {} },
      { segment: 'buyer', metrics: { row_kind: 'x', segmentation_version: 1 } },
    ]);
  });

  it('moves a computed segmentation when its inputs move', async () => {
    const { adapter } = createMemoryAePersistence();
    const intent = shipped('tagTrend', ['return_intent']);
    const interest = { min_pages: 3, min_clicks: 2, min_scroll_pct: 50, min_duration_sec: 30 };
    await (await runVersions(intent, { lookbackDays: 30, interest }, { idsite: 7, persistence: adapter })).record();
    const longer = await runVersions(intent, { lookbackDays: 60, interest }, { idsite: 7, persistence: adapter });
    expect(versionNotes(longer.resolved)).toEqual([{ id: 'return_intent', version: 2, changed: true }]);
    expect(longer.pending[0].definition).toMatchObject({ lookbackDays: 60 });
  });

  it('versions nothing over a store without the role', async () => {
    const none = await runVersions(segs, {}, { idsite: 7, persistence: {} });
    expect(none.resolved).toEqual([]);
    expect(stampVersions([{ segment: 'buyer', metrics: {} }], none.byId)).toEqual([{ segment: 'buyer', metrics: {} }]);
  });
});
