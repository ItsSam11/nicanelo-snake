import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Direction } from "../src/api/types.js";
import { behaviorCandidates } from "../src/model/behavior-features.js";
import {
  immediateHeadToHeadOutcome,
  isReasonableHeadToHeadAlternative,
} from "../src/search/head-to-head-guard.js";
import {
  selectRootMoveStatistic,
  type MctsResult,
  type RootMoveStatistics,
} from "../src/search/mcts.js";
import { aggregateSearchResults } from "../src/search/search-pool.js";
import { strategicPosture } from "../src/strategy/strategic-posture.js";
import { gameState, opponent } from "./fixtures.js";

function statistic(
  move: Direction,
  visits: number,
  value = 0.5,
): RootMoveStatistics {
  return {
    move,
    visits,
    meanValue: value,
    outcomeCount: 4,
    valueSquareMean: value * value,
    downsideSquareMean: 0,
    forcedLossCount: 0,
    forcedLossRate: 0,
    riskAdjustedValue: value,
  };
}

function contestedFoodState(ourLength: 2 | 3 | 4) {
  const body = [
    { x: 3, y: 2 },
    { x: 3, y: 1 },
    { x: 3, y: 0 },
    { x: 2, y: 0 },
  ].slice(0, ourLength);
  return gameState({
    width: 7,
    height: 7,
    youBody: body,
    opponents: [
      opponent("rival", [
        { x: 2, y: 3 },
        { x: 1, y: 3 },
        { x: 1, y: 2 },
      ]),
    ],
    food: [{ x: 3, y: 3 }],
  });
}

describe("contextual root head-to-head guard", () => {
  it("treats equal projected food growth as a losing contest", () => {
    const state = contestedFoodState(3);

    assert.equal(immediateHeadToHeadOutcome(state, "up"), "losing");
    assert.equal(immediateHeadToHeadOutcome(state, "right"), "none");
    assert.equal(isReasonableHeadToHeadAlternative(state, "right"), true);
  });

  it("reselects a reasonable non-losing root action", () => {
    const state = contestedFoodState(3);
    const selected = selectRootMoveStatistic([
      statistic("up", 100, 0.8),
      statistic("right", 40, 0.3),
      statistic("left", 20, 0.2),
    ], state);

    assert.equal(selected?.move, "right");
  });

  it("also guards the same geometry when our snake is strictly shorter", () => {
    const state = contestedFoodState(2);

    assert.equal(immediateHeadToHeadOutcome(state, "up"), "losing");
    assert.equal(
      selectRootMoveStatistic([
        statistic("up", 100, 0.8),
        statistic("right", 40, 0.3),
      ], state)?.move,
      "right",
    );
  });

  it("replays the real turn-185 loss and selects its surviving alternative", () => {
    const state = gameState({
      width: 11,
      height: 11,
      health: 99,
      youBody: [
        { x: 0, y: 9 },
        { x: 0, y: 8 },
        { x: 0, y: 7 },
        { x: 0, y: 6 },
        { x: 0, y: 5 },
        { x: 0, y: 4 },
        { x: 0, y: 3 },
        { x: 0, y: 2 },
        { x: 0, y: 1 },
      ],
      opponents: [
        opponent("palaserpiente", [
          { x: 1, y: 8 },
          { x: 1, y: 7 },
          { x: 1, y: 6 },
          { x: 1, y: 5 },
          { x: 1, y: 4 },
          { x: 1, y: 3 },
          { x: 2, y: 3 },
          { x: 2, y: 2 },
          { x: 2, y: 1 },
          { x: 3, y: 1 },
          { x: 4, y: 1 },
          { x: 4, y: 2 },
        ]),
      ],
      food: [
        { x: 9, y: 4 },
        { x: 9, y: 8 },
        { x: 10, y: 5 },
        { x: 8, y: 5 },
      ],
    });
    const selected = selectRootMoveStatistic([
      {
        ...statistic("right", 323, -0.5800864972730134),
        forcedLossRate: 0.6873065015479877,
        riskAdjustedValue: -1,
      },
      {
        ...statistic("up", 182, -0.35376192937029394),
        forcedLossRate: 0.489010989010989,
        riskAdjustedValue: -0.7612524907948477,
      },
    ], state);

    assert.equal(immediateHeadToHeadOutcome(state, "right"), "losing");
    assert.equal(isReasonableHeadToHeadAlternative(state, "up"), true);
    assert.equal(selected?.move, "up");
  });

  it("preserves an aggressive contest when our projected length is strictly greater", () => {
    const state = contestedFoodState(4);

    assert.equal(immediateHeadToHeadOutcome(state, "up"), "winning");
    assert.equal(
      selectRootMoveStatistic([
        statistic("up", 100, 0.8),
        statistic("right", 40, 0.3),
      ], state)?.move,
      "up",
    );
  });

  it("does not replace a contest with a zero-exit pocket", () => {
    const state = gameState({
      width: 3,
      height: 3,
      health: 1,
      youBody: [
        { x: 1, y: 0 },
        { x: 0, y: 0 },
        { x: 0, y: 0 },
        { x: 0, y: 0 },
        { x: 0, y: 0 },
      ],
      opponents: [
        opponent("rival", [
          { x: 0, y: 1 },
          { x: 0, y: 2 },
          { x: 1, y: 2 },
          { x: 2, y: 2 },
          { x: 2, y: 1 },
        ]),
      ],
      food: [
        { x: 1, y: 1 },
        { x: 2, y: 0 },
      ],
    });

    assert.equal(immediateHeadToHeadOutcome(state, "up"), "losing");
    assert.equal(isReasonableHeadToHeadAlternative(state, "right"), false);
    assert.equal(
      selectRootMoveStatistic([
        statistic("up", 100, 0.7),
        statistic("right", 50, 0.4),
      ], state)?.move,
      "up",
    );
  });

  it("applies the same guard after worker statistics are pooled", () => {
    const state = contestedFoodState(3);
    const rootStatistics = [
      statistic("up", 100, 0.8),
      statistic("right", 40, 0.3),
      statistic("left", 20, 0.2),
    ];
    const workerResult: MctsResult = {
      move: "up",
      fallbackMove: "right",
      iterations: 160,
      elapsedMs: 10,
      deadlineReached: false,
      usedSearch: true,
      fallbackProtected: false,
      rootStatistics,
      priorVisits: 0,
      reusedTree: false,
      cacheHits: 0,
      cacheMisses: 0,
    };

    const pooled = aggregateSearchResults(
      state,
      "right",
      [workerResult],
      1,
      0.05,
    );

    assert.equal(pooled.move, "right");
  });
});

describe("strict length advantage semantics", () => {
  it("grants initiative for a strictly shorter rival, not an equal one", () => {
    const equal = strategicPosture(contestedFoodState(3));
    const shorter = strategicPosture(contestedFoodState(4));

    assert.ok(shorter.initiative > equal.initiative);
  });

  it("does not label pressure against an equal head as favorable aggression", () => {
    const equalState = contestedFoodState(3);
    const longerState = contestedFoodState(4);
    const equalMove = behaviorCandidates(equalState, equalState.you.id)
      .find((candidate) => candidate.move === "up");
    const longerMove = behaviorCandidates(longerState, longerState.you.id)
      .find((candidate) => candidate.move === "up");

    assert.ok(equalMove !== undefined);
    assert.ok(longerMove !== undefined);
    assert.ok(
      longerMove.utilities.aggression > equalMove.utilities.aggression,
    );
  });
});
