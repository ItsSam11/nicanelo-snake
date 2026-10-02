import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  evaluateMove,
  evaluateState,
} from "../src/evaluation/evaluate-state.js";
import {
  constrainLearnedEvaluationWeights,
  DEFAULT_EVALUATION_WEIGHTS,
  resolveEvaluationWeights,
} from "../src/evaluation/weights.js";
import { gameState, opponent } from "./fixtures.js";
import { analyzeSpatialMove } from "../src/evaluation/spatial-analysis.js";

describe("evaluateState", () => {
  it("uses dominant scores for terminal win, loss, and draw", () => {
    const win = gameState();
    const loss = gameState();
    loss.board.snakes = [opponent("them", [{ x: 8, y: 8 }])];
    const draw = gameState();
    draw.board.snakes = [];

    assert.equal(evaluateState(win).total, DEFAULT_EVALUATION_WEIGHTS.terminalWin);
    assert.equal(evaluateState(loss).total, DEFAULT_EVALUATION_WEIGHTS.terminalLoss);
    assert.equal(evaluateState(draw).total, DEFAULT_EVALUATION_WEIGHTS.terminalDraw);
  });

  it("reports each weighted contribution and their exact total", () => {
    const state = gameState({
      food: [{ x: 8, y: 8 }],
      opponents: [opponent("them", [{ x: 9, y: 9 }])],
    });
    const result = evaluateState(state);
    const contributionTotal = Object.values(result.contributions).reduce(
      (sum, value) => sum + value,
      0,
    );

    assert.equal(result.outcome, "ongoing");
    assert.equal(result.total, result.terminalScore + contributionTotal);
    assert.equal(result.features.survival, 1);
  });

  it("applies custom weights predictably", () => {
    const state = gameState({
      opponents: [opponent("them", [{ x: 9, y: 9 }])],
    });
    const baseline = evaluateState(state);
    const custom = evaluateState(
      state,
      state.you.id,
      resolveEvaluationWeights({
        health: DEFAULT_EVALUATION_WEIGHTS.health + 10,
      }),
    );

    assert.equal(
      custom.total - baseline.total,
      baseline.features.health * 10,
    );
  });

  it("ignores head-to-head threats the opponent cannot survive", () => {
    const sharedCandidate = { x: 6, y: 5 };
    const exhaustedOpponent = {
      ...opponent("them", [
        { x: 7, y: 5 },
        { x: 7, y: 4 },
        { x: 7, y: 3 },
      ]),
      health: 1,
    };
    const lethalHazard = gameState({
      opponents: [exhaustedOpponent],
      hazards: [sharedCandidate],
    });
    const rescuedByFood = gameState({
      opponents: [exhaustedOpponent],
      hazards: [sharedCandidate],
      food: [sharedCandidate],
    });

    assert.equal(evaluateState(lethalHazard).features.headToHead, 0);
    assert.equal(evaluateState(rescuedByFood).features.headToHead, -0.25);
  });
});

describe("evaluateMove", () => {
  it("scores the larger side of a partition above the smaller side", () => {
    const state = gameState({
      width: 7,
      height: 5,
      youBody: [
        { x: 2, y: 2 },
        { x: 2, y: 1 },
        { x: 1, y: 1 },
      ],
      opponents: [
        opponent("top-wall", [
          { x: 2, y: 4 },
          { x: 2, y: 3 },
        ]),
        opponent("bottom-wall", [{ x: 2, y: 0 }]),
      ],
    });

    assert.ok(evaluateMove(state, "right").total > evaluateMove(state, "left").total);
  });

  it("exposes normalized features for a candidate move", () => {
    const state = gameState({
      food: [{ x: 5, y: 6 }],
      health: 20,
      opponents: [opponent("them", [{ x: 9, y: 9 }])],
    });
    const result = evaluateMove(state, "up");

    assert.ok(Math.abs(result.features.foodAccess - 50 / 70) < 1e-12);
    assert.equal(result.features.health, 1);
    assert.ok(result.features.reachableSpace >= 0 && result.features.reachableSpace <= 1);
  });

  it("uses relative territory consistently for candidate moves", () => {
    const state = gameState({
      width: 7,
      height: 7,
      opponents: [opponent("them", [
        { x: 5, y: 5 }, { x: 5, y: 4 }, { x: 5, y: 3 }, { x: 4, y: 3 },
      ])],
    });
    const analysis = analyzeSpatialMove(state, "left");
    const result = evaluateMove(state, "left");

    assert.equal(
      result.features.territory,
      analysis.territoryAdvantage,
    );
  });

  it("keeps immediate food relevant at high health without a global length chase", () => {
    const state = gameState({
      health: 90,
      opponents: [
        opponent("them", [
          { x: 9, y: 9 }, { x: 9, y: 8 }, { x: 9, y: 7 },
        ]),
      ],
      food: [{ x: 6, y: 5 }],
    });
    const towardFood = evaluateMove(state, "right");
    const awayFromFood = evaluateMove(state, "left");

    assert.ok(towardFood.features.foodAccess > 0);
    assert.ok(towardFood.features.foodAccess > awayFromFood.features.foodAccess);
    assert.equal(towardFood.features.lengthAdvantage, 0);
  });

  it("values a nearby length edge without rewarding a larger gap", () => {
    const nearbyEqual = opponent("nearby", [
      { x: 7, y: 5 }, { x: 7, y: 4 }, { x: 7, y: 3 },
    ]);
    const state = gameState({
      health: 90,
      opponents: [nearbyEqual],
      food: [{ x: 6, y: 5 }],
    });

    const growIntoAdvantage = evaluateMove(state, "right");
    const remainEqual = evaluateMove(state, "left");

    assert.ok(growIntoAdvantage.features.lengthAdvantage > 0);
    assert.equal(remainEqual.features.lengthAdvantage, 0);

    const oneAhead = gameState({
      youBody: [
        { x: 5, y: 5 }, { x: 5, y: 4 }, { x: 5, y: 3 }, { x: 5, y: 2 },
      ],
      opponents: [nearbyEqual],
    });
    const twoAhead = gameState({
      youBody: [
        { x: 5, y: 5 }, { x: 5, y: 4 }, { x: 5, y: 3 }, { x: 5, y: 2 },
        { x: 5, y: 1 },
      ],
      opponents: [nearbyEqual],
    });
    assert.equal(
      evaluateState(twoAhead).features.lengthAdvantage,
      evaluateState(oneAhead).features.lengthAdvantage,
    );
  });

  it("keeps optional growth below spatial safety even at learned bounds", () => {
    const state = gameState({
      health: 90,
      opponents: [opponent("nearby", [
        { x: 7, y: 5 }, { x: 7, y: 4 }, { x: 7, y: 3 },
      ])],
      food: [{ x: 6, y: 5 }],
    });
    const weights = constrainLearnedEvaluationWeights({
      ...DEFAULT_EVALUATION_WEIGHTS,
      reachableSpace: -1_000,
      relativeSpace: -1_000,
      mobility: -1_000,
      tailAccess: -1_000,
      trapSafety: -1_000,
      foodAccess: 1_000,
      lengthAdvantage: 1_000,
    });
    const result = evaluateMove(state, "right", weights);
    const optionalGrowth = result.contributions.foodAccess +
      result.contributions.lengthAdvantage;
    const spatialSafety = result.contributions.reachableSpace +
      result.contributions.relativeSpace + result.contributions.mobility +
      result.contributions.tailAccess + result.contributions.trapSafety;

    assert.ok(optionalGrowth < spatialSafety);
  });
});
