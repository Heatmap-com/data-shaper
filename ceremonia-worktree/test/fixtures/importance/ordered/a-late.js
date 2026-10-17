/** @type {import('../../../../src/ports/importance.js').ImportanceDescriptor} */
export const adapter = {
  id: 'late',
  priority: 50,
  strategy: 'match',
  select: [
    { tag: 'button', kind: 'button' },
    { tag: 'a', kind: 'link' },
  ],
};
