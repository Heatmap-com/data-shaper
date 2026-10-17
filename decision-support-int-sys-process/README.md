# Analysis engine

Landing-page analysis pipeline. The pipeline is described in `docs/`.

## Triggers

A trigger is a named predicate over sessions or visitors. Abandoned Cart, Showed Interest, and Super-Shopper ship in `src/triggers/defaults.json`. Thresholds live in that config, and a site overrides them with a row in `ae_trigger_definition`. Each hit records the version that produced it, and the same visitor's later sessions are followed for the chain window.

The feature, the tables, the batch, the week-over-week query, and how to add a trigger without code are written up in [docs/TRIGGER-CHAINS.md](docs/TRIGGER-CHAINS.md).
