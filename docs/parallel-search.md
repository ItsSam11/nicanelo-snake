# Persistent parallel search

Production search runs off the HTTP event loop in a persistent worker-thread
pool. The static policy is computed first, so a protocol-valid fallback is
available when search cannot return enough evidence before its deadline.

## Request flow

1. The main thread computes the deterministic fallback.
2. The coordinator sends the same state to every search worker with a distinct
   deterministic seed.
3. Workers search independently until their internal deadline.
4. The coordinator sums visits and visit-weighted values for each root move.
5. Full root coverage makes the aggregated MCTS result authoritative. The
   minimum-improvement gate exists only as an explicit ablation.
6. Results that arrive after the parent deadline are ignored for that response.

The default pool contains up to four workers. `SEARCH_WORKERS` can override the
count after deployment benchmarks. Workers are created once with the server,
not once per request.

## Per-game tree reuse

Every worker owns a bounded `MctsMemory`. Search states receive a canonical key
made from rules, turn, board dimensions, food, hazards, snake health, and body
coordinates. On the next request, a worker re-roots at the previously sampled
child whose key matches the observed state.

Random food spawning is sampled as a chance outcome above the deterministic
simulator. If the real next state matches one of those sampled states, the tree
can be re-rooted there; otherwise reuse safely misses and a new tree is created.
`/start` and `/end` clear memory for that `game.id`.

Tree statistics are invalidated when evaluation weights or opponent-policy
configuration changes. A newly observed opponent behavior profile no longer
throws the matching subtree away: the worker keeps its topology and half of
its accumulated visits and value evidence by default, then continues sampling
with the updated opponent policy. `SEARCH_TREE_REUSE_CONTEXT_DECAY` controls
that fraction, and `SEARCH_REUSE_OPPONENT_CONTEXT_TREE=false` restores strict
invalidation for an ablation or rollback. Memory is also capped by game count
so abandoned games cannot accumulate without bound.

## Transposition-style caches

Each worker keeps bounded LRU-like maps for:

- searchable moves for a canonical state and perspective;
- normalized leaf rewards for a canonical state, perspective, and evaluation
  configuration.

The full mutable tree is never shared across threads and is not sent to Redis.
Workers return only compact root statistics. All memory is disposable: a miss,
restart, or replica change reduces accumulated evidence but does not change API
correctness.

## Diagnostics

Move logs include elapsed time, current iterations, prior visits, tree-reuse and
cache metrics, completed/requested workers, and fallback protection. A completed
count below the requested count is an observable degraded-search signal; the
response remains the precomputed fallback when aggregate search does not cover
every root move.

## Local four-snake benchmark

With four persistent workers, a 40 ms total budget, and a warmed repeated root:

```text
p50: 35.18 ms
p95: 36.20 ms
p99/max: 36.58 ms
completed workers: 4/4
last-turn iterations: 143
```

This benchmark measures the search process only. Repeated-root reuse is useful
for validating the mechanism but is more favorable than a normal game, where
the tree is re-rooted to a child each turn or reset after an unsampled random
food spawn.
