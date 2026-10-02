# Engine v2 codebase audit — 2026-09-20

## Scope

Local codebase work only. No Azure resources, deployments, jobs, training runs,
or tournament games were started or changed.

The audit started from the 200-game finding that Nicanelo usually reached a
positive-looking non-terminal state and then died with no safe move. The main
goal was therefore to improve forward survival and conversion without adding a
new global incentive to eat or become the longest snake.

## Material findings and corrections

### Search correctness and runtime

- Forced-death positions now enter the rules simulator instead of remaining a
  falsely positive ongoing leaf.
- Capped chance nodes evaluate the actual sampled rival/food outcome through an
  ephemeral node. Rare losses are no longer inflated by uniform reuse or erased
  when the persistent outcome cap is full.
- PUCT and final aggregation use downside deviation and observed forced-loss
  rate. Final root choice requires accumulated visits, preventing a lucky
  one-sample branch from winning selection.
- Chance widening remains bounded while stochastic samples retain their real
  distribution. A 4,000-iteration 50/50 regression with a one-outcome cap
  measures a forced-loss rate between 0.47 and 0.53.
- Worker requests now share an absolute deadline. Expired queued work receives
  zero new budget, is removed from pending state, and cannot contaminate the
  next turn's tree.
- The process waits for every search worker to be ready before opening the HTTP
  server. Workers remain referenced until explicit shutdown, so startup cannot
  exit with an unresolved prewarm.

### Forward safety without blanket passivity

- Escape resilience simulates exact Standard turns against rival replies.
  Its score is graded by how many replies leave zero, one, or multiple exits;
  one rare blocker no longer creates the same cliff as unanimous catastrophe.
- Tail access is distance-weighted. A remote tail is not treated as an
  immediate escape, either for Nicanelo or for a trapped rival.
- Learned evaluation weights cannot collapse the aggregate spatial-safety
  budget below the hand-tuned baseline.
- Territory combines 35% current body-constrained ownership, 32.5% open-head
  Voronoi, and 32.5% body-release-aware ownership. This reduces temporary body
  wall discontinuities without pretending deep body segments vanish now.

### Food, growth, and offense

- Maintenance eating remains modest and health urgency remains authoritative.
- Optional catch-up is bounded, fades with occupancy/enclosure, abandons
  irrecoverable gaps, and repairs a one- or two-cell losing duel deficit.
- Local length control saturates after Nicanelo becomes longer than a nearby
  rival. Growing from +1 to +2 no longer erases tactical control, but a larger
  gap adds no extra reward.
- Offensive pressure is rival-specific and causal: space/exit reduction,
  head-to-head control, food control, third-party exposure, and post-attack
  escape all affect the candidate move.
- Distant theoretical rival-tail routes no longer suppress a real trapping
  opportunity as strongly as an adjacent tail.

### Rules and multiplayer formats

- Unique tails are treated as vacating for every snake; duplicated tails remain
  occupied. Eating projects movement first and duplicates the post-move tail,
  matching official Standard transition order.
- Opponent head threats that die from health/hazard damage are excluded unless
  food rescues them.
- Local replay validation, corpus eligibility, and the tournament batch harness
  now support Standard 11x11 games beginning with 2, 3, or 4 snakes.

### Training/runtime alignment

- Ongoing value no longer treats the constant `survival` feature as evidence of
  winning.
- Value calibration uses the phase prior `1 / aliveSnakes`: 25% in four-player,
  33% in three-player, and 50% in a duel. Training learns only the strategic
  residual and runtime uses the same equation.
- The validation baseline is the phase climatology rather than a universal 50%
  predictor.
- Prepared value records carry the phase prior. Prepared-training schema is now
  v3 and provenance includes exact feature, policy-target, and binary layouts.
- Policy targets are v2 because root choice, risk, and chance semantics changed.
- Configured model loading fails closed on incompatibility or a failed offline
  gate; it cannot silently serve the heuristic baseline under the requested
  model name.

## Compatibility boundary

This source requires feature set `escape-control-v3`. Existing v1.2/v1.3 model
artifacts and old prepared shards are intentionally incompatible and must not be
relabelled. A fresh model must be trained from data prepared with the new
schemas before any deployment.

## Local validation

- `npm run check`: passed.
- `npm test`: 212/212 tests passed.
- Full HTTP test ran on an ephemeral loopback port.
- Four-worker static benchmark after explicit prewarm: 4/4 workers completed
  each 75 ms search, with 76, 80, and 113 aggregate iterations in three runs.
- No game engine tournament was run, so no win-rate claim is made.

## Highest-value remaining work

1. Retrain an `escape-control-v3` artifact and require both the offline gate and
   explicit model-version verification before serving it.
2. Run deterministic replay regressions, then a small 2/3/4-player tournament
   to measure conversion, no-move deaths, health deaths, regressions, and
   latency. This is deliberately outside this audit's local-only scope.
3. Validate concurrent multi-game fairness. Deadlines and stale-work handling
   are fixed, but multiple simultaneous games still compete for one shared
   four-worker pool.
4. If four-player horizon remains shallow, add a probability-preserving chance
   abstraction rather than raising worker count or restoring biased outcome
   reuse.

