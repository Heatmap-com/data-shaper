# D-14: the `utm_medium` field reads the visit variable (segmentation plan SG0.5)

**Decision:** the `utm_medium` segmentation field is `custom_var_v1` on the
visit's first action, lowercased and trimmed, the column the analyst bundle
already reads as `med`. Every grain that maps the field (trend, tag trend,
experiments, bundle, triggers) reads it from the visit row. The bundle's
`med` does not change.

**Evidence:** `docs/probes/2026-10-medium-source.md`. Where both sources
are set, they agree on 99.9% of Mellow's visits and, on the `utm_medium`
key, on 99.9% of DVF's. The visit variable is set on more visits than the
tag on both sites, and it needs no scan of `udp_session_tags`.

**The trigger rule is a defect.** The trigger chains read the first
session-tag key whose name contains `medium`. On DVF that is often
`tw_medium`, a second tracker's key, so 2,440 of DVF's visits in one week
carry a medium that is not their UTM medium. SG10 gives trigger sessions
the `utm_medium` field from the visit variable. The existing `medium`
dimension on trigger trends keeps its current reading until a reviewed
change moves it, so stored trigger rows do not shift under this initiative.

**Rejected:** the session tag as the source, which needs one more scan per
query and reads a second tracker's key on DVF. Averaging or merging the
two, which would give a value neither source recorded. Falling back to the
tag when the variable is empty, which adds the scan for 1% of DVF's visits
and makes the field's meaning depend on which source a visit had.
