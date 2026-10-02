# Two-to-four-snake gym corpus

The batch harness uses the official Battlesnake CLI to run reproducible games in the
supported Elaniin tournament formats: Standard rules, an 11x11 board, two to
four snakes, and a 500 ms request timeout. The example below uses a four-snake
roster; removing one or two `--snake` entries produces a three-player or 1v1
batch with the same replay and corpus checks.

Each controlled Nicanelo seat must point to an independent process. Reusing one
Nicanelo process for concurrent lanes would mix per-game PUCT memory because
all seats share the engine game id. External Zoo opponents may share a server
when their implementation keeps strategy state isolated per game.

```bash
npm run gym -- \
  --games 10 \
  --base-seed 2026091600 \
  --run-id warmup-01 \
  --output data/telemetry/raw/gym/warmup-01 \
  --provenance config/opponents/warmup-01.json \
  --snake 'Nicanelo=http://127.0.0.1:8101' \
  --snake 'Devious-Devin=http://127.0.0.1:8200/devious-devin' \
  --snake 'Hovering-Hobbs=http://127.0.0.1:8200/hovering-hobbs' \
  --snake 'Improbable-Irene=http://127.0.0.1:8200/improbable-irene'
```

The batch is sequential so local CPU contention does not silently turn into
timeouts. Every completed game gets its own engine-provided game-ID directory
containing:

- `record.jsonl`, the complete ordered replay;
- `summary.json`, with winner, coverage, eliminations, latency, and behavior
  profiles;
- JSONL supervised move observations for every snake that survives into the
  next snapshot;
- for the managed batch Job, `search-observations.jsonl` with normalized PUCT
  visit targets and eligibility reasons for every controlled-snake turn;
- an append-only batch manifest recording successes and failures.

The batch manifest also records `snakeOrder` for every seed. The official CLI
assigns board positions from argument order, so the harness rotates the complete
configured roster on every game. Managed multi-lane runs carry a global
rotation offset into each lane instead of restarting at position zero; this
keeps seat exposure balanced across the complete cohort.

When `--provenance` is present, its JSON object is embedded in `run.json`.
Use it for immutable opponent source commits, image identities, and cohort
labels. The source path itself is deliberately omitted so the run remains
portable between local storage and Azure Blob.

The engine removes eliminated snakes from the next board snapshot. Their final
move therefore cannot be inferred from CLI replay states and is deliberately
excluded rather than guessed. Their elimination turn remains in the summary.

The managed batch Job runs one Nicanelo process per lane and faces a pinned,
three-opponent Snake Zoo roster. The stateful Coreyja server is embedded in the
Job image and runs on loopback, which guarantees that every request for a game
reaches the same in-memory state. Stateless external opponents remain
internal-only Container Apps. Each Nicanelo process gets a distinct exclusive
telemetry file. After the games the Job stops those processes, waits for their
queues to flush, materializes Nicanelo's per-game PUCT search targets, and only
then uploads the finished run under
`telemetry/raw/gym/<runId>`. It cannot target the production endpoint, so gym
games cannot enter `telemetry/raw/live`.

The replay and `summary.json` cover every configured snake, so behavior profiles
can be computed for Nicanelo and every Zoo opponent. Search targets exist only
for Nicanelo because only its internal PUCT statistics are observable. The
managed Azure cohorts below remain pinned four-snake campaigns; local support
for two- and three-snake starts does not mutate those existing campaign
definitions.

The Azure dataset is intentionally split into independent cohorts:

- `legacy`: Nicanelo versus Devious Devin, Hovering Hobbs, and Improbable
  Irene;
- `challenger`: Nicanelo versus Hovering Hobbs, Snork Tree, and Nessegrev
  Expert.

Hovering Hobbs is the common anchor for comparing cohorts. Managed campaigns
partition games into independently recoverable shards and lanes, with unique
run IDs and Blob prefixes. Seeds and roster rotation use cohort-global offsets.
Classification and eligibility are evaluated from completed cohort artifacts
before accepted examples are combined downstream.

Game counts, shard counts, workload profiles, and environment placement are
deployment parameters. See `infra/README.md` and the Bicep parameter files for
the supplied campaign configurations.
