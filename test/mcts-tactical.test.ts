import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveEvaluationWeights } from "../src/evaluation/weights.js";
import { searchMove } from "../src/search/mcts.js";
import { chooseStaticMove } from "../src/strategy/static-policy.js";
import { gameState, opponent } from "./fixtures.js";

describe("MCTS tactical lookahead", () => {
  it("overrides an immediate food preference when another move forces a win", () => {
    const trappedOpponent = {
      ...opponent("them", [
        { x: 2, y: 1 },
        { x: 2, y: 0 },
      ]),
      health: 10,
    };
    const state = gameState({
      width: 3,
      height: 3,
      youBody: [
        { x: 0, y: 1 },
        { x: 0, y: 0 },
        { x: 1, y: 0 },
      ],
      opponents: [trappedOpponent],
      food: [{ x: 0, y: 2 }],
      hazards: [
        { x: 2, y: 2 },
        { x: 2, y: 0 },
      ],
      health: 20,
    });
    const foodBiasedWeights = resolveEvaluationWeights({
      survival: 0,
      reachableSpace: 0,
      relativeSpace: 0,
      territory: 0,
      health: 0,
      foodAccess: 1_000,
      lengthAdvantage: 0,
      mobility: 0,
      headToHead: 0,
      opponentPressure: 0,
      hazardDistance: 0,
      wallDistance: 0,
      tailAccess: 0,
      trapSafety: 0,
    });
    const fallback = chooseStaticMove(state, foodBiasedWeights).move;
    const search = searchMove(state, fallback, foodBiasedWeights, {
      timeBudgetMs: 1_000,
      maxIterations: 8,
      maxTreeDepth: 4,
      rolloutDepth: 2,
      seed: 12,
      now: () => 0,
    });

    assert.equal(fallback, "up");
    assert.equal(search.move, "right");
    assert.equal(search.rootStatistics[0]?.meanValue, 1);
  });
});
