export interface PairedGameSummary {
  seed?: number;
  ruleset: string;
  map: string;
  width: number;
  height: number;
  initialSnakeCount: number;
  winnerName: string;
  isDraw: boolean;
  finalTurn: number;
  /** Exact initial CLI seat order, when supplied by the tournament manifest. */
  snakeOrder?: readonly string[];
  profiles: readonly { snakeName: string }[];
  latency: readonly { snakeName: string; p95Ms: number; maxMs: number }[];
}

export interface CohortSummary {
  cohort: string;
  summary: PairedGameSummary;
}

export interface OutcomeCounts {
  games: number;
  wins: number;
  draws: number;
  losses: number;
  winRate: number;
  scoreRate: number;
}

export interface PairedCohortEvaluation {
  cohort: string;
  games: number;
  baseline: OutcomeCounts;
  candidate: OutcomeCounts;
  candidateWinRateDelta: number;
  candidateWinRateDelta95: { lower: number; upper: number };
  gainedWins: number;
  lostWins: number;
  retainedWins: number;
  retainedNonWins: number;
  candidateLatencyMs: {
    samples: number;
    p50OfGameP95: number;
    p95OfGameP95: number;
    maximum: number;
  };
}

export interface PairedModelEvaluation {
  subjectName: string;
  games: number;
  cohorts: readonly PairedCohortEvaluation[];
  combined: PairedCohortEvaluation;
}

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
}

function outcome(summary: PairedGameSummary, subjectName: string): 0 | 0.5 | 1 {
  if (summary.isDraw) return 0.5;
  return summary.winnerName === subjectName ? 1 : 0;
}

function outcomeCounts(
  summaries: readonly PairedGameSummary[],
  subjectName: string,
): OutcomeCounts {
  const wins = summaries.filter((summary) => outcome(summary, subjectName) === 1).length;
  const draws = summaries.filter((summary) => outcome(summary, subjectName) === 0.5).length;
  const games = summaries.length;
  return {
    games,
    wins,
    draws,
    losses: games - wins - draws,
    winRate: wins / Math.max(1, games),
    scoreRate: (wins + draws * 0.5) / Math.max(1, games),
  };
}

function scenarioSignature(summary: PairedGameSummary): string {
  return JSON.stringify({
    ruleset: summary.ruleset,
    map: summary.map,
    width: summary.width,
    height: summary.height,
    initialSnakeCount: summary.initialSnakeCount,
    // Preserve the exact seeded CLI order: sorting would accept a different
    // seat rotation as paired. Historical callers can still rely on the
    // profile order, which is emitted from the initial board order.
    snakeOrder: summary.snakeOrder ??
      summary.profiles.map((profile) => profile.snakeName),
  });
}

function indexed(
  entries: readonly CohortSummary[],
  label: string,
): Map<string, PairedGameSummary> {
  const result = new Map<string, PairedGameSummary>();
  for (const entry of entries) {
    if (!Number.isSafeInteger(entry.summary.seed)) {
      throw new Error(`${label} ${entry.cohort} summary is missing a valid seed`);
    }
    const key = `${entry.cohort}|${entry.summary.seed}`;
    if (result.has(key)) throw new Error(`${label} has duplicate pair ${key}`);
    result.set(key, entry.summary);
  }
  return result;
}

function pairedConfidenceInterval(deltas: readonly number[]): {
  lower: number;
  upper: number;
} {
  if (deltas.length < 2) return { lower: -1, upper: 1 };
  const mean = deltas.reduce((sum, value) => sum + value, 0) / deltas.length;
  const variance = deltas.reduce(
    (sum, value) => sum + (value - mean) ** 2,
    0,
  ) / (deltas.length - 1);
  const margin = 1.96 * Math.sqrt(variance / deltas.length);
  return {
    lower: Math.max(-1, mean - margin),
    upper: Math.min(1, mean + margin),
  };
}

function evaluatePairs(
  cohort: string,
  pairs: readonly {
    baseline: PairedGameSummary;
    candidate: PairedGameSummary;
  }[],
  subjectName: string,
): PairedCohortEvaluation {
  const baseline = pairs.map((pair) => pair.baseline);
  const candidate = pairs.map((pair) => pair.candidate);
  const deltas = pairs.map((pair) =>
    Number(outcome(pair.candidate, subjectName) === 1) -
    Number(outcome(pair.baseline, subjectName) === 1)
  );
  const p95Latencies = candidate.flatMap((summary) =>
    summary.latency
      .filter((entry) => entry.snakeName === subjectName)
      .map((entry) => entry.p95Ms)
  );
  const maximumLatencies = candidate.flatMap((summary) =>
    summary.latency
      .filter((entry) => entry.snakeName === subjectName)
      .map((entry) => entry.maxMs)
  );
  return {
    cohort,
    games: pairs.length,
    baseline: outcomeCounts(baseline, subjectName),
    candidate: outcomeCounts(candidate, subjectName),
    candidateWinRateDelta: deltas.reduce((sum, value) => sum + value, 0) /
      Math.max(1, deltas.length),
    candidateWinRateDelta95: pairedConfidenceInterval(deltas),
    gainedWins: deltas.filter((value) => value === 1).length,
    lostWins: deltas.filter((value) => value === -1).length,
    retainedWins: pairs.filter((pair) =>
      outcome(pair.baseline, subjectName) === 1 &&
      outcome(pair.candidate, subjectName) === 1
    ).length,
    retainedNonWins: pairs.filter((pair) =>
      outcome(pair.baseline, subjectName) !== 1 &&
      outcome(pair.candidate, subjectName) !== 1
    ).length,
    candidateLatencyMs: {
      samples: p95Latencies.length,
      p50OfGameP95: percentile(p95Latencies, 0.5),
      p95OfGameP95: percentile(p95Latencies, 0.95),
      maximum: Math.max(0, ...maximumLatencies),
    },
  };
}

export function evaluatePairedModels(
  baselineEntries: readonly CohortSummary[],
  candidateEntries: readonly CohortSummary[],
  subjectName = "Nicanelo",
): PairedModelEvaluation {
  const baseline = indexed(baselineEntries, "baseline");
  const candidate = indexed(candidateEntries, "candidate");
  if (baseline.size !== candidate.size) {
    throw new Error(`Pair count differs: baseline=${baseline.size}, candidate=${candidate.size}`);
  }
  const pairsByCohort = new Map<string, {
    baseline: PairedGameSummary;
    candidate: PairedGameSummary;
  }[]>();
  for (const [key, baselineSummary] of baseline) {
    const candidateSummary = candidate.get(key);
    if (candidateSummary === undefined) throw new Error(`Candidate is missing pair ${key}`);
    if (scenarioSignature(baselineSummary) !== scenarioSignature(candidateSummary)) {
      throw new Error(`Scenario differs for pair ${key}`);
    }
    const separator = key.indexOf("|");
    const cohort = key.slice(0, separator);
    const pairs = pairsByCohort.get(cohort) ?? [];
    pairs.push({ baseline: baselineSummary, candidate: candidateSummary });
    pairsByCohort.set(cohort, pairs);
  }
  for (const key of candidate.keys()) {
    if (!baseline.has(key)) throw new Error(`Baseline is missing pair ${key}`);
  }
  const cohorts = [...pairsByCohort.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([cohort, pairs]) => evaluatePairs(cohort, pairs, subjectName));
  const allPairs = [...pairsByCohort.values()].flat();
  return {
    subjectName,
    games: allPairs.length,
    cohorts,
    combined: evaluatePairs("combined", allPairs, subjectName),
  };
}
