import type { BehaviorScores } from "../model/behavior-features.js";
import type { BehaviorProfileName } from "./behavior-profile.js";
import type { ReplaySummary } from "./replay-corpus.js";

export const CORPUS_SELECTOR_VERSION = "corpus-selector-v2" as const;

export interface ProfileAssignment {
  snakeId: string;
  snakeName: string;
  dominantProfile: BehaviorProfileName;
  rawScores: BehaviorScores;
  percentileScores: BehaviorScores;
  confidence: number;
}

export interface CorpusSelectionCandidate {
  summary: ReplaySummary;
  profileAssignments: readonly ProfileAssignment[];
}

export interface CorpusSelectionMetrics {
  selectorVersion: typeof CORPUS_SELECTOR_VERSION;
  selected: boolean;
  quality: number;
  coverage: number;
  diversity: number;
  decisionDensity: number;
  selectionScore: number;
  samplingWeight: number;
  coverageTags: readonly string[];
  exclusionReasons: readonly string[];
}

export interface CorpusSelectionResult {
  gameId: string;
  metrics: CorpusSelectionMetrics;
}

export interface CorpusSelectionOptions {
  maximumGames?: number;
  minimumQuality?: number;
}

function rounded(value: number): number {
  return Number(value.toFixed(6));
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function quality(candidate: Readonly<CorpusSelectionCandidate>): number {
  const summary = candidate.summary;
  const span = Math.max(
    1,
    summary.coverage.lastTurn - summary.coverage.firstTurn + 1,
  );
  const continuity = clamp01(1 - summary.coverage.missingTurnCount / span);
  const expectedMoves = Math.max(1, span * summary.initialSnakeCount);
  const observationCoverage = clamp01(summary.observedMoveCount / expectedMoves);
  const confidence = candidate.profileAssignments.reduce(
    (sum, assignment) => sum + assignment.confidence,
    0,
  ) / Math.max(1, candidate.profileAssignments.length);
  return rounded(
    0.4 * continuity + 0.3 * observationCoverage + 0.3 * confidence,
  );
}

function decisionDensity(candidate: Readonly<CorpusSelectionCandidate>): number {
  return rounded(candidate.summary.profiles.reduce(
    (sum, profile) => sum + profile.metrics.decisionDensity,
    0,
  ) / Math.max(1, candidate.summary.profiles.length));
}

function lengthBucket(finalTurn: number): string {
  if (finalTurn < 40) return "short";
  if (finalTurn < 90) return "medium";
  return "long";
}

function tags(candidate: Readonly<CorpusSelectionCandidate>): string[] {
  const profileTags = new Set(
    candidate.profileAssignments.map((assignment) =>
      `profile:${assignment.dominantProfile}`
    ),
  );
  return [
    `source:${candidate.summary.source}`,
    `outcome:${candidate.summary.isDraw ? "draw" : "decisive"}`,
    `length:${lengthBucket(candidate.summary.finalTurn)}`,
    `coverage:${candidate.summary.coverage.kind}`,
    ...profileTags,
  ].sort();
}

function aggregateVector(
  candidate: Readonly<CorpusSelectionCandidate>,
): number[] {
  const count = Math.max(1, candidate.profileAssignments.length);
  return [
    "aggression",
    "resourceAcquisition",
    "healthManagement",
    "conservatism",
  ].map((dimension) =>
    candidate.profileAssignments.reduce(
      (sum, assignment) =>
        sum + assignment.percentileScores[
          dimension as keyof BehaviorScores
        ],
      0,
    ) / count
  );
}

function distance(a: readonly number[], b: readonly number[]): number {
  const squared = a.reduce((sum, value, index) => {
    const difference = value - (b[index] ?? 0);
    return sum + difference * difference;
  }, 0);
  return Math.sqrt(squared / Math.max(1, a.length));
}

/**
 * Applies a hard quality floor, then ranks deterministically for coverage and
 * diversity. Without a maximum, every quality-passing game remains selected;
 * the scores still drive reproducible sampling weights.
 */
export function selectCorpusGames(
  candidates: readonly CorpusSelectionCandidate[],
  options: Readonly<CorpusSelectionOptions> = {},
): CorpusSelectionResult[] {
  const minimumQuality = options.minimumQuality ?? 0.25;
  const maximumGames = options.maximumGames ?? Number.POSITIVE_INFINITY;
  if (!Number.isFinite(minimumQuality) || minimumQuality < 0 || minimumQuality > 1) {
    throw new Error("minimumQuality must be between zero and one");
  }
  if (
    maximumGames !== Number.POSITIVE_INFINITY &&
    (!Number.isSafeInteger(maximumGames) || maximumGames < 1)
  ) {
    throw new Error("maximumGames must be a positive integer");
  }

  const tagFrequency = new Map<string, number>();
  for (const candidate of candidates) {
    for (const tag of tags(candidate)) {
      tagFrequency.set(tag, (tagFrequency.get(tag) ?? 0) + 1);
    }
  }
  const staged = candidates.map((candidate) => {
    const coverageTags = tags(candidate);
    const coverage = rounded(coverageTags.reduce(
      (sum, tag) => sum + 1 / Math.max(1, tagFrequency.get(tag) ?? 1),
      0,
    ) / Math.max(1, coverageTags.length));
    return {
      candidate,
      quality: quality(candidate),
      coverage,
      decisionDensity: decisionDensity(candidate),
      coverageTags,
      vector: aggregateVector(candidate),
    };
  });
  const passing = staged.filter((item) => item.quality >= minimumQuality).sort(
    (a, b) =>
      b.coverage - a.coverage ||
      b.decisionDensity - a.decisionDensity ||
      b.quality - a.quality ||
      a.candidate.summary.gameId.localeCompare(b.candidate.summary.gameId),
  );
  const selected: typeof passing = [];
  const diversity = new Map<string, number>();
  while (passing.length > 0) {
    const ranked = passing.map((item) => ({
      item,
      diversity: selected.length === 0
        ? 1
        : Math.min(...selected.map((chosen) =>
          distance(item.vector, chosen.vector)
        )),
    })).sort((a, b) =>
      b.diversity - a.diversity ||
      b.item.coverage - a.item.coverage ||
      b.item.decisionDensity - a.item.decisionDensity ||
      b.item.quality - a.item.quality ||
      a.item.candidate.summary.gameId.localeCompare(
        b.item.candidate.summary.gameId,
      )
    );
    const next = ranked[0];
    if (next === undefined) break;
    selected.push(next.item);
    diversity.set(next.item.candidate.summary.gameId, rounded(next.diversity));
    passing.splice(passing.indexOf(next.item), 1);
  }
  const selectedIds = new Set(
    selected.slice(0, maximumGames).map((item) => item.candidate.summary.gameId),
  );

  return staged.map((item): CorpusSelectionResult => {
    const passesQuality = item.quality >= minimumQuality;
    const isSelected = passesQuality && selectedIds.has(item.candidate.summary.gameId);
    const diversityScore = diversity.get(item.candidate.summary.gameId) ?? 0;
    const selectionScore = rounded(clamp01(
      0.35 * item.quality + 0.25 * item.coverage +
        0.25 * diversityScore + 0.15 * item.decisionDensity,
    ));
    const exclusionReasons = passesQuality
      ? (isSelected ? [] : ["selection-budget-exhausted"])
      : ["quality-below-threshold"];
    return {
      gameId: item.candidate.summary.gameId,
      metrics: {
        selectorVersion: CORPUS_SELECTOR_VERSION,
        selected: isSelected,
        quality: item.quality,
        coverage: item.coverage,
        diversity: diversityScore,
        decisionDensity: item.decisionDensity,
        selectionScore,
        samplingWeight: rounded(0.5 + selectionScore),
        coverageTags: item.coverageTags,
        exclusionReasons,
      },
    };
  }).sort((a, b) => a.gameId.localeCompare(b.gameId));
}
