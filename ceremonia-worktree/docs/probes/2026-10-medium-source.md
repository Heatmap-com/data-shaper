# Probe: where a visit's UTM medium comes from

**Run:** 14 October 2026, `node scripts/probes/medium-source.mjs --sites 5795,4879 --week 2026-10-05`, read only.
**Week:** 2026-10-05 to 2026-10-11.
**Question:** the analyst bundle reads the medium from `udp_hsrce_visits.custom_var_v1` at the visit's first action. The trigger chains read the first session-tag key whose name contains `medium`. Do the two agree, and which should the `utm_medium` segmentation field read? (Decision D-14.)

## Visits by agreement

| Class | DVF (5795) | Mellow (4879) |
|---|---:|---:|
| Both empty | 47,743 | 332,365 |
| Only the visit variable | 3,486 | 210,713 |
| Only the session tag | 714 | 11,508 |
| Both set and equal | 14,138 | 812,047 |
| Both set and different | 2,452 | 563 |

Mellow's two sources disagree on 0.07% of the visits where both are set. DVF's disagree on 14.8%.

## Why DVF disagrees

The second query names the tag key that carried the disagreeing value:

| Site | Key | The visit has more than one medium value | Visits |
|---|---|---|---:|
| DVF | `tw_medium` | yes | 2,440 |
| DVF | `utm_medium` | no | 7 |
| DVF | `utm_medium` | yes | 5 |
| Mellow | `utm_medium` | no | 306 |
| Mellow | `utm_medium` | yes | 257 |

DVF runs a second tracker that writes `tw_medium` beside `utm_medium`. The trigger rule takes whichever key containing `medium` comes first, so it reads `tw_medium` (`campaign`, `flow`, `affiliate`) on those visits. On `utm_medium` alone, DVF disagrees on 12 visits, under 0.1%.

The common disagreeing pairs (variable | tag) on DVF are `email | campaign`, `flow | campaign`, and `email | flow`, all from `tw_medium`. Mellow's are `social | paid` and `paid | social`, the kind a later pageview's tag gives when the visit arrived on one link and then followed another.

## Coverage

The visit variable is set on more visits than the tag on both sites: 20,076 against 17,304 on DVF, and 1,023,323 against 824,118 on Mellow. The tag is the only source for 714 DVF visits (1.0% of the week's 68,533) and 11,508 Mellow visits (0.8% of 1,367,196).
