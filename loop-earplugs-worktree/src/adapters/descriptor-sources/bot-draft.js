import { configuredDatabase } from '../query-gateway/clickhouse.js';
import { loadCatalog } from '../../catalog/index.js';
import { DESCRIPTOR_EXPIRY_DAYS } from '../../descriptor-import.js';

/**
 * bot-draft descriptor source (data-capture-plan.md §9.6, Phase 5). Drafts
 * the paths whose schema entry allows it — bot_may_draft true or a string
 * qualifier, read literally from descriptor.schema.json — from render
 * artifacts (ae_page_render_current / ae_render_node_current) and measured
 * datasets (ctx.datasets). Everything it writes is provenance 'bot_draft',
 * confidence 'low', owner 'bot-draft', expiring 90 days after capture: a
 * low-confidence field counts as Unknown until an operator row with
 * human_confirmed_by replaces it (§7.1). Absence beats a guessed value: any
 * path whose data source is missing is skipped, never filled with invented
 * content.
 *
 * Qualifiers:
 * - except_guarantee_terms (p09.proof_risk): proof signals observed in the
 *   render, but guarantee_terms is stripped from the drafted object.
 * - order_and_depth_only (p10.hierarchy): {order, depths} from section
 *   nodes; movability, function and tags are operator facts (§7.1).
 * - measured_only (p03.offer, p05.traffic): only fields computable from
 *   collected datasets — p03 drafts aov_measured (order-value data) and a
 *   shipping_threshold only when a dataset supplies one, else skips the
 *   path; p05 drafts {device_split, new_returning_split, source_shares}
 *   from page-segment-weekly and never the source→promise mapping.
 * - list_only_no_validation (p14.events): the observed event-name list from
 *   custom-event-inventory (or an empty list); validation status is a
 *   recording-check fact the bot may not assert (§7.1).
 *
 * p02.context, p13.constraints, p15.revenue_join, s20.returns_policy,
 * s26.economics, s31.consent and s33.fraud_policy carry bot_may_draft
 * false and are never drafted (asserted in test).
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export const adapter = {
  id: 'bot-draft',

  /**
   * @param {import('../../../ports/qualifier.js').QualifiedPage} page
   * @param {import('../../../ports/dataset.js').RunContext} ctx
   * @returns {Promise<Array<import('../../../ports/persistence.js').AeDescriptorRow>>}
   */
  async draft(page, ctx) {
    const schema = loadCatalog().descriptorSchema;
    const flags = new Map();
    for (const field of [...schema.page_fields, ...schema.store_fields]) {
      flags.set(field.path, field.bot_may_draft);
    }
    /** @type {(path: string) => boolean} true or a string qualifier */
    const mayDraft = (path) => {
      const flag = flags.get(path);
      return flag === true || typeof flag === 'string';
    };

    const capturedAt = new Date().toISOString();
    const expiresAt = new Date(Date.parse(capturedAt) + DESCRIPTOR_EXPIRY_DAYS * DAY_MS).toISOString();
    const templateKey = `url:${page.idsitehsr}`;
    /** @type {Array<import('../../../ports/persistence.js').AeDescriptorRow>} */
    const rows = [];

    /** @param {string} fieldPath @param {string} deviceClass @param {*} value */
    const push = (fieldPath, deviceClass, value) => {
      rows.push({
        idsite: page.idsite,
        template_key: templateKey,
        device_class: deviceClass,
        field_path: fieldPath,
        value_json: JSON.stringify(value ?? null),
        provenance: 'bot_draft',
        confidence: 'low',
        human_confirmed_by: '',
        owner: 'bot-draft',
        captured_at: capturedAt,
        expires_at: expiresAt,
      });
    };

    // --- render artifacts (memoized on the site's batchNotes) ---
    const render = await readRenderArtifacts(ctx, page);

    if (render.renders.length > 0 && mayDraft('p00.walk')) {
      for (const r of render.renders) {
        push('p00.walk', String(r.device_class ?? 'all'), {
          url: page.url,
          device: String(r.device_class ?? ''),
          viewport: { w: Number(r.viewport_w ?? 0), h: Number(r.viewport_h ?? 0) },
        });
      }
    }

    const nodesByDevice = groupBy(render.nodes, (n) => String(n.device_class ?? 'all'));
    for (const [device, nodes] of nodesByDevice) {
      const sections = nodes
        .filter((n) => String(n.node_kind ?? '') === 'section')
        .sort((a, b) => Number(a.dom_order ?? 0) - Number(b.dom_order ?? 0));
      const elements = nodes.filter((n) => String(n.node_kind ?? '') === 'element');

      if (mayDraft('p04.first_viewport')) {
        const first = elements
          .filter((n) => Number(n.in_first_viewport ?? 0) === 1)
          .sort((a, b) => Number(a.dom_order ?? 0) - Number(b.dom_order ?? 0))
          .map((n) => String(n.selector ?? ''))
          .filter(Boolean);
        push('p04.first_viewport', device, first);
      }

      if (mayDraft('p07.navigation')) {
        // Menu activation (hover vs click) is a tracker fact (T05); from
        // render node counts the bot can only say how much nav there is and
        // whether search exists.
        const navSections = sections.filter((s) => /nav|header|menu/i.test(String(s.section_type ?? '')));
        const navElements = elements.filter(
          (n) => /nav|menu/i.test(String(n.selector ?? '')) || navSections.some((s) => s.node_id === n.parent_section_id),
        );
        push('p07.navigation', device, {
          menu_depth: navElements.length === 0 ? 0 : Math.max(1, navSections.length),
          search_present: nodes.some((n) => /search/i.test(`${n.selector ?? ''} ${n.section_type ?? ''}`)) ? 1 : 0,
        });
      }

      if (mayDraft('p08.commerce')) {
        // Only what the render shows; the cart type cannot be seen.
        const selectorOf = (n) => `${n.selector ?? ''} ${n.section_type ?? ''}`;
        push('p08.commerce', device, {
          add_to_cart: elements.some((n) => /add.?to.?(cart|bag)|buy.?now/i.test(selectorOf(n))) ? 1 : 0,
          express_checkout: elements.some((n) => /express|shop.?pay|apple.?pay|google.?pay|paypal/i.test(selectorOf(n))) ? 1 : 0,
          variant_selector: elements.some((n) => /variant|swatch/i.test(selectorOf(n))) ? 1 : 0,
          cart_type: 'unknown',
        });
      }

      if (mayDraft('p09.proof_risk')) {
        // Proof signals observed in the render; guarantee_terms is the
        // operator-reserved sub-field (except_guarantee_terms) and is
        // stripped from the drafted object. Section types drive the
        // block-level signals; element selectors drive the policy link.
        const sectionTypes = sections.map((s) => String(s.section_type ?? '')).join(' ');
        const elementSelectors = elements.map((e) => String(e.selector ?? '')).join(' ');
        const candidate = {
          reviews_block: /reviews/i.test(sectionTypes) ? 1 : 0,
          brag_bar: /\b(brag|press|proof|featured|as_seen)\b|press_bar|brag_bar/i.test(sectionTypes) ? 1 : 0,
          faq_block: /\bfaq/i.test(sectionTypes) ? 1 : 0,
          returns_policy_link: /returns?[ _-]?policy|refund/i.test(elementSelectors) ? 1 : 0,
        };
        if (/guarantee/i.test(sectionTypes)) candidate.guarantee_terms = { present: true };
        if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
          delete candidate.guarantee_terms;
        }
        push('p09.proof_risk', device, candidate);
      }

      if (mayDraft('p10.hierarchy') && sections.length > 0) {
        const depths = {};
        for (const s of sections) depths[String(s.node_id ?? '')] = Number(s.y ?? 0);
        push('p10.hierarchy', device, { order: sections.map((s) => String(s.node_id ?? '')), depths });
      }

      if (mayDraft('p11.affordances')) {
        const falseAffordances = elements
          .filter((n) => Number(n.looks_clickable ?? 0) === 1 && Number(n.is_control ?? 0) === 0)
          .map((n) => String(n.selector ?? ''))
          .filter(Boolean);
        push('p11.affordances', device, falseAffordances);
      }
    }

    // --- measured-only drafts from collected datasets ---
    const datasets = ctx.datasets ?? new Map();

    if (mayDraft('p03.offer')) {
      const orderValue = datasets.get('order-value-hist');
      const hasOrderValue = Array.isArray(orderValue?.rows) && orderValue.rows.length > 0;
      if (hasOrderValue) {
        const value = { aov_measured: aovFromOrderValueHist(orderValue.rows) };
        const threshold = shippingThresholdFrom(datasets);
        if (threshold !== undefined) value.shipping_threshold = threshold;
        push('p03.offer', 'all', value);
      }
      // No order-value/payment data: the path is skipped entirely, never
      // drafted with guessed values.
    }

    if (mayDraft('p05.traffic')) {
      const segment = datasets.get('page-segment-weekly');
      const rows = Array.isArray(segment?.rows) ? segment.rows.filter((r) => Number(r.metrics?.sessions ?? 0) > 0) : [];
      if (rows.length > 0) {
        const preferred = preferBotFilter(rows);
        push('p05.traffic', 'all', {
          device_split: shareOf(preferred, 'device', 'sessions'),
          new_returning_split: shareOf(preferred, 'returning', 'sessions'),
          source_shares: shareOf(preferred, 'referer', 'sessions'),
        });
      }
      // source→promise is an operator/ad-API fact (§7.1) and is never drafted.
    }

    if (mayDraft('p14.events')) {
      const inventory = datasets.get('custom-event-inventory');
      const names = Array.isArray(inventory?.rows)
        ? [...new Set(inventory.rows.map((r) => String(r.dims?.event_name ?? '')).filter(Boolean))].sort()
        : [];
      // The observed name list only; validation status needs a recording
      // check (O05) the bot may not assert.
      push('p14.events', 'all', names);
    }

    return rows;
  },
};

