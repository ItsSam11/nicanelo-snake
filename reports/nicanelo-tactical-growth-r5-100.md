# Nicanelo R5: tactical food and head-to-head protection

Date: 2026-09-21

## Scope and evaluation configuration

The R5 campaign evaluated the local engine with tactical food, strategic
posture, and head-to-head selection protection. Nicanelo's public application
was not changed.

- 50 Challenger games and 50 Legacy games, five games per Job.
- The same seeds, opponents, seat rotations, and configuration as R4.
- Four workers, a 150 ms search budget, and a 100 ms external reserve.
- The fixed `heuristic-adaptive-control-v1` model.
- A 121-input local manifest and verified immutable R5 engine/image artifacts.

Exact campaign identifiers, build tags, and artifact hashes are retained in
the local archive.

Before deployment, hashes of the eight changed compiled modules and the model
were compared inside ACR with the local build; all matched byte for byte.
The image tag was locked against writes and deletion.

## Verification

- The local suite passed 249/249 tests.
- Bicep compiled, and `az deployment group validate` finished with `Succeeded`.
- The `what-if` showed 20 new R5 Jobs, zero deletes, and zero modifications;
  the public app was ignored.
- The canary used the first five games of each cohort and counted toward the
  final 100 games.
- 20/20 executions finished with `Succeeded`; the complete staggered window
  lasted 13 minutes and 17 seconds.
- 860 blobs (425,129,907 bytes) were produced, with no `failure.json` or empty
  files: 100 records, 100 summaries, 100 observations, 100 search-observations,
  100 telemetry files, and the expected manifests/root files.
- 100 seeds, 100 IDs, and 100 unique pairs were validated, with full coverage.
- All 100 pairs matched exactly in cohort, seed, `snakeOrder`, rules, map,
  board, roster, and Zoo configuration.
- Across all 20 shards, `job.json`, `provenance.json`, and the completion
  marker repeated the same engine, image, digest, model, hash, and campaign ID.

## R4 versus R5 results

|Cohort|Campaign|Wins|Top 2|Placements 1/2/3/4|Mean placement|Survival|Food|Maximum length|
|---|---|---:|---:|---|---:|---:|---:|---:|
|Challenger|R4|0/50|4/50|0 / 4 / 46 / 0|2.92|229.54|5.46|8.46|
|Challenger|R5|0/50|9/50|0 / 9 / 41 / 0|2.82|238.34|7.88|10.88|
|Legacy|R4|5/50|22/50|5 / 17 / 14 / 14|2.74|221.74|7.32|10.32|
|Legacy|R5|5/50|26/50|5 / 21 / 18 / 6|2.50|241.68|11.14|14.14|
|Total|R4|5/100|26/100|5 / 21 / 60 / 14|2.83|225.64|6.39|9.39|
|Total|R5|5/100|35/100|5 / 30 / 59 / 6|2.66|240.01|9.51|12.51|

R5 won four games that R4 had lost and lost four that R4 had won; it retained
one win. For top-2 finishes there were 23 improvements, 14 losses, 12 retained
pairs, and 51 pairs outside the top 2 in both campaigns. The two-sided exact
McNemar test gives `p=0.1877` for top-2 finishes and `p=1.0` for wins.

|Paired metric, R5 - R4|Delta|Bootstrap 95%|Better / equal / worse|
|---|---:|---:|---:|
|Total food|+3.12|[1.90, 4.34]|63 / 6 / 31|
|Maximum length|+3.12|[1.89, 4.34]|63 / 6 / 31|
|Food through T20|+0.70|[0.51, 0.89]|57 / 36 / 7|
|Food through T50|+1.23|[0.94, 1.52]|66 / 23 / 11|
|Survival|+14.37|[-12.34, 41.44]|52 / 0 / 48|
|Mean placement|-0.17|[-0.36, 0.01]|30 / 49 / 21|
|Top-2 rate|+0.09|[-0.03, 0.21]|23 / 63 / 14|

