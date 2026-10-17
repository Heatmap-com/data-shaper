/**
 * Shared ae_render_node row mapping for both persistence adapters
 * (data-capture-plan.md §9.3): one node per section (node_kind 'section',
 * the section's own id as node_id, full-width geometry from top/height) and
 * one per element (node_kind 'element', parent_section_id from the artifact).
 * Saliency stays null — the saliency worker rewrites these rows once the
 * plan's Q8 is resolved.
 *
 * @param {import('../../ports/persistence.js').AeCaptureComplete} done
 * @param {import('../../ports/persistence.js').AeRenderInput} render
 * @param {string} captureId
 * @param {string} generatedAt adapter clock timestamp (CH DateTime64 shape)
 * @returns {object[]}
 */
/**
 * The bot records `in_first_viewport` from the viewport-relative box.
 * A missing box is stored at the origin with the flag false; recomputing
 * from `y < fold` would mark that miss as above the fold.
 *
 * @param {object} element
 * @param {{fold_px?: number}} render
 * @returns {0 | 1}
 */
function firstViewport(element, render) {
  if (element.in_first_viewport === true || element.in_first_viewport === 1) return 1;
  if (element.in_first_viewport === false || element.in_first_viewport === 0) return 0;
  return (element.y ?? 0) < (render.fold_px ?? 0) ? 1 : 0;
}

export function renderNodeRows(done, render, captureId, generatedAt) {
  const base = {
    idsite: done.idsite,
    idsitehsr: done.idsitehsr,
    device_class: render.device_class,
    capture_id: captureId,
    saliency_share: null,
    saliency_quartile: null,
    saliency_model: '',
    generated_at: generatedAt,
  };
  const sections = render.sections ?? [];
  const elements = render.elements ?? [];
  return [
    ...sections.map((section, index) => ({
      ...base,
      node_id: section.id,
      node_kind: 'section',
      selector: section.selector ?? '',
      parent_section_id: '',
      dom_order: index,
      x: 0,
      y: Math.max(0, Math.round(section.top ?? 0)),
      w: render.viewport_w,
      h: Math.max(0, Math.round(section.height ?? 0)),
      section_type: section.type ?? '',
      visual_class: '',
      image_type: '',
      is_control: 0,
      looks_clickable: 0,
      is_sticky: 0,
      word_count: section.words ?? 0,
      in_first_viewport: (section.top ?? 0) < render.fold_px ? 1 : 0,
    })),
    ...elements.map((element, index) => {
      const domOrder = element.dom_order ?? index;
      return {
        ...base,
        node_id: `el:${domOrder}`,
        node_kind: 'element',
        selector: element.selector,
        parent_section_id: element.section_id ?? '',
        dom_order: domOrder,
        x: Math.round(element.x ?? 0),
        y: Math.round(element.y ?? 0),
        w: Math.max(0, Math.round(element.w ?? 0)),
        h: Math.max(0, Math.round(element.h ?? 0)),
        section_type: '',
        visual_class: element.visual_class ?? '',
        image_type: element.image_type ?? '',
        is_control: element.is_control ? 1 : 0,
        looks_clickable: element.looks_clickable ? 1 : 0,
        is_sticky: element.sticky ? 1 : 0,
        word_count: element.words ?? element.word_count ?? 0,
        in_first_viewport: firstViewport(element, render),
      };
    }),
  ];
}
