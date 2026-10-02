# Nicanelo tournament R1: paired Azure micro-evaluation

Operational references and artifact hashes are retained in the local archive.

Date: 2026-09-20

## Scope

This was one bounded Azure iteration. It compared the new adaptive engine and
baseline against the existing v1.3 results using the same four seeds, rosters,
and seat orders:

- Challenger: `2027100000`, `2027100001`
- Legacy: `2027120000`, `2027120001`

The evaluated model was `nicanelo-tournament-r1-20260920-v1`, packaged in:

`<image-reference-retained-locally>`

Image digest:

`<artifact-hash-retained-locally>`

The reference campaign was `<evaluation-reference-retained-locally>`
with model `nicanelo-v1.3-control-safe-main-20k-20260920-v1`.

## Paired results

| Cohort / seed | Placement | Last seen turn | Food / max length | Aggression | Conservatism | Nicanelo latency p50/p95/max |
|---|---:|---:|---:|---:|---:|---:|
| Challenger `2027100000` | 3 -> 2 | 185 -> 264 (+79) | 4/7 -> 8/11 | .179 -> .398 | .874 -> .706 | 71/74/104 -> 73/76/108 ms |
| Challenger `2027100001` | 2 -> 2 | 413 -> 357 (-56) | 16/19 -> 10/13 | .311 -> .387 | .863 -> .672 | 71/73/79 -> 73/76/106 ms |
| Legacy `2027120000` | 4 -> 3 | 219 -> 268 (+49) | 8/11 -> 4/7 | .233 -> .496 | .888 -> .721 | 72/76/100 -> 74/80/108 ms |
| Legacy `2027120001` | 4 -> 3 | 83 -> 270 (+187) | 1/4 -> 5/8 | .149 -> .345 | .889 -> .727 | 73/76/79 -> 74/78/111 ms |

Aggregate directional changes:

- Mean placement: 3.25 -> 2.50; three improvements and one tie.
- Mean last-seen turn: 225.0 -> 289.75 (+64.75); three improvements and one regression.
- Mean aggression: .218 -> .406 (+.188).
- Mean conservatism: .879 -> .706 (-.172).
- Mean food eaten: 7.25 -> 6.75; mean maximum length: 10.25 -> 9.75.
- No wins in either cohort.

The new behavior was materially less conservative in all four paired games,
and its placement improved without relying on additional growth. However, all
four new games were still classified as `conservatism`, so this is a useful
directional result rather than evidence that the engine is tournament-ready.

## Search integrity

Across 1,163 Nicanelo decisions:

- MCTS was accepted for 1,128 decisions (97.0%).
- The selected move differed from the static fallback 498 times (42.8%).
- `fallbackProtected` was never active.
- In 35 decisions (3.0%), at least one very-low-prior root action received
  zero visits, so the engine correctly fell back instead of claiming a valid
  MCTS result. Three selected fallback moves had zero search visits.
- Four workers completed on 1,162 decisions; one decision completed three of
  four workers and still had 140 iterations.
- Median aggregate iterations were 130; the range was 26 to 665.
- Nicanelo had no request timeout; its maximum observed latency was 111 ms
  against a 500 ms game timeout.

`deadlineReached` is true in search telemetry because each request consumes its
bounded search budget. It is not a Battlesnake request timeout.

## Most important failure found

The new prior can remain too dominant at the end of a short search. In Legacy
seed `2027120000`, turn 268, the pool selected `left` and Nicanelo died. The
aggregated root statistics were:

| Move | Visits | Prior | Mean value | Forced-loss rate | Risk-adjusted value |
|---|---:|---:|---:|---:|---:|
| left | 521 | .939 | -.981 | 98.85% | -1.000 |
| right | 117 | .009 | -.117 | 43.59% | -.523 |
| down | 27 | .052 | -.882 | 88.89% | -1.000 |

The final pool selector ranks actions primarily by visit count. Here, the
adaptive prior concentrated visits on an action even after the sampled value
identified it as overwhelmingly worse. The next high-leverage correction is a
final root decision rule that cannot let prior-driven visit inertia override a
large, adequately sampled risk-adjusted value gap, plus one guaranteed initial
visit per physical root action. Adding workers would not have rescued this
decision: all four workers completed and produced 665 iterations. Those changes
need another paired Azure micro-evaluation; they were deliberately not applied
after this run.

The two Challenger deaths also ended in constrained duel positions against a
much longer Snork-Tree. The engine survived to second place but did not convert
or escape the final edge/corner traps.

## Validation and cleanup

- `npm run check`: passed.
- `npm test`: 217/217 passed.
- No local matches were run for this iteration.
- Challenger Azure execution: 4 minutes 1 second.
- Legacy Azure execution: 5 minutes 17 seconds.
- Both temporary Container Apps Job definitions were deleted after telemetry
  was copied. The immutable image and telemetry were retained.
- Production traffic and production revisions were not changed.

With only four games, the result is too small to estimate win rate. It does
show that the adaptive posture changed actual decisions and reduced the old
single-profile behavior without a placement regression in this paired sample.
