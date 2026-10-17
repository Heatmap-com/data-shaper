import { clock } from './support.js';

/**
 * The CatalogSeedStore role over ClickHouse: the reference seed of requirements, strategies, crosswalk, and screen rules.
 * @param {object} support the adapter's shared state from support.js
 * @returns {import('../../../ports/persistence/catalog-seed-store.js').CatalogSeedStore}
 */
export function createCatalogSeedStore({ client, database, log, run }) {
  return {
    /**
     * Idempotent seed of the four reference tables from the catalog bundle
     * (§8.6). Same-version rows are replaced by ReplacingMergeTree
     * semantics, so a re-run after a catalog edit ships as data. Expands
     * crosswalk members ("PO:A1") into one row per member.
     * @param {object} bundle loadCatalog()
     */
    async seedReference(bundle) {
      const ts = clock.now();

      const requirements = (bundle.requirements.requirements ?? []).map((r) => ({
        registry_version: bundle.requirements.registry_version,
        requirement_key: r.key,
        domain: r.domain ?? '',
        title: r.title ?? '',
        source_layer: r.source_layer ?? '',
        mechanism: r.mechanism ?? '',
        dataset_ids: r.dataset_ids ?? r.datasets ?? [],
        grain: r.grain ?? '',
        human_required: r.human_required ? 1 : 0,
        generated_at: ts,
      }));
      if (requirements.length > 0) {
        await client.insert({
          table: `${database}.ae_requirement`,
          format: 'JSONEachRow',
          values: requirements,
        });
      }

      const strategies = Object.values(bundle.strategies ?? {}).flatMap((catalog) =>
        (catalog.strategies ?? []).filter((s) => !s.card_only).map((s) => ({
          catalog_version: catalog.catalog_version ?? '',
          catalog_id: catalog.catalog_id,
          strategy_id: s.id,
          family: s.family ?? '',
          name: s.title ?? '',
          scope: s.scope ?? '',
          surface: s.surface ?? '',
          tools: s.tools ?? [],
          requirement_keys: s.requirement_keys ?? [],
          composite_of: s.composite_of ?? [],
          alias_of: s.alias_of ?? '',
          spec: JSON.stringify(s.spec ?? {}),
          source_ref: s.source_ref ?? '',
          generated_at: ts,
        })),
      );
      if (strategies.length > 0) {
        await client.insert({
          table: `${database}.ae_strategy_catalog`,
          format: 'JSONEachRow',
          values: strategies,
        });
      }

      const crosswalk = (bundle.crosswalk.entries ?? []).flatMap((entry) =>
        (entry.members ?? []).map((member) => ({
          catalog_version: bundle.crosswalk.catalog_version ?? '',
          intent_id: entry.intent_id,
          catalog_id: member.slice(0, member.indexOf(':')),
          strategy_id: member,
          relation: entry.relation ?? '',
          generated_at: ts,
        })),
      );
      if (crosswalk.length > 0) {
        await client.insert({
          table: `${database}.ae_strategy_crosswalk`,
          format: 'JSONEachRow',
          values: crosswalk,
        });
      }

      const screenRules = (bundle.screenRules.rules ?? []).map((rule) => ({
        catalog_version: bundle.screenRules.version ?? '',
        catalog_id: rule.catalog ?? '',
        rule_id: rule.id,
        kind: rule.kind ?? '',
        applies_to: rule.applies_to ?? [],
        disposition: rule.disposition ?? '',
        spec: JSON.stringify(rule.spec ?? {}),
        source_ref: rule.source_ref ?? '',
        generated_at: ts,
      }));
      if (screenRules.length > 0) {
        await client.insert({
          table: `${database}.ae_screen_rule`,
          format: 'JSONEachRow',
          values: screenRules,
        });
      }
      log('seedReference', {
        requirements: requirements.length,
        strategies: strategies.length,
        crosswalk: crosswalk.length,
        screenRules: screenRules.length,
      });
    },
  };
}
