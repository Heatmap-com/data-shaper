/** Placeholder for stages whose completion check lands with their handler. It never reports complete. */
export const adapter = {
  id: 'pending',
  describe() {
    return 'this stage has no completion check yet';
  },
  async evaluate() {
    return { ok: false, summary: 'this stage has no completion check yet', details: [] };
  },
};
