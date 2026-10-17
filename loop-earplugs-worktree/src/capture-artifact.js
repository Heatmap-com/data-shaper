/**
 * Render artifact validation (data-capture-plan.md §9.3, tests in §13):
 * pure functions over the bot's render.<device>.json payload. The consumer
 * (src/capture-consumer.js) resolves and parses the file; this module only
 * validates shape and the binding contract, and summarizes for coverage.
 * A missing or unparseable device file is the caller's failure (the consumer
 * names the device class when it failCaptures).
 */

const REQUIRED_FIELDS = [
  'url',
  'device_class',
  'viewport',
  'page_height_px',
  'fold_px',
  'rendered_at',
  'renderer_version',
  'content_hash',
  'dom_hash',
];

/**
 * @param {*} value
 * @returns {value is number}
 */
function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * @param {object} artifact
 * @param {string} field
 */
function requirePresent(artifact, field) {
  if (artifact[field] === undefined || artifact[field] === null || artifact[field] === '') {
    throw new Error(`render artifact: missing required field "${field}"`);
  }
}

/**
 * @param {object} artifact
 * @param {string} field
 */
function requireNonEmptyString(artifact, field) {
  requirePresent(artifact, field);
  if (typeof artifact[field] !== 'string' || artifact[field].trim() === '') {
    throw new Error(`render artifact: "${field}" must be a non-empty string`);
  }
}

/**
 * @param {object} artifact
 * @param {string} field
 */
function requireNonNegativeNumber(artifact, field) {
  requirePresent(artifact, field);
  if (!isFiniteNumber(artifact[field]) || artifact[field] < 0) {
    throw new Error(`render artifact: "${field}" must be a number >= 0`);
  }
}

/**
 * The naming bot writes viewport `{width, height}`, `screenshot_file`, and
 * elements whose geometry lives on `box` (`width`/`height`, null when the
 * selector is not on the page). The engine contract is viewport `{w, h}`,
 * `screenshot`, and flat `x, y, w, h`. Artifacts that already use the engine
 * shape pass through. A missing box becomes a zero-size element that is not
 * in the first viewport, so the selector still satisfies the binding
 * contract without being treated as above-the-fold content.
 *
 * @param {object} artifact
 * @returns {object}
 */
export function normalizeRenderArtifact(artifact) {
  if (typeof artifact !== 'object' || artifact === null || Array.isArray(artifact)) return artifact;
  const viewport = artifact.viewport;
  const nextViewport =
    typeof viewport === 'object' && viewport !== null && !Array.isArray(viewport)
      ? {
          ...viewport,
          w: isFiniteNumber(viewport.w) ? viewport.w : viewport.width,
          h: isFiniteNumber(viewport.h) ? viewport.h : viewport.height,
        }
      : viewport;
  const screenshot =
    typeof artifact.screenshot === 'string' && artifact.screenshot.trim() !== ''
      ? artifact.screenshot
      : artifact.screenshot_file;
  const elements = Array.isArray(artifact.elements)
    ? artifact.elements.map((element, index) => normalizeElement(element, index))
    : artifact.elements;
  return { ...artifact, viewport: nextViewport, screenshot, elements };
}

/**
 * @param {object} element
 * @param {number} index
 */
function normalizeElement(element, index) {
  if (typeof element !== 'object' || element === null) return element;
  const words = element.words ?? element.word_count ?? 0;
  if (isFiniteNumber(element.x) && isFiniteNumber(element.y) && isFiniteNumber(element.w) && isFiniteNumber(element.h)) {
    return { ...element, words, dom_order: element.dom_order ?? index };
  }
  const box = element.box;
  const missing = box === null || box === undefined;
  return {
    ...element,
    x: missing ? 0 : box.x,
    y: missing ? 0 : box.y,
    w: missing ? 0 : (box.w ?? box.width),
    h: missing ? 0 : (box.h ?? box.height),
    words,
    in_first_viewport: missing ? false : Boolean(element.in_first_viewport),
    dom_order: element.dom_order ?? index,
  };
}

/**
 * Validates one render.<device>.json payload (§9.3): required top fields,
 * non-empty hashes, section geometry, element boxes (off-canvas origins
 * included), and the binding contract — every selector the naming harvest
 * bound must exist among the artifact's elements.
 *
 * @param {object} artifact the parsed render.<device>.json
 * @param {Array<{selector: string}>} bindings the captured element bindings
 *   (names), used to prove every bound selector rendered
 * @returns {void} throws with a precise message on the first violation
 */
