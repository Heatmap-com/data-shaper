/**
 * Partner tags to experiments.
 *
 * A tag row is (partner, experience_id, variant_id, friendly_name) with the
 * visits it was seen on per day. The same arm reaches us under several raw
 * ids: case changes, `#slr-…` and `?fbclid=…` suffixes, and Intelligems
 * sends each visit twice, once with the experience id and a short arm
 * name and once with an empty experience id and "Experiment - Arm". This
 * module folds those into one experiment with canonical arms, a control,
 * a declared allocation when the partner registry has one, a kind, and a
 * scope.
 */

/** An arm below this share of the experiment's visits, and not declared, is stray. */
export const STRAY_ARM_SHARE = 0.01;
export const SURFACE_SHARE = 0.02;
export const PARTIAL_SURFACE_SHARE = 0.1;

const CONTROL_EXACT = /^(control|control group|original|ctl|baseline|default)$/i;
const CONTROL_WORD = /\bcontrol\b/i;
const UNTITLED = /^untitled\b/i;

/** Registry `type` (Shoplift, Convert) to scope and the templates a visit must view to be exposed. */
const REGISTRY_SCOPES = {
  theme: { scope: 'site', templates: [] },
  product: { scope: 'template', templates: ['pdp'] },
  collection: { scope: 'template', templates: ['plp'] },
  collectionList: { scope: 'template', templates: ['plp'] },
  index: { scope: 'template', templates: ['home'] },
  landing: { scope: 'page', templates: [] },
  urlRedirect: { scope: 'redirect', templates: [] },
  price: { scope: 'site', templates: [] },
  basicScript: { scope: 'script', templates: [] },
  manualScript: { scope: 'script', templates: [] },
};

/** Name tokens to templates. A cart drawer, a price, or a shipping fee shows on every page. */
const NAME_TEMPLATES = [
  { re: /\[(home|hp)\]|\b(hp|homepage|home ?page)\b|-home-|\bhome\b/i, template: 'home' },
  { re: /\[(pdp|product)\]|\bpdp\b|\bproducts?\b/i, template: 'pdp' },
  { re: /\[(plp|collection)\]|\bplp\b|\bcollections?\b|\bcategory\b/i, template: 'plp' },
];
const NAME_SITEWIDE = /\b(cart|mini ?cart|cart drawer|checkout|shipping|price|pricing|strikeout|strikethrough|header|nav|announcement|theme|sitewide|site-wide)\b/i;

export const KINDS = ['experiment', 'rollout', 'personalization', 'internal', 'single_arm'];

/** Partners whose tags are this product's own, not a client test. */
const INTERNAL_PARTNERS = new Set(['heatmap-report']);

/** The first rule that matches names the kind; anything else is `experiment`. */
const KIND_RULES = [
  { kind: 'internal', test: (exp) => INTERNAL_PARTNERS.has(exp.partner) },
  { kind: 'rollout', test: (exp) => /^rollout of\b/i.test(exp.name) },
  { kind: 'personalization', test: (exp) => /\[personali[sz]ation\]|^personali[sz]ation\b/i.test(exp.name) },
  { kind: 'single_arm', test: (exp) => exp.arms.filter((a) => !a.stray).length < 2 },
];

/** Name patterns to the device a test targets, checked in order. */
const NAME_DEVICES = [
  { device: 'mobile', patterns: [/^(m|mob|mobile|mb)\s*[|\-:]/i, /\bmobile\b/i] },
  { device: 'desktop', patterns: [/^(d|dt|dsk|desktop)\s*[|\-:]/i, /^dt\b/i, /\bdesktop\b/i] },
];

/**
 * @typedef {Object} TagDay
 * @property {string} day YYYY-MM-DD
 * @property {string} partner
 * @property {string} experience_id
 * @property {string} variant_id
 * @property {string} friendly_name
 * @property {number} visits
 */

/**
 * @typedef {Object} RegistryArm
 * @property {string} id canonical variant id
 * @property {string} name
 * @property {number | null} percentage
 * @property {boolean} isControl
 * @property {string} type
 */

/**
 * @typedef {Object} Arm
 * @property {string} arm canonical id
 * @property {string} label
 * @property {boolean} isControl
 * @property {number | null} allocation share, 0..1
 * @property {string[]} aliases raw variant ids seen
 * @property {number} visits
 * @property {boolean} stray
 * @property {boolean} declared
 */

