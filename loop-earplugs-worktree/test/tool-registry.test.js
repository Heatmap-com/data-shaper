import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadToolRegistrySeed,
  normalizeToolRegistryRow,
  parseToolRegistryImport,
} from '../src/tool-registry-import.js';
import { createMemoryAePersistence } from '../src/adapters/persistence/memory.js';
import { adapter as toolRegistry } from '../src/adapters/datasets/tool-registry.js';
import { adapter as adCreative } from '../src/adapters/datasets/ad-creative.js';

/**
 * Phase 5 tool-registry seed and import path (plan task 5, §7.3/§4.6):
 * seed-shape validation, collision rules (identical re-import and the
 * installed 0→1 flip pass, everything else is rejected), the memory
 * adapter's writeToolRegistry replace semantics, and the tool-registry /
 * ad-creative site datasets including UNKNOWN_TABLE degradation.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(path.join(here, '..', 'src', 'catalog', 'tool-registry.seed.json'), 'utf8'));
const SEED_ROW = SEED[0];

function row(over = {}) {
  return { ...SEED_ROW, ...over };
}

describe('parseToolRegistryImport', () => {
  it('accepts the Phase 0 seed against itself (idempotent re-import)', () => {
    const parsed = parseToolRegistryImport(JSON.stringify(SEED));
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]).toEqual(normalizeToolRegistryRow(SEED_ROW));
  });

  it('rejects a tool slug outside [a-z0-9_]', () => {
    for (const tool of ['Rebuy', 're-buy', 'rebuy cart', 'rebuy.cart', '']) {
      expect(() => parseToolRegistryImport([row({ tool })], { existing: [] }), tool).toThrow(/slug/);
    }
  });

  it('rejects non-enum revenue_join_class, event_taxonomy_status and api_status', () => {
    expect(() => parseToolRegistryImport([row({ revenue_join_class: 'cookie' })], { existing: [] })).toThrow(
      /revenue_join_class/,
    );
    expect(() => parseToolRegistryImport([row({ event_taxonomy_status: 'made_up' })], { existing: [] })).toThrow(
      /event_taxonomy_status/,
    );
    expect(() => parseToolRegistryImport([row({ api_status: 'yes' })], { existing: [] })).toThrow(/api_status/);
    for (const extra of [
      { revenue_join_class: 'tool_event' },
      { revenue_join_class: 'order_only' },
      { event_taxonomy_status: 'documented' },
      { event_taxonomy_status: 'observed' },
      { api_status: 'available' },
      { api_status: 'unavailable' },
      { api_status: 'partial' },
    ]) {
      expect(() => parseToolRegistryImport([row(extra)], { existing: [] })).not.toThrow();
    }
  });

  it('rejects installed outside 0|1 and a non-positive idsite', () => {
    expect(() => parseToolRegistryImport([row({ installed: 2 })], { existing: [] })).toThrow(/installed/);
    expect(() => parseToolRegistryImport([row({ installed: '1' })], { existing: [] })).toThrow(/installed/);
    expect(() => parseToolRegistryImport([row({ idsite: 0 })], { existing: [] })).toThrow(/idsite/);
  });

  it('rejects a row that collides with the seed for the same idsite and tool', () => {
    expect(() => parseToolRegistryImport([row({ note: 'operator override attempt' })])).toThrow(/collides/);
  });

  it('allows the installed 0→1 flip on a colliding row', () => {
    const existing = [{ ...SEED_ROW, installed: 0 }];
    const parsed = parseToolRegistryImport([row({ installed: 1 })], { existing });
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0].installed).toBe(1);
  });

  it('allows an identical re-import of a row already in the registry', () => {
    const existing = [SEED_ROW];
    const parsed = parseToolRegistryImport([row()], { existing });
    expect(parsed.rows).toHaveLength(1);
  });

  it('rejects a non-array payload and aggregates row errors', () => {
    expect(() => parseToolRegistryImport({ rows: SEED })).toThrow(/JSON array/);
    expect(() => parseToolRegistryImport('[not json')).toThrow(/JSON array/);
    expect(() =>
      parseToolRegistryImport([row({ tool: 'Bad' }), row({ api_status: 'nope' })], { existing: [] }),
    ).toThrow(/2 error/);
  });

  it('accepts rows for idsites the seed does not cover (absence is not evidence)', () => {
    const parsed = parseToolRegistryImport(
      [row({ idsite: 3199, tool: 'klaviyo', vendor: 'Klaviyo', modules: [], surfaces_owned: [] })],
      { existing: [] },
    );
    expect(parsed.rows).toHaveLength(1);
  });

  it('loadToolRegistrySeed matches the on-disk seed file', () => {
    expect(loadToolRegistrySeed()).toEqual(SEED);
  });
});

describe('writeToolRegistry (memory adapter)', () => {
  it('round-trips rows and replaces on (idsite, tool)', async () => {
    const { adapter, snapshot } = createMemoryAePersistence();
    await adapter.writeToolRegistry([SEED_ROW]);
    let rows = snapshot().toolRegistry;
    expect(rows).toHaveLength(1);
    expect(rows[0].tool).toBe('rebuy');
    expect(rows[0].installed).toBe(1);
    expect(rows[0].modules).toEqual(['cart_drawer']);
    expect(rows[0].event_taxonomy_status).toBe('undocumented');
    expect(rows[0].detection_confidence).toBe('low');
    expect(rows[0].note).toContain('operator to confirm');

    // same key, new facts: one row, latest wins
    await adapter.writeToolRegistry([row({ event_taxonomy_status: 'observed', note: 'walked 2026-10-04' })]);
    rows = snapshot().toolRegistry;
    expect(rows).toHaveLength(1);
    expect(rows[0].event_taxonomy_status).toBe('observed');

    // a second tool on the same site keys independently
    await adapter.writeToolRegistry([row({ tool: 'klaviyo', vendor: 'Klaviyo' })]);
    expect(snapshot().toolRegistry).toHaveLength(2);
  });
});

/** RunContext with a fake gateway: rows per label, or an UNKNOWN_TABLE throw. */
function ctx({ rows = [], fail = false } = {}) {
  return {
    batchId: '11111111-1111-1111-1111-111111111111',
    windowStart: '2026-09-06',
    windowEnd: '2026-10-04',
    gateway: {
      async query(_sql, _params, label) {
        if (fail) throw new Error(`Code: 60. DB::Exception: Table journey_events.ae_tool_registry doesn't exist (UNKNOWN_TABLE)`);
        if (label !== 'tool-registry:rows' && label !== 'ad-creative:rows') throw new Error(`unexpected query ${label}`);
        return rows;
      },
    },
    logger: { info() {}, warn() {}, error() {} },
    clock: { todayUtc: () => '2026-10-04' },
    datasets: new Map(),
    batchNotes: new Map(),
  };
}

