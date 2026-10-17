import { checkPatch } from './screens.js';

/**
 * A person's answers to findings, kept in a site's quality-decisions.json:
 * `{ idsite, decisions: [...] }`. Later entries win over earlier ones.
 *
 * - `exclude` / `include` on a finding apply to its members (order ids,
 *   attribute values), so the same rows are not asked about again; with
 *   `applies: "rule"` they stand for every finding of the screen.
 * - `reprocess` re-runs the screen with `params`, a patch of the screen;
 *   the finding it answers is screened again under the new constants.
 * - `dataset` limits a decision to one dataset; without it, it applies to
 *   every dataset of the site.
 *
 * @typedef {'exclude' | 'include' | 'reprocess'} DecisionValue
 * @typedef {Object} Decision
 * @property {string} rule                 the screen id
 * @property {DecisionValue} decision
 * @property {'finding' | 'rule'} applies
 * @property {string | null} finding       the finding id answered
 * @property {string[]} members            member keys; empty for a rule decision or a reprocess
 * @property {string | null} dataset
 * @property {object | null} params        reprocess only: the patch
 * @property {string} by
 * @property {string} at                   YYYY-MM-DD
 * @property {string} note
 * @property {object} [evidence]           what the person saw
 */

export const DECISIONS = Object.freeze(['exclude', 'include', 'reprocess']);
const KEYS = ['rule', 'decision', 'applies', 'finding', 'members', 'dataset', 'params', 'by', 'at', 'note', 'evidence'];
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * @param {unknown} doc
 * @param {string} where
 * @returns {{idsite: number, decisions: Decision[]}}
 */
export function checkDecisions(doc, where) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error(`${where}: must be an object`);
  for (const key of Object.keys(doc)) if (key !== 'idsite' && key !== 'decisions') throw new Error(`${where}: unknown key "${key}" (idsite, decisions)`);
  if (!Number.isInteger(doc.idsite) || doc.idsite <= 0) throw new Error(`${where}: idsite must be a positive integer`);
  if (!Array.isArray(doc.decisions)) throw new Error(`${where}: decisions must be a list`);
  return { idsite: doc.idsite, decisions: doc.decisions.map((entry, i) => checkDecision(entry, `${where}: decisions[${i}]`)) };
}

/**
 * @param {unknown} entry
 * @param {string} where
 * @returns {Decision}
 */
export function checkDecision(entry, where) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`${where}: a decision is an object`);
  const doc = /** @type {Record<string, any>} */ (entry);
  for (const key of Object.keys(doc)) if (!KEYS.includes(key)) throw new Error(`${where}: unknown key "${key}" (${KEYS.join(', ')})`);
  if (typeof doc.rule !== 'string' || !doc.rule) throw new Error(`${where}: rule names the screen`);
  if (!DECISIONS.includes(doc.decision)) throw new Error(`${where}: decision must be one of ${DECISIONS.join(', ')}`);
  const applies = doc.applies ?? 'finding';
  if (applies !== 'finding' && applies !== 'rule') throw new Error(`${where}: applies is finding or rule`);
  const members = doc.members ?? [];
  if (!Array.isArray(members) || members.some((member) => typeof member !== 'string' || !member)) throw new Error(`${where}: members is a list of member keys`);
  if (doc.decision === 'reprocess') {
    if (!doc.params) throw new Error(`${where}: a reprocess decision carries params, the patch of the screen`);
    checkPatch(doc.params, `${where}: params`);
  } else {
    if (doc.params !== undefined && doc.params !== null) throw new Error(`${where}: only a reprocess decision carries params`);
    if (applies === 'finding' && members.length === 0) throw new Error(`${where}: a decision on a finding lists its members`);
  }
  if (doc.finding !== undefined && doc.finding !== null && typeof doc.finding !== 'string') throw new Error(`${where}: finding is a finding id`);
  if (doc.dataset !== undefined && doc.dataset !== null && (typeof doc.dataset !== 'string' || !doc.dataset)) throw new Error(`${where}: dataset is a dataset id or null`);
  for (const key of ['by', 'note']) if (typeof doc[key] !== 'string' || !doc[key].trim()) throw new Error(`${where}: ${key} must say who decided and why`);
  if (typeof doc.at !== 'string' || !DAY.test(doc.at)) throw new Error(`${where}: at is YYYY-MM-DD`);
  return {
    rule: doc.rule,
    decision: doc.decision,
    applies,
    finding: doc.finding ?? null,
    members: [...members],
    dataset: doc.dataset ?? null,
    params: doc.decision === 'reprocess' ? JSON.parse(JSON.stringify(doc.params)) : null,
    by: doc.by,
    at: doc.at,
    note: doc.note,
    ...(doc.evidence !== undefined ? { evidence: doc.evidence } : {}),
  };
}

/**
 * The decisions that bear on one screen in one dataset: the reprocess
 * patches in file order, a standing rule decision if any, and the member
 * decisions (the last one for a member wins). A dataset-specific entry
 * applies after the site-wide ones, so it wins. A member's own decision
 * wins over the standing one, which answers only the members nobody
 * decided one by one.
 * @param {ReadonlyArray<Decision>} decisions
 * @param {string} rule
 * @param {string} dataset
 */
export function decisionsFor(decisions, rule, dataset) {
  const relevant = decisions.filter((d) => d.rule === rule && (d.dataset === null || d.dataset === dataset));
  const ordered = [...relevant.filter((d) => d.dataset === null), ...relevant.filter((d) => d.dataset !== null)];
  const reprocess = ordered.filter((d) => d.decision === 'reprocess');
  let standing = null;
  const members = new Map();
  for (const d of ordered) {
    if (d.decision === 'reprocess') continue;
    if (d.applies === 'rule') standing = d;
    else for (const member of d.members) members.set(member, d);
  }
  return { reprocess, standing, members };
}
