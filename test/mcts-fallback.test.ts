import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { searchMove } from "../src/search/mcts.js";
import { chooseStaticMove } from "../src/strategy/static-policy.js";
import { gameState, opponent } from "./fixtures.js";

describe("MCTS fallback coverage", () => {
  it("does not replace the fallback before every root move is sampled", () => {
    const state = gameState({
      opponents: [
        opponent("them", [
          { x: 8, y: 8 },
          { x: 8, y: 7 },
          { x: 8, y: 6 },
        ]),
      ],
    });
    const fallback = chooseStaticMove(state).move;
    const result = searchMove(state, fallback, undefined, {
      timeBudgetMs: 1_000,
      maxIterations: 1,
      seed: 3,
      now: () => 0,
    });

    assert.equal(result.iterations, 1);
    assert.equal(result.usedSearch, false);
    assert.equal(result.move, fallback);
  });
});
