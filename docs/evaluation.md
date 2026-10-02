# State evaluation

The evaluator converts a board state or candidate move into normalized features
and combines them with centralized, configurable weights:

```text
score = terminal_score + sum(feature_i * weight_i)
```

Terminal wins and losses use dominant values so a heuristic cannot outweigh a
known game result. Every evaluation returns the raw features, each weighted
contribution, and the final total.

The current feature vector contains:

- survival;
- reachable board fraction;
- space relative to snake length;
- Voronoi territory balance;
- normalized health;
- health-, route-, and space-aware food access, with only local tactical
  matchup pressure;
- relative length;
- immediate mobility;
- head-to-head control or exposure;
- conditioned offensive pressure against the most vulnerable relevant rival;
- distance from hazards;
- distance from walls;
- static access to the snake's tail;
- trap and enclosure safety.

Default values live in `src/evaluation/weights.ts`. Call
`resolveEvaluationWeights` to create an immutable-by-convention configuration
with selected overrides. These defaults are an initial policy, not trained
parameters; local tournaments and later offline learning should calibrate them.

`evaluateState` is suitable for leaf states produced by search.
`evaluateMove` scores the conservative one-move spatial projection used by the
current deterministic policy.

Offensive analysis is rival-specific rather than a chase after the longest
snake. For each rival it measures the reachable space and exits removed by our
candidate body placement, enclosure vulnerability, local favorable
head-to-head control, and proximity. The best tactical target is discounted by
our own post-move enclosure risk and by exposure to equal-or-longer third
snakes. This makes deliberate doorway closures and traps valuable only when
Nicanelo still has an escape route.

Once a strict length advantage already exists, the same causal pressure can
produce one bounded `advantageConversion` increment (at most 25%). It remains
zero for unsafe space, no-exit projections, losing or equal head contests, and
is suppressed by third-party exposure. Food captured on the current move does
not retroactively enable it, and it never relaxes the safety or final
head-to-head guards.

Immediate food is evaluated as part of the same interaction. A shorter nearby
rival creates food-control value; an equal-or-longer rival that can enter the
same cell creates contest risk. This modifier affects only an immediate food
capture. Longer routes keep using the survivable food-path and appetite model,
while MCTS resolves their opponent uncertainty over later simulated turns.

Food motivation separates survival urgency from optional eating. Health and
the distance of the nearest survivable food route determine urgency. A small
maintenance appetite remains at high health, while reachable space and
enclosure risk reduce it only moderately when the snake is crowded. At least
65% of maintenance appetite remains, while purely tactical growth can fall to
25%. Survival urgency is never reduced by congestion. Opponent length
contributes only when one nearby growth step would turn an equal head-to-head
into a winning one; there is no globally "strongest" rival to outgrow. The same
signal is used by the opponent policy so rollouts model moderate and locally
tactical eating.

## Model-version scorecard

PUCT model versions are compared on separate axes instead of one blended score:

- held-out policy NLL, Brier score, top-action accuracy, and value Brier score;
- paired tournament win-rate delta, mean placement, and elimination turn using
  identical seeds, roster order, and opponents for baseline and candidate;
- p95/p99 request latency, deadline rate, protected-fallback rate, and completed
  search workers;
- strength at fixed 25, 50, and 75 millisecond budgets, plus the smallest budget
  at which the candidate matches the baseline's 75 millisecond result.

The primary promotion statistic is the paired performance delta with a
confidence interval. A multiplayer rating can summarize a larger tournament,
but does not replace paired results because opponent mix and seat order can move
the rating independently of the model. Report legacy and challenger cohorts,
and every opponent, separately before aggregating them.

A candidate passes only when its offline gate holds, its paired strength does
not regress, its latency/deadline limits hold, and the same conclusion appears
across more than one opponent cohort. A faster model may pass at equal strength;
a stronger model may pass at equal latency. Keep both measurements visible so a
single composite number cannot conceal the tradeoff.
