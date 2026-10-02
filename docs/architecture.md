# Architecture reference

Nicanelo is a TypeScript Battlesnake service with process-local search memory,
optional background persistence, and separate evaluation and training tools.

## Runtime components

| Component | Implementation | Responsibility |
| --- | --- | --- |
| Bootstrap | `src/index.ts` | Load the model, initialize workers, and open the HTTP listener. |
| HTTP API | `src/server.ts` | Handle Battlesnake lifecycle requests and emit JSON responses. |
| Search coordinator | `src/search/search-pool.ts` | Update opponent history, compute fallback, coordinate workers, and arbitrate the final move. |
| Static strategy | `src/strategy/` | Rank fallback moves and derive strategic posture. |
| State evaluation | `src/evaluation/` | Measure space, routes, resources, threats, and tactical opportunities. |
| Rules simulator | `src/domain/` | Resolve the deterministic part of simultaneous Standard turns. |
| Search workers | `src/search/mcts.ts`, `src/search/search-worker.ts` | Run independent PUCT trees under a bounded budget. |
| Model artifacts | `src/model/`, `models/` | Supply evaluation weights, policy priors, and opponent policy settings. |
| Persistence | `src/persistence/` | Queue optional telemetry and compact summaries. |

## Decision path

A move request supplies the board state. The coordinator updates observable
opponent history and computes a deterministic fallback. Workers explore
physically viable root moves, sample rival responses and food spawning, and
evaluate simulated outcomes. The coordinator aggregates their statistics,
selects search or fallback, and applies the root-safety arbiter before
responding.

Each worker owns its tree and bounded caches. Reuse depends on the observed
state matching a sampled state and on compatible search settings. Opponent
history, trees, and tactical state remain local to a process and are
partitioned by game identity.

The simulator handles Standard rules. Evaluation tournaments support 11×11
boards with two to four initial participants. Seeded transitions and fixed
iteration searches are reproducible; wall-clock-bounded search also depends
on available compute and scheduling.

## Storage and training

The persistence coordinator writes telemetry through a bounded background
queue. Local simulations use an exclusive JSONL file; Azure deployments can
write one immutable Blob per event and optional Redis summaries with a TTL.
Move selection does not read Redis or Blob.

Offline tools organize replays, freeze behavior references and selected corpus
manifests, verify digests, and derive versioned training features. CPU worker
threads can prepare and train numeric shards. Candidate JSON models require
offline validation and tournament evaluation before explicit promotion.

## Detailed guides

- [State evaluation](evaluation.md)
- [Turn simulation](turn-simulator.md)
- [MCTS and root safety](mcts.md)
- [Parallel search and memory](parallel-search.md)
- [Opponent policy](opponent-policy.md)
- [Persistence](persistence-plan.md)
- [Data lifecycle](data-lifecycle.md)
- [Tournaments and replays](tournament-corpus.md)
- [Offline learning](offline-learning.md)
- [Azure persistence](azure-persistence.md)
- [Infrastructure deployment](../infra/README.md)

See the [project README](../README.md) for technology choices, configuration,
and execution commands.
