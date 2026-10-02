# Offline learning and model promotion

The offline pipeline prepares replay-derived datasets, trains versioned
strategy artifacts, and evaluates candidates before explicit promotion.
Training runs separately from the HTTP service.

## Runtime behavior

The container loads one immutable strategy-model JSON before opening the HTTP
server. The artifact contains:

- evaluation weights used by the static policy and leaf value calculation;
- a policy prior for our PUCT actions;
- an opponent policy used to sample rival moves;
- the PUCT exploration constant;
- corpus identity, validation metrics, and promotion status.

PUCT selects an explored action with:

```text
Q(s, a) + c_puct * P(s, a) * sqrt(N(s)) / (1 + N(s, a))
```

The highest-prior unvisited actions are expanded first. Search values can still
override the prior, and the static policy supplies the fallback.
When `MODEL_PATH` is unset, the server uses the built-in
`heuristic-adaptive-control-v1` baseline. An explicitly configured path must
load a valid artifact that passes compatibility and offline-gate checks;
otherwise startup logs the error and stops.

## Data lifecycle

Raw games are immutable and separated by provenance:

```text
telemetry/raw/live/<date>/<gameId>/
telemetry/raw/gym/<runId>/<lane>/<gameId>/
```

Each organized game contains `record.jsonl`, `summary.json`, and derived
`observations.jsonl`. Controlled simulations additionally contain
`search-observations.jsonl`, whose targets are normalized from PUCT root visits.
The summary includes coverage, latency, eliminations, and
versioned, opportunity-conditioned behavior profiles for aggression, resource
acquisition, health management, and conservatism. Outcomes are stored
separately and never define a profile.

Structural eligibility and corpus selection are separate. The eligible
manifest retains every valid game. The frozen corpus contains only games that
pass the quality floor and the deterministic coverage, diversity, and
decision-density selector. Promotion writes manifests; it never copies or
mutates the immutable replay.

## Train a candidate

Rebuild derived v2 artifacts when upgrading existing raw data, freeze one
profile reference, and prepare a corpus against that explicit reference:

```bash
npm run telemetry:rebuild-derived -- data/telemetry/raw
npm run profile:reference -- data/telemetry profile-reference-v1
npm run corpus:prepare -- \
  data/telemetry selection-v2 corpus-v2 profile-reference-v1
```

The original in-memory trainer remains available as a small-corpus reference:

```bash
npm run train:model -- \
  --corpus-manifest data/telemetry/corpus/corpus-v2/manifest.jsonl \
  --model-version nicanelo-v2-candidate \
  --output models/candidates/nicanelo-v2-candidate.json \
  --min-games 20
```

Manifest paths are resolved relative to the manifest. `record.jsonl`,
`summary.json`, the frozen profile reference, and any referenced
`search-observations.jsonl` hashes are verified before training. Duplicate game
IDs, unselected entries, modified artifacts, and direct uncurated directory
input fail closed. Candidate files use exclusive creation and are never loaded
automatically.

For production-sized corpora, first materialize compact immutable training
shards. Preparation validates the same corpus artifacts, derives features once,
keeps whole games in either training or validation, and distributes games
across worker threads:

```bash
npm run training:prepare -- \
  --corpus-manifest data/telemetry/corpus/corpus-v2/manifest.jsonl \
  --output data/telemetry/training/nicanelo-v2-smoke-10 \
  --workers 8 \
  --max-games 10

npm run train:model:parallel -- \
  --dataset-manifest data/telemetry/training/nicanelo-v2-smoke-10/manifest.json \
  --model-version nicanelo-v2-smoke-10 \
  --output models/candidates/nicanelo-v2-smoke-10.json \
  --workers 8 \
  --min-games 10
```

Prepared datasets contain fixed-width Float64 records, a schema and feature
manifest, an explicit semantic `featureSetVersion`, exact sample counts, and a
success marker tied to the manifest digest. Changing the meaning of an existing
feature requires a new feature-set version and a fresh preparation pass; an old
binary dataset cannot be relabeled and reused. Every shard file also carries a
SHA-256 digest. Training verifies the
marker, size, and digest after loading each local file or Blob into memory.
Workers retain only compact numeric shards, calculate partial gradients in
parallel, and the coordinator combines those gradients in stable worker order.
The model equations, learning rates, regularization, and game-hash validation
split remain the same as the reference trainer.

On the 15-thread Apple M5 Pro development machine, the checked 10-game smoke
with 200 epochs took 2.19 seconds to prepare and 0.20 seconds to train with four
workers. The equivalent reference path took about 6.1 seconds. A 50-game run
took 4.87 seconds to prepare and 0.48 seconds to train with eight workers. These
figures measure local pipeline behavior only; Azure sizing must use a D32 smoke
because Blob throughput and x86 CPU performance differ.

The trainer uses a deterministic game-hash split, so turns from the same game
cannot leak between training and validation. The three signals remain
separate: Nicanelo's policy prior learns only from eligible PUCT visit
distributions, the contextual opponent policy learns from observed rival moves
and their prior history, and value weights learn from outcomes.
`samplingWeight` scales their losses. Games without search targets can improve
the opponent and value models but are never converted into fabricated prior
targets. The trainer records separate prior/opponent negative log-likelihood,
accuracy, opponent Brier score, and value Brier score.

The offline gate requires the contextual opponent model to improve held-out
opponent NLL while preserving its calibration and avoiding material prior or
value regressions. A descriptive profile alone cannot promote a model.

## Azure production corpus

The 40,000-game campaign is selected once into balanced, immutable roles per
cohort: 2,500 pilot-training games, 10,000 total main-training games (including
the pilot), 1,000 validation games, 1,000 test games, and the remaining reserve.
This yields 5,000 training games for the pilot and 20,000 for main. The same
2,000 validation games are used for both models; the 2,000 test games stay
sealed until the final comparison.

The selector records Blob names, ETags, lengths, roles, and sampling weights.
Sixty preparation Jobs validate the selected replays and PUCT targets and write
one compact shard each. A finalizer refuses to publish `manifest.json` unless
all 60 immutable job markers exist, the selection digest agrees, every Blob
size agrees with its sample count, and the exact training and validation game
counts are present. The training Job then streams its assigned shards from Blob
to worker RAM, verifies SHA-256, and runs full-batch gradients across 31 worker
threads. Container Apps ephemeral disk is used only for the small manifest and
candidate model.

Azure validation uses `selection-manifest-v1`, a deterministic, cohort-balanced
split tied to `selectionId`. Local corpora continue to use `game-hash-v2`.

## Promotion gate

First run the full deterministic suite:

```bash
npm test
```

Then run a two-to-four-snake tournament matching the target format, where the
candidate has its own process and model path. Gate its manifest:

```bash
npm run gate:model -- \
  --model models/candidates/warmup-20260916-v1.json \
  --manifest data/telemetry/raw/gym/candidate-vs-baseline/manifest.jsonl \
  --candidate-name Candidate \
  --min-games 20 \
  --min-win-rate 0.25 \
  --max-p95-ms 250
```

The gate fails unless the candidate passed held-out offline validation and the
tournament satisfies every requested sample, win-rate, and latency threshold.
Promotion is an explicit copy to `models/<version>.json`, followed by a normal
container build with `MODEL_PATH` set to that immutable artifact. There is no
automatic production deployment or online weight mutation.

Twenty games exercise the pipeline but are not strong statistical evidence.
Use progressively larger, seeded batches and compare confidence intervals
before treating a small win-rate difference as real improvement.
