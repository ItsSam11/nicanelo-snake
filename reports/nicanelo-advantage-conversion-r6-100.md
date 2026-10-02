# Nicanelo R6: safely converting length advantage

Date: 2026-09-21

## Executive conclusion

R6 implements an online signal that converts a strict length advantage into
tactical pressure, alongside separate metrics for pressure, constriction,
favorable head-to-head offers, and associated eliminations. The signal was
active: relative to R5, selection of projected constrictions increased from
68.41% to 71.50%, and favorable H2H offers from 67.79% to 72.59%.

The behavioral change did not produce a competitive improvement in this
sample. R6 went from 5 to 1 wins, from 35 to 31 top-2 finishes, and from mean
placement 2.66 to 2.78. Food stayed close to R5 (9.51 to 9.34; median first
food capture at T2 for both), and mean survival rose from 240.01 to 243.47 turns.

R6 should not be promoted to production. The next step should examine pairs
that lost a win or top-2 finish and improve conversion quality rather than
simply increasing its weight.

## Implementation and isolation

Online action selection uses one additional signal:

- `strictLengthControl` requires Nicanelo to be strictly longer than the target
  before the move. Eating on that move does not create a retroactive advantage
  when contesting food.
- `advantageConversion` is available only with positive health, enough space,
  at least one exit, positive offensive safety, and no immediately losing H2H.
- Exposure to a third opponent reduces or disables conversion.
- The increment is capped at 25% of an already bounded base-pressure signal.
  Length is not added again as an independent score.
- Food retains `foodAccess`; pressure uses `opponentPressure`. Legality,
  catastrophic penalties, forced-loss evidence, and the final H2H guard
  continue to take precedence.

H2H classification was extracted to `src/domain/head-to-head.ts` and is shared
by online decisions and post-game analysis, avoiding divergent definitions
of projected length.

The `post-length-advantage-v1` metrics are calculated after games and do not
enter `chooseMove`. Their denominators are independent:

- pressure: opportunity and relative selection among safe candidates;
- constriction: projected progress that reduces the target's space or exits,
  or increases its vulnerability;
- favorable H2H: opportunity and offer, not a claim that a collision occurred;
- eliminations: temporal disappearances while Nicanelo led, never causal
  attribution of a kill.

The `strategicAggression` block is optional and preserves compatibility with
historical schema-v2 summaries.

## Local tests

- `npm run check`: passed.
- `npm test`: 259/259 tests passed across 53 suites, with zero failures.
- New cases cover strict advantage, increment bounds, equal length, unsafe
  pockets, third-party exposure, food separation, contested food, independent
  denominators, missing frames, and historical summary compatibility.
- Existing tests retain final H2H reselection both per worker and after
  pooling, as well as catastrophic-safety precedence.

An independent audit found no flow from post-game metrics into online
decisions and no double counting between food and pressure. The Azure campaign
exercised the full search flow; unit interaction coverage is deliberately
layered and does not replace that runtime validation.

## Evaluation configuration

- 50 Challenger games and 50 Legacy games, five per Job.
- The same seeds, roster, seat rotations, and configuration as R5.
- The R6 advantage-conversion engine and a verified immutable evaluation image.
- The fixed `heuristic-adaptive-control-v1` model.
- A 130-input manifest.

Exact campaign IDs, registry references, image digests, and artifact hashes
are retained in the local archive.

ACR rebuilt the image, and compiled offense, evaluation, H2H, metrics, and
corpus modules, plus the model, were compared byte for byte. The tag was
locked against writes and deletion.

`bicep build`, deployment validation, and `what-if` passed. The `what-if`
created only the 20 R6 Jobs and expected evaluation resources; the public app
remained in `Ignore`, and R6 was not deployed to production.

## Campaign integrity

- The 30-game canary counted toward the 100 games.
- 20/20 Jobs finished with `Succeeded`.
- 860 blobs, 436,410,867 bytes, with no failure artifacts or empty files.
- 100 records, 100 observations, 100 search-observations, 100 telemetry files,
  100 manifests, 100 search-manifests, 100 run files, 120 summaries,
  20 `job.json` files, and 20 `provenance.json` files.
- 100 unique IDs and 100/100 exact pairs by cohort, seed, `snakeOrder`, and
  Nicanelo's seat.
- Complete coverage under Standard rules, the Standard map, and an 11x11 board.
- `post-length-advantage-v1` was present in all 100 summaries.
- Maximum Nicanelo latency: 249 ms, below the 500 ms timeout.

After securing the artifacts, the eight Zoo apps had `minReplicas=0` and zero
active revisions, while the six `GymD32` pools had `currentCount=0`.

## R5 versus R6 results

|Cohort|Campaign|Wins|Top 2|Placements 1/2/3/4|Mean placement|Survival|Food|Maximum length|
|---|---|---:|---:|---|---:|---:|---:|---:|
|Challenger|R5|0/50|9/50|0 / 9 / 41 / 0|2.82|238.34|7.88|10.88|
|Challenger|R6|0/50|5/50|0 / 5 / 45 / 0|2.90|236.72|7.84|10.84|
|Legacy|R5|5/50|26/50|5 / 21 / 18 / 6|2.50|241.68|11.14|14.14|
|Legacy|R6|1/50|26/50|1 / 25 / 14 / 10|2.66|250.22|10.84|13.84|
|Total|R5|5/100|35/100|5 / 30 / 59 / 6|2.66|240.01|9.51|12.51|
|Total|R6|1/100|31/100|1 / 30 / 59 / 10|2.78|243.47|9.34|12.34|

