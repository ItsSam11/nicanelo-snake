import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { analyzeEscapeResilience } from "../src/evaluation/escape-resilience.js";
import { gameState, opponent } from "./fixtures.js";

describe("forward escape resilience", () => {
  it("values durable branching above a one-way corridor", () => {
    const open = gameState({
      width: 5,
      height: 5,
      youBody: [{ x: 2, y: 2 }, { x: 2, y: 1 }],
      opponents: [opponent("them", [{ x: 4, y: 4 }])],
    });
    const corridor = gameState({
      width: 5,
      height: 1,
      youBody: [{ x: 0, y: 0 }],
      opponents: [opponent("them", [{ x: 4, y: 0 }])],
    });

    const openAnalysis = analyzeEscapeResilience(open);
    const corridorAnalysis = analyzeEscapeResilience(corridor);

    assert.ok(openAnalysis.currentSafeMoves >= 3);
    assert.equal(corridorAnalysis.currentSafeMoves, 1);
    assert.ok(openAnalysis.score > corridorAnalysis.score);
  });

  it("enumerates duel replies and discounts a contested losing reply", () => {
    const state = gameState({
      width: 5,
      height: 5,
      youBody: [{ x: 2, y: 1 }, { x: 2, y: 0 }],
      opponents: [opponent("them", [
        { x: 2, y: 3 },
        { x: 1, y: 3 },
        { x: 0, y: 3 },
      ])],
    });
    const analysis = analyzeEscapeResilience(state, state.you.id, "up");

    assert.ok(analysis.replyScenarios >= 2 && analysis.replyScenarios <= 4);
    assert.equal(analysis.bestNextSafeMoves, 0);
    assert.ok(analysis.score > -1 && analysis.score < 1);
  });

  it("returns maximum downside for a living snake with no safe exit", () => {
    const trapped = gameState({
      width: 3,
      height: 3,
      youBody: [
        { x: 0, y: 0 },
        { x: 0, y: 1 },
        { x: 1, y: 1 },
        { x: 1, y: 0 },
        { x: 1, y: 0 },
      ],
    });

    assert.deepEqual(analyzeEscapeResilience(trapped), {
      currentSafeMoves: 0,
      bestNextSafeMoves: 0,
      replyScenarios: 0,
      score: -1,
    });
  });
});