const SITE = { idsite: 3228, idsitehsr: 0, siteName: 'pilot-3228' };

describe('tool-registry dataset', () => {
  it('maps registry rows, flagging undocumented event taxonomies', async () => {
    const out = await toolRegistry.collect(SITE, {
      ...ctx({
        rows: [
          SEED_ROW,
          {
            ...SEED_ROW,
            tool: 'klaviyo',
            vendor: 'Klaviyo',
            modules: ['email', 'sms'],
            event_taxonomy_status: 'documented',
            api_status: 'available',
            detection_confidence: 'medium',
            verified_by_walk_at: '2026-10-02 12:00:00.000',
            note: '',
          },
        ],
      }),
    });
    expect(out.rows).toHaveLength(2);

    const rebuy = out.rows.find((r) => r.dims.tool === 'rebuy');
    expect(rebuy.metrics.installed).toBe(1);
    expect(rebuy.metrics.modules).toEqual(['cart_drawer']);
    expect(rebuy.metrics.surfaces_owned).toEqual(['cart_drawer']);
    expect(rebuy.metrics.revenue_join_class).toBe('unknown');
    expect(rebuy.metrics.event_taxonomy_status).toBe('undocumented');
    expect(rebuy.metrics.undocumented_events).toBe(1);
    expect(rebuy.metrics.detection_sources).toEqual(['script_hint']);
    expect(rebuy.metrics.detection_confidence).toBe('low');
    expect(rebuy.metrics.note).toContain('operator to confirm');

    const klaviyo = out.rows.find((r) => r.dims.tool === 'klaviyo');
    expect(klaviyo.metrics.undocumented_events).toBeUndefined();
    expect(klaviyo.metrics.api_status).toBe('available');
    expect(klaviyo.metrics.verified_by_walk_at).toBe('2026-10-02 12:00:00.000');
  });

  it('degrades to zero rows plus a note when the table is missing', async () => {
    const out = await toolRegistry.collect(SITE, ctx({ fail: true }));
    expect(out.rows).toEqual([]);
    expect(out.notes.tool_registry_note).toMatch(/ae_tool_registry_current unreadable/);
  });
});

describe('ad-creative dataset', () => {
  const AD = {
    idsite: 3228,
    platform: 'meta',
    ad_id: '1200012345678901',
    campaign_id: 'cmp-leather-gifts-q4',
    utm_source: 'facebook',
    utm_campaign: 'leather_gifts_q4',
    utm_content: 'ad01_angle_durability',
    destination_url: 'https://example.com/products/briefcase?utm_campaign=leather_gifts_q4',
    offer_text: '20% off briefcases this week',
    claim_text: 'full-grain leather, 25-year warranty',
    has_code: 1,
    offer_led: 1,
    creator: '',
    angle: 'durability',
    temperature: 'cold_paid_social',
    provenance: 'operator_map',
    captured_at: '2026-10-01 09:00:00.000',
  };

  it('maps ad rows with campaign_id in dims', async () => {
    const out = await adCreative.collect(SITE, ctx({ rows: [AD] }));
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0].dims).toEqual({
      platform: 'meta',
      campaign_id: 'cmp-leather-gifts-q4',
      utm_source: 'facebook',
      temperature: 'cold_paid_social',
    });
    expect(out.rows[0].metrics.ad_id).toBe('1200012345678901');
    expect(out.rows[0].metrics.destination_url).toContain('utm_campaign=leather_gifts_q4');
    expect(out.rows[0].metrics.offer_text).toBe('20% off briefcases this week');
    expect(out.rows[0].metrics.has_code).toBe(1);
    expect(out.rows[0].metrics.offer_led).toBe(1);
    expect(out.rows[0].metrics.angle).toBe('durability');
    expect(out.rows[0].metrics.provenance).toBe('operator_map');
    expect(out.requirements).toBeUndefined();
  });

  it('emits the A01 missing requirement when there are no rows', async () => {
    const out = await adCreative.collect(SITE, ctx({ rows: [] }));
    expect(out.rows).toEqual([]);
    expect(out.requirements).toEqual([
      {
        key: 'A01',
        status: 'missing',
        rowCount: 0,
        detail: 'operator UTM map or ad API not imported (Q13)',
      },
    ]);
  });

  it('degrades to zero rows, the A01 requirement and a note when the table is missing', async () => {
    const out = await adCreative.collect(SITE, ctx({ fail: true }));
    expect(out.rows).toEqual([]);
    expect(out.notes.ad_creative_note).toMatch(/ae_src_ad_creative_current unreadable/);
    expect(out.requirements?.[0]).toMatchObject({ key: 'A01', status: 'missing', rowCount: 0 });
  });
});
