# Probe: what the segmentation fan-out costs

**Run:** 14 October 2026, `node scripts/probes/segmentation-fanout.mjs --idsite 5795 --w0 2026-09-14 --w1 2026-10-09`, read only.
**Site and window:** DVF (5795), 2026-09-14 to 2026-10-09, the stored template paths `plp > pdp`, `pdp > plp > pdp`, and `home > plp > pdp > home`.
**Question:** does reading each segmentation as an `arrayJoin` of (segment, value) tuples cost more than today's crossed `GROUP BY` columns, and how does it grow with more segmentations? (Requirement N4, budget R20.)

## Seconds, three runs each

| Variant | What it reads | Runs | Median | Result rows |
|---|---|---|---:|---:|
| `crossed` | today's `pathAggregateSql('template')`: the four segmentations crossed in the `GROUP BY` | 2.4, 0.8, 0.8 | 0.8 | 4,834 |
| `fanout4` | the four as tuples plus `all`, in a subquery (the SG5 shape) | 0.8, 0.8, 0.9 | 0.8 | 8,853 |
| `fanout6` | `fanout4` plus the seven-value visit channel and a six-value stand-in for return intent | 1.2, 1.0, 1.0 | 1.0 | 14,384 |

The first `crossed` run warmed the cache.

## Correctness

`fanout4`'s `all` sessions equal the crossed query's totals in every one of the 1,357 (week, viewport, path) cells.

## Reading

The fan-out costs the same as today with the four shipped segmentations, and about a quarter more with six. That is well under the stop rule (twice today's seconds), so SG5 goes ahead. The result grows with the number of values rather than their product: `fanout6` returns 14,384 rows where the six crossed would return up to 7 × 2 × 2 × 2 × 7 × 6 combinations per cell. The budget stays at 48 values per query group (R20), which holds the shipped defaults plus `channel` and `return_intent` in one group.
