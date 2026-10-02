# Nicanelo engine v2 alpha — local challenger smoke (10 games)

Operational references and artifact hashes are retained in the local archive.

Date: 2026-09-19

Run: `<evaluation-reference-retained-locally>`

Seeds: `2026120000` through `2026120009`

## Configuration

- Nicanelo model: `nicanelo-v1.1-value-main-20k-20260918-v1`
- Engine: `nicanelo-engine-v2-alpha`
- Search workers: 4
- Search budget: 75 ms
- Rollout policy: learned policy
- Opponent-context tree reuse: enabled
- Context-change statistics decay: 0.5
- Rules: standard, standard map, 11x11, four snakes
- Runner request timeout: 500 ms

The opponents used the same immutable images selected for the challenger cohort:

- Hovering-Hobbs: `snake-zoo-coreyja:<local-image-tag>`, digest `<artifact-hash-retained-locally>`
- Snork-Tree: `snake-zoo-snork:<local-image-tag>`, digest `<artifact-hash-retained-locally>`
- Nessegrev-Expert: `snake-zoo-nessegrev:<local-image-tag>`, digest `<artifact-hash-retained-locally>`

The host was arm64 and the challenger images were amd64, so Docker emulated the opponents. This does not affect the identity of their code, but wall-clock throughput and opponent latency are not representative of Azure.

## Results

| Seed | Winner | Final turn | Nicanelo place | Nicanelo survival | Nicanelo p95 |
| ---: | --- | ---: | ---: | ---: | ---: |
| 2026120000 | Snork-Tree | 449 | 2 | 449 | 73 ms |
| 2026120001 | Snork-Tree | 355 | 4 | 106 | 73 ms |
| 2026120002 | Snork-Tree | 376 | 4 | 29 | 75 ms |
| 2026120003 | Hovering-Hobbs | 357 | 3 | 205 | 75 ms |
| 2026120004 | Snork-Tree | 363 | 4 | 238 | 74 ms |
| 2026120005 | Snork-Tree | 330 | 4 | 92 | 75 ms |
| 2026120006 | Snork-Tree | 363 | 4 | 142 | 75 ms |
| 2026120007 | Snork-Tree | 389 | 4 | 199 | 74 ms |
| 2026120008 | Snork-Tree | 469 | 2 | 469 | 72 ms |
| 2026120009 | Snork-Tree | 219 | 3 | 212 | 73 ms |

Winner totals:

- Snork-Tree: 9
- Hovering-Hobbs: 1
- Nicanelo: 0
- Nessegrev-Expert: 0

Nicanelo's mean placement was 3.4. It finished second twice, third twice, and fourth six times. Its mean survival turn was 214.1.

## Integrity and runtime

- 10/10 games succeeded on their first attempt.
- 10 unique seeds and 10 unique game IDs were produced.
- All 30 expected record, summary, and observation files exist and are non-empty.
- All 10 games have full coverage from turn zero through the final turn, with no missing turns.
- The run produced 26 MB of local artifacts.
- Elapsed wall time was about 21 minutes 15 seconds.
- The local Nicanelo server and all three test opponent containers were stopped after verification.

Across 2,141 Nicanelo move requests:

- request latency: p50 70.53 ms, p95 73.60 ms, p99 75.89 ms, max 94.83 ms
- search time: p50 67.97 ms, p95 68.67 ms, max 75.76 ms
- no request reached the runner's 500 ms timeout
- one turn completed with 3 of 4 workers; the request remained valid and completed in 82.15 ms
- one forced-move turn skipped search, completed in 0.64 ms, and used the only viable move

## Engine diagnostics

Search iterations per move were min 0, p10 127, median 172, p95 396, max 2,982, and mean 210.0. Very high counts occur in constrained states with one legal branch and should not be compared directly with branching positions.

Tree reuse occurred in 1,697 of 2,131 eligible moves, or 79.6%. A reused tree contributed at least one prior visit in 1,506 moves, or 70.7% of eligible moves. This confirms that the new reuse path is active in real games.

The fallback-protection gate overrode the search's top move in 838 of 2,141 decisions, or 39.1%. In those turns, search preferred a different move but did not exceed the heuristic fallback by the configured minimum value margin. This is not an execution failure, but it limits how often the guided search can alter actual play and is the strongest engine-level finding from this smoke.

## Assessment

The v2 alpha is operationally healthy at a 75 ms budget: it loads the intended v1.1 model, executes guided rollouts, reuses trees, respects latency, and produces complete game artifacts. This sample does not show a competitive gain. Nicanelo won 0/10, and the run was not paired against the old engine on the same seeds, so it cannot estimate the change in win probability or prove a regression.

The next strength check should be a paired A/B between the current engine and v2 alpha on the same seeds and snake-order rotations. The fallback-protection rate should be treated as a first engine-tuning target: measure calibration and decision quality before lowering or removing the protection margin.
