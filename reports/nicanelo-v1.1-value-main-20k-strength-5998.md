# Nicanelo v1.1 strength evaluation

Operational references and artifact hashes are retained in the local archive.

Generated from the paired Azure run on 2026-09-19.

## Integrity

- Attempted candidate games: 6,000
- Accepted paired games: 5,998
- Challenger pairs: 2,998
- Legacy pairs: 3,000
- Every accepted game has full telemetry coverage and the exact model version `nicanelo-v1.1-value-main-20k-20260918-v1`.
- Every accepted candidate game was compared with the baseline game having the same cohort, seed, ruleset, map, board size, and roster.

Two challenger games were excluded together with their baseline pairs:

- Seed `2026094958`: the game failed after a metadata timeout from Nessegrev.
- Seed `2026094959`: the manifest reported success, but its record, summary, and observations never reached Blob Storage.

## Results

| Cohort | Pairs | v1 wins | v1.1 wins | Win rate v1 | Win rate v1.1 | Absolute delta | Paired 95% CI |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Challenger | 2,998 | 8 | 7 | 0.267% | 0.233% | -0.033 pp | [-0.287, +0.220] pp |
| Legacy | 3,000 | 154 | 242 | 5.133% | 8.067% | +2.933 pp | [+1.661, +4.206] pp |
| Combined | 5,998 | 162 | 249 | 2.701% | 4.151% | +1.450 pp | [+0.800, +2.101] pp |

The combined result is a net gain of 87 wins and a 53.7% relative increase in win rate. The improvement is statistically clear in the paired sample, but it comes entirely from the legacy cohort. The challenger result is inconclusive and provides no evidence that v1.1 is stronger against that roster.

Candidate latency remained within the intended search budget: the median per-game p95 was 73 ms, the p95 of those values was 75 ms, and the maximum observed request was 121 ms.

The two exclusions cannot overturn the combined conclusion: even the worst possible outcome for both missing pairs changes the combined delta by at most 0.033 percentage points, below the observed confidence interval's positive lower bound.

## Future-run hardening

The local implementation now:

- retries each game up to three times for transient opponent failures;
- waits for every lane to finish before stopping shared snake services;
- retries Blob uploads and attempts every file even if one upload fails;
- writes the final success or failure marker only after all data uploads complete;
- exposes `JOB_GAME_ATTEMPTS=3` in the Bicep Job definition.

These changes are validated locally but have not been built into a new image or deployed to Azure.

The machine-readable source is `nicanelo-v1.1-value-main-20k-strength-5998.json`, SHA-256 `<artifact-hash-retained-locally>`.
