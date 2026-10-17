/** Placeholder for stages whose handler lands in a later phase. */
export const adapter = {
  id: 'pending',
  async run() {
    return { status: 'error', message: 'this stage has no handler yet' };
  },
};