/**
 * @typedef {Object} Experiment
 * @property {string} key `${partner}:${experiment id}`
 * @property {string} partner
 * @property {string} partnerExperimentId
 * @property {string} name
 * @property {Arm[]} arms
 * @property {Map<string, string>} rawKeys `partner|experience_id|variant_id` -> canonical arm
 * @property {Map<string, number>} daily day -> assigned visits
 * @property {string[]} registryTypes
 * @property {number} visits
 */

/**
 * The raw variant id without the tracking suffixes and case. Empty for ids
 * that name no arm (`_removed_`, blank).
 * @param {unknown} raw
 */
export function canonicalVariant(raw) {
  const id = String(raw ?? '').split(/[#?]/)[0].trim().toLowerCase();
  if (id === '' || id === '_removed_') return '';
  return id;
}

/**
 * A click selector without Shopify's template / section-group ids, the
 * same key normalizedSelectorSql writes.
 * @param {unknown} selector
 */
export function normalizeSelector(selector) {
  return String(selector ?? '').trim().replace(/(template|sections)--\d+__/g, '$1--__');
}

/** @param {string} partner @param {string} experience_id @param {string} variant_id */
export function rawKey(partner, experience_id, variant_id) {
  return `${partner}|${experience_id}|${variant_id}`;
}

/**
 * "Experiment - Arm" split at the last " - ".
 * @param {unknown} label
 * @returns {{name: string, arm: string}}
 */
export function splitLabel(label) {
  const s = String(label ?? '').trim();
  const i = s.lastIndexOf(' - ');
  if (i <= 0) return { name: s, arm: '' };
  return { name: s.slice(0, i).trim(), arm: s.slice(i + 3).trim() };
}

/** @param {string} name */
function slug(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120) || 'unnamed';
}

/**
 * partner_tags_logs rows (one per partner experiment) to lookups. The
 * variations column is a JSON array of arms for Shoplift, Convert, and
 * Intelligems, and a single-variant object for Monetate, Visually, and
 * Pagedeck.
 * @param {object[]} rows
 */
export function indexRegistry(rows) {
  /** @type {Map<string, {name: string, arms: RegistryArm[], firstSeen: string, lastSeen: string}>} */
  const byExperiment = new Map();
  /** @type {Map<string, Set<string>>} */
  const variantExperiments = new Map();
  for (const row of rows) {
    const partner = String(row.partner ?? '');
    const id = String(row.experiment_id ?? '');
    if (partner === '' || id === '') continue;
    const arms = parseVariations(row.variations);
    byExperiment.set(`${partner}|${id}`, {
      name: String(row.experiment_name ?? ''),
      arms,
      firstSeen: String(row.first_seen ?? ''),
      lastSeen: String(row.last_seen ?? ''),
    });
    const variantIds = [...arms.map((a) => a.id), ...(Array.isArray(row.variant_ids) ? row.variant_ids : []).map(canonicalVariant)];
    for (const variant of variantIds) {
      if (variant === '' || variant === 'control') continue;
      const key = `${partner}|${variant}`;
      if (!variantExperiments.has(key)) variantExperiments.set(key, new Set());
      variantExperiments.get(key).add(id);
    }
  }
  /** @type {Map<string, string>} */
  const variantToExperiment = new Map();
  for (const [key, ids] of variantExperiments) {
    if (ids.size === 1) variantToExperiment.set(key, [...ids][0]);
  }
  return { byExperiment, variantToExperiment };
}

/**
 * @param {unknown} raw
 * @returns {RegistryArm[]}
 */
export function parseVariations(raw) {
  let parsed;
  try {
    parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return [];
  }
  if (Array.isArray(parsed)) {
    return parsed
      .filter((a) => a && typeof a === 'object')
      .map((a) => ({
        id: canonicalVariant(a.id),
        name: String(a.name ?? ''),
        percentage: Number.isFinite(Number(a.percentage)) ? Number(a.percentage) : null,
        isControl: a.isControl === true,
        type: String(a.type ?? ''),
      }))
      .filter((a) => a.id !== '');
  }
  if (parsed && typeof parsed === 'object') {
    const id = canonicalVariant(parsed.variant_id);
    if (id === '') return [];
    return [{
      id,
      name: String(parsed.variant_friendly_name ?? parsed.variant_name ?? ''),
      percentage: null,
      isControl: false,
      type: '',
    }];
  }
  return [];
}

/**
 * Tag days to experiments. Every raw key lands in exactly one experiment.
 * @param {TagDay[]} tagDays
 * @param {object[]} [registryRows] partner_tags_logs, one row per partner experiment
 * @returns {Experiment[]}
 */
export function buildExperiments(tagDays, registryRows = []) {
  const registry = indexRegistry(registryRows);

  // Intelligems: the experience id is on one of the two tags of a visit.
  /** @type {Map<string, Map<string, number>>} */
  const variantVotes = new Map();
  for (const row of tagDays) {
    if (row.experience_id === '') continue;
    const key = `${row.partner}|${row.variant_id}`;
    if (!variantVotes.has(key)) variantVotes.set(key, new Map());
    const votes = variantVotes.get(key);
    votes.set(row.experience_id, (votes.get(row.experience_id) ?? 0) + Number(row.visits));
  }
  /** @type {Map<string, string>} */
  const variantExperience = new Map();
  for (const [key, votes] of variantVotes) {
    variantExperience.set(key, [...votes.entries()].sort((a, b) => b[1] - a[1])[0][0]);
  }

  /** @type {Map<string, {partner: string, id: string, rows: TagDay[]}>} */
  const groups = new Map();
  for (const row of tagDays) {
    const id =
      row.experience_id ||
      variantExperience.get(`${row.partner}|${row.variant_id}`) ||
      registry.variantToExperiment.get(`${row.partner}|${canonicalVariant(row.variant_id)}`) ||
      `name:${slug(splitLabel(row.friendly_name).name)}`;
    const key = `${row.partner}:${id}`;
    if (!groups.has(key)) groups.set(key, { partner: row.partner, id, rows: [] });
    groups.get(key).rows.push(row);
  }

  return [...groups.entries()].map(([key, group]) => assemble(key, group, registry.byExperiment.get(`${group.partner}|${group.id}`)));
}

/**
 * @param {string} key
 * @param {{partner: string, id: string, rows: TagDay[]}} group
 * @param {{name: string, arms: RegistryArm[]} | undefined} reg
 * @returns {Experiment}
 */
function assemble(key, group, reg) {
  const name = experimentName(group, reg);
  const regArms = reg?.arms ?? [];
  const regControl = regArms.find((a) => a.isControl);

  /** @type {Map<string, {labels: Map<string, number>, aliases: Set<string>, days: Map<string, Map<string, number>>}>} */
  const arms = new Map();
  /** @type {Map<string, string>} */
  const rawKeys = new Map();
  for (const row of group.rows) {
    const arm = canonicalVariant(row.variant_id);
    if (arm === '') continue;
    rawKeys.set(rawKey(row.partner, row.experience_id, row.variant_id), arm);
    if (!arms.has(arm)) arms.set(arm, { labels: new Map(), aliases: new Set(), days: new Map() });
    const entry = arms.get(arm);
    entry.aliases.add(row.variant_id);
    const label = armLabel(row.friendly_name, name, arm);
    if (label !== '') entry.labels.set(label, (entry.labels.get(label) ?? 0) + Number(row.visits));
    // Two tags of the same variant on one visit differ only in experience id.
    if (!entry.days.has(row.day)) entry.days.set(row.day, new Map());
    const byVariant = entry.days.get(row.day);
    byVariant.set(row.variant_id, Math.max(byVariant.get(row.variant_id) ?? 0, Number(row.visits)));
  }

  /** @type {Map<string, number>} */
  const daily = new Map();
  /** @type {Arm[]} */
  const built = [];
  for (const [arm, entry] of arms) {
    let visits = 0;
    for (const [day, byVariant] of entry.days) {
      const dayVisits = [...byVariant.values()].reduce((sum, v) => sum + v, 0);
      visits += dayVisits;
      daily.set(day, (daily.get(day) ?? 0) + dayVisits);
    }
    const regArm = regArms.find((a) => a.id === arm) ?? (arm === 'control' ? regControl : undefined);
    const tagLabel = [...entry.labels.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
    const regLabel = regArm && !UNTITLED.test(regArm.name) ? regArm.name : '';
    built.push({
      arm,
      label: regLabel || tagLabel || (arm === 'control' ? 'Control' : arm),
      isControl: false,
      allocation: null,
      aliases: [...entry.aliases].sort(),
      visits,
      stray: false,
      declared: Boolean(regArm),
      regArm,
    });
  }

  const total = built.reduce((sum, a) => sum + a.visits, 0);
  for (const a of built) a.stray = !a.declared && total > 0 && a.visits / total < STRAY_ARM_SHARE;
  markControl(built);

  const percentages = built.filter((a) => a.regArm?.percentage != null && !a.stray);
  const pctTotal = percentages.reduce((sum, a) => sum + a.regArm.percentage, 0);
  if (percentages.length >= 2 && pctTotal > 0) {
    for (const a of percentages) a.allocation = round4(a.regArm.percentage / pctTotal);
  }

  return {
    key,
    partner: group.partner,
    partnerExperimentId: group.id.startsWith('name:') ? '' : group.id,
    name,
    arms: built
      .map(({ regArm, ...rest }) => rest)
      .sort((a, b) => Number(b.isControl) - Number(a.isControl) || b.visits - a.visits || a.arm.localeCompare(b.arm)),
    rawKeys,
    daily,
    registryTypes: [...new Set(regArms.map((a) => a.type).filter(Boolean))],
    visits: total,
  };
}

/**
 * Registry name, then the "Experiment - Arm" prefix, then Shoplift's
 * control label (the control tag carries the experiment name).
 * @param {{id: string, rows: TagDay[]}} group
 * @param {{name: string} | undefined} reg
 */
function experimentName(group, reg) {
  if (reg?.name) return reg.name;
  /** @type {Map<string, number>} */
  const votes = new Map();
  const vote = (name, visits) => {
    if (name) votes.set(name, (votes.get(name) ?? 0) + visits);
  };
  for (const row of group.rows) {
    if (row.experience_id === '') vote(splitLabel(row.friendly_name).name, Number(row.visits));
  }
  if (votes.size === 0) {
    for (const row of group.rows) {
      if (canonicalVariant(row.variant_id) === 'control') vote(String(row.friendly_name ?? '').trim(), Number(row.visits));
    }
  }
  if (votes.size === 0) {
    // Theme tests tag every arm with the test name.
    /** @type {Map<string, Set<string>>} */
    const variantsByName = new Map();
    for (const row of group.rows) {
      const label = String(row.friendly_name ?? '').trim();
      if (label === '') continue;
      if (!variantsByName.has(label)) variantsByName.set(label, new Set());
      variantsByName.get(label).add(canonicalVariant(row.variant_id));
    }
    for (const row of group.rows) {
      const label = String(row.friendly_name ?? '').trim();
      if ((variantsByName.get(label)?.size ?? 0) >= 2) vote(label, Number(row.visits));
    }
  }
  const best = [...votes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  return best ?? group.id;
}

/**
 * Shoplift theme tests use theme ids as arms, and the live theme is an arm
 * of every one of them. An experiment with no control gets the arm that is
 * in the most of the partner's experiments, when that is at least two and
 * more than any other of its arms. Mutates the arms and returns the
 * experiments.
 * @param {Experiment[]} experiments
 * @returns {Experiment[]}
 */
export function markSharedControls(experiments) {
  /** @type {Map<string, number>} partner|arm -> experiments */
  const seen = new Map();
  for (const exp of experiments) {
    for (const arm of exp.arms) {
      if (arm.stray) continue;
      const key = `${exp.partner}|${arm.arm}`;
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
  }
  for (const exp of experiments) {
    if (exp.arms.some((a) => a.isControl)) continue;
    const live = exp.arms
      .filter((a) => !a.stray)
      .map((a) => ({ arm: a, count: seen.get(`${exp.partner}|${a.arm}`) ?? 0 }))
      .sort((a, b) => b.count - a.count);
    if (live.length < 2 || live[0].count < 2 || live[0].count === live[1].count) continue;
    const control = live[0].arm;
    control.isControl = true;
    control.controlSource = 'shared_arm';
    if (!control.label || control.label === control.arm) control.label = 'Control (shared arm)';
    exp.arms.sort((a, b) => Number(b.isControl) - Number(a.isControl) || b.visits - a.visits || a.arm.localeCompare(b.arm));
  }
  return experiments;
}

/**
 * The arm's label from a tag's friendly name, with the experiment name
 * removed. A label that is the experiment name says nothing about the arm.
 * @param {unknown} friendly
 * @param {string} name
 * @param {string} arm
 */
function armLabel(friendly, name, arm) {
  const label = String(friendly ?? '').trim();
  if (label === '') return '';
  if (name && label.startsWith(`${name} - `)) return label.slice(name.length + 3).trim();
  if (name && label.startsWith(`${name}_`)) return label.slice(name.length + 1).trim();
  if (label === name) return arm === 'control' ? 'Control' : '';
  return label;
}

/**
 * One control at most: the registry's, then a `control` variant id, then
 * an exact control label, then a label containing "control".
 * @param {Array<Arm & {regArm?: RegistryArm}>} arms
 */
function markControl(arms) {
  const live = arms.filter((a) => !a.stray);
  const tests = [
    (a) => a.regArm?.isControl === true,
    (a) => a.arm === 'control',
    (a) => CONTROL_EXACT.test(a.label),
    (a) => CONTROL_WORD.test(a.label),
  ];
  for (const test of tests) {
    const hit = live.filter(test).sort((a, b) => b.visits - a.visits)[0];
    if (hit) {
      hit.isControl = true;
      return;
    }
  }
}

/**
 * What the tag is. Only `experiment` gets a readout.
 * @param {Experiment} exp
 * @returns {string}
 */
export function classifyKind(exp) {
  return KIND_RULES.find((rule) => rule.test(exp))?.kind ?? 'experiment';
}

/**
 * Scope from the registry type, then from tokens in the name. `site`,
 * `redirect`, `script`, and `page` without pages expose every assigned
 * visit; `template` exposes visits that viewed a page of the template.
 * @param {Experiment} exp
 * @returns {{scope: string, templates: string[], scopeSource: string}}
 */
export function inferScope(exp) {
  for (const type of exp.registryTypes) {
    const hit = REGISTRY_SCOPES[type];
    if (hit) return { scope: hit.scope, templates: [...hit.templates], scopeSource: 'registry' };
  }
  const templates = NAME_TEMPLATES.filter((t) => t.re.test(exp.name)).map((t) => t.template);
  if (templates.length > 0 && !NAME_SITEWIDE.test(exp.name)) {
    return { scope: 'template', templates, scopeSource: 'name' };
  }
  if (NAME_SITEWIDE.test(exp.name)) return { scope: 'site', templates: [], scopeSource: 'name' };
  return { scope: 'unknown', templates: [], scopeSource: 'none' };
}

/**
 * The templates every live arm fires on. A partner like Shoplift tags the
 * tested template with the visit's arm and every other page as control, so
 * control tags off the tested template carry no assignment. A template is
 * on the surface when it holds at least SURFACE_SHARE of each live arm's
 * tags. `all` is set when every arm has under PARTIAL_SURFACE_SHARE of its
 * tags off the surface, so the fact query skips the page filter. The
 * templates, the pages, and the arms are in sorted order, whatever order
 * the rows came in.
 *
 * @param {Experiment} exp after operator arms
 * @param {Array<{partner: string, experience_id: string, variant_id: string, idsitehsr: string, template: string, tags: number}>} rows
 * @returns {{templates: string[], pages: string[], all: boolean, offSurface: Map<string, number>}}
 *   offSurface: per arm, the share of its tags off the surface
 */
export function inferSurface(exp, rows) {
  const live = new Set(exp.arms.filter((a) => !a.stray).map((a) => a.arm));
  /** @type {Map<string, Map<string, number>>} arm -> template -> tags */
  const byArm = new Map();
  /** @type {Map<string, Set<string>>} template -> pages */
  const pagesByTemplate = new Map();
  let total = 0;
  for (const r of rows) {
    const arm = exp.rawKeys.get(rawKey(r.partner, r.experience_id, r.variant_id));
    if (arm === undefined || !live.has(arm)) continue;
    const template = r.template || 'other';
    const tags = Number(r.tags) || 0;
    if (!byArm.has(arm)) byArm.set(arm, new Map());
    const t = byArm.get(arm);
    t.set(template, (t.get(template) ?? 0) + tags);
    if (!pagesByTemplate.has(template)) pagesByTemplate.set(template, new Set());
    pagesByTemplate.get(template).add(String(r.idsitehsr));
    total += tags;
  }
  const allTemplates = [...pagesByTemplate.keys()].sort();
  if (byArm.size < 2 || total === 0) {
    return { templates: allTemplates, pages: [], all: true, offSurface: new Map() };
  }
  const armTotals = new Map([...byArm].map(([arm, t]) => [arm, [...t.values()].reduce((s, n) => s + n, 0)]));
  const templates = allTemplates.filter((template) =>
    [...byArm].every(([arm, t]) => (t.get(template) ?? 0) >= SURFACE_SHARE * armTotals.get(arm)));
  if (templates.length === 0) {
    return { templates: allTemplates, pages: [], all: true, offSurface: new Map() };
  }
  const on = new Set(templates);
  /** @type {Map<string, number>} */
  const offSurface = new Map();
  for (const [arm, t] of [...byArm].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    let off = 0;
    for (const [template, tags] of t) if (!on.has(template)) off += tags;
    offSurface.set(arm, round4(off / armTotals.get(arm)));
  }
  const all = Math.max(...offSurface.values()) < PARTIAL_SURFACE_SHARE;
  const pages = all ? [] : templates.flatMap((template) => [...pagesByTemplate.get(template)].sort());
  return { templates, pages, all, offSurface };
}

/**
 * A device the name says the test targets: "M | HP | …", "PDP | Mobile
 * ATF", "DT Cart Drawer". Empty when the name does not say.
 * @param {string} name
 */
export function inferDevice(name) {
  const s = String(name ?? '');
  return NAME_DEVICES.find((rule) => rule.patterns.some((re) => re.test(s)))?.device ?? '';
}

/**
 * Operator arms override what was inferred: an operator arm takes every
 * inferred arm whose id is one of its aliases, and its allocation and
 * control flag win.
 * @param {Experiment} exp
 * @param {Array<{arm: string, label?: string, is_control?: boolean, allocation?: number | null, aliases?: string[]}>} operatorArms
 * @returns {Experiment}
 */
export function applyOperatorArms(exp, operatorArms) {
  if (!Array.isArray(operatorArms) || operatorArms.length === 0) return exp;
  /** @type {Map<string, string>} inferred arm -> operator arm */
  const remap = new Map();
  for (const op of operatorArms) {
    const target = canonicalVariant(op.arm);
    if (target === '') continue;
    remap.set(target, target);
    for (const alias of op.aliases ?? []) {
      const id = canonicalVariant(alias);
      if (id !== '') remap.set(id, target);
    }
  }
  /** @type {Map<string, Arm>} */
  const merged = new Map();
  for (const arm of exp.arms) {
    const target = remap.get(arm.arm) ?? arm.arm;
    const prev = merged.get(target);
    if (!prev) {
      merged.set(target, { ...arm, arm: target, aliases: [...arm.aliases] });
    } else {
      prev.visits += arm.visits;
      prev.aliases = [...new Set([...prev.aliases, ...arm.aliases])].sort();
      prev.isControl = prev.isControl || arm.isControl;
    }
  }
  const declaredControl = operatorArms.some((op) => op.is_control === true);
  for (const op of operatorArms) {
    const target = canonicalVariant(op.arm);
    const arm = merged.get(target);
    if (!arm) continue;
    arm.declared = true;
    arm.stray = false;
    if (op.label) arm.label = op.label;
    if (op.allocation != null && Number.isFinite(Number(op.allocation))) arm.allocation = Number(op.allocation);
    if (declaredControl) arm.isControl = op.is_control === true;
  }
  const rawKeys = new Map([...exp.rawKeys].map(([raw, arm]) => [raw, remap.get(arm) ?? arm]));
  return {
    ...exp,
    arms: [...merged.values()].sort((a, b) => Number(b.isControl) - Number(a.isControl) || b.visits - a.visits || a.arm.localeCompare(b.arm)),
    rawKeys,
  };
}

/** @param {number} n */
function round4(n) {
  return Math.round(n * 10000) / 10000;
}
