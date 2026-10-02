# Nicanelo R4: MCTS budget continuity

Date: 2026-09-20/21

## Scope

The R4 evaluation tested an engine that continues into a robust search stage
when the initial short coordinated coverage returns no results. The pool also
separates the computation deadline from the collection margin and
cooperatively cancels late work.

Configuration:

- 50 Challenger games and 50 Legacy games, five games per Job;
- four workers, a 150 ms search budget, and a 100 ms external reserve;
- the `heuristic-adaptive-control-v1` model;
- the R4 budget-continuation engine and a verified immutable image.

Exact campaign identifiers and image digests are retained in the local archive.

## Execution integrity

- 20/20 Azure Container Apps Job executions finished with `Succeeded`.
- The complete execution window was 7 minutes and 6 seconds.
- 100 unique IDs and 100 unique seeds were validated, with complete coverage
  in 100/100 games.
- 860 blobs (438 MB) were produced, with no `failure.json`, empty files, or
  malformed JSON.
- Engine, model, hashes, image digest, and campaign ID were consistent across
  all 20 shards.
- Maximum observed latency was 228.02 ms, below the 500 ms timeout.

## Results

|Cohort|Wins|Top 2|Placements 1/2/3/4|Mean survival|Mean food|Mean maximum length|
|---|---:|---:|---:|---:|---:|---:|
|Challenger|0/50|4/50|0 / 4 / 46 / 0|229.54|5.46|8.46|
|Legacy|5/50|22/50|5 / 17 / 14 / 14|221.74|7.32|10.32|
|Total|5/100|26/100|5 / 21 / 60 / 14|225.64|6.39|9.39|

Snork won 46 of the 50 Challenger games. The favorable signal is concentrated
in Legacy; five total wins still represent weak performance.

## Effect of the pool fix

|Measure|R3|R4|
|---|---:|---:|
|Total decisions|21,859|22,664|
|Decisions using MCTS|6,661 (30.47%)|22,649 (99.934%)|
|Fallbacks|15,198|15|
|MCTS iterations|1,541,142|4,543,588|

In R4, 22,590 decisions completed all four workers; only 74 received fewer
than four results. Request latency was p50 150.43 ms, p95 157.66 ms, p99
164.92 ms, and a maximum of 228.02 ms. The higher median is expected: search
now uses its budget instead of stopping around 45 ms.

Of the 15 fallbacks, five were terminal requests with Nicanelo already the sole
surviving snake. The ten competitive misses occurred during cold starts:
nine at turn zero and one at turn one. The actual competitive fallback rate
was 10/22,659 decisions (0.044%); Challenger had none.

## Causes of defeat

All 95 defeats were reconstructed from the final action and the next turn's
state:

- 84 head-to-head collisions against a longer snake;
- 9 deaths from starvation;
- 2 collisions with Nicanelo's own body;
- 0 wall collisions and 0 ordinary collisions with opponent bodies.

The head-to-head defeats were against Hovering Hobbs (48), Snork (25), Devious
Devin (9), and Improbable Irene (2). Nicanelo was one to twenty segments
shorter in those collisions.

All 95 fatal decisions used MCTS and completed 4/4 workers; 84 reached their
deadline. Given the simultaneous moves that opponents actually selected,
58 had another root action that would have survived that turn. In 43 cases,
the fallback was different and immediately safe. This is a single-turn
counterfactual, not evidence that the fallback would have won the game.

## Comparison with R3

R4 recorded 5 wins, 26 top-2 finishes, and mean placement 2.83; R3 recorded 2,
17, and 2.98. Mean food and maximum length increased from 5.39/8.39 to
6.39/9.39. Seeds were not paired, so this is a directional signal rather than
a causal estimate of playing strength. Telemetry directly demonstrates the
improvement in MCTS utilization.

## Conclusion

The next bottleneck is root/MCTS risk estimation. It underestimates the
probability that a longer opponent will contest the same cell. The next
change should calibrate that risk in the opponent move distribution and root
selection while preserving attacks where Nicanelo wins the collision.
A general heuristic veto should not be restored.

After the campaign, the eight Zoo apps had `minReplicas=0`, zero active
revisions, and zero replicas. The six `GymD32` pools reported `NodeCount=0`.
