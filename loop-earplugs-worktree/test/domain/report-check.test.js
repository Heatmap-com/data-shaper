import { describe, expect, it } from 'vitest';
import { dateForms, describeReport, evaluateReport, headingMatches, numberForms, numberPattern, parseMarkdown } from '../../src/domain/report-check/index.js';

const facts = (over = {}) => ({ figures: {}, anchors: [], window: {}, docTime: 2, bundleTime: 1, ...over });
const failing = (details) => details.filter((row) => !row.ok).map((row) => row.name);

describe('parseMarkdown', () => {
  it('reads headings, images, and words, and leaves fenced code out', () => {
    const doc = parseMarkdown('# Title\n\nOne two three.\n\n```\n# not a heading TODO\n```\n\n## 2. At a glance\n\n![Daily orders](media/a.png)\n');
    expect(doc.headings.map((row) => row.text)).toEqual(['Title', '2. At a glance']);
    expect(doc.images).toEqual(['media/a.png']);
    expect(doc.text).not.toContain('not a heading');
    expect(doc.words).toBeGreaterThanOrEqual(5);
  });
});

describe('headingMatches', () => {
  it('matches a section name with or without its number, case and apostrophes folded', () => {
    expect(headingMatches('3. What’s working', "What's working")).toBe(true);
    expect(headingMatches('A Data and Method', 'A Data and Method')).toBe(true);
    expect(headingMatches('01 Where shoppers land', '01')).toBe(true);
    expect(headingMatches('The month in numbers', 'The month')).toBe(true);
  });

  it('needs a word boundary after the name', () => {
    expect(headingMatches('Action 10', 'Action 1')).toBe(false);
    expect(headingMatches('011 Extra', '01')).toBe(false);
  });
});

describe('number and date forms', () => {
  it('accepts the exact value with or without separators, and the rounded integer inside the tolerance', () => {
    const forms = numberForms(6404.73, 1);
    expect(forms).toEqual(expect.arrayContaining(['6,404.73', '6404.73', '6,405']));
    expect(numberForms(201, 0)).toEqual(expect.arrayContaining(['201']));
  });

  it('matches a number only as a whole token', () => {
    expect(numberPattern('201').test('201 orders')).toBe(true);
    expect(numberPattern('201').test('2201 orders')).toBe(false);
    expect(numberPattern('201').test('201.5 orders')).toBe(false);
  });

  it('names a day the three ways the reports write it', () => {
    expect(dateForms('2026-10-12')).toEqual(['2026-10-12', '12 October 2026', 'October 12, 2026']);
  });
});

describe('evaluateReport', () => {
  const report = [
    '# Sayii — Site Opportunity Report',
    '## Contents',
    '## At a glance',
    'Orders in the window were 201, and revenue was $6,404.73, through 12 October 2026.',
    '## Opportunity 1', '## Opportunity 2',
    '![Fig](media/fig1.png)',
    'An ad sent `{{campaign.name}}` literally.',
  ].join('\n\n');
  const anchors = [{ label: 'orders in report window', expect: 201 }, { label: 'revenue in report window', expect: 6404.73, tolerance: 1 }];

  it('passes a document that meets every rule', () => {
    const details = evaluateReport(parseMarkdown(report), {
      minWords: 10,
      sections: ['Contents', 'At a glance'],
      headingCount: [{ name: 'Opportunity N', match: '^Opportunity \\d+', min: 2 }],
      placeholders: true,
      figures: true,
      anchors: ['orders in report window', 'revenue in report window', 'not in this bundle'],
      windowEnd: true,
      fresh: true,
    }, facts({ figures: { 'media/fig1.png': true }, anchors, window: { end: '2026-10-12' } }));
    expect(failing(details)).toEqual([]);
  });

  it('names each rule that fails', () => {
    const doc = parseMarkdown('# Title\n\nTODO add the number. Revenue was NaN.\n\n![x](media/gone.png)\n\n[insert chart]');
    const details = evaluateReport(doc, {
      minWords: 500,
      sections: ['Method and caveats'],
      placeholders: true,
      figures: true,
      anchors: ['orders in report window'],
      windowEnd: true,
      fresh: true,
      speling: true,
    }, facts({ anchors, window: { end: '2026-10-12' }, docTime: 1, bundleTime: 2 }));
    expect(failing(details)).toEqual([
      'length', 'section "Method and caveats"', 'no editor note', 'no bracketed placeholder', 'no missing value',
      'figure media/gone.png', 'anchor "orders in report window"', 'window end', 'fresh', 'rule speling',
    ]);
  });

  it('reads image alt text as prose, not a placeholder', () => {
    const details = evaluateReport(parseMarkdown('![Add to cart button](media/a.png)'), { placeholders: true }, facts());
    expect(failing(details)).toEqual([]);
  });

  it('skips a rule set to false and describes the rest as sentences', () => {
    expect(evaluateReport(parseMarkdown('short'), { minWords: false }, facts())).toEqual([]);
    expect(describeReport({ minWords: 600, sections: ['Contents', 'Action 1'], fresh: true, unknown: 1 })).toEqual([
      'at least 600 words',
      'these sections, in headings: Contents · Action 1',
      'written after the bundle it reads was built',
    ]);
  });
});