For wins, one pair improved and five regressed; the two-sided exact McNemar
test gives `p=0.21875`. For top-2 finishes there were 17 improvements and
21 losses, with `p=0.62710`. The sample does not statistically establish a
decline in strength, but its direction does not support claiming an improvement.

|Paired delta, R6 - R5|Delta|Bootstrap 95%|
|---|---:|---:|
|Mean placement, lower is better|+0.12|[-0.06, 0.31]|
|Survival|+3.46|[-20.49, 27.61]|
|Total food|-0.17|[-1.34, 1.01]|
|Maximum length|-0.17|[-1.34, 1.01]|
|Food through T20|-0.07|[-0.26, 0.12]|
|Food through T50|-0.06|[-0.35, 0.23]|
|Top-2 rate|-0.04|[-0.16, 0.08]|

Intervals use a paired percentile bootstrap with 100,000 resamples and a fixed
seed. R5's early growth is approximately preserved, but R6 does not improve
its conversion into placement or wins.

## Early food

|Metric|R5|R6|
|---|---:|---:|
|Mean food through T20|1.61|1.54|
|Mean food through T50|2.55|2.49|
|First food capture, mean|T4.97|T4.93|
|First food capture, median|T2|T2|
|Games without a first food capture|0|0|
|Second food capture, median|T19|T20|
|Games without a second food capture|4|2|

The new action signal did not undo R5's main improvement. The small decline
in total and early food is well within the uncertainty of 100 pairs.

## Defeats and head-to-head collisions

|Terminal cause|R5|R6|Delta|
|---|---:|---:|---:|
|Win|5|1|-4|
|H2H against a strictly longer opponent|83|86|+3|
|Starvation|5|9|+4|
|Opponent body|4|1|-3|
|Own body|2|3|+1|
|Wall|1|0|-1|
|Ambiguous|0|0|0|

Classification uses the actual `selectedMove`, the next frame, and projected
lengths after resolving food. An H2H is counted only when a single surviving
opponent occupies the destination and is strictly longer; ties and ambiguous
cases are excluded. As a control, the method exactly reproduced the published
R5 counts before it was applied to R6.

|Opponent in a strictly losing H2H|R5|R6|
|---|---:|---:|
|Devious-Devin|13|8|
|Hovering-Hobbs|36|42|
|Improbable-Irene|1|8|
|Snork-Tree|33|28|

Although R6 offered more favorable H2Hs when it had an advantage, it did not
reduce the dominant defeat mode: H2Hs against longer opponents increased from
83 to 86. Starvation rising from 5 to 9 also deserves investigation even though
mean food remained stable.

## Pressure, traps, and H2H after gaining an advantage

All 200 replays were reconstructed with the same current `buildReplayCorpus`.
R5 does not use embedded historical metrics here: it is reanalyzed with
exactly the same definition as R6.

|Metric|R5|R6|Rate change|
|---|---:|---:|---:|
|Turns with an advantage|7,939|8,053|—|
|Global lead / advantage|1,189 / 14.98%|1,092 / 13.56%|-1.42 pp|
|Selected pressure / opportunity|126/150 / 84.00%|132/158 / 83.54%|-0.46 pp|
|Selected constriction / opportunity|812/1,187 / 68.41%|848/1,186 / 71.50%|+3.09 pp|
|Favorable H2H offer / opportunity|423/624 / 67.79%|466/642 / 72.59%|+4.80 pp|
|Sustained pressure runs|17|16|—|

Paired bootstrap of the rates:

- pressure: -0.46 pp, 95% `[-8.87, 8.19]`;
- projected constriction: +3.09 pp, 95% `[-0.51, 6.81]`;
- favorable H2H offer: +4.80 pp, 95% `[0.08, 9.57]`;
- global lead per turn with an advantage: -1.42 pp, 95% `[-9.10, 6.12]`.

The clearest behavioral change was in favorable H2H offers. The signal did
not increase relative pressure selection, and global-lead time decreased
directionally, which is useful for diagnosing lost wins.

## Associated eliminations, not attributed kills

|Temporal association|R5|R6|
|---|---:|---:|
|Opponent eliminated while Nicanelo led|50|42|
|Opponent eliminated while Nicanelo led globally|7|0|
|Constricted target absent from the next frame|20|18|

The last association's rate per selected constriction went from 2.46% to
2.12%, with delta -0.34 pp and 95% bootstrap interval `[-1.69, 0.95]`.

These events are not kills attributed to Nicanelo. Official replays do not
retain an eliminated snake's final move, and multiple causes can be consistent
with a disappearance. Future causal attribution would require saving all
opponents' `/move` responses or internal rules-engine events.

## Latency

- Sample-weighted mean p95: 157.14 ms in R5 and 157.25 ms in R6.
- Observed maximum: 232 ms in R5 and 249 ms in R6.
- No measured Nicanelo request reached the 500 ms timeout.

Instrumentation is computed after each game and does not enter the synchronous
`/move` budget.

## Decision

The implementation achieves the intended isolation: food, safety, H2H, and
pressure retain separate channels; length advantage only enables a small,
safe offensive preference, and metrics do not participate in online decisions.

R6 does not demonstrate an engine improvement. It produces more favorable
H2H offers and somewhat more constriction, but less global-lead time and worse
raw results. It should remain an experimental challenger. Before another R7
iteration, review the six discordant win pairs and 38 discordant top-2 pairs,
especially in Legacy, to distinguish useful pressure from pressure that
surrenders late-game control.