export function validateRenderArtifact(artifact, bindings = []) {
  if (typeof artifact !== 'object' || artifact === null || Array.isArray(artifact)) {
    throw new Error('render artifact: payload must be a JSON object');
  }
  for (const field of REQUIRED_FIELDS) {
    requirePresent(artifact, field);
  }
  requireNonEmptyString(artifact, 'url');
  requireNonEmptyString(artifact, 'device_class');
  if (typeof artifact.viewport !== 'object' || artifact.viewport === null || Array.isArray(artifact.viewport)) {
    throw new Error('render artifact: "viewport" must be an object {w, h}');
  }
  if (!isFiniteNumber(artifact.viewport.w) || artifact.viewport.w <= 0) {
    throw new Error('render artifact: "viewport.w" must be a number > 0');
  }
  if (!isFiniteNumber(artifact.viewport.h) || artifact.viewport.h <= 0) {
    throw new Error('render artifact: "viewport.h" must be a number > 0');
  }
  requireNonNegativeNumber(artifact, 'page_height_px');
  requireNonNegativeNumber(artifact, 'fold_px');
  requireNonEmptyString(artifact, 'rendered_at');
  requireNonEmptyString(artifact, 'renderer_version');
  requireNonEmptyString(artifact, 'content_hash');
  requireNonEmptyString(artifact, 'dom_hash');

  const sections = artifact.sections ?? [];
  if (!Array.isArray(sections)) {
    throw new Error('render artifact: "sections" must be an array');
  }
  sections.forEach((section, index) => {
    if (typeof section !== 'object' || section === null) {
      throw new Error(`render artifact: sections[${index}] must be an object`);
    }
    if (typeof section.id !== 'string' || section.id.trim() === '') {
      throw new Error(`render artifact: sections[${index}].id must be a non-empty string`);
    }
    if (section.selector !== undefined && section.selector !== null) {
      if (typeof section.selector !== 'string' || section.selector.trim() === '') {
        throw new Error(`render artifact: sections[${index}].selector must be a non-empty string when present`);
      }
    }
    if (!isFiniteNumber(section.top) || section.top < 0) {
      throw new Error(`render artifact: sections[${index}].top must be a number >= 0`);
    }
    if (!isFiniteNumber(section.height) || section.height < 0) {
      throw new Error(`render artifact: sections[${index}].height must be a number >= 0`);
    }
  });

  const elements = artifact.elements ?? [];
  if (!Array.isArray(elements)) {
    throw new Error('render artifact: "elements" must be an array');
  }
  const elementSelectors = new Set();
  elements.forEach((element, index) => {
    if (typeof element !== 'object' || element === null) {
      throw new Error(`render artifact: elements[${index}] must be an object`);
    }
    if (typeof element.selector !== 'string' || element.selector.trim() === '') {
      throw new Error(`render artifact: elements[${index}].selector must be a non-empty string`);
    }
    for (const axis of ['x', 'y', 'w', 'h']) {
      if (!isFiniteNumber(element[axis])) {
        throw new Error(`render artifact: elements[${index}].${axis} must be a number`);
      }
    }
    if (element.w < 0 || element.h < 0) {
      throw new Error(`render artifact: elements[${index}] box w/h must be >= 0 (got w=${element.w}, h=${element.h})`);
    }
    elementSelectors.add(element.selector);
  });

  for (const binding of bindings) {
    const selector = binding?.selector;
    if (typeof selector !== 'string' || selector.trim() === '') {
      throw new Error('render artifact: bindings must carry a non-empty selector');
    }
    if (!elementSelectors.has(selector)) {
      throw new Error(`render artifact: bound selector "${selector}" is not among elements[] selectors`);
    }
  }
}

/**
 * Coverage counts for one render artifact (§9.3); the consumer folds these
 * into ae_page_capture.coverage alongside the naming counts.
 *
 * @param {object} artifact
 * @returns {{sections_found: number, elements_found: number, selectors: string[]}}
 */
export function summarizeArtifact(artifact) {
  const sections = Array.isArray(artifact?.sections) ? artifact.sections : [];
  const elements = Array.isArray(artifact?.elements) ? artifact.elements : [];
  return {
    sections_found: sections.length,
    elements_found: elements.length,
    selectors: elements.map((element) => element?.selector).filter((selector) => typeof selector === 'string'),
  };
}
