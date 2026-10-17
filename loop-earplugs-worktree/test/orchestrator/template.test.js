import { describe, expect, it } from 'vitest';
import { parseFrontMatter, renderTemplate, renderValues } from '../../src/orchestrator/domain/template.js';
import { TemplateError } from '../../src/orchestrator/domain/errors.js';

describe('renderValues', () => {
  it('substitutes dotted values', () => {
    expect(renderValues('{{site.domain}} on {{unit.page.url}}', {
      site: { domain: 'sayii.com' },
      unit: { page: { url: 'https://sayii.com/' } },
    })).toBe('sayii.com on https://sayii.com/');
  });

  it('throws naming the key and the source when a value is missing', () => {
    expect(() => renderValues('{{site.idsite}}', { site: {} }, 'prompt.md'))
      .toThrow('prompt.md: no value for {{site.idsite}}');
    expect(() => renderValues('{{site.idsite}}', { site: {} }, 'prompt.md')).toThrow(TemplateError);
  });

  it('renders null as empty', () => {
    expect(renderValues('[{{job.blocker}}]', { job: { blocker: null } })).toBe('[]');
  });

  it('renders objects as JSON', () => {
    expect(renderValues('{{window}}', { window: { start: '2026-09-13', end: '2026-10-12' } }))
      .toBe(JSON.stringify({ start: '2026-09-13', end: '2026-10-12' }, null, 2));
  });

  it('does not walk the prototype chain', () => {
    expect(() => renderValues('{{constructor}}', {})).toThrow(TemplateError);
  });
});

describe('parseFrontMatter', () => {
  it('parses mode and strips comments', () => {
    const { meta, body } = parseFrontMatter('---\nmode: append # site text goes last\n---\nBody text.\n');
    expect(meta).toEqual({ mode: 'append' });
    expect(body).toBe('Body text.\n');
  });

  it('returns the raw text when there is no front matter', () => {
    const { meta, body } = parseFrontMatter('Just text.\n');
    expect(meta).toEqual({});
    expect(body).toBe('Just text.\n');
  });
});

describe('renderTemplate', () => {
  it('expands partials through the loader before substituting values', async () => {
    const partials = { 'system/rules.md': { body: 'Rules for {{site.domain}}.', file: 'system/rules.md' } };
    const text = await renderTemplate('Head.\n{{> system/rules}}\nTail.', { site: { domain: 'sayii.com' } }, {
      loadPartial: async (name) => partials[name],
    });
    expect(text).toBe('Head.\nRules for sayii.com.\nTail.');
  });

  it('expands partials nested inside partials', async () => {
    const partials = {
      'a.md': { body: 'A {{> b}}', file: 'a.md' },
      'b.md': { body: 'B {{value}}', file: 'b.md' },
    };
    const text = await renderTemplate('{{> a}}', { value: 'v' }, { loadPartial: async (name) => partials[name] });
    expect(text).toBe('A B v');
  });

  it('errors when a partial is used with no loader', async () => {
    await expect(renderTemplate('{{> system/rules}}', {})).rejects.toThrow(/partial \{\{> system\/rules\}\} with no loader/);
  });

  it('errors when partials nest more than 5 deep', async () => {
    const loadPartial = async (name) => ({ body: `{{> ${name}}}`, file: name });
    await expect(renderTemplate('{{> loop}}', {}, { loadPartial })).rejects.toThrow(/partials nest more than 5 deep/);
  });
});
