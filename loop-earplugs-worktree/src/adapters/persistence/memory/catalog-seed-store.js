import { aeNow } from './support.js';

/**
 * The CatalogSeedStore role over memory: the reference seed of requirements, strategies, crosswalk, and screen rules.
 * @param {object} support the adapter's shared state from support.js
 * @returns {import('../../../ports/persistence/catalog-seed-store.js').CatalogSeedStore}
 */
export function createCatalogSeedStore({ store }) {
  return {
    /**
     * Idempotent seed of the four reference tables; same-version rows are
     * replaced on re-run.
     * @param {object} bundle loadCatalog()
     */
    async seedReference(bundle) {
      for (const r of bundle.requirements.requirements ?? []) {
        store.requirements.set(`${bundle.requirements.registry_version}:${r.key}`, {
          registry_version: bundle.requirements.registry_version,
          requirement_key: r.key,
          domain: r.domain ?? '',
          title: r.title ?? '',
          source_layer: r.source_layer ?? '',
          mechanism: r.mechanism ?? '',
          dataset_ids: [...(r.dataset_ids ?? r.datasets ?? [])],
          grain: r.grain ?? '',
          human_required: r.human_required ? 1 : 0,
          generated_at: aeNow(),
        });
      }
      for (const catalog of Object.values(bundle.strategies ?? {})) {
        for (const s of (catalog.strategies ?? []).filter((x) => !x.card_only)) {
          store.strategyCatalog.set(
            `${catalog.catalog_version}:${catalog.catalog_id}:${s.id}`,
            {
              catalog_version: catalog.catalog_version ?? '',
              catalog_id: catalog.catalog_id,
              strategy_id: s.id,
              family: s.family ?? '',
              name: s.title ?? '',
              scope: s.scope ?? '',
              surface: s.surface ?? '',
              tools: [...(s.tools ?? [])],
              requirement_keys: [...(s.requirement_keys ?? [])],
              composite_of: [...(s.composite_of ?? [])],
              alias_of: s.alias_of ?? '',
              spec: JSON.stringify(s.spec ?? {}),
              source_ref: s.source_ref ?? '',
              generated_at: aeNow(),
            },
          );
        }
      }
      for (const entry of bundle.crosswalk.entries ?? []) {
        for (const member of entry.members ?? []) {
          store.crosswalk.set(
            `${bundle.crosswalk.catalog_version}:${entry.intent_id}:${member}`,
            {
              catalog_version: bundle.crosswalk.catalog_version ?? '',
              intent_id: entry.intent_id,
              catalog_id: member.slice(0, member.indexOf(':')),
              strategy_id: member,
              relation: entry.relation ?? '',
              generated_at: aeNow(),
            },
          );
        }
      }
      for (const rule of bundle.screenRules.rules ?? []) {
        store.screenRules.set(
          `${bundle.screenRules.version}:${rule.catalog}:${rule.id}`,
          {
            catalog_version: bundle.screenRules.version ?? '',
            catalog_id: rule.catalog ?? '',
            rule_id: rule.id,
            kind: rule.kind ?? '',
            applies_to: [...(rule.applies_to ?? [])],
            disposition: rule.disposition ?? '',
            spec: JSON.stringify(rule.spec ?? {}),
            source_ref: rule.source_ref ?? '',
            generated_at: aeNow(),
          },
        );
      }
    },
  };
}
