# Game data lifecycle

Nicanelo keeps generation, selection, and training as separate stages. Raw
games are immutable and no directory is treated as a corpus merely because it
contains valid JSON.

```text
telemetry/
  raw/live/<date>/<gameId>/
  raw/gym/<runId>/[lane]/<gameId>/
  references/<profileReferenceVersion>.json
  eligible/<selectionId>/
  corpus/<corpusId>/
  training/<trainingRunId>/
```

Local data uses the same relative layout below `data/telemetry`. Azure Blob
uses it from the container root.

## Per-game artifacts

Every organized game has:

- `record.jsonl`: ordered game metadata, states, and result;
- `summary.json`: compact, schema-versioned outcome, coverage, latency,
  elimination, behavior-profile, and optional strategic-aggression metadata;
- `observations.jsonl`: derived supervised moves. Missing elimination moves are
  never guessed. Every observation contains a behavior snapshot computed only
  from earlier moves, so training cannot see the future outcome.
- `search-observations.jsonl` (controlled simulations only): the normalized
  PUCT root-visit distribution, value diagnostics, outcome, and explicit
  policy-eligibility decision for each controlled-snake turn.

The engine-provided `game.id` is the canonical directory key and is treated as
an opaque string, not validated as a UUID. An internal UUID is needed only for
a future source that has no engine identity.

Production coverage can end when Nicanelo is eliminated and resume at
`POST /end`; those summaries use `coverage.kind=controlled-snake`. Official gym
replays with consecutive states use `coverage.kind=full`.

## Eligibility and corpus freezing

`championship-eligibility-v3` accepts Standard 11x11 games that begin with two,
three, or four snakes and rejects only structurally unusable games: wrong
ruleset/map/board/player count, missing identity, no observable moves, invalid
turn ranges, or missing profiles. A loss is not a rejection reason.

Eligibility and selection are separate. The eligible manifest contains every
structurally valid game. `corpus-selector-v2` first applies a quality floor and
then scores coverage deficits, trajectory diversity, and decision density. An
optional game budget chooses a deterministic subset. A rare game cannot bypass
the quality floor merely by being novel.

Manifests frozen under `championship-eligibility-v2` must be rebuilt from their
immutable raw replay and summary artifacts before entering a v3 corpus. The raw
games themselves do not need to be regenerated.

`eligible/<selectionId>/manifest.jsonl` references every accepted raw artifact.
`corpus/<corpusId>/manifest.jsonl` contains only selected games. Manifest schema
3 stores SHA-256 digests for the replay, summary, frozen profile reference, and
optional PUCT targets, plus the selector components and `samplingWeight`.
Games are never copied between stages. The trainer accepts only the selected
frozen manifest and verifies every referenced digest.

Large-corpus training adds one derived layer beneath `training/<trainingRunId>`.
It contains numeric shards for policy-prior, opponent-policy, and value samples,
split at whole-game boundaries. `_SUCCESS.json` is written only after every
shard and `manifest.json` are complete. Raw replays remain the authority; the
prepared layer can always be rebuilt and must never be edited in place.

## Behavior profiles

`behavior-profile-v2` stores four opportunity-conditioned dimensions:

- aggression: pressure chosen beyond what food attraction or escape explains;
- resource acquisition: food pursuit and capture relative to available routes;
- health management: decision quality under the snake's current health;
- conservatism: preference for mobility, safe space, and lower collision risk.

Scores compare the observed move with the other physically viable moves in the
same state. A dimension is updated only when the alternatives differ enough to
create a real opportunity to express that behavior. `winner`, placement,
survival duration, and elimination remain outcomes; they never define a
behavior profile.

The complete continuous vector, opportunity counts, and confidence are kept.
`dominantProfile` is human-facing metadata, not a mutually exclusive model
label. Percentiles come from an immutable `profile-reference` distribution,
never from the current candidate batch, so adding games cannot silently change
an existing classification.

At runtime, the opponent model receives only history observed before the
current turn. Its contextual terms are confidence-gated and fall back to the
unchanged generic policy when evidence is absent. Nicanelo's own PUCT prior is
not conditioned on these profiles.

## Strategic-aggression measurements

New summaries may include the additive `post-length-advantage-v1` block under
`strategicAggression`. It is separate from `behavior-profile-v2`: these metrics
describe how a snake used an already-held strict length advantage and may refer
to later outcomes, so they are not causal opponent-model inputs.

The analysis reuses the engine's own root signals instead of defining a second
notion of aggression. Pressure reports the selected `basePressure` and bounded
`advantageConversion`; projected trap progress uses the same
`constraintProgress` and its underlying vulnerability, exit, and space
reductions. A length advantage must exist at the start of the move. Eating from
equal length enables measurements on the following state, not retroactively on
the capture turn. Favorable head-to-head counts are offers of a strictly
winning possible contest, not proof that the rival entered it.

The same `advantageConversion` acts online through `opponentPressure`. It is a
maximum 25% increment of the existing bounded pressure signal, never a second
independent trap or length reward. It is zero unless length control is strict,
the projected move preserves health, space and an exit, the post-attack safety
signal is positive, and the destination is not a losing head-to-head. Third-
party exposure continuously suppresses it. Food utility, candidate legality,
catastrophic penalties, MCTS forced-loss evidence, and the final head-to-head
guard remain separate and authoritative.

Only inferable surviving moves across consecutive replay frames are measured.
Missing turns and the unobservable final move of an eliminated snake are
skipped. `opponentEliminationsWhileLeading` and `associatedEliminations` are
temporal associations: official replay frames do not contain enough information
to award direct kill credit safely.

## Local preparation workflow

After a profile schema change, rebuild only the derived summary and observation
files from immutable `record.jsonl` inputs:

```bash
npm run telemetry:rebuild-derived -- data/telemetry/raw
```

Freeze a reference once, then use it explicitly for corpus selection:

```bash
npm run profile:reference -- data/telemetry profile-reference-v1
npm run corpus:prepare -- \
  data/telemetry selection-v2 corpus-v2 profile-reference-v1
```

Both commands use exclusive creation for frozen outputs. A new reference,
selection, or corpus receives a new version rather than overwriting the old
artifact.

## Gym isolation

The batch Job gives every controlled Nicanelo process its own exclusive local
telemetry file, keeps Blob telemetry disabled inside those processes, shuts
them down to flush the files, and materializes Nicanelo's per-game PUCT targets
before upload. Zoo opponents run in a separate internal Container App whose
identity has `AcrPull` only; they never receive the Job identity that can write
Blob data. The Job uploads completed artifacts only to
`telemetry/raw/gym/<runId>`. It has no production-target option. Real platform
traffic writes only to `telemetry/raw/live`.
