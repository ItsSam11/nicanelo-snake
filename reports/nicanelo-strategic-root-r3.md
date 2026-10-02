# Nicanelo: R3 strategic root prior

Date: 2026-09-20

## Objective

Address the overly conservative playing style while keeping aggression
conditional on the position. Search should take initiative through territory,
pressure, constriction, elimination, and tactical growth when the position
allows it, while treating proven death as a non-negotiable cost.

## Architecture

- The coordinator computes one complete strategic prior for root actions and
  shares it with all four workers. Unlike the previous lightweight prior,
  this evaluates the resulting state, including territory, pressure,
  head-to-head control, food, mobility, and trap safety.
- When a tree is reused, rerooting updates the priors of expanded actions and
  reorders unexplored actions. Accumulated visits and returns are preserved;
  a prior from an earlier context does not remain attached to the new root.
- `heuristic-adaptive-control-v1` becomes the default local baseline. Its
  value function gives territory, pressure, head-to-head control, and food
  access more influence without treating growth as an isolated objective.
- Initiative gradually reduces the MCTS variance penalty to permit lines
  with a wider range of nonterminal outcomes. It does not reduce the
  `forced-loss` penalty: an offensive posture cannot accept a higher rate
  of proven death.

## Safety and rollback

- The strategic prior normalizes probability mass over physically available
  actions and penalizes catastrophic candidates when an alternative exists.
- `SEARCH_STRATEGIC_ROOT_PRIOR=false` restores the previous lightweight prior
  while retaining the rest of the engine.
- `MODEL_PATH` can select an earlier artifact without changing source code.
- The `forced-loss` penalty remains fixed at every initiative level.

## Targeted validation

Targeted strategic-prior, MCTS, pool-coordination, model, and safety tests
passed: **77/77**.

The full suite also passed: **243/243**, with zero failures.

## Static retrospective audit

Four existing JSONL files were analyzed, containing **1,163 decisions**:

|Measure|Result|
|---|---:|
|Leading candidate changes from the historical prior|546 (46.95%)|
|New leader differs from the recorded move|540 (46.43%)|
|Model scaling changes the leader from the strategic prior with default weights|94 (8.08%)|
|New leader offers more pressure than the recorded move|210|
|New leader offers more territory than the recorded move|387|
|Mean mass of the new leading candidate|0.5525|
|Mean mass of the historical leading candidate|0.6933|

The only leading candidate marked catastrophic occurred in a position with
just one available action; it did not displace a safe alternative. The lower
mean mass indicates a less concentrated distribution, not an improvement in
game outcomes by itself.

Local latency to calculate the prior for each state:

|Percentile|Time|
|---|---:|
|p50|2.960 ms|
|p95|4.290 ms|
|p99|4.754 ms|
|maximum|6.328 ms|
|mean|2.681 ms|

## Evidence limits

This is a static retrospective over previously observed states. It shows that
the change broadly alters initial exploration and has bounded local cost,
but **does not demonstrate more wins** or reconstruct how games would have
continued with different moves. No new games were played, and neither Azure
nor production was changed during this investigation.
