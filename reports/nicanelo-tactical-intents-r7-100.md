# Nicanelo R7: tactical intents, growth, and continuity

Date: 2026-09-21

## Executive decision

R7 was promoted to production because it improved placement, total growth,
and several tactical-conversion indicators relative to R6 in 100 paired games.
Wins increased from 1 to 4, top-2 finishes from 31 to 44, and mean placement
improved from 2.78 to 2.56. Mean food increased from 9.34 to 12.54, and mean
maximum length from 12.34 to 15.54.

The improvement is not uniform. R7 ate less before T20 and delayed median
first food capture from T2 to T10, although it grew substantially more from
T50 onward. Starvation deaths decreased from 9 to 0 and losing H2Hs against
strictly longer opponents from 86 to 78, but own-body collisions increased
from 3 to 11. Delayed early food and own-body collisions are the main remaining
limits for a future iteration.

The R7 campaign used a 350 ms search budget, while R6 used 150 ms. Pairing
controls seed, roster, order, and seat, but cannot attribute the outcome only
to policy changes: it evaluates the complete R7 package that was promoted.

## Implementation

Decision-making separates seven intents instead of treating aggression as a
single scalar:

- `FORCE_H2H`: offers a collision only when projected length strictly wins;
  an equal-length collision remains losing.
- `CONSTRICT_TRAP`: makes progress toward causally restricting space or exits.
- `SPACE_DENIAL`: controls useful territory without requiring an immediate
  collision.
- `THIRD_PARTY_LEVERAGE`: uses an independent third-party threat without
  assuming cooperation or exposing Nicanelo to that third party.
- `RESOURCE_GROWTH`: gains length through a controlled food route.
- `RECOVER`: prioritizes food when health or route slack requires it.
- `SURVIVE`: preserves an exit when no safe tactical action is available.

Food catch-up is bounded to deficits of 2–6 segments and controlled food
within six steps. The final root selector and static fallback reject
abandoning that route unless a win is fully proven. Safety, food, pressure,
and H2H retain independent gates; post-game metrics do not directly feed
`chooseMove`.

## Local verification and artifact integrity

- `npm run check`: passed on the final source tree.
- Tests: 270/270 outside `server.test`, plus 3/3 server tests in an environment
  with loopback access; 273/273 overall.
- Evaluation Jobs and production used separately verified immutable images.
- Both ACR tags were locked against writes and deletion.
- The fixed model was `heuristic-adaptive-control-v1`.
- The code-context hash was recorded for reproducibility.

Exact image tags, digests, code-context hashes, and model hashes are retained
in the local archive.

## Azure campaign

- 50 Challenger games and 50 Legacy games; no additional games were started.
- 20/20 Jobs finished with `Succeeded`; 0 failures.
- 860 blobs, 416,561,067 bytes, 0 empty files, and 0 `failure.json` files.
- Exactly 43 blobs for each of the 20 shards.
- 100 records and 100 unique IDs.
- 100/100 exact pairs by cohort, seed, `snakeOrder`, and Nicanelo's seat.
- The full analysis artifact and its digest were recorded locally.

Exact campaign identifiers and machine-specific analysis paths are retained
in the local archive.

## R6 versus R7 results

|Cohort|Campaign|Wins|Top 2|Placements 1/2/3/4|Mean placement|Mean survival|Mean food|Mean maximum length|
|---|---|---:|---:|---|---:|---:|---:|---:|
|Challenger|R6|0/50|5/50|0 / 5 / 45 / 0|2.90|236.72|7.84|10.84|
|Challenger|R7|0/50|12/50|0 / 12 / 38 / 0|2.76|225.52|10.46|13.46|
|Legacy|R6|1/50|26/50|1 / 25 / 14 / 10|2.66|250.22|10.84|13.84|
|Legacy|R7|4/50|32/50|5 / 27 / 13 / 5|2.36|245.10|14.62|17.62|
|Total|R6|1/100|31/100|1 / 30 / 59 / 10|2.78|243.47|9.34|12.34|
|Total|R7|4/100|44/100|5 / 39 / 51 / 5|2.56|235.31|12.54|15.54|

One of R7's five first-place finishes was a draw with no winner, yielding
four official wins. In paired games, R7 gained four new wins and lost one R6
win; the two-sided McNemar test gives `p=0.375`. For top-2 finishes there were
25 improvements and 12 losses, with `p=0.0470`.

|Paired delta, R7 - R6|Delta|Bootstrap 95%|
|---|---:|---:|
|Mean placement, lower is better|-0.22|[-0.39, -0.05]|
|Mean survival|-8.16|[-33.49, 16.99]|
|Mean total food|+3.20|[1.85, 4.59]|
|Mean food through T20|-0.22|[-0.37, -0.07]|
|Mean food through T50|+0.42|[0.14, 0.69]|

Intervals use a paired percentile bootstrap with 100,000 resamples and a fixed
seed. Placement and total-growth signals are positive; four wins remain a
small sample.

## Food timing

