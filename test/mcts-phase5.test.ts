import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { searchMove } from "../src/search/mcts.js";
import { chooseStaticMove } from "../src/strategy/static-policy.js";
import { gameState, opponent } from "./fixtures.js";

describe("phase-five stochastic MCTS", () => {
  it("records multiple opponent outcomes below the same root action", () => {
    const state = gameState({
      opponents: [
        opponent("them", [
          { x: 8, y: 8 },
          { x: 8, y: 7 },
          { x: 8, y: 6 },
        ]),
      ],
      food: [{ x: 3, y: 5 }],
    });
    const fallback = chooseStaticMove(state).move;
    const result = searchMove(state, fallback, undefined, {
      timeBudgetMs: 1_000,
      maxIterations: 96,
      maxTreeDepth: 4,
      rolloutDepth: 2,
      seed: 19,
      now: () => 0,
    });

    assert.equal(result.iterations, 96);
    assert.equal(result.usedSearch, true);
    assert.ok(
      result.rootStatistics.every((candidate) => candidate.outcomeCount > 1),
    );
  });

  it("keeps distinct random food spawns under the same joint action", () => {
    const state = gameState({
      opponents: [
        opponent("them", [
          { x: 8, y: 8 },
          { x: 8, y: 7 },
          { x: 8, y: 6 },
        ]),
      ],
      food: [{ x: 0, y: 0 }],
    });
    state.game.ruleset.settings.minimumFood = 1;
    state.game.ruleset.settings.foodSpawnChance = 100;
    const fallback = chooseStaticMove(state).move;
    const baseOptions = {
      timeBudgetMs: 1_000,
      maxIterations: 192,
      maxTreeDepth: 2,
      rolloutDepth: 0,
      seed: 7,
      now: () => 0,
    } as const;
    const deterministic = searchMove(state, fallback, undefined, {
      ...baseOptions,
      simulateFoodSpawns: false,
    });
    const stochastic = searchMove(state, fallback, undefined, baseOptions);
    const repeated = searchMove(state, fallback, undefined, baseOptions);
    const deterministicMaximum = Math.max(
      ...deterministic.rootStatistics.map((item) => item.outcomeCount),
    );
    const stochasticMinimum = Math.min(
      ...stochastic.rootStatistics.map((item) => item.outcomeCount),
    );

    assert.deepEqual(repeated, stochastic);
    assert.ok(stochasticMinimum > deterministicMaximum);
  });

  it("uses the completed MCTS result without a heuristic veto by default", () => {
    const state = gameState({
      opponents: [
        opponent("them", [
          { x: 8, y: 8 },
          { x: 8, y: 7 },
          { x: 8, y: 6 },
          { x: 8, y: 5 },
        ]),
      ],
      food: [{ x: 3, y: 0 }],
    });
    const fallback = chooseStaticMove(state).move;
    const result = searchMove(state, fallback, undefined, {
      timeBudgetMs: 1_000,
      maxIterations: 96,
      maxTreeDepth: 4,
      rolloutDepth: 2,
      strategicRootPrior: false,
      seed: 2,
      now: () => 0,
    });

    assert.equal(result.usedSearch, true);
    assert.equal(result.fallbackProtected, false);
    assert.equal(result.move, result.rootStatistics[0]?.move);
    assert.notEqual(result.rootStatistics[0]?.move, fallback);
  });

  it("retains fallback protection as an explicit ablation", () => {
    const state = gameState({
      opponents: [
        opponent("them", [
          { x: 8, y: 8 },
          { x: 8, y: 7 },
          { x: 8, y: 6 },
          { x: 8, y: 5 },
        ]),
      ],
      food: [{ x: 3, y: 0 }],
    });
    const fallback = chooseStaticMove(state).move;
    const result = searchMove(state, fallback, undefined, {
      timeBudgetMs: 1_000,
      maxIterations: 96,
      maxTreeDepth: 4,
      rolloutDepth: 2,
      fallbackProtection: true,
      strategicRootPrior: false,
      seed: 2,
      now: () => 0,
    });

    assert.equal(result.usedSearch, true);
    assert.equal(result.fallbackProtected, true);
    assert.equal(result.move, fallback);
    assert.notEqual(result.rootStatistics[0]?.move, fallback);
  });
});
