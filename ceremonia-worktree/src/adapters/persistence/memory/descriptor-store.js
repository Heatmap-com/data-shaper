import { aeNow } from './support.js';

/**
 * The DescriptorStore role over memory: page and store descriptors and the change log.
 * @param {object} support the adapter's shared state from support.js
 * @returns {import('../../../ports/persistence/descriptor-store.js').DescriptorStore}
 */
export function createDescriptorStore({ store }) {
  return {
    /**
     * @param {{idsite: number, template_key: string, device_class?: string}} key
     */
    async readPageDescriptor(key) {
      const deviceClass = key.device_class ?? 'all';
      return [...store.pageDescriptors.values()]
        .filter(
          (row) =>
            Number(row.idsite) === Number(key.idsite) &&
            row.template_key === key.template_key &&
            row.device_class === deviceClass,
        )
        .sort((a, b) => String(a.field_path).localeCompare(String(b.field_path)))
        .map((row) => ({ ...row }));
    },

    /** @param {{idsite: number}} key */
    async readStoreDescriptor(key) {
      return [...store.storeDescriptors.values()]
        .filter((row) => Number(row.idsite) === Number(key.idsite))
        .sort((a, b) => String(a.field_path).localeCompare(String(b.field_path)))
        .map((row) => ({ ...row }));
    },

    /**
     * @param {import('../../../ports/persistence.js').AeDescriptorRow[]} rows
     */
    async writeDescriptorRows(rows) {
      for (const r of rows) {
        const base = {
          idsite: r.idsite,
          field_path: r.field_path,
          value_json: r.value_json ?? 'null',
          provenance: r.provenance ?? '',
          confidence: r.confidence ?? '',
          human_confirmed_by: r.human_confirmed_by ?? '',
          owner: r.owner ?? '',
          captured_at: r.captured_at ?? aeNow(),
          expires_at: r.expires_at ?? '',
          invalidated_by: r.invalidated_by ?? '',
          descriptor_version: r.descriptor_version ?? 1,
          generated_at: aeNow(),
        };
        if (r.template_key !== undefined) {
          store.pageDescriptors.set(
            `${r.idsite}:${r.template_key}:${r.device_class ?? 'all'}:${r.field_path}`,
            { ...base, template_key: r.template_key, device_class: r.device_class ?? 'all' },
          );
        } else {
          store.storeDescriptors.set(`${r.idsite}:${r.field_path}`, { ...base });
        }
      }
    },

    /**
     * @param {number} idsite
     * @param {string} fromIso
     * @param {string} toIso
     */
    async readChanges(idsite, fromIso, toIso) {
      return [...store.changeLog.values()]
        .filter(
          (row) =>
            Number(row.idsite) === Number(idsite) &&
            String(row.effective_at) >= String(fromIso) &&
            String(row.effective_at) <= String(toIso),
        )
        .sort(
          (a, b) =>
            String(a.effective_at).localeCompare(String(b.effective_at)) ||
            String(a.change_id).localeCompare(String(b.change_id)),
        )
        .map((row) => ({ ...row }));
    },

    /** @param {import('../../../ports/persistence.js').AeChangeRow[]} rows */
    async writeChanges(rows) {
      for (const r of rows) {
        store.changeLog.set(`${r.idsite}:${r.change_id}`, {
          idsite: r.idsite,
          change_id: r.change_id,
          change_kind: r.change_kind,
          effective_at: r.effective_at,
          detected_at: r.detected_at ?? r.effective_at,
          source: r.source ?? '',
          subject: r.subject ?? '',
          detail: JSON.stringify(r.detail ?? {}),
          generated_at: aeNow(),
        });
      }
    },
  };
}
