import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { collectImportant } from '../src/importance/collect.js';
import { discoverImportance, IMPORTANCE_DIR } from '../src/importance/discover.js';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/importance');

const html = `
  <p>Intro</p>
  <button id="add">Add to cart</button>
  <a href="/cart">Cart</a>
  <div role="button">Menu</div>
  <input type="submit" value="Buy">
  <input type="text" name="q">
  <span>No</span>
`;

describe('importance adapters', () => {
  it('discovers declarative descriptors and runs them in priority order', async () => {
    const live = await discoverImportance(IMPORTANCE_DIR);
    expect(live.map((adapter) => adapter.id)).toEqual(['buttons-and-links']);
    expect(live[0].priority).toBe(100);
    expect(typeof live[0].important).toBe('undefined');

    const ordered = await discoverImportance(path.join(fixtures, 'ordered'));
    expect(ordered.map((adapter) => adapter.id)).toEqual(['early', 'late']);

    const found = collectImportant(ordered, { html });
    const button = found.find((element) => element.selector === '#add');
    const link = found.find((element) => element.selector === 'a[href="/cart"]');
    expect(button?.adapterId).toBe('early');
    expect(link?.adapterId).toBe('late');
  });

  it('selects buttons and links from the page', async () => {
    const adapters = await discoverImportance();
    const found = collectImportant(adapters, { html });
    expect(found.map((element) => [element.selector, element.kind])).toEqual([
      ['#add', 'button'],
      ['a[href="/cart"]', 'link'],
      ['div:nth-of-type(1)', 'button'],
      ['input[type="submit"]', 'button'],
    ]);
    expect(found.every((element) => element.adapterId === 'buttons-and-links')).toBe(true);
  });

  it('refuses a descriptor that is not declarative', async () => {
    await expect(discoverImportance(path.join(fixtures, 'missing-priority'))).rejects.toThrow(/priority/);
  });
});
