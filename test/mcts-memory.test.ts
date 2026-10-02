import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MctsMemory,
  searchMove,
} from "../src/search/mcts.js";
import { chooseStaticMove } from "../src/strategy/static-policy.js";
import { gameState, opponent } from "./fixtures.js";

describe("process-local MCTS memory", () => {
  it("reuses root visits and cached calculations for the same game state", () => {
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
    const memory = new MctsMemory();
    const common = {
      timeBudgetMs: 1_000,
      maxTreeDepth: 4,
      rolloutDepth: 2,
      seed: 19,
      now: () => 0,
    } as const;

    const first = searchMove(
      state,
      fallback,
      undefined,
      { ...common, maxIterations: 24 },
      memory,
    );
    const second = searchMove(
      state,
      fallback,
      undefined,
      { ...common, maxIterations: 8 },
      memory,
    );

    assert.equal(first.priorVisits, 0);
    assert.equal(first.reusedTree, false);
    assert.equal(second.priorVisits, 24);
    assert.equal(second.reusedTree, true);
    assert.equal(
      second.rootStatistics.reduce((sum, item) => sum + item.visits, 0),
      32,
    );
    assert.ok(second.cacheHits > 0);

    const changedTransitionModel = searchMove(
      state,
      fallback,
      undefined,
      {
        ...common,
        maxIterations: 1,
        simulateFoodSpawns: false,
      },
      memory,
    );
    assert.equal(changedTransitionModel.priorVisits, 0);
    assert.equal(changedTransitionModel.reusedTree, false);

    memory.clearGame(state.game.id);
    const afterClear = searchMove(
      state,
      fallback,
      undefined,
      { ...common, maxIterations: 1 },
      memory,
    );
    assert.equal(afterClear.priorVisits, 0);
    assert.equal(afterClear.reusedTree, false);
  });
});
