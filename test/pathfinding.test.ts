import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { coordinateKey } from "../src/domain/board.js";
import {
  shortestPath,
  shortestPathToOwnTail,
  shortestSurvivablePathToFood,
} from "../src/evaluation/pathfinding.js";
import { gameState, opponent } from "./fixtures.js";

describe("shortestPath", () => {
  it("uses BFS distance around obstacles instead of Manhattan distance", () => {
    const result = shortestPath(
      { x: 0, y: 1 },
      { x: 2, y: 1 },
      3,
      3,
      new Set(["1,1"]),
    );

    assert.equal(result?.distance, 4);
    assert.deepEqual(result?.path[0], { x: 0, y: 1 });
    assert.deepEqual(result?.path.at(-1), { x: 2, y: 1 });
  });

  it("returns undefined when a target is separated by a wall", () => {
    const result = shortestPath(
      { x: 0, y: 1 },
      { x: 2, y: 1 },
      3,
      3,
      new Set(["1,0", "1,1", "1,2"]),
    );

    assert.equal(result, undefined);
  });
});

describe("shortestSurvivablePathToFood", () => {
  it("lets a snake with one health eat adjacent food", () => {
    const state = gameState({
      width: 4,
      height: 4,
      health: 1,
      youBody: [{ x: 1, y: 1 }],
      food: [{ x: 2, y: 1 }],
      opponents: [opponent("them", [{ x: 3, y: 3 }])],
    });

    const result = shortestSurvivablePathToFood(
      state,
      state.you,
      new Set(["1,1", "3,3"]),
    );

    assert.equal(result?.distance, 1);
  });

  it("treats food inside a hazard as survivable at one health", () => {
    const destination = { x: 2, y: 1 };
    const state = gameState({
      width: 4,
      height: 4,
      health: 1,
      youBody: [{ x: 1, y: 1 }],
      food: [destination],
      hazards: [destination],
      opponents: [opponent("them", [{ x: 3, y: 3 }])],
    });

    const result = shortestSurvivablePathToFood(
      state,
      state.you,
      new Set(["1,1", "3,3"]),
    );

    assert.equal(result?.distance, 1);
  });

  it("takes a longer route around a lethal hazard", () => {
    const state = gameState({
      width: 3,
      height: 3,
      health: 5,
      youBody: [{ x: 0, y: 1 }],
      food: [{ x: 2, y: 1 }],
      hazards: [{ x: 1, y: 1 }],
      opponents: [opponent("them", [{ x: 2, y: 2 }])],
    });

    const result = shortestSurvivablePathToFood(
      state,
      state.you,
      new Set(["0,1", "2,2"]),
    );

    assert.equal(result?.distance, 4);
    assert.ok(!result?.path.some((cell) => coordinateKey(cell) === "1,1"));
  });

  it("returns undefined when every route to food is lethal", () => {
    const state = gameState({
      width: 3,
      height: 1,
      health: 5,
      youBody: [{ x: 0, y: 0 }],
      food: [{ x: 2, y: 0 }],
      hazards: [{ x: 1, y: 0 }],
      opponents: [opponent("them", [{ x: 2, y: 0 }])],
    });

    const result = shortestSurvivablePathToFood(
      state,
      state.you,
      new Set(["0,0"]),
    );

    assert.equal(result, undefined);
  });
});

describe("shortestPathToOwnTail", () => {
  it("allows a unique tail to be the path target", () => {
    const state = gameState({
      width: 4,
      height: 4,
      youBody: [
        { x: 1, y: 1 },
        { x: 1, y: 2 },
        { x: 2, y: 2 },
        { x: 2, y: 1 },
      ],
      opponents: [opponent("them", [{ x: 3, y: 3 }])],
    });
    const blocked = new Set(
      state.board.snakes.flatMap((snake) => snake.body.map(coordinateKey)),
    );

    assert.equal(shortestPathToOwnTail(state, state.you, blocked)?.distance, 1);
  });

  it("does not assume a duplicated tail vacates", () => {
    const state = gameState({
      width: 4,
      height: 4,
      youBody: [
        { x: 1, y: 1 },
        { x: 1, y: 2 },
        { x: 2, y: 2 },
        { x: 2, y: 1 },
        { x: 2, y: 1 },
      ],
      opponents: [opponent("them", [{ x: 3, y: 3 }])],
    });
    const blocked = new Set(
      state.board.snakes.flatMap((snake) => snake.body.map(coordinateKey)),
    );

    assert.equal(shortestPathToOwnTail(state, state.you, blocked), undefined);
  });
});