Intervals use a paired percentile bootstrap with 100,000 resamples and a
fixed seed. Early and total growth are clear in this sample; improvements in
top-2 rate, placement, and survival remain inconclusive with 100 pairs.

## Early growth

|Cohort|Food through T20, R4 -> R5|Food through T50, R4 -> R5|
|---|---:|---:|
|Challenger|0.68 -> 1.36|0.94 -> 2.02|
|Legacy|1.14 -> 1.86|1.70 -> 3.08|
|Total|0.91 -> 1.61|1.32 -> 2.55|

- Games with at least one food capture through T20: 68/100 -> 97/100.
- Games with at least two food captures through T50: 30/100 -> 76/100.
- First food capture: median T7 -> T2; observed mean 21.35 -> 4.97; games
  without any food capture 2 -> 0.
- Second food capture: median T91 -> T18; observed mean 77.64 -> 32.46; games
  without a second food capture 10 -> 4.

Food-capture turns were reconstructed from length increases between
consecutive states. T20 and T50 are inclusive; first/second food-capture means
and medians include only games where the event occurred, with missing events
reported separately.

## Defeats and head-to-head collisions

|Cause|R4|R5|
|---|---:|---:|
|Head-to-head against a strictly longer opponent|84|83|
|Starvation|9|5|
|Opponent body|0|4|
|Own body|2|2|
|Wall|0|1|

R5's 83 H2H defeats were reconstructed from the selected move and the next
frame: the surviving opponent occupied the destination and was strictly
longer than Nicanelo's projected length, including food at that destination.
Ties and ambiguous cases were excluded.

H2H defeats by opponent changed as follows: Hobbs 48 -> 36, Snork 25 -> 33,
Devin 9 -> 13, and Irene 2 -> 1. Reduced starvation is consistent with the
change's objective, but greater length did not yet produce a material
reduction in H2H defeats.

## Search, latency, and behavior profile

- Measured requests: 22,564 -> 24,001.
- R4 -> R5 latency: p50 151 -> 150 ms, p95 158 -> 158 ms, p99 166 -> 165 ms,
  maximum 229 -> 232 ms, below the 500 ms timeout.
- Decisions using search: 22,649/22,664 (99.934%) -> 24,092/24,101 (99.963%).
- Mean completed workers: 3.9950 -> 3.9959; incomplete decisions 74 -> 75,
  proportionally 0.327% -> 0.311%.
- Mean iterations: 200.48 -> 211.80; tree reuse 80.36% -> 80.72%.
- `fallbackProtected` remained zero. Root-risk overrides increased from
  245 to 528 (1.08% -> 2.19%).

The observed aggression score decreased from 0.4655 to 0.3978, with paired
delta `-0.0677` and 95% interval `[-0.1067, -0.0289]`. Conservatism decreased
from 0.7132 to 0.6925, with delta `-0.0207` and interval `[-0.0353, -0.0061]`.

The aggression metric is not a pure measure of pressure: its formula
explicitly subtracts resource acquisition and escape gain, so eating more
mechanically reduces it. The opportunity-weighted variant also decreased;
this campaign does not demonstrate that tactical aggression was preserved
or improved.

## Conclusion

The adjustment met its immediate objective: Nicanelo eats much earlier and
finishes substantially longer, without a latency regression. Fourth-place
finishes decreased from 14 to 6 and top-2 finishes increased from 26 to 35,
although those placement signals remain uncertain with 100 pairs.

There is no evidence of improved final playing strength: wins remained 5/100
and H2H deaths against longer opponents were 83 versus 84. Improved aggression
is also unproven. R5 should remain a challenger rather than being automatically
promoted to production. The next adjustment should convert length advantage
into pressure, traps, and better H2H decisions while preserving early food
gains and safety limits.

After the campaign, the eight Zoo apps had `minReplicas=0`, zero active
revisions, and zero replicas. The six `GymD32` pools reported `NodeCount=0`.