/**
 * Render reads are memoized per (site, page) on the site's batchNotes so a
 * draft over several paths reads ae_page_render/ae_render_node once.
 * Pre-cutover clusters (no ae_ tables) degrade to empty reads, never a
 * throw; the render-dependent paths are then skipped.
 *
 * @param {import('../../../ports/dataset.js').RunContext} ctx
 * @param {{idsite: number, idsitehsr: number}} page
 */
async function readRenderArtifacts(ctx, page) {
  const key = `bot-draft:render:${page.idsite}:${page.idsitehsr}`;
  if (ctx.batchNotes?.has(key)) return ctx.batchNotes.get(key);

  const params = { idsite: page.idsite, idsitehsr: page.idsitehsr };
  /** @type {{renders: object[], nodes: object[]}} */
  const out = { renders: [], nodes: [] };

  try {
    out.renders = await ctx.gateway.query(
      `SELECT device_class, viewport_w, viewport_h
         FROM ${configuredDatabase()}.ae_page_render_current
        WHERE idsite = {idsite:UInt32} AND idsitehsr = {idsitehsr:UInt64}`,
      params,
      'bot-draft:renders',
    );
  } catch (err) {
    if (!/UNKNOWN_TABLE|Unknown table/i.test(String(err?.message ?? err))) throw err;
  }
  try {
    out.nodes = await ctx.gateway.query(
      `SELECT device_class, node_kind, node_id, parent_section_id, selector,
              section_type, dom_order, y, is_control, looks_clickable, in_first_viewport
         FROM ${configuredDatabase()}.ae_render_node_current
        WHERE idsite = {idsite:UInt32} AND idsitehsr = {idsitehsr:UInt64}
        ORDER BY device_class, node_kind, dom_order`,
      params,
      'bot-draft:nodes',
    );
  } catch (err) {
    if (!/UNKNOWN_TABLE|Unknown table/i.test(String(err?.message ?? err))) throw err;
  }

  ctx.batchNotes?.set(key, out);
  return out;
}

