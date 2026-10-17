/**
 * The subject identity columns of a stored row. A row that names no
 * subject belongs to a page subject: its key is its idsitehsr, and a
 * site-scope row (idsitehsr 0) keeps an empty key.
 * @param {{subjectType?: string, subjectKey?: string, idsitehsr?: number}} row
 * @returns {{subject_type: string, subject_key: string}}
 */
export function subjectColumns(row) {
  return {
    subject_type: row.subjectType ?? 'page',
    subject_key: row.subjectKey ?? (Number(row.idsitehsr) > 0 ? String(row.idsitehsr) : ''),
  };
}

/**
 * One ae_subject_target row from a SubjectTarget.
 * @param {string} batchId
 * @param {number} idsite
 * @param {import('../../ports/subject.js').SubjectTarget & {status?: string, reason?: string}} target
 * @param {string} generatedAt
 */
export function subjectTargetRow(batchId, idsite, target, generatedAt) {
  return {
    batch_id: batchId,
    idsite,
    subject_type: target.subjectType,
    subject_key: target.subjectKey,
    label: target.label ?? '',
    dims: JSON.stringify(target.dims ?? {}),
    role: target.role ?? '',
    selection_reason: target.selectionReason ?? '',
    evidence: JSON.stringify(target.evidence ?? {}),
    status: target.status ?? 'selected',
    reason: target.reason ?? '',
    generated_at: generatedAt,
  };
}

/**
 * A stored ae_subject_target row as a SubjectTarget with its status.
 * @param {object} row
 */
export function fromSubjectTargetRow(row) {
  return {
    subjectType: String(row.subject_type),
    subjectKey: String(row.subject_key),
    label: String(row.label ?? ''),
    dims: parseJson(row.dims),
    role: String(row.role ?? ''),
    selectionReason: String(row.selection_reason ?? ''),
    evidence: parseJson(row.evidence),
    status: String(row.status ?? 'selected'),
    reason: String(row.reason ?? ''),
  };
}

function parseJson(value) {
  if (typeof value !== 'string' || value === '') return {};
  return JSON.parse(value);
}
