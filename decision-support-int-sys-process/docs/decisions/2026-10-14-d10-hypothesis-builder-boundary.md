# D-10: the hypothesis builder is a sibling repo with a read-only seam

**Context:** the platform vision (`docs/VISION.md`) defines an **Agile** mode — a
client question becomes new shaped data, built agentically against the engine's
extension points (declarations, single files, checks). The workflow is: question →
interactive hypothesis building → gap analysis → data-shaping plan → agentic build.
The question was where that workflow lives: inside this repo or beside it.

**Answer (probed):** the engine's load-bearing rule is *measure here, write
there* — one writer per table, interpretation kept out of measurement, create-only
schema, idempotency everywhere. Hypothesis state (questions, hypotheses, gap
analyses, plans, session transcripts) is conversational, mutable, deletable —
every property the engine's persistence posture forbids. The engine already
publishes everything the workflow needs as a read model: `ae_strategy_card_current`,
`ae_requirement_status_current`, `ae_dataset_row_current`, trend rows, and the
seeded reference tables (`ae_requirement`, `ae_strategy_catalog`) that mirror the
catalog bundle.

**Decision:** the hypothesis builder is a **separate repository**. It owns its
own store and deployment. It reads the information hierarchy through the engine's
`_current` views and the catalog at a pinned version; it never writes engine
tables. Proposals cross the boundary as **data + code** (segmentation
declarations, profile descriptors, dataset specs) and are accepted only when the
engine's own checks pass — the builder proposes, the engine disposes. Links from
hypotheses to engine artifacts are stored in the builder's store as references
(batch id, card id); no engine columns are added for hypotheses.

**Consequences:** the engine gains nothing and keeps sole-writer status; the
builder's iteration speed is unconstrained by engine schema safety and
architecture-test allowlists. The cost is a versioned contract: the builder pins
the engine ref/catalog version it reads, and a catalog version change is a
builder-side re-index, silent never.

**Rejected:** hypothesis tables inside the engine (violates the write boundary
and drags conversational lifecycle into create-only DDL); the builder writing
engine tables directly (breaks idempotency and "the engine does not trust the
agent"); a shared library importing engine code (couples deployment cycles;
the read model is the API).
