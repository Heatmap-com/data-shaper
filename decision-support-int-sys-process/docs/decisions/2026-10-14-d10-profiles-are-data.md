# D-10: profiles are data (execution-profiles plan §9; P3)

**Decision:** an execution profile is a file, `profiles/<id>.profile.json`,
that names its subject selector and criteria, its datasets, its catalogs,
and its step list. The composition root reads the profile and binds the
steps by key from `src/site-analysis/handlers.js` (`select-subjects`,
`subject-datasets`, `site-datasets`, `analysis`, and the landing-page
steps). The runner receives the resolved step list and loops over it, so
it holds no switch on the profile. A new profile is a new file plus, where
it needs one, a selector and datasets registered through their
descriptors.

The orchestrator reaches the profiles through the `analysis` stage. Its
params name the profile and the criteria (`{"profile": "lp", "select":
{}}`); a run patches them (`pdp-full`, `funnel`), a site sets them
(`"profile"` or `"stageParams"` in `site.json`), and `--set` wins over
both. The stage's check, `ae-batch-complete`, reads the stored batch, so
the batch status decides the stage.

**Rejected:** a `ProfilePort` with a module per profile. It duplicates the
discovery the descriptors already do and invites a fork of the runner per
profile.
