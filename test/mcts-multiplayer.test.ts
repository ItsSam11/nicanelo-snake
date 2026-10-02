import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MctsMemory, searchMove } from "../src/search/mcts.js";
import { chooseStaticMove } from "../src/strategy/static-policy.js";
import { gameState, opponent } from "./fixtures.js";

const FOUR_SNAKE_STATE = gameState({
  opponents: [
    opponent("north-east", [
      { x: 8, y: 8 }, { x: 8, y: 9 }, { x: 8, y: 10 },
    ]),
    opponent("north-west", [
      { x: 2, y: 8 }, { x: 2, y: 9 }, { x: 2, y: 10 },
    ]),
    opponent("south-east", [
      { x: 8, y: 2 }, { x: 8, y: 1 }, { x: 8, y: 0 },
    ]),
  ],
  food: [{ x: 5, y: 7 }, { x: 3, y: 5 }, { x: 7, y: 3 }],
});

const THREE_SNAKE_STATE = gameState({
  opponents: [
    opponent("north-east", [
      { x: 8, y: 8 }, { x: 8, y: 9 }, { x: 8, y: 10 },
    ]),
    opponent("north-west", [
      { x: 2, y: 8 }, { x: 2, y: 9 }, { x: 2, y: 10 },
    ]),
  ],
  food: [{ x: 5, y: 7 }, { x: 3, y: 5 }],
});

describe("multiplayer MCTS", () => {
  it("reaches strategic depth while bounding retained joint outcomes", () => {
    const memory = new MctsMemory();
    const fallback = chooseStaticMove(FOUR_SNAKE_STATE).move;
    const result = searchMove(FOUR_SNAKE_STATE, fallback, undefined, {
      timeBudgetMs: 1_000,
      maxIterations: 128,
      maxTreeDepth: 8,
      rolloutDepth: 6,
      seed: 20260920,
      now: () => 0,
    }, memory);
    const root = memory.games.get(FOUR_SNAKE_STATE.game.id)?.root;
    assert.ok(root !== undefined);
    let maximumDepth = 0;
    const visit = (node: NonNullable<typeof root>): void => {
      maximumDepth = Math.max(maximumDepth, node.depth);
      for (const action of node.actions) {
        for (const outcome of action.outcomes.values()) visit(outcome);
      }
    };
    visit(root);

    assert.ok(maximumDepth >= 3);
    assert.ok(result.rootStatistics.every((candidate) => candidate.outcomeCount <= 8));
  });

  it("samples joint outcomes for two rivals in a three-snake game", () => {
    const fallback = chooseStaticMove(THREE_SNAKE_STATE).move;
    const result = searchMove(THREE_SNAKE_STATE, fallback, undefined, {
      timeBudgetMs: 1_000,
      maxIterations: 128,
      maxTreeDepth: 4,
      rolloutDepth: 2,
      seed: 20260920,
      now: () => 0,
    });

    assert.equal(result.iterations, 128);
    assert.equal(result.usedSearch, true);
    assert.ok(result.rootStatistics.length >= 2);
    assert.ok(
      result.rootStatistics.every((candidate) => candidate.outcomeCount > 2),
      "each move should cover multiple two-rival joint outcomes",
    );
  });

  it("samples joint outcomes for all three rivals reproducibly", () => {
    const fallback = chooseStaticMove(FOUR_SNAKE_STATE).move;
    const options = {
      timeBudgetMs: 1_000,
      maxIterations: 192,
      maxTreeDepth: 4,
      rolloutDepth: 2,
      seed: 20260916,
      now: () => 0,
    } as const;
    const first = searchMove(FOUR_SNAKE_STATE, fallback, undefined, options);
    const second = searchMove(FOUR_SNAKE_STATE, fallback, undefined, options);

    assert.deepEqual(second, first);
    assert.equal(first.iterations, 192);
    assert.equal(first.usedSearch, true);
    assert.ok(first.rootStatistics.length >= 2);
    assert.ok(
      first.rootStatistics.every((candidate) => candidate.outcomeCount > 4),
      "each move should cover more outcomes than a one-rival branch can have",
    );
  });
});
