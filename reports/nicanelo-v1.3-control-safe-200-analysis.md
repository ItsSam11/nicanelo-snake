# Nicanelo v1.3 control-safe: 200-game analysis

Operational references and artifact hashes are retained in the local archive.

Campaign: `<evaluation-reference-retained-locally>`

Model: `nicanelo-v1.3-control-safe-main-20k-20260920-v1`

## Integrity

- 60/60 Azure Jobs succeeded.
- 200/200 game summaries, records, observations, and search-observation files exist.
- All 200 games have full turn coverage, exact Nicanelo elimination turns, and the expected model version.
- No duplicate cohort/seed pair and no failure marker was found.
- The run contains 46,559 Nicanelo search decisions.

## Tournament outcome

| Cohort | Games | 1st | 2nd | 3rd | 4th | Win rate | Top-two rate |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Challenger | 100 | 0 | 15 | 85 | 0 | 0% | 15% |
| Legacy | 100 | 2 | 22 | 42 | 34 | 2% | 24% |
| Combined | 200 | 2 | 37 | 127 | 34 | 1% | 19.5% |

Winners in challenger were Snork-Tree (87) and Hovering-Hobbs (13). Winners
in legacy were Hovering-Hobbs (93), Devious-Devin (5), and Nicanelo (2).

The raw win rate is better than the previous v1.2 alpha campaign (1/1,000),
and placement improved substantially, but the campaigns are not paired and
the new 1% win rate is still not tournament-ready.

## Search and latency health

- All four workers completed on 99.90% of moves.
- Search was used on 97.39% of moves.
- Every root move was visited on 97.66% of moves.
- Tree reuse occurred on 81.40% of moves.
- Iterations: median 192, p95 308.
- Per-game Nicanelo p95 latency: median 76 ms, p95 79 ms.
- Maximum observed Nicanelo latency: 116 ms; no game reached 450 ms.
- Fallback protection was never enabled.

More workers or more Azure capacity are therefore not the primary fix.

## Observed behavior

- Dominant profile: health-management in 132 games, conservatism in 64,
  resource-acquisition in 3, and aggression in 1.
- Median food eaten: 6; median maximum length: 9.
- Median Nicanelo survival turn: 227.5.
- Nicanelo reached the final two in 39 games but converted only 2 (5.13%).
- Its two wins reached lengths 21 and 23 after eating 18 and 20 food.
- Second-place games had median maximum length 16; third-place games 8;
  fourth-place games 5. These are associations with longer survival, not proof
  that eating alone causes the better result.

## Pre-death state analysis

The engine's `immediatelySafeMoves` definition excludes walls, guaranteed body
collisions, lethal health moves, and possible head-to-heads against an equal or
longer rival.

- In all 198 losses, the final decision state had zero immediately safe moves.
- 123 deaths had no physically viable move; 75 had only head-to-head-contested
  physical moves.
- Nicanelo did not voluntarily select an immediately contested move while a
  safe alternative existed at the same final decision.
- 58 deaths occurred at one health; 57 of those also had no physical move.
- In 197/198 losses, Nicanelo was shorter than the largest living opponent.
  The median deficit was 7 cells.
- In the 37 final-two losses, median health was 94 and median length deficit
  was 8. Those losses are enclosure/control failures, not hunger emergencies.
- In the 37 deaths while all three opponents were alive, median health was 1;
  this exposes a separate early resource-access failure mode.

Five turns before death, the median state still had two immediately safe moves
and the selected branch's mean search return was +0.551. One turn before death,
the mean safe-move count was 1.63 and the selected return was still +0.374.
After the realized opponent response, every loss reached zero safe moves. The
MCTS values are shaped returns, not win probabilities, but they show that
future enclosure risk is recognized too late.

## Diagnosis

The v1.3 guardrails fixed the unbounded growth reward and clearly improved
placement, but they overcorrected the control balance:

1. The trained model placed `reachableSpace`, `relativeSpace`, `mobility`,
   `tailAccess`, `trapSafety`, and `opponentPressure` at their minimum allowed
   values. Independent per-feature clamps still let every related safety and
   offense signal fall together.
2. Length has no catch-up value once Nicanelo is more than one cell behind.
   This avoids growth for its own sake, but leaves no bounded strategic response
   to a rival accumulating enough body to control the board.
3. Opponent blocking responses are averaged through the stochastic MCTS model.
   The selected branch remains optimistic immediately before realized
   enclosure, suggesting that lethal opponent replies are underweighted.
4. The observed policy rarely converts into offense. Only one game received an
   aggression-dominant profile, and only 2 of 39 final-two appearances became
   wins.

## Recommended next iteration

1. Replace independent safety minima with a grouped safety budget and add a
   forward escape-degradation feature: penalize moves whose plausible opponent
   replies sharply reduce next-turn safe moves, reachable space, or tail access.
2. Use risk-sensitive opponent aggregation (for example, expected value plus a
   bounded worst-tail/CVaR penalty) so a plausible forced enclosure is not
   hidden by many benign sampled replies.
3. Add bounded catch-up growth. In roomy positions, especially final-two, food
   may reduce a length deficit toward a stage- and free-space-dependent target;
   the incentive must decay as board occupancy and enclosure risk rise. This is
   not a return to globally chasing the longest snake.
4. Give final-two control its own objective: route denial, safe head control,
   and conversion pressure should strengthen when only one rival remains.
5. Retrain and run targeted replay regressions against the 198 pre-death states
   before spending on another tournament batch.
