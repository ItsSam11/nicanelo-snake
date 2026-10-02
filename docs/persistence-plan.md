# Persistence architecture

## Request boundary

Move selection depends on the Battlesnake payload, the loaded model, and
optional process-local search memory. The HTTP server sends the move response
before passing its telemetry record to the persistence coordinator. Lifecycle
events are also queued for background processing.

The coordinator uses a bounded queue with one active job at a time. When the
queue is full, it drops new work and logs `persistence_drop`. Failed jobs log
`persistence_error`. Persistence is best effort; storage failure does not
change the selected move.

## Storage lifetimes

### Process memory

Workers retain private MCTS trees, searchable-move caches, and evaluation
caches. The coordinator retains observable opponent history. State is
partitioned by `game.id`, and `/start` and `/end` clear search memory.

A matching observed state can re-root an existing tree. A mismatch, restart,
or move routed to another process can lose accumulated evidence. Search can
continue from the full request payload.

### Optional Redis summaries

`AzureRedisHotStateStore` writes the latest compact summary and observed
opponent move counts. Cluster keys share a game-specific hash tag, and each
write refreshes their TTL.

The adapter establishes its connection lazily on the first queued write and
reuses it. It authenticates through Microsoft Entra and uses TLS. Summary
writes include the latest turn, state key, model version, chosen move,
fallback, and root statistics. Search trees stay inside worker memory.

The runtime write path does not read these summaries before selecting a move.
Ended games expire through the configured TTL.

### Telemetry sinks

Local simulations can use `JsonlFileTelemetrySink`. It creates its file
exclusively, then appends JSONL events. Each process needs a fresh, unique path.

Azure deployments can use `AzureBlobTelemetrySink`. It creates one block blob
per event under:

```text
<prefix>/<UTC-date>/<gameId>/<turn>-<event>-<eventId>.json
```

Conditional creation prevents an existing event from being overwritten. Blob
authentication uses `DefaultAzureCredential`. File and Blob telemetry are
alternative sinks; Redis can be enabled alongside either.

## Recorded data

Lifecycle records preserve the supplied game state. Move records include:

- game identity, turn, ruleset, map, and canonical state key;
- the original board state and loaded model version;
- fallback and final moves;
- observed opponent moves inferred from consecutive requests;
- request and search duration, iterations, and deadline status;
- worker completion, tree reuse, cache metrics, and root statistics;
- root-safety decisions when the arbiter is enabled.

The coordinator attempts to drain pending work during shutdown within
`PERSISTENCE_FLUSH_TIMEOUT_MS`. Queue capacity and drain timeout are
configurable through environment variables.

## Offline processing

The [data lifecycle](data-lifecycle.md) organizes raw telemetry into replays,
summaries, move observations, and controlled-search targets. Selected corpus
manifests reference immutable artifacts and their digests.

The [training pipeline](offline-learning.md) consumes that frozen data and
produces versioned JSON model artifacts. Evaluation weights, policy priors,
and opponent-policy settings load at startup; training and promotion run
separately from game requests.
