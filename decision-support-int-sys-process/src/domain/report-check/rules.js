import { dateForms, numberForms, numberPattern } from './forms.js';
import { headingMatches } from './parse.js';

/**
 * Text a finished report never holds: template markers, editor notes, and
 * values a script printed when a number was missing. Inline code is quoted
 * data (an ad that really sent `{{campaign.name}}`), so it is not searched.
 */
export const PLACEHOLDERS = Object.freeze([
  { name: 'template marker', pattern: /\{\{|\}\}/ },
  { name: 'editor note', pattern: /\b(?:TODO|TBD|FIXME|XXX)\b/ },
  { name: 'filler text', pattern: /lorem ipsum/i },
  { name: 'bracketed placeholder', pattern: /(?<!!)\[(?:insert|placeholder|fill in|tk)\b[^\]]*\]/i },
  { name: 'missing value', pattern: /\b(?:NaN|Infinity)\b|\?\?\?/ },
]);

const detail = (name, ok, message) => ({ name, ok, ...(message ? { message } : {}) });

/**
 * Every rule a report check can apply, keyed by its name in the check spec's
 * `rules`. Each rule says in a sentence what it requires (`describe`) and
 * returns one detail per thing it looked at (`evaluate`). The document is
 * parseMarkdown's output; facts are what the adapter read from disk and the
 * bundle. A new rule is one entry here.
 *
 * @type {Record<string, {describe: (value: any) => string, evaluate: (doc: ReturnType<typeof import('./parse.js').parseMarkdown>, value: any, facts: ReportFacts) => Array<{name: string, ok: boolean, message?: string}>}>}
 *
 * @typedef {Object} ReportFacts
 * @property {Record<string, boolean>} figures image link -> the file exists
 * @property {Array<{label: string, expect: number, tolerance?: number}>} anchors from the bundle profile
 * @property {{start?: string, end?: string}} window the bundle's report window
 * @property {number|null} docTime the report's modification time, ms
 * @property {number|null} bundleTime the bundle profile's modification time, ms
 */
export const REPORT_RULES = Object.freeze({
  minWords: {
    describe: (min) => `at least ${min} words`,
    evaluate: (doc, min) => [detail('length', doc.words >= min, `${doc.words} words, needs ${min}`)],
  },
  sections: {
    describe: (names) => `these sections, in headings: ${names.join(' · ')}`,
    evaluate: (doc, names) => names.map((name) => {
      const found = doc.headings.find((heading) => headingMatches(heading.text, name));
      return detail(`section "${name}"`, Boolean(found), found ? found.text : 'no heading starts with it');
    }),
  },
  headingCount: {
    describe: (counts) => counts.map((row) => `at least ${row.min} headings like "${row.name}"`).join('; '),
    evaluate: (doc, counts) => counts.map((row) => {
      const pattern = new RegExp(row.match, 'i');
      const n = doc.headings.filter((heading) => pattern.test(heading.text)).length;
      return detail(`${row.name} headings`, n >= row.min, `${n} found, needs ${row.min}`);
    }),
  },
  placeholders: {
    describe: () => 'no placeholder text (template markers, TODO or TBD, filler, NaN)',
    evaluate: (doc) => {
      const prose = doc.text.replace(/`[^`\n]*`/g, '``');
      return PLACEHOLDERS.map(({ name, pattern }) => {
        const hit = pattern.exec(prose);
        return detail(`no ${name}`, !hit, hit ? `found "${prose.slice(Math.max(0, hit.index - 30), hit.index + 30).replace(/\s+/g, ' ')}"` : '');
      });
    },
  },
  figures: {
    describe: () => 'every linked figure exists beside the report',
    evaluate: (doc, _value, facts) => (doc.images.length === 0
      ? [detail('figures', true, 'no figures linked')]
      : doc.images.map((ref) => detail(`figure ${ref}`, facts.figures[ref] === true, facts.figures[ref] ? '' : 'missing'))),
  },
  anchors: {
    describe: (labels) => `quotes the bundle's anchor numbers: ${labels.join(', ')}`,
    evaluate: (doc, labels, facts) => labels.map((label) => {
      const anchor = facts.anchors.find((row) => row.label === label);
      if (!anchor) return detail(`anchor "${label}"`, true, 'not in this bundle, not checked');
      const forms = numberForms(Number(anchor.expect), Number(anchor.tolerance ?? 0));
      const found = forms.find((form) => numberPattern(form).test(doc.text));
      return detail(`anchor "${label}"`, Boolean(found), found ? `quotes ${found}` : `expects ${anchor.expect} (as ${forms.join(' or ')})`);
    }),
  },
  windowEnd: {
    describe: () => "names the last day of the bundle's report window",
    evaluate: (doc, _value, facts) => {
      if (!facts.window?.end) return [detail('window end', true, 'the bundle has no report window, not checked')];
      const forms = dateForms(facts.window.end);
      const text = doc.text.toLowerCase();
      const found = forms.find((form) => text.includes(form.toLowerCase()));
      return [detail('window end', Boolean(found), found ? `names ${found}` : `expects ${forms.join(' or ')}`)];
    },
  },
  fresh: {
    describe: () => 'written after the bundle it reads was built',
    evaluate: (_doc, _value, facts) => {
      if (facts.bundleTime === null || facts.docTime === null) return [detail('fresh', true, 'no bundle time, not checked')];
      const ok = facts.docTime >= facts.bundleTime;
      return [detail('fresh', ok, ok ? '' : 'the bundle was rebuilt after this report')];
    },
  },
});

/**
 * Runs the rules a spec names, in the spec's order.
 *
 * @param {ReturnType<typeof import('./parse.js').parseMarkdown>} doc
 * @param {Record<string, unknown>} rules
 * @param {ReportFacts} facts
 */
export function evaluateReport(doc, rules, facts) {
  return Object.entries(rules).flatMap(([name, value]) => {
    if (value === false || value === null) return [];
    const rule = REPORT_RULES[name];
    if (!rule) return [detail(`rule ${name}`, false, `unknown report rule; use ${Object.keys(REPORT_RULES).join(', ')}`)];
    return rule.evaluate(doc, value, facts);
  });
}

/** The rules a spec names, as the sentence an agent reads under "Done means". */
export function describeReport(rules) {
  return Object.entries(rules)
    .filter(([name, value]) => value !== false && value !== null && REPORT_RULES[name])
    .map(([name, value]) => REPORT_RULES[name].describe(value));
}
