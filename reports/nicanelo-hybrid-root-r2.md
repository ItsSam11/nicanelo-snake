# Nicanelo hybrid root search R2

Date: 2026-09-20

## Scope

This is a local codebase iteration only. It does not deploy production, start
Azure Jobs, build a container image, retrain a model, or run local matches.

## Search change

- The default MCTS budget is now 150 ms. The existing 100 ms external timeout
  reserve remains intact.
- Four workers retain independent persistent trees, but the pool coordinates
  their root work in two stages.
- Coverage assigns every physical root action to at least one worker. The stage
  has a 4 ms delivery reserve so the parent does not cancel a result at the
  instant its compute slice expires.
- After aggregation, each worker gives one sample to a leading contender and
  then returns to unconstrained PUCT over every root action. This lets workers
  converge without making visit totals a proxy for branch simulation speed.
- A coverage-only early return requires at least 16 visits per action, separated
  95% intervals, and agreement between the statistically separated leader and
  the action the normal selector would return.
- Reused actions whose context-decayed visit count reaches zero are sampled
  again before search can be considered complete.

## Root risk arbiter

Visit count remains the normal MCTS decision. A lower-visit action overrides
the visit leader only when all three conditions hold:

- at least 32 visits on the alternative;
- risk-adjusted value advantage of at least 0.25;
- forced-loss-rate advantage of at least 0.20.

Distinct chance outcomes are not treated as sample count: a deterministic
death may have one outcome and hundreds of visits.

The root statistics remain visit-sorted for honest telemetry. Policy targets
are versioned as `puct-policy-target-v3`; a risk-overridden decision is retained
for audit but excluded from policy-prior training.

## Retrospective check

The arbiter was applied offline to all 1,128 accepted MCTS decisions from the
four-game Azure R1 micro-evaluation. It changed exactly two decisions, both in
Legacy seed `2027120000`:

| Turn | Previous | Arbiter | Previous forced-loss rate | Arbiter forced-loss rate |
|---:|---|---|---:|---:|
| 267 | down | right | 58.49% | 33.33% |
| 268 | left | right | 98.85% | 43.59% |

This is a counterfactual decision audit, not a claim that the game would have
been won: changing turn 267 changes the subsequent state. Its useful result is
that the bounded rule catches the known fatal prior-inertia failure without
changing the other 1,126 accepted decisions.

## Validation

- `npm run check`: passed.
- Focused MCTS, pool, re-root, and policy-target tests: 41/41 passed.
- Full suite: 225/225 passed.
- Bicep JSON templates were regenerated locally with the 150 ms setting.

## Remaining runtime question

Concurrent games can still contend for the same four process-local workers.
Absolute deadlines make that failure safe, but a cancelled synchronous worker
search cannot be interrupted mid-iteration and may degrade a later phase to
partial coverage. This needs a bounded concurrent-load evaluation before a
production rollout. No cloud validation was started in this iteration.
