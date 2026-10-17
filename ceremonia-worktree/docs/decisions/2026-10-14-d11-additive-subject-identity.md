# D-11: subject identity is additive (execution-profiles plan §9; P2)

**Decision:** a subject other than a page is stored under the existing
keys with two more columns, `subject_type` and `subject_key`, on
`ae_dataset_row`, `ae_analysis_checkpoint`, `ae_requirement_status`, and
`ae_strategy_card` (and `subject_type` on `ae_batch`). The schema migrator
adds them with a whitelisted `ADD COLUMN IF NOT EXISTS` and a default of
`'page'` and `''`, so every stored row reads as the page subject it was.
Non-page rows sit at `idsitehsr` 0. Their identity within a dataset is
carried by `row_key` and `segment_key`, and the checkpoint key format is
unchanged. Every `ORDER BY` is unchanged; a rebuild that puts the subject
into the sort key waits for a measured read cost.

The migration is tested against a fake client and the memory adapter. It
runs live the first time `ensure` runs against the production database,
which is the operator's step.

**Rejected:** rebuilding `ae_dataset_row` with the subject in its key now.
It costs downtime and risk for a read cost nobody has measured.