|Aggregate metric|R6|R7|
|---|---:|---:|
|Total food|934|1,254|
|Mean per game|9.34|12.54|
|Food through T20|154|132|
|Food through T50|249|291|
|First food capture, median|T2|T10|
|First food capture, mean|T4.93|T9.97|
|Games without a first food capture|0|0|
|Second food capture, median|T20|T26|
|Games without a second food capture|2|1|

R7 did not meet the literal subobjective of eating earlier at the beginning.
Its improvement is that it almost always establishes a route and then grows
more from T20–T50 onward, gains an advantage in 99/100 games, and avoids
starvation. This behavior was not changed after the campaign, because doing
so would have put production on code different from the evaluated version.

## Observed intents

A retrospective analyzer applied the current R7 evaluator to each selected
move in both campaigns. This measures which intent best describes the observed
action; it does not claim that R6 emitted those labels during live play.

|Metric|R6|R7|
|---|---:|---:|
|Classified turns|24,447|23,631|
|Offensive intent|2,111 / 8.64%|2,831 / 11.98%|
|`FORCE_H2H`|378|776|
|`CONSTRICT_TRAP`|917|993|
|`SPACE_DENIAL`|816|1,062|
|`RESOURCE_GROWTH`|6,933|7,779|
|`RECOVER`|1,263|149|
|Required route abandoned|2,869 / 11.74%|34 / 0.14%|
|Food-capturing move|938|1,256|

`THIRD_PARTY_LEVERAGE` was not the dominant intent on any turn. The logic was
available, but this sample does not demonstrate that it changed a final decision.

Post-game metrics also show more converted advantage:

- turns with an advantage: 8,053 -> 13,324;
- global lead: 1,092 -> 2,722, or 13.56% -> 20.43% of turns with an advantage;
- selected pressure: 132/157 -> 182/213;
- selected constrictions: 848/1,186 -> 1,374/1,927;
- favorable H2H offers: 466/642 -> 834/1,041, or 72.59% -> 80.12%;
- opponent eliminations while Nicanelo led: 42 -> 66;
- eliminations while Nicanelo led globally: 0 -> 10.

Eliminations are temporal associations, not causal attribution of kills.

## Terminal causes

|Terminal cause|R6|R7|Delta|
|---|---:|---:|---:|
|Win|1|4|+3|
|H2H against a strictly longer opponent|86|78|-8|
|Starvation|9|0|-9|
|Opponent body|1|5|+4|
|Own body|3|11|+8|
|Wall|0|1|+1|
|Ambiguous/tie|0|1|+1|

The classifier uses the actual `selectedMove`, simulates the turn, and marks
an H2H as strictly losing only when a longer opponent survives. Ties and
non-unique causes are excluded from that category.

## Latency and search

- R7 used a 350 ms budget and a declared 100 ms reserve against a 500 ms timeout.
- Sample-weighted mean p95: 374.20 ms.
- Median per-game p95: 374 ms.
- Highest per-game p95: 390 ms.
- Observed maximum: 434 ms; Nicanelo had no timeouts.
- The local benchmark over 24 states produced mean iterations of 420.9 at
  250 ms, 585.3 at 350 ms (+39.1%), and 630.2 at 400 ms (+7.7% over 350).
  At 400 ms, the external margin was too narrow, so production used 350/100.

Azure ran five simultaneous lanes per Job. Under that contention,
`usedSearch` was 17,250/23,631, mean completed workers were 2.386/4, and
13,993 decisions completed fewer than four workers. R6 at 150 ms recorded
24,440/24,447 and 3.995/4. The R7 package still improved competitive results,
in part because the fallback shares the same tactical gates; a 350 ms budget
should not be interpreted as a free benefit under concurrent load.

## Production and continuity

Only the public Container App was promoted directly, avoiding the general
deployment that also reconciles Jobs and Zoo resources.

- Revision: the R7 production revision; its infrastructure identifier is local.
- State: `Healthy`, `Provisioned`, `RunningAtMaxScale`.
- Image: the exact verified R7 production image.
- Traffic: 100% R7, with one active revision.
- Scale: `minReplicas=1`, `maxReplicas=1`; one replica observed.
- Configuration: `SNAKE_VERSION=2.0-alpha-r7`, 350 ms search, 100 ms reserve.
- 20/20 endpoint reads returned R7, with no 404 responses.

This corrects the observed round-robin distribution: while the replica is
alive, all turns reach the same process and retain the tree and history
partitioned by `game.id`. A process restart still loses in-memory state;
handling continuity across process changes would require game-aware routing
or distributed persistence outside the synchronous `/move` path.

After securing the artifacts, the eight Zoo apps were updated to
`minReplicas=0` and `maxReplicas=1`. Azure retained a validation replica after
cooldown, so only those internal gym revisions were deactivated. Final
verification found zero active revisions and zero replicas in all eight apps;
the six `GymD32` pools also reported `currentCount=0`.

## Next risk, without another campaign

As instructed, work stopped after these 50+50 games. The most useful finding
for a future iteration is that the food gate eliminates starvation and
improves final growth but delays the first food capture and increases
own-body closures. The next change should target those two issues while
keeping metrics separate and avoiding a global increase in aggression.
