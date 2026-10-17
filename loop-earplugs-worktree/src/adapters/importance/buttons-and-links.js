/**
 * Baseline importance: every button and every link on the page.
 * Priority 100 leaves lower numbers for a more specific adapter (names,
 * behavior, a Playwright pass) to claim a selector first.
 */

/** @type {import('../../ports/importance.js').ImportanceDescriptor} */
export const adapter = {
  id: 'buttons-and-links',
  priority: 100,
  strategy: 'match',
  select: [
    { tag: 'button', kind: 'button' },
    { tag: 'a', kind: 'link' },
    { tag: 'input', type: 'submit', kind: 'button' },
    { tag: 'input', type: 'button', kind: 'button' },
    { tag: 'input', type: 'image', kind: 'button' },
    { role: 'button', kind: 'button' },
    { role: 'link', kind: 'link' },
  ],
};
