import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { samplePolicyMove, searchMove } from "../src/search/mcts.js";
import { resolveOpponentPolicy } from "../src/search/opponent-policy.js";
import { chooseStaticMove } from "../src/strategy/static-policy.js";
import { gameState, opponent } from "./fixtures.js";

const STATE = gameState({
  width: 7,
  height: 7,
  youBody: [
    { x: 0, y: 3 },
    { x: 0, y: 2 },
    { x: 0, y: 1 },
  ],
  opponents: [opponent("them", [
    { x: 6, y: 6 },
    { x: 6, y: 5 },
    { x: 6, y: 4 },
  ])],
});

const PRIOR = {
  temperature: 0.25,
  weights: {
    mobility: 0,
    foodAccess: 0,
    headSafety: 0,
    hazardSafety: 0,
    wallDistance: 20,
  },
} as const;

describe("PUCT policy prior", () => {
  it("uses the learned prior to guide rollout moves", () => {
    const move = samplePolicyMove(
      STATE,
      STATE.you.id,
      ["up", "right"],
      resolveOpponentPolicy(PRIOR),
      () => 0.5,
    );

    assert.equal(move, "right");
  });

  it("expands the highest-prior action first", () => {
    const fallback = chooseStaticMove(STATE).move;
    const result = searchMove(STATE, fallback, undefined, {
      timeBudgetMs: 1_000,
      maxIterations: 1,
      maxTreeDepth: 1,
      rolloutDepth: 0,
      now: () => 0,
      seed: 1,
      policyPrior: PRIOR,
      strategicRootPrior: false,
    });

    assert.equal(result.rootStatistics.length, 1);
    assert.equal(result.rootStatistics[0]?.move, "right");
    assert.ok((result.rootStatistics[0]?.prior ?? 0) > 0.99);
  });

  it("reports a normalized prior across every root action", () => {
    const fallback = chooseStaticMove(STATE).move;
    const result = searchMove(STATE, fallback, undefined, {
      timeBudgetMs: 1_000,
      maxIterations: 3,
      maxTreeDepth: 1,
      rolloutDepth: 0,
      now: () => 0,
      seed: 1,
      policyPrior: PRIOR,
      strategicRootPrior: false,
    });
    const total = result.rootStatistics.reduce(
      (sum, item) => sum + (item.prior ?? 0),
      0,
    );

    assert.ok(Math.abs(total - 1) < 1e-12);
  });
});
