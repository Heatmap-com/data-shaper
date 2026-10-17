import { formatValue } from '../../domain/quality/findings.js';

/** @typedef {import('./screen.js').QualityResult} QualityResult */
/** @typedef {import('./screen.js').Finding} Finding */

const SHOWN_MEMBERS = 20;

/** The command that records a decision on one finding. */
export function decideCommand(finding, ledger, choice = finding.proposed) {
  const how = choice === 'reprocess' ? `--reprocess '{"method":{"params":{}}}'` : `--${choice}`;
  return `node src/cli.js --quality-decide ${finding.id} --from ${ledger} ${how} --by <you> --note "<why>"`;
}

/**
 * The dataset's quality.json: everything the decide command and a reader
 * need, without the subject rows.
 * @param {QualityResult} result
 * @param {{dataset: string, idsite: number, slug: string | null, today: string}} head
 */
export function qualityLedger(result, head) {
  return {
    dataset: head.dataset,
    idsite: head.idsite,
    slug: head.slug,
    built: head.today,
    window: result.window,
    summary: summaryOf(result),
    screens: result.screens,
    off: result.off,
    findings: result.findings,
    exclusions: {
      orders: result.exclusions.orders,
      visits: result.exclusions.visits,
      conditions: result.exclusions.conditions,
    },
  };
}

/** Counts by status, and what the build excluded. @param {QualityResult} result */
export function summaryOf(result) {
  const count = (status) => result.findings.filter((f) => f.status === status).length;
  return {
    findings: result.findings.length,
    awaiting: count('awaiting_decision'),
    auto: count('auto'),
    decided: count('decided'),
    excludedOrders: result.exclusions.orders.length,
    excludedVisits: result.exclusions.visits.length,
    excludedGroups: result.exclusions.conditions.map((c) => `${c.field} in ${c.in.map((v) => JSON.stringify(v)).join(', ')}`),
  };
}

const plain = (value) => (typeof value === 'object' ? JSON.stringify(value) : String(value));
const membersText = (finding) => {
  const shown = finding.members.slice(0, SHOWN_MEMBERS).map((m) => `\`${m}\``).join(', ');
  return finding.members.length > SHOWN_MEMBERS ? `${shown}, and ${finding.members.length - SHOWN_MEMBERS} more (quality.json lists them all)` : shown;
};

function impactLine(finding) {
  const i = finding.impact;
  const parts = [];
  if (i.sessions !== undefined) parts.push(`${formatValue(i.sessions, 'count')} sessions (${formatValue(i.sessionShare, 'share')})`);
  parts.push(`${formatValue(i.orders, 'count')} orders (${formatValue(i.orderShare, 'share')})`);
  parts.push(`${formatValue(i.revenue, 'money')} revenue (${formatValue(i.revenueShare, 'share')})`);
  if (i.conversionWith !== undefined) parts.push(`conversion ${formatValue(i.conversionWith, 'share')} with them, ${formatValue(i.conversionWithout, 'share')} without`);
  parts.push(`AOV ${formatValue(i.aovWith, 'money')} with them, ${formatValue(i.aovWithout, 'money')} without`);
  return parts.join('; ');
}

/**
 * QUALITY.md: what was screened, what was found, what the build applied,
 * what waits for a person, and where every constant came from.
 * @param {QualityResult} result
 * @param {{dataset: string, idsite: number, today: string, ledger: string}} head
 */
