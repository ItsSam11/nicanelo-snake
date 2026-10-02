# Nicanelo engine v2 alpha

This engine experiment keeps the Nicanelo v1.1 model fixed. Any behavioral
difference therefore comes from search rather than retraining.

## Search changes

### Policy-guided rollouts

Nicanelo previously selected its own rollout moves uniformly at random after
leaving the explicit PUCT tree. The new default samples those moves from the
loaded model's policy prior. Rival moves continue to use the opponent policy.

`SEARCH_ROLLOUT_POLICY=uniform` restores the previous behavior for an ablation
or rollback.

### Context-aware tree reuse

The persistent tree previously became incompatible whenever the observed
opponent behavior snapshot changed, which normally happens as a game advances.
The engine can now re-root at a matching state while using the updated opponent
policy. It retains half of the old visit and value evidence by default and then
continues sampling under the new context.

`SEARCH_TREE_REUSE_CONTEXT_DECAY` controls the retained fraction.
`SEARCH_REUSE_OPPONENT_CONTEXT_TREE=false` restores strict invalidation.

## Compute benchmark

A synthetic four-snake state was searched twelve times per mode with the same
75 ms budget, tree depth eight, and rollout depth six.

| Rollout | Minimum iterations | Median | Maximum | Mean |
| --- | ---: | ---: | ---: | ---: |
| Uniform | 68 | 88 | 92 | 84.4 |
| Policy | 69 | 83 | 86 | 80.7 |

Policy guidance reduced mean iteration throughput by about 4.4%. This is a
small and explicit compute cost; only paired games can establish whether the
higher-quality rollout policy produces a strength gain.

## Validation

- Full TypeScript suite: 144 passed, 0 failed.
- Focused search suite: 20 passed, 0 failed.
- Production and gym Bicep templates compile.
- Tactical forced-win, stochastic multiplayer, fallback, deadline, persistent
  memory, worker aggregation, and PUCT tests remain green.

No container image was built, no Azure resource was changed, and no game Job
was started. A suitable next gate is a small paired local tournament using the
same v1.1 model on both sides of the comparison.
