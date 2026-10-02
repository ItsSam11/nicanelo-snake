import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { BehaviorScores } from "../src/model/behavior-features.js";
import type { SnakeBehaviorProfile } from "../src/training/behavior-profile.js";
import { selectCorpusGames } from "../src/training/corpus-selection.js";
import {
  buildProfileReference,
  parseProfileReference,
  profilePercentiles,
  profileReferenceDigest,
  serializeProfileReference,
} from "../src/training/profile-reference.js";
import type { ReplaySummary } from "../src/training/replay-corpus.js";

function profile(id: string, scores: BehaviorScores): SnakeBehaviorProfile {
  return {
    profileVersion: "behavior-profile-v2",
    snakeId: id,
    snakeName: id,
    dominantProfile: "aggression",
    scores,
    opportunities: {
      aggression: 10,
      resourceAcquisition: 10,
      healthManagement: 10,
      conservatism: 10,
    },
    confidence: {
      aggression: 0.8,
      resourceAcquisition: 0.8,
      healthManagement: 0.8,
      conservatism: 0.8,
      overall: 0.8,
    },
    metrics: {
      turnsObserved: 30,
      observedMoves: 29,
      foodEaten: 2,
      initialLength: 3,
      maximumLength: 5,
      averageHealth: 70,
      lowHealthRate: 0.1,
      criticalHealthRate: 0,
      averageHealthBeforeEating: 40,
      lastSeenTurn: 39,
      decisionDensity: 0.6,
    },
  };
}

const low: BehaviorScores = {
  aggression: 0.2,
  resourceAcquisition: 0.2,
  healthManagement: 0.2,
  conservatism: 0.2,
};
const high: BehaviorScores = {
  aggression: 0.8,
  resourceAcquisition: 0.8,
  healthManagement: 0.8,
  conservatism: 0.8,
};

function summary(gameId: string): ReplaySummary {
  const profiles = ["a", "b", "c", "d"].map((id, index) =>
    profile(id, index % 2 === 0 ? low : high)
  );
  return {
    schemaVersion: 2,
    source: "gym",
    gameId,
    ruleset: "standard",
    map: "standard",
    timeoutMs: 500,
    width: 11,
    height: 11,
    initialSnakeCount: 4,
    finalTurn: 40,
    winnerId: "a",
    winnerName: "a",
    isDraw: false,
    observedMoveCount: 116,
    modelVersions: ["heuristic-puct-v1"],
    coverage: {
      kind: "full",
      firstTurn: 10,
      lastTurn: 40,
      missingTurnCount: 0,
    },
    eliminations: [],
    latency: [],
    profiles,
  };
}

describe("frozen profile reference", () => {
  it("keeps percentiles stable and round-trips with a stable digest", () => {
    const reference = buildProfileReference(
      [profile("low", low), profile("high", high)],
      "profile-reference-v1",
      "2026-09-17T00:00:00.000Z",
    );
    const middle = profilePercentiles({
      aggression: 0.5,
      resourceAcquisition: 0.5,
      healthManagement: 0.5,
      conservatism: 0.5,
    }, reference);
    const parsed = parseProfileReference(
      JSON.parse(serializeProfileReference(reference)) as unknown,
    );

    assert.equal(middle.aggression, 0.5);
    assert.deepEqual(parsed, reference);
    assert.equal(
      profileReferenceDigest(parsed),
      profileReferenceDigest(reference),
    );
  });

  it("selects a deterministic diverse subset under a corpus budget", () => {
    const reference = buildProfileReference(
      summary("game-a").profiles,
      "profile-reference-v1",
      "2026-09-17T00:00:00.000Z",
    );
    const candidates = [summary("game-b"), summary("game-a")].map((game) => ({
      summary: game,
      profileAssignments: game.profiles.map((item) => ({
        snakeId: item.snakeId,
        snakeName: item.snakeName,
        dominantProfile: item.dominantProfile,
        rawScores: item.scores,
        percentileScores: profilePercentiles(item.scores, reference),
        confidence: item.confidence.overall,
      })),
    }));
    const selected = selectCorpusGames(candidates, { maximumGames: 1 });

    assert.equal(selected.filter((item) => item.metrics.selected).length, 1);
    assert.equal(
      selected.find((item) => item.metrics.selected)?.gameId,
      "game-a",
    );
  });
});