/**
 * AOV from order-value-hist bucket rows (dims {bot_filter, bucket}, metrics
 * {orders, revenue}). Prefers the exclude_confirmed filter when present.
 * @param {Array<{dims: object, metrics: object}>} rows
 */
function aovFromOrderValueHist(rows) {
  const buckets = preferBotFilter(rows).filter((r) => typeof r.metrics?.orders === 'number');
  const orders = buckets.reduce((n, r) => n + r.metrics.orders, 0);
  const revenue = buckets.reduce((n, r) => n + Number(r.metrics.revenue ?? 0), 0);
  return orders > 0 ? Math.round((revenue / orders) * 100) / 100 : null;
}

/**
 * A shipping threshold is drafted only when a collected dataset actually
 * supplies one (S14 delivery profiles); it is never guessed.
 * @param {Map<string, object>} datasets
 */
function shippingThresholdFrom(datasets) {
  for (const dataset of datasets.values()) {
    for (const row of dataset?.rows ?? []) {
      const threshold = row.metrics?.shipping_threshold ?? row.metrics?.free_shipping_threshold;
      if (Number.isFinite(threshold)) return threshold;
    }
  }
  return undefined;
}

/** @param {Array<{dims: object, metrics: object}>} rows */
function preferBotFilter(rows) {
  const excluded = rows.filter((r) => r.dims?.bot_filter === 'exclude_confirmed');
  return excluded.length > 0 ? excluded : rows.filter((r) => r.dims?.bot_filter === 'none');
}

/**
 * Session share per dim value, rounded to 4 decimals.
 * @param {Array<{dims: object, metrics: object}>} rows
 * @param {string} dim
 * @param {string} metric
 */
function shareOf(rows, dim, metric) {
  const totals = new Map();
  for (const row of rows) {
    const key = String(row.dims?.[dim] ?? 'unknown');
    totals.set(key, (totals.get(key) ?? 0) + Number(row.metrics?.[metric] ?? 0));
  }
  const sum = [...totals.values()].reduce((n, v) => n + v, 0);
  const shares = {};
  for (const [key, value] of totals) shares[key] = sum > 0 ? Math.round((value / sum) * 10000) / 10000 : 0;
  return shares;
}

/** @param {Array<object>} items @param {(item: object) => string} keyOf */
function groupBy(items, keyOf) {
  /** @type {Map<string, object[]>} */
  const groups = new Map();
  for (const item of items) {
    const key = keyOf(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return groups;
}
