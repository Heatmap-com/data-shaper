import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { createLayeredPromptSource } from '../../src/orchestrator/adapters/prompts/layered-fs.js';
import { NotFoundError } from '../../src/orchestrator/domain/errors.js';

const root = path.join(import.meta.dirname, 'fixtures', 'prompts');
const prompts = createLayeredPromptSource({ root });
const general = path.join(root, 'general', 'prompts');
const sayii = path.join(root, 'sites', 'sayii', 'prompts');

describe('layered prompt source', () => {
  it('replaces the general prompt by default', async () => {
    const { text, sources } = await prompts.render('fallback/naming.md', {}, { site: 'sayii' });
    expect(text).toBe('Fix naming for Sayii only.\n');
    expect(sources).toEqual([path.join(sayii, 'fallback', 'naming.md')]);
  });

  it('appends the site prompt after the general one', async () => {
    const { text, sources } = await prompts.render('fallback/stage.md', { job: { id: 'j1' } }, { site: 'sayii' });
    expect(text).toBe('Generic recovery for j1.\n\n\nSayii-specific recovery notes.\n');
    expect(sources).toEqual([path.join(general, 'fallback', 'stage.md'), path.join(sayii, 'fallback', 'stage.md')]);
  });

  it('prepends the site prompt before the general one', async () => {
    const { text } = await prompts.render('fallback/report.md', {}, { site: 'sayii' });
    expect(text).toBe('Sayii report preamble.\n\n\nGeneral report guidance.\n');
  });

  it('uses a site-only prompt when the general one is absent', async () => {
    const { text, sources } = await prompts.render('primary/only.md', {}, { site: 'sayii' });
    expect(text).toContain('Sayii-only primary prompt.');
    expect(sources[0]).toBe(path.join(sayii, 'primary', 'only.md'));
  });

  it('throws NotFoundError when neither layer has the prompt', async () => {
    await expect(prompts.render('fallback/nope.md', {}, { site: 'sayii' })).rejects.toThrow(NotFoundError);
    await expect(prompts.sources('fallback/nope.md', {})).rejects.toThrow(/no prompt fallback\/nope\.md/);
  });

  it('rejects a name outside the prompt classes', async () => {
    await expect(prompts.sources('../secret.md', {})).rejects.toThrow(NotFoundError);
  });

  it('resolves a partial site first, then general', async () => {
    const { text, sources } = await prompts.render('primary/only.md', {}, { site: 'sayii' });
    expect(text).toContain('Follow the shared agent rules.');
    expect(sources).toEqual([
      path.join(sayii, 'primary', 'only.md'),
      path.join(general, 'system', 'agent-rules.md'),
    ]);
  });

  it('lists sources general first', async () => {
    const sources = await prompts.sources('fallback/stage.md', { site: 'sayii' });
    expect(sources).toEqual([path.join(general, 'fallback', 'stage.md'), path.join(sayii, 'fallback', 'stage.md')]);
  });

  it('renders the general prompt when no site is given', async () => {
    const { text, sources } = await prompts.render('fallback/naming.md', { site: { domain: 'x.test' } });
    expect(text).toBe('Fix the naming stage for x.test.\n');
    expect(sources).toEqual([path.join(general, 'fallback', 'naming.md')]);
  });
});
