/** @type {import('../../../../src/ports/importance.js').ImportanceDescriptor} */
export const adapter = {
  id: 'early',
  priority: 10,
  strategy: 'match',
  select: [{ tag: 'button', kind: 'button' }],
};