export function qualityMarkdown(result, head) {
  const lines = [`# Data quality: ${head.dataset}`, ''];
  const summary = summaryOf(result);
  lines.push(`Screened ${head.today} over every kept session of idsite ${head.idsite} from ${result.window.start} to ${result.window.end}: the whole site in the days this dataset reads, not only its filter, so a suspect order or group is judged the same in every dataset of the run.`);
  lines.push('');
  lines.push(`${summary.findings} findings: ${summary.awaiting} waiting for a person, ${summary.auto} applied without one, ${summary.decided} decided.`);
  lines.push('');

  const awaiting = result.findings.filter((f) => f.status === 'awaiting_decision');
  lines.push(`## Waiting for you (${awaiting.length})`, '');
  if (awaiting.length === 0) lines.push('Nothing.', '');
  for (const f of awaiting) {
    lines.push(`### ${f.label} (\`${f.id}\`)`, '');
    lines.push(f.question, '');
    lines.push(`- This build applied **${f.disposition}**, the screen's disposition while nobody has answered. The screen proposes **${f.proposed}**.`);
    lines.push(`- Asked because ${f.triage?.why ?? 'the screen asks'}.`);
    lines.push(`- Why it is suspect: ${f.reason}.`);
    lines.push(`- What excluding it does: ${impactLine(f)}.`);
    lines.push(`- Members: ${membersText(f)}.`);
    lines.push(`- Exclude: \`${decideCommand(f, head.ledger, 'exclude')}\``);
    lines.push(`- Keep: \`${decideCommand(f, head.ledger, 'include')}\``);
    lines.push(`- Screen again under other constants: \`${decideCommand(f, head.ledger, 'reprocess')}\`, with the parameters to change.`);
    lines.push('');
  }

  const auto = result.findings.filter((f) => f.status === 'auto');
  lines.push(`## Applied without a person (${auto.length})`, '');
  if (auto.length === 0) lines.push('Nothing.', '');
  else {
    lines.push('| Finding | Screen | What | Applied | Why no person was asked |', '|---|---|---|---|---|');
    for (const f of auto) lines.push(`| \`${f.id}\` | ${f.screen} | ${f.label}: ${impactLine(f)} | ${f.disposition} | ${f.triage?.why ?? ''} |`);
    lines.push('');
  }

  const decided = result.findings.filter((f) => f.status === 'decided');
  lines.push(`## Decided (${decided.length})`, '');
  if (decided.length === 0) lines.push('Nothing.', '');
  else {
    lines.push('| Finding | Screen | What | Decision | By | On | Note |', '|---|---|---|---|---|---|---|');
    for (const f of decided) {
      const d = /** @type {any} */ (f.decision);
      lines.push(`| \`${f.id}\` | ${f.screen} | ${f.label} | ${d.decision}${d.applies === 'rule' ? ' (every finding of the screen)' : ''}${d.dataset ? `, dataset ${d.dataset} only` : ''} | ${d.by} | ${d.at} | ${d.note} |`);
    }
    lines.push('');
  }

  lines.push('## What this build excluded', '');
  const excluded = [];
  if (summary.excludedOrders > 0) excluded.push(`- ${summary.excludedOrders} orders by id: their count and revenue are out of every row; their sessions stay.`);
  if (summary.excludedVisits > 0) excluded.push(`- ${summary.excludedVisits} sessions by visit id.`);
  for (const text of summary.excludedGroups) excluded.push(`- Every session with ${text}.`);
  lines.push(...(excluded.length > 0 ? excluded : ['Nothing. Every number in data.csv includes every kept session and order.']), '');

  lines.push('## Screens', '');
  lines.push('| Screen | Subject | Method | Triage | Propose / pending / auto, scope | Result |', '|---|---|---|---|---|---|');
  for (const s of result.screens) {
    const subject = /** @type {any} */ (s.subject);
    const outcome = s.skipped ? `skipped: ${s.skipped}` : `${s.findings.length} finding${s.findings.length === 1 ? '' : 's'}`;
    lines.push(`| ${s.id} (${s.origin}) | ${subject.kind}${subject.by ? ` by ${subject.by}` : ''}, ${subject.measure ?? ''} | ${s.method.adapter} ${plain(s.method.params)} | ${s.triage.adapter} ${plain(s.triage.params)} | ${s.dispositions.propose} / ${s.dispositions.pending} / ${s.dispositions.auto}, ${s.dispositions.scope} | ${outcome} |`);
  }
  lines.push('');
  for (const entry of result.off) lines.push(`- ${entry.id === '*' ? 'Every screen' : entry.id} is off (${entry.layer}).`);
  const patched = result.screens.filter((s) => s.layers.length > 0);
  if (patched.length > 0) {
    lines.push('', 'Constants set past the shipped screen, in the order they applied:', '');
    for (const s of patched) for (const layer of s.layers) lines.push(`- ${s.id}: \`${layer.path}\` = \`${plain(layer.value)}\` from ${layer.layer}`);
  }
  for (const s of result.screens) for (const r of s.reprocessed) lines.push(`- ${s.id} is screened again under ${plain(r.params)}, decided ${r.at} by ${r.by}: ${r.note}`);
  lines.push('');
  return lines.join('\n');
}

/**
 * The data-quality section of ANSWER.md: per built request, its counts,
 * and every question waiting for a person.
 * @param {Array<{id: string, quality?: {summary: ReturnType<typeof summaryOf>, waiting: Array<{id: string, question: string}>, folder: string}}>} answers
 */
export function answerQualitySection(answers) {
  const screened = answers.filter((a) => a.quality);
  if (screened.length === 0) return '';
  const lines = ['', '## Data quality', ''];
  for (const a of screened) {
    const s = a.quality.summary;
    lines.push(`- **${a.id}**: ${s.findings} findings, ${s.awaiting} waiting for a person, ${s.auto} applied without one, ${s.decided} decided. See \`${a.quality.folder}/QUALITY.md\`.`);
  }
  const questions = new Map();
  for (const a of screened) for (const q of a.quality.waiting) if (!questions.has(q.id)) questions.set(q.id, { ...q, datasets: [] });
  for (const a of screened) for (const q of a.quality.waiting) questions.get(q.id).datasets.push(a.id);
  if (questions.size > 0) {
    lines.push('', '### Waiting for you', '');
    for (const q of questions.values()) lines.push(`- \`${q.id}\` (${q.datasets.join(', ')}): ${q.question}`);
  }
  lines.push('');
  return lines.join('\n');
}
